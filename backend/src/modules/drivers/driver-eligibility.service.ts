import { Injectable } from '@nestjs/common';
import { AuditService, type AuditEntry } from '../../common/audit/audit.service.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { NotificationService } from '../../common/notifications/notification.service.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import type { DriverEligibility, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import {
  addisToday,
  evaluateEligibility,
  type EligibilityResult,
  isoDate,
} from './driver-rules.js';

type Tx = Prisma.TransactionClient;
const SYSTEM = { type: 'SYSTEM' } as const;

/**
 * The only writer of `driver_profiles.eligibility_status` (a cache of 02 §3.5) and of the
 * time-based licence expiry. Callers lock the profile row first (`lockProfile`).
 */
@Injectable()
export class DriverEligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationService,
  ) {}

  /** `SELECT … FOR UPDATE` on the profile: serializes all driver changes of one user. */
  async lockProfile(tx: Tx, profileId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 AS locked FROM "driver_profiles" WHERE "id" = ${profileId}::uuid FOR UPDATE`;
  }

  async evaluate(tx: Tx, profileId: string, now: Date = new Date()): Promise<EligibilityResult> {
    const profile = await tx.driverProfile.findUniqueOrThrow({
      where: { id: profileId },
      select: {
        suspendedAt: true,
        user: { select: { status: true, identityStatus: true } },
        license: {
          select: {
            reviewStatus: true,
            expiresOn: true,
            documents: {
              select: {
                purpose: true,
                document: { select: { uploadStatus: true, reviewStatus: true } },
              },
            },
          },
        },
      },
    });
    return evaluateEligibility(
      {
        accountStatus: profile.user.status,
        identityStatus: profile.user.identityStatus,
        suspended: profile.suspendedAt !== null,
        license:
          profile.license === null
            ? null
            : {
                reviewStatus: profile.license.reviewStatus,
                expiresOn: isoDate(profile.license.expiresOn),
                documents: profile.license.documents.map((link) => ({
                  purpose: link.purpose,
                  uploadStatus: link.document.uploadStatus,
                  reviewStatus: link.document.reviewStatus,
                })),
              },
      },
      addisToday(now),
    );
  }

  /** Applies a due licence expiry, then updates the cached eligibility. Profile locked. */
  async refresh(
    tx: Tx,
    profileId: string,
    actor: AuditEntry['actor'] = SYSTEM,
    meta?: RequestMeta,
    now: Date = new Date(),
    /** Status before the caller's change, if the caller already wrote the cache. */
    previous?: DriverEligibility,
  ): Promise<EligibilityResult> {
    await this.expireIfDue(tx, profileId, now);
    const result = await this.evaluate(tx, profileId, now);
    const profile = await tx.driverProfile.findUniqueOrThrow({
      where: { id: profileId },
      select: { userId: true, eligibilityStatus: true },
    });
    if (profile.eligibilityStatus !== result.status) {
      await tx.driverProfile.update({
        where: { id: profileId },
        data: { eligibilityStatus: result.status },
      });
    }
    const from = previous ?? profile.eligibilityStatus;
    if (from !== result.status) {
      await this.audit.record(tx, {
        actor,
        action: 'driver.eligibility_changed',
        target: { type: 'driver_profile', id: profileId },
        changes: {
          from,
          to: result.status,
          blockers: [...result.blockers],
        },
        ...(meta === undefined ? {} : { meta }),
      });
      await this.outbox.enqueue(tx, {
        aggregateType: 'driver_profile',
        aggregateId: profileId,
        eventType: 'driver.eligibility_changed',
        payload: { userId: profile.userId, from, to: result.status },
        requestId: meta?.requestId,
      });
    }
    return result;
  }

  private async expireIfDue(tx: Tx, profileId: string, now: Date): Promise<void> {
    const today = new Date(`${addisToday(now)}T00:00:00.000Z`);
    const license = await tx.driverLicense.findFirst({
      where: {
        driverProfileId: profileId,
        reviewStatus: { in: ['APPROVED', 'SUSPENDED'] },
        expiresOn: { lte: today },
      },
      select: {
        id: true,
        reviewStatus: true,
        version: true,
        driverProfile: { select: { userId: true } },
        documents: { select: { documentId: true } },
      },
    });
    if (license === null) return;
    await tx.driverLicense.update({
      where: { id: license.id },
      data: { reviewStatus: 'EXPIRED', version: { increment: 1 } },
    });
    await tx.document.updateMany({
      where: { id: { in: license.documents.map((d) => d.documentId) } },
      data: { reviewStatus: 'EXPIRED' },
    });
    await tx.driverReviewEvent.create({
      data: {
        driverLicenseId: license.id,
        action: 'expired',
        fromStatus: license.reviewStatus,
        toStatus: 'EXPIRED',
        reasonCode: 'EXPIRED',
      },
    });
    await this.audit.record(tx, {
      actor: SYSTEM,
      action: 'driver.license_expired',
      target: { type: 'driver_license', id: license.id },
    });
    await this.outbox.enqueue(tx, {
      aggregateType: 'driver_license',
      aggregateId: license.id,
      eventType: 'driver.license_expired',
      payload: { userId: license.driverProfile.userId, driverLicenseId: license.id },
    });
    await this.notifications.notify(tx, {
      recipientUserId: license.driverProfile.userId,
      eventType: 'driver.license_expired',
      dedupeKey: `driver.license_expired:${license.id}:${license.version + 1}`,
      titleKey: 'notif.driver.licenseExpired.title',
      bodyKey: 'notif.driver.licenseExpired.body',
      deepLink: '/driver',
    });
  }

  /** Lazy refresh for one user (cheap read first). */
  async refreshForUser(userId: string): Promise<void> {
    const profile = await this.prisma.driverProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (profile === null) return;
    await this.prisma.$transaction(async (tx) => {
      await this.lockProfile(tx, profile.id);
      await this.refresh(tx, profile.id);
    });
  }

  /** Nightly job (`npm run drivers:refresh`): expiries and eligibility for every driver. */
  async sweep(now: Date = new Date(), batchSize = 200): Promise<number> {
    let processed = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.driverProfile.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(cursor === undefined ? {} : { skip: 1, cursor: { id: cursor } }),
      });
      if (page.length === 0) return processed;
      for (const { id } of page) {
        await this.prisma.$transaction(async (tx) => {
          await this.lockProfile(tx, id);
          await this.refresh(tx, id, SYSTEM, undefined, now);
        });
        processed += 1;
      }
      cursor = page.at(-1)?.id;
    }
  }
}
