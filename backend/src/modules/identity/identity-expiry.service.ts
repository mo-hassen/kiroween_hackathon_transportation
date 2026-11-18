import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { OutcomeCode } from './identity-state.js';
import { IdentityTransitions, type LockedAccount } from './identity-transitions.js';

const SYSTEM = { type: 'SYSTEM' } as const;
/** A callback that was claimed but never finished (process crash) is abandoned after this. */
const ABANDONED_CALLBACK_GRACE_MS = 60_000;

/**
 * Time-based transitions: a PENDING session lapses after its TTL (15 min by default) and a
 * VERIFIED identity expires at valid_until (BR-ID-3). Applied lazily whenever the account
 * reads or changes its identity, and in bulk by `npm run identity:expire` (cron).
 */
@Injectable()
export class IdentityExpiryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: IdentityTransitions,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private dueFilter(now: Date): Prisma.IdentityVerificationWhereInput {
    const abandonedBefore = new Date(
      now.getTime() - this.config.identity.providerTimeoutMs - ABANDONED_CALLBACK_GRACE_MS,
    );
    return {
      OR: [
        { status: 'PENDING', callbackReceivedAt: null, sessionExpiresAt: { lte: now } },
        // Claimed but never finished (process crash during the provider exchange).
        {
          status: 'PENDING',
          callbackReceivedAt: { lte: abandonedBefore },
          confirmationExpiresAt: null,
        },
        // A provider result the app never confirmed.
        { status: 'PENDING', confirmationExpiresAt: { lte: now } },
        { status: 'VERIFIED', validUntil: { lte: now } },
      ],
    };
  }

  /** Applies due expiries for one locked account. Returns the account as it is now. */
  async expireDue(
    tx: Prisma.TransactionClient,
    account: LockedAccount,
    now: Date = new Date(),
  ): Promise<LockedAccount> {
    const due = await tx.identityVerification.findMany({
      where: { userId: account.id, ...this.dueFilter(now) },
      select: {
        id: true,
        userId: true,
        status: true,
        previousIdentityStatus: true,
        confirmationExpiresAt: true,
      },
    });
    let current = account;
    for (const attempt of due) {
      if (attempt.status === 'PENDING') {
        current =
          (await this.transitions.endPending(
            tx,
            current,
            attempt,
            'EXPIRED',
            attempt.confirmationExpiresAt === null
              ? OutcomeCode.SESSION_EXPIRED
              : OutcomeCode.CONFIRMATION_EXPIRED,
            SYSTEM,
            undefined,
          )) ?? current;
        continue;
      }
      const moved = await this.transitions.moveAttempt(tx, attempt.id, ['VERIFIED'], 'EXPIRED', {
        outcomeCode: OutcomeCode.VALIDITY_ENDED,
      });
      if (!moved) continue;
      if (current.identityStatus === 'VERIFIED') {
        current = await this.transitions.setAccountStatus(tx, current, 'EXPIRED');
      }
      await this.audit.record(tx, {
        actor: SYSTEM,
        action: 'identity.verification_expired',
        target: { type: 'identity_verification', id: attempt.id },
        changes: { outcomeCode: OutcomeCode.VALIDITY_ENDED },
      });
      await this.outbox.enqueue(tx, {
        aggregateType: 'identity_verification',
        aggregateId: attempt.id,
        eventType: 'identity.expired',
        payload: { userId: attempt.userId, verificationId: attempt.id },
      });
    }
    return current;
  }

  /** Cheap read first; only takes the account lock when something is actually due. */
  async expireDueForUser(userId: string, now: Date = new Date()): Promise<void> {
    const due = await this.prisma.identityVerification.count({
      where: { userId, ...this.dueFilter(now) },
    });
    if (due === 0) return;
    await this.prisma.$transaction(async (tx) => {
      await this.expireDue(tx, await this.transitions.lockAccount(tx, userId), now);
    });
  }

  /** Bulk sweep for the scheduled job. Returns the number of accounts processed. */
  async sweep(now: Date = new Date(), batchSize = 200): Promise<number> {
    let processed = 0;
    for (;;) {
      const users = await this.prisma.identityVerification.findMany({
        where: this.dueFilter(now),
        select: { userId: true },
        distinct: ['userId'],
        take: batchSize,
      });
      if (users.length === 0) return processed;
      for (const { userId } of users) {
        await this.expireDueForUser(userId, now);
        processed += 1;
      }
    }
  }
}
