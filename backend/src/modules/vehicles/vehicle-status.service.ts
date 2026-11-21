import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { NotificationService } from '../../common/notifications/notification.service.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { addisToday, evidenceExpired, isoDate, parseIsoDate } from './vehicle-rules.js';

type Tx = Prisma.TransactionClient;

/**
 * Time-driven vehicle transitions: an APPROVED vehicle becomes EXPIRED once its insurance or
 * inspection certificate ended before today's Addis Ababa date. Applied lazily on every owner
 * read and officer action, and in bulk by `npm run vehicles:refresh`. No scheduler is deployed
 * in this phase: until one runs the CLI, a vehicle nobody reads stays APPROVED in the database
 * (its eligibility is still computed correctly on every read). Reminders are Phase 15.
 */
@Injectable()
export class VehicleStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationService,
  ) {}

  /** SELECT … FOR UPDATE on the vehicle: every vehicle write takes this lock first. */
  async lock(tx: Tx, vehicleId: string): Promise<void> {
    await tx.$queryRaw`SELECT 1 AS locked FROM "vehicles" WHERE "id" = ${vehicleId}::uuid FOR UPDATE`;
  }

  /** Expires the owner's approved vehicles whose evidence ended. */
  async refreshForOwner(ownerProfileId: string, now: Date = new Date()): Promise<void> {
    const today = addisToday(now);
    const due = await this.prisma.vehicle.findMany({
      where: this.dueWhere(today, { ownerProfileId }),
      select: { id: true },
    });
    for (const { id } of due) {
      await this.prisma.$transaction(async (tx) => {
        await this.lock(tx, id);
        await this.apply(tx, id, now);
      });
    }
  }

  private dueWhere(today: string, extra: Prisma.VehicleWhereInput = {}): Prisma.VehicleWhereInput {
    const date = parseIsoDate(today) as Date;
    return {
      ...extra,
      status: 'APPROVED',
      evidence: {
        some: { slot: { in: ['INSURANCE', 'INSPECTION'] }, expiresOn: { lt: date } },
      },
    };
  }

  /** Within a transaction that holds the vehicle lock. Returns true when it changed. */
  async apply(tx: Tx, vehicleId: string, now: Date = new Date()): Promise<boolean> {
    const today = addisToday(now);
    const vehicle = await tx.vehicle.findUniqueOrThrow({
      where: { id: vehicleId },
      select: {
        id: true,
        version: true,
        status: true,
        ownerProfile: { select: { userId: true } },
        evidence: { select: { slot: true, expiresOn: true, document: true } },
      },
    });
    if (vehicle.status !== 'APPROVED') return false;
    const facts = vehicle.evidence.map((e) => ({
      slot: e.slot,
      uploadStatus: e.document.uploadStatus,
      reviewStatus: e.document.reviewStatus,
      expiresOn: e.expiresOn === null ? null : isoDate(e.expiresOn),
    }));
    if (!evidenceExpired(facts, today)) return false;
    await tx.vehicle.update({
      where: { id: vehicle.id },
      data: { status: 'EXPIRED', version: { increment: 1 } },
    });
    await tx.vehicleReviewEvent.create({
      data: {
        vehicleId: vehicle.id,
        action: 'evidence_expired',
        fromStatus: 'APPROVED',
        toStatus: 'EXPIRED',
      },
    });
    await this.audit.record(tx, {
      actor: { type: 'SYSTEM' },
      action: 'vehicle.expired',
      target: { type: 'vehicle', id: vehicle.id },
      changes: { from: 'APPROVED', to: 'EXPIRED' },
    });
    await this.outbox.enqueue(tx, {
      aggregateType: 'vehicle',
      aggregateId: vehicle.id,
      eventType: 'vehicle.expired',
      payload: { userId: vehicle.ownerProfile.userId, vehicleId: vehicle.id },
    });
    await this.notifications.notify(tx, {
      recipientUserId: vehicle.ownerProfile.userId,
      eventType: 'vehicle.expired',
      dedupeKey: `vehicle.expired:${vehicle.id}:${vehicle.version + 1}`,
      titleKey: 'notif.vehicle.expired.title',
      bodyKey: 'notif.vehicle.expired.body',
      deepLink: '/vehicles',
    });
    return true;
  }

  /** Bulk sweep for the scheduled job. Returns the number of vehicles changed. */
  async sweep(now: Date = new Date(), batchSize = 200): Promise<number> {
    const today = addisToday(now);
    let changed = 0;
    for (;;) {
      const due = await this.prisma.vehicle.findMany({
        where: this.dueWhere(today),
        select: { id: true },
        take: batchSize,
      });
      if (due.length === 0) return changed;
      let moved = 0;
      for (const { id } of due) {
        const done = await this.prisma.$transaction(async (tx) => {
          await this.lock(tx, id);
          return this.apply(tx, id, now);
        });
        if (done) moved += 1;
      }
      changed += moved;
      // Nothing moved: the remaining rows are not due after all (guards against a loop).
      if (moved === 0) return changed;
    }
  }
}
