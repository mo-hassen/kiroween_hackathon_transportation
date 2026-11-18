import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService, type AuditEntry } from '../../common/audit/audit.service.js';
import { DomainError, ErrorCode } from '../../common/http/problem-details.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import type {
  IdentityStatus,
  IdentityVerificationStatus,
  Prisma,
} from '../../generated/prisma/client.js';
import {
  accountStatusAfter,
  type AttemptOutcome,
  canTransitionAccount,
  canTransitionAttempt,
  type OutcomeCode,
} from './identity-state.js';

type Tx = Prisma.TransactionClient;

export interface LockedAccount {
  readonly id: string;
  readonly accountType: 'CUSTOMER' | 'STAFF';
  readonly identityStatus: IdentityStatus;
  readonly identitySubjectHmac: string | null;
}

export interface PendingAttempt {
  readonly id: string;
  readonly userId: string;
  readonly previousIdentityStatus: IdentityStatus;
}

export type IdentityActor = AuditEntry['actor'];

export function invalidTransition(): DomainError {
  return new DomainError(ErrorCode.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT);
}

/**
 * The only writer of identity state (BR-ID-1). Every method runs inside the caller's
 * transaction, after `lockAccount`, so the attempt, the account status, the audit row and
 * the outbox event commit together (02 §3). Lock order is always: users row, then attempts.
 */
@Injectable()
export class IdentityTransitions {
  constructor(
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** `SELECT … FOR UPDATE` on the account: serializes all identity changes of one user. */
  async lockAccount(tx: Tx, userId: string): Promise<LockedAccount> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        account_type: 'CUSTOMER' | 'STAFF';
        identity_status: IdentityStatus;
        identity_subject_hmac: string | null;
      }[]
    >`SELECT "id", "account_type", "identity_status", "identity_subject_hmac"
      FROM "users" WHERE "id" = ${userId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (row === undefined) throw new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
    return {
      id: row.id,
      accountType: row.account_type,
      identityStatus: row.identity_status,
      identitySubjectHmac: row.identity_subject_hmac,
    };
  }

  /**
   * Moves an attempt if it is still in one of `from`. Returns false when another request
   * changed it first (the caller then does nothing). An illegal pair is a programming
   * error and throws.
   */
  async moveAttempt(
    tx: Tx,
    attemptId: string,
    from: readonly IdentityVerificationStatus[],
    to: IdentityVerificationStatus,
    data: Omit<Prisma.IdentityVerificationUncheckedUpdateManyInput, 'status' | 'version'> = {},
  ): Promise<boolean> {
    for (const status of from) {
      if (!canTransitionAttempt(status, to)) {
        throw new Error(`Illegal identity attempt transition ${status} -> ${to}`);
      }
    }
    // Leaving PENDING always erases the session secrets and any unconfirmed result.
    const cleared = from.includes('PENDING')
      ? {
          requestSecretsEnc: null,
          pendingResultEnc: null,
          confirmationHash: null,
          confirmationExpiresAt: null,
        }
      : {};
    const result = await tx.identityVerification.updateMany({
      where: { id: attemptId, status: { in: [...from] } },
      data: { ...cleared, ...data, status: to, version: { increment: 1 } },
    });
    return result.count === 1;
  }

  /**
   * Sets `users.identity_status`. Server-managed, so the profile `version` (If-Match for
   * PATCH /me) is not bumped. Returns the account as it is now.
   */
  async setAccountStatus(
    tx: Tx,
    account: LockedAccount,
    to: IdentityStatus,
    data: { identitySubjectHmac?: string } = {},
  ): Promise<LockedAccount> {
    if (account.identityStatus === to && data.identitySubjectHmac === undefined) return account;
    if (account.identityStatus !== to && !canTransitionAccount(account.identityStatus, to)) {
      throw new Error(`Illegal account identity transition ${account.identityStatus} -> ${to}`);
    }
    await tx.user.update({ where: { id: account.id }, data: { identityStatus: to, ...data } });
    return {
      ...account,
      identityStatus: to,
      identitySubjectHmac: data.identitySubjectHmac ?? account.identitySubjectHmac,
    };
  }

  /**
   * Ends a PENDING attempt without a verified identity and restores (or sets) the account
   * status. Returns false if the attempt was no longer PENDING.
   */
  async endPending(
    tx: Tx,
    account: LockedAccount,
    attempt: PendingAttempt,
    outcome: Exclude<AttemptOutcome, 'VERIFIED'>,
    outcomeCode: OutcomeCode,
    actor: IdentityActor,
    meta: RequestMeta | undefined,
    extra: { subjectHmac?: string } = {},
  ): Promise<LockedAccount | null> {
    const moved = await this.moveAttempt(tx, attempt.id, ['PENDING'], outcome, {
      outcomeCode,
      completedAt: new Date(),
      requestSecretsEnc: null,
      ...(extra.subjectHmac === undefined ? {} : { subjectHmac: extra.subjectHmac }),
    });
    if (!moved) return null;
    // The account is PENDING while this attempt is open, unless staff suspended it.
    const updated =
      account.identityStatus === 'PENDING'
        ? await this.setAccountStatus(
            tx,
            account,
            accountStatusAfter(outcome, attempt.previousIdentityStatus),
          )
        : account;
    await this.audit.record(tx, {
      actor,
      action: `identity.verification_${outcome.toLowerCase()}`,
      target: { type: 'identity_verification', id: attempt.id },
      changes: { outcomeCode },
      ...(meta === undefined ? {} : { meta }),
    });
    if (outcome === 'REJECTED') {
      await this.outbox.enqueue(tx, {
        aggregateType: 'identity_verification',
        aggregateId: attempt.id,
        eventType: 'identity.rejected',
        payload: { userId: attempt.userId, verificationId: attempt.id },
        requestId: meta?.requestId,
      });
    }
    return updated;
  }
}
