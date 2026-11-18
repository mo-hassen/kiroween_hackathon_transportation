import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/principal.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DomainError, ErrorCode } from '../../common/http/problem-details.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import type { IdentityVerificationStatus, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { AdminVerificationResponse } from './dto/identity.dto.js';
import { IdentityExpiryService } from './identity-expiry.service.js';
import { OutcomeCode } from './identity-state.js';
import { IdentityTransitions, invalidTransition } from './identity-transitions.js';
import { IdentityVerificationService } from './identity-verification.service.js';

export interface StaffActionResult {
  readonly id: string;
  readonly status: IdentityVerificationStatus;
  readonly accountIdentityStatus: string;
}

function notFound(): DomainError {
  return new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
}

/**
 * Verification officer actions (identity.review): a logged view of the verified claims,
 * "require re-verification" and suspension (02 §3.2). Staff accounts have no customer
 * identity (database CHECK), so an officer can never act on their own identity.
 */
@Injectable()
export class IdentityAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transitions: IdentityTransitions,
    private readonly expiry: IdentityExpiryService,
    private readonly verifications: IdentityVerificationService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Every read of identity details is audited with the officer's reason (01 §4). */
  async view(
    actor: Principal,
    verificationId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<AdminVerificationResponse> {
    const attempt = await this.prisma.identityVerification.findUnique({
      where: { id: verificationId },
      include: { user: { select: { identityStatus: true } } },
    });
    if (attempt === null) throw notFound();
    await this.audit.record(this.prisma, {
      actor: { type: 'STAFF', userId: actor.userId },
      action: 'identity.details_viewed',
      target: { type: 'identity_verification', id: attempt.id },
      reason,
      meta,
    });
    const claims =
      attempt.verifiedClaimsEnc === null
        ? null
        : this.verifications.decryptClaims(attempt.id, attempt.verifiedClaimsEnc);
    const holder =
      attempt.subjectHmac === null
        ? null
        : await this.prisma.user.findUnique({
            where: { identitySubjectHmac: attempt.subjectHmac },
            select: { id: true },
          });
    return {
      id: attempt.id,
      userId: attempt.userId,
      provider: attempt.provider,
      status: attempt.status,
      outcomeCode: attempt.outcomeCode,
      accountIdentityStatus: attempt.user.identityStatus,
      createdAt: attempt.createdAt.toISOString(),
      completedAt: attempt.completedAt?.toISOString() ?? null,
      verifiedAt: attempt.verifiedAt?.toISOString() ?? null,
      validUntil: attempt.validUntil?.toISOString() ?? null,
      assuranceLevel: attempt.assuranceLevel,
      verifiedFullName: claims?.fullName ?? null,
      verifiedDateOfBirth: claims?.dateOfBirth ?? null,
      conflictingUserId: holder !== null && holder.id !== attempt.userId ? holder.id : null,
    };
  }

  /** VERIFIED | SUSPENDED -> REVERIFICATION_REQUIRED (risk signal, or lifting a suspension). */
  requireReverification(
    actor: Principal,
    verificationId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<StaffActionResult> {
    return this.staffAction(verificationId, async (tx, account, attempt) => {
      if (attempt.status !== 'VERIFIED' && attempt.status !== 'SUSPENDED') {
        throw invalidTransition();
      }
      const moved = await this.transitions.moveAttempt(
        tx,
        attempt.id,
        ['VERIFIED', 'SUSPENDED'],
        'REVERIFICATION_REQUIRED',
        { outcomeCode: OutcomeCode.STAFF_REVERIFICATION_REQUIRED, reviewedById: actor.userId },
      );
      if (!moved) throw invalidTransition();
      const updated = await this.transitions.setAccountStatus(
        tx,
        account,
        'REVERIFICATION_REQUIRED',
      );
      await this.record(tx, actor, attempt, 'identity.reverification_required', reason, meta);
      return {
        id: attempt.id,
        status: 'REVERIFICATION_REQUIRED',
        accountIdentityStatus: updated.identityStatus,
      };
    });
  }

  /** VERIFIED | REVERIFICATION_REQUIRED -> SUSPENDED; an open attempt is closed. */
  suspend(
    actor: Principal,
    verificationId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<StaffActionResult> {
    return this.staffAction(verificationId, async (tx, account, attempt) => {
      if (attempt.status !== 'VERIFIED' && attempt.status !== 'REVERIFICATION_REQUIRED') {
        throw invalidTransition();
      }
      let current = account;
      const open = await tx.identityVerification.findFirst({
        where: { userId: attempt.userId, status: 'PENDING' },
        select: { id: true, userId: true, previousIdentityStatus: true },
      });
      if (open !== null) {
        current =
          (await this.transitions.endPending(
            tx,
            current,
            open,
            'CANCELLED',
            OutcomeCode.CLOSED_BY_STAFF,
            { type: 'STAFF', userId: actor.userId },
            meta,
          )) ?? current;
      }
      const moved = await this.transitions.moveAttempt(
        tx,
        attempt.id,
        ['VERIFIED', 'REVERIFICATION_REQUIRED'],
        'SUSPENDED',
        { outcomeCode: OutcomeCode.STAFF_SUSPENDED, reviewedById: actor.userId },
      );
      if (!moved) throw invalidTransition();
      const updated = await this.transitions.setAccountStatus(tx, current, 'SUSPENDED');
      await this.record(tx, actor, attempt, 'identity.suspended', reason, meta);
      return { id: attempt.id, status: 'SUSPENDED', accountIdentityStatus: updated.identityStatus };
    });
  }

  private async staffAction(
    verificationId: string,
    work: (
      tx: Prisma.TransactionClient,
      account: Awaited<ReturnType<IdentityTransitions['lockAccount']>>,
      attempt: { id: string; userId: string; status: IdentityVerificationStatus },
    ) => Promise<StaffActionResult>,
  ): Promise<StaffActionResult> {
    const target = await this.prisma.identityVerification.findUnique({
      where: { id: verificationId },
      select: { userId: true },
    });
    if (target === null) throw notFound();
    return this.prisma.$transaction(async (tx) => {
      const account = await this.expiry.expireDue(
        tx,
        await this.transitions.lockAccount(tx, target.userId),
      );
      const attempt = await tx.identityVerification.findUniqueOrThrow({
        where: { id: verificationId },
        select: { id: true, userId: true, status: true },
      });
      return work(tx, account, attempt);
    });
  }

  private async record(
    tx: Prisma.TransactionClient,
    actor: Principal,
    attempt: { id: string; userId: string },
    action: 'identity.reverification_required' | 'identity.suspended',
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'STAFF', userId: actor.userId },
      action,
      target: { type: 'identity_verification', id: attempt.id },
      reason,
      meta,
    });
    await this.outbox.enqueue(tx, {
      aggregateType: 'identity_verification',
      aggregateId: attempt.id,
      eventType: action,
      payload: { userId: attempt.userId, verificationId: attempt.id },
      requestId: meta.requestId,
    });
  }
}
