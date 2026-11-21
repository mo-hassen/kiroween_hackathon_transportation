import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { NotificationService } from '../../common/notifications/notification.service.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { IdentityExpiryService } from '../identity/identity-expiry.service.js';
import { statusAfterIdentityCheck } from './owner-rules.js';

type Tx = Prisma.TransactionClient;

/**
 * Time- and identity-driven owner transitions: a VERIFIED owner becomes EXPIRED when the
 * identity expired and REVERIFICATION_REQUIRED when the identity is otherwise no longer
 * verified. Applied lazily on every owner read and review, and in bulk by
 * `npm run owners:refresh`. The only code that changes status without an actor.
 */
@Injectable()
export class OwnerStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identityExpiry: IdentityExpiryService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationService,
  ) {}

  /** SELECT … FOR UPDATE on the profile: every owner write takes this lock first. */
  async lock(tx: Tx, profileId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 AS locked FROM "owner_profiles" WHERE "id" = ${profileId}::uuid FOR UPDATE`;
  }

  /** Applies due identity expiries for the user, then the owner consequence. */
  async refreshForUser(userId: string, now: Date = new Date()): Promise<void> {
    await this.identityExpiry.expireDueForUser(userId, now);
    const profile = await this.prisma.ownerProfile.findUnique({
      where: { userId },
      select: { id: true, verificationStatus: true, user: { select: { identityStatus: true } } },
    });
    if (
      profile === null ||
      statusAfterIdentityCheck(profile.verificationStatus, profile.user.identityStatus) === null
    ) {
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, profile.id);
      await this.apply(tx, profile.id);
    });
  }

  /** Within a transaction that holds the profile lock. Returns true when it changed. */
  async apply(tx: Tx, profileId: string): Promise<boolean> {
    const profile = await tx.ownerProfile.findUniqueOrThrow({
      where: { id: profileId },
      select: {
        id: true,
        userId: true,
        version: true,
        verificationStatus: true,
        user: { select: { identityStatus: true } },
      },
    });
    const next = statusAfterIdentityCheck(profile.verificationStatus, profile.user.identityStatus);
    if (next === null) return false;
    await tx.ownerProfile.update({
      where: { id: profile.id },
      data: { verificationStatus: next, version: { increment: 1 } },
    });
    await tx.ownerReviewEvent.create({
      data: {
        ownerProfileId: profile.id,
        action: next === 'EXPIRED' ? 'identity_expired' : 'identity_not_verified',
        fromStatus: profile.verificationStatus,
        toStatus: next,
      },
    });
    const eventType =
      next === 'EXPIRED' ? 'owner.verification_expired' : 'owner.reverification_required';
    await this.audit.record(tx, {
      actor: { type: 'SYSTEM' },
      action: eventType,
      target: { type: 'owner_profile', id: profile.id },
      changes: { from: profile.verificationStatus, to: next },
    });
    await this.outbox.enqueue(tx, {
      aggregateType: 'owner_profile',
      aggregateId: profile.id,
      eventType,
      payload: { userId: profile.userId, ownerProfileId: profile.id },
    });
    const key = next === 'EXPIRED' ? 'expired' : 'reverificationRequired';
    await this.notifications.notify(tx, {
      recipientUserId: profile.userId,
      eventType,
      dedupeKey: `${eventType}:${profile.id}:${profile.version + 1}`,
      titleKey: `notif.owner.${key}.title`,
      bodyKey: `notif.owner.${key}.body`,
      deepLink: '/owner',
    });
    return true;
  }

  /** Bulk sweep for the scheduled job. Returns the number of owners changed. */
  async sweep(now: Date = new Date(), batchSize = 200): Promise<number> {
    await this.identityExpiry.sweep(now, batchSize);
    let changed = 0;
    for (;;) {
      const due = await this.prisma.ownerProfile.findMany({
        where: { verificationStatus: 'VERIFIED', user: { identityStatus: { not: 'VERIFIED' } } },
        select: { id: true },
        take: batchSize,
      });
      if (due.length === 0) return changed;
      for (const { id } of due) {
        const moved = await this.prisma.$transaction(async (tx) => {
          await this.lock(tx, id);
          return this.apply(tx, id);
        });
        if (moved) changed += 1;
      }
    }
  }
}
