import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/principal.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { FieldEncryption } from '../../common/crypto/field-encryption.js';
import { DomainError, ErrorCode } from '../../common/http/problem-details.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { NotificationService } from '../../common/notifications/notification.service.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import type { PresignedRequest } from '../../infrastructure/storage/object-storage.js';
import type { Prisma, ReviewReasonCode, ReviewStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { DocumentsService, toDocumentResponse } from '../documents/documents.service.js';
import type { DocumentResponse } from '../documents/dto/document.dto.js';
import { claimsAad } from '../identity/identity-policy.js';
import { DriverEligibilityService } from './driver-eligibility.service.js';
import { addisToday, isoDate, REVIEW_CLAIM_TTL_MS } from './driver-rules.js';
import { licenseNumberAad } from './drivers.service.js';
import type {
  ApproveDto,
  CaseCountsResponse,
  CaseDetailResponse,
  CaseListResponse,
  CaseSummaryResponse,
  RejectDto,
  ReviewQueueQuery,
  SuspendDto,
} from './dto/driver.dto.js';

type Tx = Prisma.TransactionClient;

const CASE_INCLUDE = {
  driverProfile: {
    select: {
      id: true,
      userId: true,
      yearsLicensed: true,
      homeSubCity: true,
      eligibilityStatus: true,
      suspendedAt: true,
      user: { select: { displayName: true, phoneE164: true, status: true, identityStatus: true } },
    },
  },
  documents: { include: { document: true } },
} satisfies Prisma.DriverLicenseInclude;
type CaseRow = Prisma.DriverLicenseGetPayload<{ include: typeof CASE_INCLUDE }>;

function notFound(): DomainError {
  return new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
}
function invalidTransition(): DomainError {
  return new DomainError(ErrorCode.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT);
}

/** A claim is active while it has not expired. */
function activeClaim(
  row: { claimedById: string | null; claimExpiresAt: Date | null },
  now: Date,
): string | null {
  return row.claimedById !== null && row.claimExpiresAt !== null && row.claimExpiresAt > now
    ? row.claimedById
    : null;
}

/** Plain object (not a class instance) for spreading into the detail response. */
function summaryFields(row: CaseRow, officerId: string): Omit<CaseSummaryResponse, never> {
  return summary(row, officerId, new Date());
}

function summary(row: CaseRow, officerId: string, now: Date): CaseSummaryResponse {
  const claimer = activeClaim(row, now);
  return {
    id: row.id,
    reviewStatus: row.reviewStatus,
    driverName: row.driverProfile.user.displayName,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    claimedById: claimer,
    claimedByMe: claimer === officerId,
    claimExpiresAt: claimer === null ? null : (row.claimExpiresAt?.toISOString() ?? null),
    expiresOn: isoDate(row.expiresOn),
    version: row.version,
  };
}

/**
 * Verification-officer review of driver licence cases (drivers.review). The database also
 * refuses claims and decisions by anyone but an active VERIFICATION_OFFICER other than the
 * driver (trigger), so a bug here cannot let a driver approve themselves.
 */
@Injectable()
export class DriverReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly eligibility: DriverEligibilityService,
    private readonly encryption: FieldEncryption,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationService,
  ) {}

  async list(officer: Principal, query: ReviewQueueQuery): Promise<CaseListResponse> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const q = query.q;
    const where: Prisma.DriverLicenseWhereInput = {
      // Drafts are the driver's private work in progress.
      reviewStatus: query.status ?? { not: 'DRAFT' },
      ...(q === undefined || q === ''
        ? {}
        : {
            driverProfile: {
              user: {
                OR: [
                  { displayName: { contains: q, mode: 'insensitive' } },
                  { phoneE164: q.replace(/\s/g, '') },
                ],
              },
            },
          }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.driverLicense.findMany({
        where,
        include: CASE_INCLUDE,
        // Oldest submissions first (FIFO queue).
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.driverLicense.count({ where }),
    ]);
    const now = new Date();
    return { items: rows.map((row) => summary(row, officer.userId, now)), total, page, limit };
  }

  async counts(): Promise<CaseCountsResponse> {
    const groups = await this.prisma.driverLicense.groupBy({
      by: ['reviewStatus'],
      _count: { _all: true },
      where: { reviewStatus: { not: 'DRAFT' } },
    });
    const count = (status: ReviewStatus): number =>
      groups.find((g) => g.reviewStatus === status)?._count._all ?? 0;
    return {
      SUBMITTED: count('SUBMITTED'),
      UNDER_REVIEW: count('UNDER_REVIEW'),
      APPROVED: count('APPROVED'),
      REJECTED: count('REJECTED'),
      EXPIRED: count('EXPIRED'),
      SUSPENDED: count('SUSPENDED'),
    };
  }

  /** Full case for the officer, including the licence number and verified name (audited). */
  async detail(officer: Principal, caseId: string, meta: RequestMeta): Promise<CaseDetailResponse> {
    const row = await this.prisma.driverLicense.findUnique({
      where: { id: caseId },
      include: CASE_INCLUDE,
    });
    if (row === null || row.reviewStatus === 'DRAFT') throw notFound();
    const [history, identity] = await Promise.all([
      this.prisma.driverReviewEvent.findMany({
        where: { driverLicenseId: row.id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.identityVerification.findFirst({
        where: { userId: row.driverProfile.userId, status: 'VERIFIED' },
        select: { id: true, verifiedClaimsEnc: true },
      }),
    ]);
    await this.audit.record(this.prisma, {
      actor: { type: 'STAFF', userId: officer.userId },
      action: 'driver.case_viewed',
      target: { type: 'driver_license', id: row.id },
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
    const document = (purpose: string): DocumentResponse | null => {
      const link = row.documents.find((d) => d.purpose === purpose);
      return link === undefined ? null : toDocumentResponse(link.document);
    };
    return {
      ...summaryFields(row, officer.userId),
      driverUserId: row.driverProfile.userId,
      driverPhone: row.driverProfile.user.phoneE164,
      licenseNumber: this.encryption
        .decrypt(Buffer.from(row.licenseNumberEnc), licenseNumberAad(row.id))
        .toString('utf8'),
      categories: [...row.categories],
      issuedOn: isoDate(row.issuedOn),
      issuingAuthority: row.issuingAuthority,
      identityStatus: row.driverProfile.user.identityStatus,
      identityVerifiedName: verifiedName,
      yearsLicensed: row.driverProfile.yearsLicensed,
      homeSubCity: row.driverProfile.homeSubCity,
      eligibilityStatus: row.driverProfile.eligibilityStatus,
      decisionReasonCode: row.decisionReasonCode,
      decisionNote: row.decisionNote,
      frontDocument: document('DRIVER_LICENSE_FRONT'),
      backDocument: document('DRIVER_LICENSE_BACK'),
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
   * SUBMITTED -> UNDER_REVIEW, or takes over a claim that expired. One statement, so two
   * officers can never both hold the case.
   */
  async claim(officer: Principal, caseId: string, meta: RequestMeta): Promise<CaseSummaryResponse> {
    return this.transition(caseId, officer, async (tx, row, now) => {
      if (row.driverProfile.userId === officer.userId) throw notFound();
      const holder = activeClaim(row, now);
      if (holder === officer.userId) return { row, changed: false };
      if (holder !== null)
        throw new DomainError(ErrorCode.REVIEW_CLAIMED_BY_OTHER, HttpStatus.CONFLICT);
      const claimed = await tx.driverLicense.updateMany({
        where: {
          id: row.id,
          OR: [
            { reviewStatus: 'SUBMITTED' },
            { reviewStatus: 'UNDER_REVIEW', claimExpiresAt: { lte: now } },
          ],
        },
        data: {
          reviewStatus: 'UNDER_REVIEW',
          claimedById: officer.userId,
          claimExpiresAt: new Date(now.getTime() + REVIEW_CLAIM_TTL_MS),
          version: { increment: 1 },
        },
      });
      if (claimed.count !== 1) throw invalidTransition();
      await tx.document.updateMany({
        where: { id: { in: row.documents.map((d) => d.documentId) } },
        data: { reviewStatus: 'UNDER_REVIEW' },
      });
      await this.history(
        tx,
        row,
        officer,
        row.reviewStatus === 'UNDER_REVIEW' ? 'claim_taken_over' : 'claimed',
        'UNDER_REVIEW',
      );
      await this.record(tx, officer, row, 'driver.review_claimed', meta, {
        takeover: row.reviewStatus === 'UNDER_REVIEW',
      });
      return { row, changed: true };
    });
  }

  async release(
    officer: Principal,
    caseId: string,
    meta: RequestMeta,
  ): Promise<CaseSummaryResponse> {
    return this.transition(caseId, officer, async (tx, row) => {
      if (row.reviewStatus !== 'UNDER_REVIEW' || row.claimedById !== officer.userId) {
        throw new DomainError(ErrorCode.REVIEW_CLAIM_REQUIRED, HttpStatus.CONFLICT);
      }
      await tx.driverLicense.update({
        where: { id: row.id },
        data: {
          reviewStatus: 'SUBMITTED',
          claimedById: null,
          claimExpiresAt: null,
          version: { increment: 1 },
        },
      });
      await tx.document.updateMany({
        where: { id: { in: row.documents.map((d) => d.documentId) } },
        data: { reviewStatus: 'SUBMITTED' },
      });
      await this.history(tx, row, officer, 'released', 'SUBMITTED');
      await this.record(tx, officer, row, 'driver.review_released', meta);
      return { row, changed: true };
    });
  }

  async approve(
    officer: Principal,
    caseId: string,
    dto: ApproveDto,
    meta: RequestMeta,
  ): Promise<CaseSummaryResponse> {
    return this.transition(caseId, officer, async (tx, row, now) => {
      this.assertHoldsClaim(row, officer, now);
      // Re-check the facts at decision time, not at submission time.
      const blockers = [
        ...(row.driverProfile.user.identityStatus === 'VERIFIED' ? [] : ['IDENTITY_NOT_VERIFIED']),
        ...(row.driverProfile.user.status === 'ACTIVE' ? [] : ['ACCOUNT_NOT_ACTIVE']),
        ...(isoDate(row.expiresOn) > addisToday(now) ? [] : ['LICENSE_EXPIRED']),
        ...(['DRIVER_LICENSE_FRONT', 'DRIVER_LICENSE_BACK'].every((purpose) =>
          row.documents.some(
            (d) => d.purpose === purpose && d.document.uploadStatus === 'AVAILABLE',
          ),
        )
          ? []
          : ['DOCUMENTS_MISSING']),
      ];
      if (blockers.length > 0) {
        throw new DomainError(
          ErrorCode.DRIVER_SUBMISSION_INCOMPLETE,
          HttpStatus.UNPROCESSABLE_ENTITY,
          blockers.map((code) => ({ field: 'case', code })),
        );
      }
      await this.decide(tx, row, officer, 'APPROVED', null, dto.note ?? null, now);
      await this.history(tx, row, officer, 'approved', 'APPROVED', null, dto.note ?? null);
      await this.record(tx, officer, row, 'driver.approved', meta, {
        identityMatches: true,
        documentsLegible: true,
        detailsMatch: true,
      });
      await this.publish(tx, row, 'driver.approved', meta, 'approved');
      return { row, changed: true };
    });
  }

  async reject(
    officer: Principal,
    caseId: string,
    dto: RejectDto,
    meta: RequestMeta,
  ): Promise<CaseSummaryResponse> {
    return this.transition(caseId, officer, async (tx, row, now) => {
      this.assertHoldsClaim(row, officer, now);
      await this.decide(tx, row, officer, 'REJECTED', dto.reasonCode, dto.note ?? null, now);
      await this.history(
        tx,
        row,
        officer,
        'rejected',
        'REJECTED',
        dto.reasonCode,
        dto.note ?? null,
      );
      await this.record(tx, officer, row, 'driver.rejected', meta, { reasonCode: dto.reasonCode });
      await this.outbox.enqueue(tx, {
        aggregateType: 'document',
        aggregateId: row.id,
        eventType: 'document.rejected',
        payload: { driverLicenseId: row.id, documentIds: row.documents.map((d) => d.documentId) },
        requestId: meta.requestId,
      });
      await this.publish(tx, row, 'driver.rejected', meta, 'rejected', {
        reasonCode: dto.reasonCode,
      });
      return { row, changed: true };
    });
  }

  /** APPROVED -> SUSPENDED; the driver profile is suspended (ineligible) too. */
  async suspend(
    officer: Principal,
    caseId: string,
    dto: SuspendDto,
    meta: RequestMeta,
  ): Promise<CaseSummaryResponse> {
    return this.transition(caseId, officer, async (tx, row, now) => {
      if (row.driverProfile.userId === officer.userId) throw notFound();
      if (row.reviewStatus !== 'APPROVED') throw invalidTransition();
      await this.decide(tx, row, officer, 'SUSPENDED', dto.reasonCode, dto.note, now);
      await tx.driverProfile.update({
        where: { id: row.driverProfile.id },
        data: {
          suspendedAt: now,
          suspendedReason: dto.reasonCode,
          eligibilityStatus: 'SUSPENDED',
          version: { increment: 1 },
        },
      });
      await this.history(tx, row, officer, 'suspended', 'SUSPENDED', dto.reasonCode, dto.note);
      await this.record(
        tx,
        officer,
        row,
        'driver.suspended',
        meta,
        { reasonCode: dto.reasonCode },
        dto.note,
      );
      await this.publish(tx, row, 'driver.suspended', meta, 'suspended');
      return { row, changed: true };
    });
  }

  /** SUSPENDED -> APPROVED (02 §3.3). Eligibility is recomputed, not assumed. */
  async reinstate(
    officer: Principal,
    caseId: string,
    note: string,
    meta: RequestMeta,
  ): Promise<CaseSummaryResponse> {
    return this.transition(caseId, officer, async (tx, row, now) => {
      if (row.driverProfile.userId === officer.userId) throw notFound();
      if (row.reviewStatus !== 'SUSPENDED') throw invalidTransition();
      await this.decide(tx, row, officer, 'APPROVED', null, null, now, { clearReason: true });
      await tx.driverProfile.update({
        where: { id: row.driverProfile.id },
        data: {
          suspendedAt: null,
          suspendedReason: null,
          eligibilityStatus: 'INELIGIBLE',
          version: { increment: 1 },
        },
      });
      await this.history(tx, row, officer, 'reinstated', 'APPROVED', null, note);
      await this.record(tx, officer, row, 'driver.reinstated', meta, {}, note);
      await this.publish(tx, row, 'driver.reinstated', meta, 'reinstated');
      return { row, changed: true };
    });
  }

  /**
   * 60-second URL to a case document. Audited with the reason. While a case is under
   * review, only the officer holding the claim may open its documents.
   */
  async documentUrl(
    officer: Principal,
    caseId: string,
    documentId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<PresignedRequest> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.driverLicense.findUnique({
        where: { id: caseId },
        include: CASE_INCLUDE,
      });
      if (
        row === null ||
        row.reviewStatus === 'DRAFT' ||
        row.driverProfile.userId === officer.userId
      ) {
        throw notFound();
      }
      if (!row.documents.some((d) => d.documentId === documentId)) throw notFound();
      const now = new Date();
      if (
        row.reviewStatus === 'SUBMITTED' ||
        (row.reviewStatus === 'UNDER_REVIEW' && activeClaim(row, now) !== officer.userId)
      ) {
        throw new DomainError(ErrorCode.REVIEW_CLAIM_REQUIRED, HttpStatus.CONFLICT);
      }
      return this.documents.staffDownloadUrl(
        tx,
        documentId,
        { userId: officer.userId, reason, caseType: 'driver_license', caseId: row.id },
        meta,
      );
    });
  }

  // --- helpers ---------------------------------------------------------------

  private assertHoldsClaim(row: CaseRow, officer: Principal, now: Date): void {
    if (row.driverProfile.userId === officer.userId) throw notFound();
    if (row.reviewStatus !== 'UNDER_REVIEW') throw invalidTransition();
    if (activeClaim(row, now) !== officer.userId) {
      throw new DomainError(ErrorCode.REVIEW_CLAIM_REQUIRED, HttpStatus.CONFLICT);
    }
  }

  /** Locks profile then licence (the same order as the driver side), runs the change, refreshes eligibility. */
  private async transition(
    caseId: string,
    officer: Principal,
    work: (tx: Tx, row: CaseRow, now: Date) => Promise<{ row: CaseRow; changed: boolean }>,
  ): Promise<CaseSummaryResponse> {
    const target = await this.prisma.driverLicense.findUnique({
      where: { id: caseId },
      select: { driverProfileId: true, reviewStatus: true },
    });
    if (target === null || target.reviewStatus === 'DRAFT') throw notFound();
    const id = await this.prisma.$transaction(async (tx) => {
      await this.eligibility.lockProfile(tx, target.driverProfileId);
      await tx.$queryRaw`SELECT 1 AS locked FROM "driver_licenses" WHERE "id" = ${caseId}::uuid FOR UPDATE`;
      const row = await tx.driverLicense.findUniqueOrThrow({
        where: { id: caseId },
        include: CASE_INCLUDE,
      });
      const now = new Date();
      const { changed } = await work(tx, row, now);
      if (changed) {
        await this.eligibility.refresh(
          tx,
          target.driverProfileId,
          { type: 'STAFF', userId: officer.userId },
          undefined,
          now,
          row.driverProfile.eligibilityStatus,
        );
      }
      return row.id;
    });
    const fresh = await this.prisma.driverLicense.findUniqueOrThrow({
      where: { id },
      include: CASE_INCLUDE,
    });
    return summary(fresh, officer.userId, new Date());
  }

  private async decide(
    tx: Tx,
    row: CaseRow,
    officer: Principal,
    to: 'APPROVED' | 'REJECTED' | 'SUSPENDED',
    reasonCode: ReviewReasonCode | null,
    note: string | null,
    now: Date,
    options: { clearReason?: boolean } = {},
  ): Promise<void> {
    await tx.driverLicense.update({
      where: { id: row.id },
      data: {
        reviewStatus: to,
        claimedById: null,
        claimExpiresAt: null,
        decidedById: officer.userId,
        decidedAt: now,
        ...(options.clearReason === true
          ? { decisionReasonCode: null, decisionNote: null }
          : { decisionReasonCode: reasonCode, decisionNote: note }),
        version: { increment: 1 },
      },
    });
    // The case decision is also the decision on its documents.
    await tx.document.updateMany({
      where: { id: { in: row.documents.map((d) => d.documentId) } },
      data: {
        reviewStatus: to === 'SUSPENDED' ? 'APPROVED' : to,
        reviewedById: officer.userId,
        reviewedAt: now,
      },
    });
  }

  private async history(
    tx: Tx,
    row: CaseRow,
    officer: Principal,
    action: string,
    to: ReviewStatus,
    reasonCode: ReviewReasonCode | null = null,
    note: string | null = null,
  ): Promise<void> {
    await tx.driverReviewEvent.create({
      data: {
        driverLicenseId: row.id,
        actorUserId: officer.userId,
        action,
        fromStatus: row.reviewStatus,
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
      target: { type: 'driver_license', id: row.id },
      changes: { from: row.reviewStatus, ...changes },
      ...(reason === undefined ? {} : { reason }),
      meta,
    });
  }

  /** Outbox event and the driver's in-app notification for a decision. */
  private async publish(
    tx: Tx,
    row: CaseRow,
    eventType: string,
    meta: RequestMeta,
    key: 'approved' | 'rejected' | 'suspended' | 'reinstated',
    params: Record<string, string> = {},
  ): Promise<void> {
    await this.outbox.enqueue(tx, {
      aggregateType: 'driver_license',
      aggregateId: row.id,
      eventType,
      payload: { userId: row.driverProfile.userId, driverLicenseId: row.id, ...params },
      requestId: meta.requestId,
    });
    await this.notifications.notify(tx, {
      recipientUserId: row.driverProfile.userId,
      eventType,
      dedupeKey: `${eventType}:${row.id}:${row.version + 1}`,
      titleKey: `notif.driver.${key}.title`,
      bodyKey: `notif.driver.${key}.body`,
      params,
      deepLink: '/driver',
    });
  }
}
