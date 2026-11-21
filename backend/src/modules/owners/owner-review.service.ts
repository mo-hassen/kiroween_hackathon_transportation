import { timingSafeEqual } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/principal.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { FieldEncryption } from '../../common/crypto/field-encryption.js';
import { SecretHasher } from '../../common/crypto/secret-hasher.js';
import { DomainError, ErrorCode, validationError } from '../../common/http/problem-details.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { IdempotencyService } from '../../common/idempotency/idempotency.service.js';
import { NotificationService } from '../../common/notifications/notification.service.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import {
  RateLimitService,
  type RateLimitRule,
} from '../../common/rate-limit/rate-limit.service.js';
import type {
  OwnerVerificationStatus,
  Prisma,
  ReviewReasonCode,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { PresignedRequest } from '../../infrastructure/storage/object-storage.js';
import { DocumentsService } from '../documents/documents.service.js';
import { REVIEW_CLAIM_TTL_MS } from '../drivers/driver-rules.js';
import { claimsAad } from '../identity/identity-policy.js';
import type {
  ApproveIndividualDto,
  OrganizationApprovalDto,
  OwnerCaseCountsResponse,
  OwnerCaseDetailResponse,
  OwnerCaseListResponse,
  OwnerCaseSummaryResponse,
  OwnerQueueQuery,
  OwnerRejectDto,
  OwnerSuspendDto,
  TinCheckDto,
  TinCheckResponse,
} from './dto/owner.dto.js';
import {
  approvalBlockers,
  type ApprovalAction,
  approvalRefusal,
  maskTin,
  normalizeTin,
} from './owner-rules.js';
import { OwnerStatusService } from './owner-status.service.js';
import { documentFacts, documentSlots, OWNER_INCLUDE } from './owners.service.js';

type Tx = Prisma.TransactionClient;

/** Audit action of a TIN check; its `changes.matches` is the result (never the value). */
export const TIN_CHECK_ACTION = 'owner.tin_checked_by_staff';
/** A check is a lookup aid for one claimed case, not a search: 10 per officer and case per hour. */
const TIN_CHECK_LIMIT: RateLimitRule = {
  name: 'owners-tin-check-1h',
  limit: 10,
  windowMs: 60 * 60_000,
};

const CASE_INCLUDE = {
  ...OWNER_INCLUDE,
  user: {
    select: { status: true, identityStatus: true, displayName: true, phoneE164: true },
  },
} satisfies Prisma.OwnerProfileInclude;
type CaseRow = Prisma.OwnerProfileGetPayload<{ include: typeof CASE_INCLUDE }>;

type Decision =
  'approve' | 'first-approval' | 'second-approval' | 'reject' | 'suspend' | 'reinstate';

function notFound(): DomainError {
  return new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
}
function invalidTransition(): DomainError {
  return new DomainError(ErrorCode.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT);
}
function secondApproverRequired(): DomainError {
  return new DomainError(ErrorCode.SECOND_APPROVER_REQUIRED, HttpStatus.CONFLICT);
}

function activeClaim(row: CaseRow, now: Date): string | null {
  return row.claimedById !== null && row.claimExpiresAt !== null && row.claimExpiresAt > now
    ? row.claimedById
    : null;
}

function awaitingSecondApproval(row: {
  verificationStatus: OwnerVerificationStatus;
  firstApprovedById: string | null;
}): boolean {
  return row.verificationStatus === 'PENDING' && row.firstApprovedById !== null;
}

function summary(row: CaseRow, officerId: string, now: Date): OwnerCaseSummaryResponse {
  const claimer = activeClaim(row, now);
  return {
    id: row.id,
    ownerType: row.ownerType,
    verificationStatus: row.verificationStatus,
    displayName: row.user.displayName,
    organizationName: row.organizationName,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    claimedById: claimer,
    claimedByMe: claimer === officerId,
    claimExpiresAt: claimer === null ? null : (row.claimExpiresAt?.toISOString() ?? null),
    awaitingSecondApproval: awaitingSecondApproval(row),
    firstApprovedByMe: awaitingSecondApproval(row) && row.firstApprovedById === officerId,
    version: row.version,
  };
}

/**
 * Verification-officer review of owner profiles (owners.review). Individuals need one
 * approval; organizations need a first approval and a second approval by a different
 * officer (four-eyes, [ASSUMPTION] 08 §7). The database enforces the same: officers only,
 * never the owner, two different approvers for an organization (owner_profiles_guard and
 * owner_profiles_four_eyes_chk).
 */
@Injectable()
export class OwnerReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly status: OwnerStatusService,
    private readonly idempotency: IdempotencyService,
    private readonly encryption: FieldEncryption,
    private readonly hasher: SecretHasher,
    private readonly rateLimits: RateLimitService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationService,
  ) {}

  async list(officer: Principal, query: OwnerQueueQuery): Promise<OwnerCaseListResponse> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const q = query.q;
    const where: Prisma.OwnerProfileWhereInput = {
      // Never-submitted profiles are the owner's private work in progress.
      verificationStatus: query.status ?? { not: 'UNVERIFIED' },
      ...(query.ownerType === undefined ? {} : { ownerType: query.ownerType }),
      ...(query.awaitingSecondApproval === undefined
        ? {}
        : query.awaitingSecondApproval
          ? { verificationStatus: 'PENDING', firstApprovedById: { not: null } }
          : { firstApprovedById: null }),
      ...(q === undefined || q === ''
        ? {}
        : {
            OR: [
              { organizationName: { contains: q, mode: 'insensitive' } },
              { user: { displayName: { contains: q, mode: 'insensitive' } } },
              { user: { phoneE164: q.replace(/\s/g, '') } },
            ],
          }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.ownerProfile.findMany({
        where,
        include: CASE_INCLUDE,
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.ownerProfile.count({ where }),
    ]);
    const now = new Date();
    return { items: rows.map((row) => summary(row, officer.userId, now)), total, page, limit };
  }

  async counts(): Promise<OwnerCaseCountsResponse> {
    const count = (where: Prisma.OwnerProfileWhereInput): Promise<number> =>
      this.prisma.ownerProfile.count({ where });
    const [individual, organization, second, verified, rejected, suspended, expired, reverify] =
      await Promise.all([
        count({ verificationStatus: 'PENDING', ownerType: 'INDIVIDUAL' }),
        count({
          verificationStatus: 'PENDING',
          ownerType: 'ORGANIZATION',
          firstApprovedById: null,
        }),
        count({ verificationStatus: 'PENDING', firstApprovedById: { not: null } }),
        count({ verificationStatus: 'VERIFIED' }),
        count({ verificationStatus: 'REJECTED' }),
        count({ verificationStatus: 'SUSPENDED' }),
        count({ verificationStatus: 'EXPIRED' }),
        count({ verificationStatus: 'REVERIFICATION_REQUIRED' }),
      ]);
    return {
      PENDING_INDIVIDUAL: individual,
      PENDING_ORGANIZATION: organization,
      AWAITING_SECOND_APPROVAL: second,
      VERIFIED: verified,
      REJECTED: rejected,
      SUSPENDED: suspended,
      EXPIRED: expired,
      REVERIFICATION_REQUIRED: reverify,
    };
  }

  /** Full case, including the verified representative name (audited). The TIN stays masked. */
  async detail(
    officer: Principal,
    caseId: string,
    meta: RequestMeta,
  ): Promise<OwnerCaseDetailResponse> {
    const row = await this.load(this.prisma, caseId);
    if (row.userId === officer.userId) throw notFound();
    const [history, identity] = await Promise.all([
      this.prisma.ownerReviewEvent.findMany({
        where: { ownerProfileId: row.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.identityVerification.findFirst({
        where: { userId: row.userId, status: 'VERIFIED' },
        select: { id: true, verifiedClaimsEnc: true },
      }),
    ]);
    const tinCheckedByMe = await this.hasMatchingTinCheck(this.prisma, row, officer);
    await this.audit.record(this.prisma, {
      actor: { type: 'STAFF', userId: officer.userId },
      action: 'owner.case_viewed',
      target: { type: 'owner_profile', id: row.id },
      meta,
    });
    const verifiedName =
      identity?.verifiedClaimsEnc == null
        ? null
        : (
            JSON.parse(
              this.encryption
                .decrypt(Buffer.from(identity.verifiedClaimsEnc), claimsAad(identity.id))
                .toString('utf8'),
            ) as { fullName: string }
          ).fullName;
    const base: Omit<OwnerCaseSummaryResponse, never> = summary(row, officer.userId, new Date());
    return {
      ...base,
      ownerUserId: row.userId,
      representativePhone: row.user.phoneE164,
      accountStatus: row.user.status,
      identityStatus: row.user.identityStatus,
      identityVerifiedName: verifiedName,
      tinMasked: row.tinLast4 === null ? null : maskTin(row.tinLast4),
      tinCheckedByMe,
      firstApprovedById: row.firstApprovedById,
      firstApprovedAt: row.firstApprovedAt?.toISOString() ?? null,
      firstApprovalNote: row.firstApprovalNote,
      verifiedById: row.verifiedById,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionReasonCode: row.decisionReasonCode,
      decisionNote: row.decisionNote,
      documents: documentSlots(row),
      history: history.map((event) => ({
        action: event.action,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        reasonCode: event.reasonCode,
        note: event.note,
        actorUserId: event.actorUserId,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Takes the review claim on a PENDING case (or an expired claim). One conditional update,
   * so two officers can never hold the same case. The first approver cannot claim a case
   * that is waiting for a second approval.
   */
  async claim(
    officer: Principal,
    caseId: string,
    meta: RequestMeta,
  ): Promise<OwnerCaseSummaryResponse> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockAndLoad(tx, caseId, officer);
      const now = new Date();
      if (row.verificationStatus !== 'PENDING') throw invalidTransition();
      const holder = activeClaim(row, now);
      if (holder === officer.userId) return;
      if (holder !== null) {
        throw new DomainError(ErrorCode.REVIEW_CLAIMED_BY_OTHER, HttpStatus.CONFLICT);
      }
      if (row.firstApprovedById === officer.userId) throw secondApproverRequired();
      const claimed = await tx.ownerProfile.updateMany({
        where: {
          id: row.id,
          verificationStatus: 'PENDING',
          OR: [{ claimedById: null }, { claimExpiresAt: { lte: now } }],
        },
        data: {
          claimedById: officer.userId,
          claimExpiresAt: new Date(now.getTime() + REVIEW_CLAIM_TTL_MS),
          version: { increment: 1 },
        },
      });
      if (claimed.count !== 1) {
        throw new DomainError(ErrorCode.REVIEW_CLAIMED_BY_OTHER, HttpStatus.CONFLICT);
      }
      const takeover = row.claimedById !== null;
      await this.history(tx, row, officer, takeover ? 'claim_taken_over' : 'claimed', 'PENDING');
      await this.record(tx, officer, row, 'owner.review_claimed', meta, { takeover });
    });
    return this.summaryOf(caseId, officer);
  }

  async release(
    officer: Principal,
    caseId: string,
    meta: RequestMeta,
  ): Promise<OwnerCaseSummaryResponse> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockAndLoad(tx, caseId, officer);
      this.assertHoldsClaim(row, officer, new Date());
      await tx.ownerProfile.update({
        where: { id: row.id },
        data: { claimedById: null, claimExpiresAt: null, version: { increment: 1 } },
      });
      await this.history(tx, row, officer, 'released', 'PENDING');
      await this.record(tx, officer, row, 'owner.review_released', meta);
    });
    return this.summaryOf(caseId, officer);
  }

  /** Individual owners: one approval. */
  async approveIndividual(
    officer: Principal,
    caseId: string,
    dto: ApproveIndividualDto,
    key: string,
    meta: RequestMeta,
  ): Promise<{ replayed: boolean; body: OwnerCaseSummaryResponse }> {
    return this.decide('approve', officer, caseId, dto, key, async (tx, row, now) => {
      this.assertHoldsClaim(row, officer, now);
      this.assertApprovalAllowed('APPROVE_INDIVIDUAL', row, officer);
      this.assertApprovable(row);
      await this.verify(tx, row, officer, now);
      await this.history(tx, row, officer, 'approved', 'VERIFIED', null, dto.note ?? null);
      await this.record(tx, officer, row, 'owner.approved', meta, { identityConfirmed: true });
      await this.publish(tx, row, 'owner.approved', meta, 'approved');
    });
  }

  /** Organizations, step 1 of 2: records the first officer's approval; stays PENDING. */
  async firstApproval(
    officer: Principal,
    caseId: string,
    dto: OrganizationApprovalDto,
    key: string,
    meta: RequestMeta,
  ): Promise<{ replayed: boolean; body: OwnerCaseSummaryResponse }> {
    return this.decide('first-approval', officer, caseId, dto, key, async (tx, row, now) => {
      this.assertHoldsClaim(row, officer, now);
      this.assertApprovalAllowed('FIRST_APPROVAL', row, officer);
      this.assertApprovable(row);
      await this.assertTinChecked(tx, row, officer);
      const updated = await tx.ownerProfile.updateMany({
        where: { id: row.id, verificationStatus: 'PENDING', firstApprovedById: null },
        data: {
          firstApprovedById: officer.userId,
          firstApprovedAt: now,
          firstApprovalNote: dto.note ?? null,
          // The claim ends so that a different officer can take the second approval.
          claimedById: null,
          claimExpiresAt: null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw invalidTransition();
      await this.history(tx, row, officer, 'first_approval', 'PENDING', null, dto.note ?? null);
      await this.record(tx, officer, row, 'owner.first_approval_recorded', meta, CHECKS);
      await this.outbox.enqueue(tx, {
        aggregateType: 'owner_profile',
        aggregateId: row.id,
        eventType: 'owner.first_approval_recorded',
        payload: { userId: row.userId, ownerProfileId: row.id },
        requestId: meta.requestId,
      });
    });
  }

  /** Organizations, step 2 of 2: a different officer approves; the owner becomes VERIFIED. */
  async secondApproval(
    officer: Principal,
    caseId: string,
    dto: OrganizationApprovalDto,
    key: string,
    meta: RequestMeta,
  ): Promise<{ replayed: boolean; body: OwnerCaseSummaryResponse }> {
    return this.decide('second-approval', officer, caseId, dto, key, async (tx, row, now) => {
      // The same-officer check comes first: the first approver can never get further.
      this.assertApprovalAllowed('SECOND_APPROVAL', row, officer);
      this.assertHoldsClaim(row, officer, now);
      this.assertApprovable(row);
      await this.assertTinChecked(tx, row, officer);
      await this.verify(tx, row, officer, now);
      await tx.document.updateMany({
        where: { id: { in: row.documents.map((d) => d.documentId) } },
        data: { reviewStatus: 'APPROVED', reviewedById: officer.userId, reviewedAt: now },
      });
      await this.history(tx, row, officer, 'second_approval', 'VERIFIED', null, dto.note ?? null);
      await this.record(tx, officer, row, 'owner.second_approval_completed', meta, {
        ...CHECKS,
        firstApprovedBy: row.firstApprovedById ?? '',
      });
      await this.record(tx, officer, row, 'owner.approved', meta);
      await this.publish(tx, row, 'owner.approved', meta, 'approved');
    });
  }

  async reject(
    officer: Principal,
    caseId: string,
    dto: OwnerRejectDto,
    key: string,
    meta: RequestMeta,
  ): Promise<{ replayed: boolean; body: OwnerCaseSummaryResponse }> {
    return this.decide('reject', officer, caseId, dto, key, async (tx, row, now) => {
      this.assertHoldsClaim(row, officer, now);
      await tx.ownerProfile.update({
        where: { id: row.id },
        data: {
          verificationStatus: 'REJECTED',
          claimedById: null,
          claimExpiresAt: null,
          // A rejection ends the case: an earlier first approval does not carry over.
          firstApprovedById: null,
          firstApprovedAt: null,
          firstApprovalNote: null,
          decidedById: officer.userId,
          decidedAt: now,
          decisionReasonCode: dto.reasonCode,
          decisionNote: dto.note ?? null,
          version: { increment: 1 },
        },
      });
      await tx.document.updateMany({
        where: { id: { in: row.documents.map((d) => d.documentId) } },
        data: { reviewStatus: 'REJECTED', reviewedById: officer.userId, reviewedAt: now },
      });
      await this.history(
        tx,
        row,
        officer,
        'rejected',
        'REJECTED',
        dto.reasonCode,
        dto.note ?? null,
      );
      await this.record(tx, officer, row, 'owner.rejected', meta, { reasonCode: dto.reasonCode });
      await this.publish(tx, row, 'owner.rejected', meta, 'rejected', {
        reasonCode: dto.reasonCode,
      });
    });
  }

  /** VERIFIED -> SUSPENDED. The internal note is never shown to the owner. */
  async suspend(
    officer: Principal,
    caseId: string,
    dto: OwnerSuspendDto,
    key: string,
    meta: RequestMeta,
  ): Promise<{ replayed: boolean; body: OwnerCaseSummaryResponse }> {
    return this.decide('suspend', officer, caseId, dto, key, async (tx, row, now) => {
      if (row.verificationStatus !== 'VERIFIED') throw invalidTransition();
      await tx.ownerProfile.update({
        where: { id: row.id },
        data: {
          verificationStatus: 'SUSPENDED',
          decidedById: officer.userId,
          decidedAt: now,
          decisionReasonCode: dto.reasonCode,
          decisionNote: dto.note,
          version: { increment: 1 },
        },
      });
      await this.history(tx, row, officer, 'suspended', 'SUSPENDED', dto.reasonCode, dto.note);
      await this.record(
        tx,
        officer,
        row,
        'owner.suspended',
        meta,
        { reasonCode: dto.reasonCode },
        dto.note,
      );
      await this.publish(tx, row, 'owner.suspended', meta, 'suspended', {
        reasonCode: dto.reasonCode,
      });
    });
  }

  /**
   * SUSPENDED -> VERIFIED. Re-checks account and identity. A suspension for suspected fraud
   * can only be lifted by an officer other than the one who imposed it (four-eyes, 08 §7).
   */
  async reinstate(
    officer: Principal,
    caseId: string,
    note: string,
    key: string,
    meta: RequestMeta,
  ): Promise<{ replayed: boolean; body: OwnerCaseSummaryResponse }> {
    return this.decide('reinstate', officer, caseId, { note }, key, async (tx, row, now) => {
      if (row.verificationStatus !== 'SUSPENDED') throw invalidTransition();
      if (row.decisionReasonCode === 'SUSPECTED_FRAUD' && row.decidedById === officer.userId) {
        throw secondApproverRequired();
      }
      this.assertApprovable(row);
      await tx.ownerProfile.update({
        where: { id: row.id },
        data: {
          verificationStatus: 'VERIFIED',
          decidedById: officer.userId,
          decidedAt: now,
          decisionReasonCode: null,
          decisionNote: null,
          version: { increment: 1 },
        },
      });
      await this.history(tx, row, officer, 'reinstated', 'VERIFIED', null, note);
      await this.record(tx, officer, row, 'owner.reinstated', meta, {}, note);
      await this.publish(tx, row, 'owner.reinstated', meta, 'reinstated');
    });
  }

  /**
   * Compares the TIN the officer reads on the certificate with the stored one, without ever
   * decrypting or returning it. Claim holder only (PENDING organization cases), with a
   * reason; audited with the result only; rate-limited per officer and case.
   */
  async tinCheck(
    officer: Principal,
    caseId: string,
    dto: TinCheckDto,
    meta: RequestMeta,
  ): Promise<TinCheckResponse> {
    const row = await this.load(this.prisma, caseId);
    if (row.userId === officer.userId || row.ownerType !== 'ORGANIZATION' || row.tinHmac === null) {
      throw notFound();
    }
    this.assertHoldsClaim(row, officer, new Date());
    await this.rateLimits.consume(TIN_CHECK_LIMIT, `${officer.userId}:${row.id}`);
    const typed = normalizeTin(dto.tin);
    if (typed === null) throw validationError('tin', 'INVALID_FORMAT');
    const expected = Buffer.from(row.tinHmac, 'hex');
    const actual = Buffer.from(this.hasher.hmacHex('tin', typed), 'hex');
    const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
    const checkedAt = new Date();
    await this.audit.record(this.prisma, {
      actor: { type: 'STAFF', userId: officer.userId },
      action: TIN_CHECK_ACTION,
      target: { type: 'owner_profile', id: row.id },
      reason: dto.reason,
      changes: { matches },
      meta,
    });
    return { matches, checkedAt: checkedAt.toISOString() };
  }

  /**
   * 60-second URL to a case document, audited with the reason. While a case is PENDING,
   * only the officer holding the claim may open its documents.
   */
  async documentUrl(
    officer: Principal,
    caseId: string,
    documentId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<PresignedRequest> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.load(tx, caseId);
      if (row.userId === officer.userId) throw notFound();
      if (!row.documents.some((d) => d.documentId === documentId)) throw notFound();
      if (row.verificationStatus === 'PENDING' && activeClaim(row, new Date()) !== officer.userId) {
        throw new DomainError(ErrorCode.REVIEW_CLAIM_REQUIRED, HttpStatus.CONFLICT);
      }
      return this.documents.staffDownloadUrl(
        tx,
        documentId,
        { userId: officer.userId, reason, caseType: 'owner_profile', caseId: row.id },
        meta,
      );
    });
  }

  // --- helpers ---------------------------------------------------------------

  /** Cases officers may see: anything that was ever submitted. */
  private async load(db: Tx, caseId: string): Promise<CaseRow> {
    const row = await db.ownerProfile.findUnique({ where: { id: caseId }, include: CASE_INCLUDE });
    if (row === null || row.verificationStatus === 'UNVERIFIED') throw notFound();
    return row;
  }

  private async lockAndLoad(tx: Tx, caseId: string, officer: Principal): Promise<CaseRow> {
    const exists = await tx.ownerProfile.findUnique({
      where: { id: caseId },
      select: { id: true },
    });
    if (exists === null) throw notFound();
    await this.status.lock(tx, caseId);
    // An identity that lapsed meanwhile changes a VERIFIED owner first.
    await this.status.apply(tx, caseId);
    const row = await this.load(tx, caseId);
    if (row.userId === officer.userId) throw notFound();
    return row;
  }

  /**
   * Exactly-once decision: the Idempotency-Key replays a retried request; the profile lock
   * and the claim check reject concurrent and repeated decisions (409).
   */
  private async decide(
    action: Decision,
    officer: Principal,
    caseId: string,
    dto: object,
    key: string,
    work: (tx: Tx, row: CaseRow, now: Date) => Promise<void>,
  ): Promise<{ replayed: boolean; body: OwnerCaseSummaryResponse }> {
    const result = await this.idempotency.execute(
      {
        scope: `owners.review.${action}`,
        principal: `staff:${officer.userId}`,
        key,
        fingerprint: {
          method: 'POST',
          route: `/admin/owner-verifications/${caseId}/${action}`,
          body: dto,
        },
      },
      async (tx) => {
        const row = await this.lockAndLoad(tx, caseId, officer);
        await work(tx, row, new Date());
        return { status: 200, body: { ownerProfileId: row.id } };
      },
    );
    return { replayed: result.replayed, body: await this.summaryOf(caseId, officer) };
  }

  /** A matching TIN check by this officer for the current submission. */
  private async hasMatchingTinCheck(db: Tx, row: CaseRow, officer: Principal): Promise<boolean> {
    if (row.ownerType !== 'ORGANIZATION' || row.submittedAt === null) return false;
    const check = await db.auditLog.findFirst({
      where: {
        action: TIN_CHECK_ACTION,
        actorUserId: officer.userId,
        targetId: row.id,
        occurredAt: { gte: row.submittedAt },
        changes: { path: ['matches'], equals: true },
      },
      select: { seq: true },
    });
    return check !== null;
  }

  /** Each approving officer must have confirmed the full TIN themselves (independent review). */
  private async assertTinChecked(tx: Tx, row: CaseRow, officer: Principal): Promise<void> {
    if (!(await this.hasMatchingTinCheck(tx, row, officer))) {
      throw new DomainError(ErrorCode.TIN_CHECK_REQUIRED, HttpStatus.CONFLICT);
    }
  }

  private async summaryOf(caseId: string, officer: Principal): Promise<OwnerCaseSummaryResponse> {
    return summary(await this.load(this.prisma, caseId), officer.userId, new Date());
  }

  private assertHoldsClaim(row: CaseRow, officer: Principal, now: Date): void {
    if (row.verificationStatus !== 'PENDING') throw invalidTransition();
    if (activeClaim(row, now) !== officer.userId) {
      throw new DomainError(ErrorCode.REVIEW_CLAIM_REQUIRED, HttpStatus.CONFLICT);
    }
  }

  private assertApprovalAllowed(action: ApprovalAction, row: CaseRow, officer: Principal): void {
    switch (approvalRefusal(action, row, officer.userId)) {
      case null:
        return;
      case 'SAME_OFFICER':
        throw secondApproverRequired();
      case 'FIRST_APPROVAL_REQUIRED':
        throw new DomainError(ErrorCode.FIRST_APPROVAL_REQUIRED, HttpStatus.CONFLICT);
      default:
        throw invalidTransition();
    }
  }

  /** Account, identity and documents at decision time, inside the transaction. */
  private assertApprovable(row: CaseRow): void {
    const blockers = approvalBlockers({
      accountStatus: row.user.status,
      identityStatus: row.user.identityStatus,
      ownerType: row.ownerType,
      documents: documentFacts(row),
    });
    if (blockers.length > 0) {
      throw new DomainError(
        ErrorCode.OWNER_SUBMISSION_INCOMPLETE,
        HttpStatus.UNPROCESSABLE_ENTITY,
        blockers.map((code) => ({ field: 'case', code })),
      );
    }
  }

  private async verify(tx: Tx, row: CaseRow, officer: Principal, now: Date): Promise<void> {
    await tx.ownerProfile.update({
      where: { id: row.id },
      data: {
        verificationStatus: 'VERIFIED',
        claimedById: null,
        claimExpiresAt: null,
        verifiedById: officer.userId,
        verifiedAt: now,
        decidedById: officer.userId,
        decidedAt: now,
        decisionReasonCode: null,
        decisionNote: null,
        version: { increment: 1 },
      },
    });
  }

  private async history(
    tx: Tx,
    row: CaseRow,
    officer: Principal,
    action: string,
    to: OwnerVerificationStatus,
    reasonCode: ReviewReasonCode | null = null,
    note: string | null = null,
  ): Promise<void> {
    await tx.ownerReviewEvent.create({
      data: {
        ownerProfileId: row.id,
        actorUserId: officer.userId,
        action,
        fromStatus: row.verificationStatus,
        toStatus: to,
        reasonCode,
        note,
      },
    });
  }

  private async record(
    tx: Tx,
    officer: Principal,
    row: CaseRow,
    action: string,
    meta: RequestMeta,
    changes: Record<string, string | boolean> = {},
    reason?: string,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'STAFF', userId: officer.userId },
      action,
      target: { type: 'owner_profile', id: row.id },
      changes: { from: row.verificationStatus, ownerType: row.ownerType, ...changes },
      ...(reason === undefined ? {} : { reason }),
      meta,
    });
  }

  /** Outbox event and the owner's in-app notification (identifiers and codes only). */
  private async publish(
    tx: Tx,
    row: CaseRow,
    eventType: string,
    meta: RequestMeta,
    key: 'approved' | 'rejected' | 'suspended' | 'reinstated',
    params: Record<string, string> = {},
  ): Promise<void> {
    await this.outbox.enqueue(tx, {
      aggregateType: 'owner_profile',
      aggregateId: row.id,
      eventType,
      payload: { userId: row.userId, ownerProfileId: row.id, ...params },
      requestId: meta.requestId,
    });
    await this.notifications.notify(tx, {
      recipientUserId: row.userId,
      eventType,
      dedupeKey: `${eventType}:${row.id}:${row.version + 1}`,
      titleKey: `notif.owner.${key}.title`,
      bodyKey: `notif.owner.${key}.body`,
      params,
      deepLink: '/owner',
    });
  }
}

const CHECKS = {
  identityConfirmed: true,
  documentsLegible: true,
  organizationDetailsMatch: true,
  representativeAuthorized: true,
} as const;
