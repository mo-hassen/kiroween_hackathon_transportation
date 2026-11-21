import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/principal.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { FieldEncryption } from '../../common/crypto/field-encryption.js';
import { DomainError, ErrorCode } from '../../common/http/problem-details.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { IdempotencyService } from '../../common/idempotency/idempotency.service.js';
import { NotificationService } from '../../common/notifications/notification.service.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import type { Prisma, ReviewReasonCode, VehicleStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { PresignedRequest } from '../../infrastructure/storage/object-storage.js';
import { DocumentsService } from '../documents/documents.service.js';
import { REVIEW_CLAIM_TTL_MS } from '../drivers/driver-rules.js';
import type {
  ApproveVehicleDto,
  RejectVehicleDto,
  SuspendVehicleDto,
  VehicleCaseCountsResponse,
  VehicleCaseDetailResponse,
  VehicleCaseListResponse,
  VehicleCaseSummaryResponse,
  VehicleQueueQuery,
} from './dto/vehicle.dto.js';
import {
  addisToday,
  approvalBlockers,
  maskIdentifier,
  REVIEWABLE_STATUSES,
  vehicleEligibility,
} from './vehicle-rules.js';
import { VehicleStatusService } from './vehicle-status.service.js';
import {
  engineNumberAad,
  evidenceFacts,
  evidenceItems,
  ownerFacts,
  VEHICLE_INCLUDE,
  type VehicleRow,
  vinAad,
} from './vehicles.service.js';

type Tx = Prisma.TransactionClient;
type Decision = 'approve' | 'reject' | 'suspend' | 'reinstate';

function notFound(): DomainError {
  return new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
}
function invalidTransition(): DomainError {
  return new DomainError(ErrorCode.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT);
}
function claimedByOther(): DomainError {
  return new DomainError(ErrorCode.REVIEW_CLAIMED_BY_OTHER, HttpStatus.CONFLICT);
}

/** The officer holding an unexpired claim, if any. */
function activeClaim(row: VehicleRow, now: Date): string | null {
  return row.status === 'UNDER_REVIEW' &&
    row.claimedById !== null &&
    row.claimExpiresAt !== null &&
    row.claimExpiresAt > now
    ? row.claimedById
    : null;
}

function summary(row: VehicleRow, officerId: string, now: Date): VehicleCaseSummaryResponse {
  const claimer = activeClaim(row, now);
  const owner = row.ownerProfile;
  return {
    id: row.id,
    vehicleType: row.vehicleType,
    make: row.make,
    model: row.model,
    year: row.year,
    plate: { region: row.plateRegion, code: row.plateCode, number: row.plateNumber },
    status: row.status,
    ownerName: owner.organizationName ?? owner.user.displayName,
    ownerType: owner.ownerType,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    claimedById: claimer,
    claimedByMe: claimer === officerId,
    claimExpiresAt: claimer === null ? null : (row.claimExpiresAt?.toISOString() ?? null),
    version: row.version,
  };
}

/**
 * Verification-officer review of vehicles (vehicles.verify). One approval is enough (the
 * architecture asks for four-eyes only for fraud); a suspension for suspected fraud can only
 * be lifted by an officer other than the one who imposed it. The database enforces officers
 * only, never the owner, and the fraud rule (vehicles_guard).
 */
@Injectable()
export class VehicleReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly status: VehicleStatusService,
    private readonly idempotency: IdempotencyService,
    private readonly encryption: FieldEncryption,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationService,
  ) {}

  async list(officer: Principal, query: VehicleQueueQuery): Promise<VehicleCaseListResponse> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const q = query.q;
    const where: Prisma.VehicleWhereInput = {
      // Drafts and archived vehicles are the owner's private business.
      status:
        query.status === undefined
          ? { in: [...REVIEWABLE_STATUSES] }
          : this.reviewable(query.status),
      ...(query.vehicleType === undefined ? {} : { vehicleType: query.vehicleType }),
      ...(q === undefined || q === ''
        ? {}
        : {
            OR: [
              { plateNumber: { contains: q, mode: 'insensitive' } },
              { plateCode: { contains: q, mode: 'insensitive' } },
              { make: { contains: q, mode: 'insensitive' } },
              { model: { contains: q, mode: 'insensitive' } },
              { ownerProfile: { organizationName: { contains: q, mode: 'insensitive' } } },
              { ownerProfile: { user: { displayName: { contains: q, mode: 'insensitive' } } } },
            ],
          }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.vehicle.findMany({
        where,
        include: VEHICLE_INCLUDE,
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.vehicle.count({ where }),
    ]);
    const now = new Date();
    return { items: rows.map((row) => summary(row, officer.userId, now)), total, page, limit };
  }

  private reviewable(status: VehicleStatus): Prisma.VehicleWhereInput['status'] {
    return REVIEWABLE_STATUSES.includes(status) ? status : { in: [] };
  }

  async counts(): Promise<VehicleCaseCountsResponse> {
    const count = (status: VehicleStatus): Promise<number> =>
      this.prisma.vehicle.count({ where: { status } });
    const [submitted, underReview, approved, rejected, suspended, expired] = await Promise.all([
      count('SUBMITTED'),
      count('UNDER_REVIEW'),
      count('APPROVED'),
      count('REJECTED'),
      count('SUSPENDED'),
      count('EXPIRED'),
    ]);
    return {
      SUBMITTED: submitted,
      UNDER_REVIEW: underReview,
      APPROVED: approved,
      REJECTED: rejected,
      SUSPENDED: suspended,
      EXPIRED: expired,
    };
  }

  /**
   * Full case (audited). The VIN and engine number are shown in full only to the officer
   * holding the claim, and that disclosure is audited separately; others see them masked.
   */
  async detail(
    officer: Principal,
    caseId: string,
    meta: RequestMeta,
  ): Promise<VehicleCaseDetailResponse> {
    const row = await this.load(this.prisma, caseId, officer);
    const history = await this.prisma.vehicleReviewEvent.findMany({
      where: { vehicleId: row.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const now = new Date();
    const holdsClaim = activeClaim(row, now) === officer.userId;
    const vin =
      holdsClaim && row.vinEnc !== null
        ? this.encryption.decrypt(Buffer.from(row.vinEnc), vinAad(row.id)).toString('utf8')
        : null;
    const engineNumber =
      holdsClaim && row.engineNumberEnc !== null
        ? this.encryption
            .decrypt(Buffer.from(row.engineNumberEnc), engineNumberAad(row.id))
            .toString('utf8')
        : null;
    await this.audit.record(this.prisma, {
      actor: { type: 'STAFF', userId: officer.userId },
      action: 'vehicle.case_viewed',
      target: { type: 'vehicle', id: row.id },
      meta,
    });
    if (vin !== null || engineNumber !== null) {
      await this.audit.record(this.prisma, {
        actor: { type: 'STAFF', userId: officer.userId },
        action: 'vehicle.identifiers_viewed',
        target: { type: 'vehicle', id: row.id },
        // Which fields were shown, never their values.
        changes: { vin: vin !== null, engineNumber: engineNumber !== null },
        meta,
      });
    }
    const facts = evidenceFacts(row);
    const owner = ownerFacts(row);
    const today = addisToday(now);
    const base: Omit<VehicleCaseSummaryResponse, never> = summary(row, officer.userId, now);
    return {
      ...base,
      ownerUserId: row.ownerProfile.userId,
      ownerPhone: row.ownerProfile.user.phoneE164,
      ownerVerificationStatus: row.ownerProfile.verificationStatus,
      accountStatus: row.ownerProfile.user.status,
      identityStatus: row.ownerProfile.user.identityStatus,
      color: row.color,
      seats: row.seats,
      transmission: row.transmission,
      fuelType: row.fuelType,
      vin,
      vinMasked: row.vinLast4 === null ? null : maskIdentifier(row.vinLast4),
      engineNumber,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decidedById: row.decidedById,
      decisionReasonCode: row.decisionReasonCode,
      decisionNote: row.decisionNote,
      evidence: evidenceItems(row),
      approvalBlockers: approvalBlockers(owner, facts, today),
      eligibility: vehicleEligibility(row.status, owner, facts, today),
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
   * SUBMITTED -> UNDER_REVIEW, or the takeover of an expired claim. One conditional update, so
   * two officers can never hold the same vehicle.
   */
  async claim(
    officer: Principal,
    caseId: string,
    meta: RequestMeta,
  ): Promise<VehicleCaseSummaryResponse> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockAndLoad(tx, caseId, officer);
      const now = new Date();
      if (row.status !== 'SUBMITTED' && row.status !== 'UNDER_REVIEW') throw invalidTransition();
      const holder = activeClaim(row, now);
      if (holder === officer.userId) return;
      if (holder !== null) throw claimedByOther();
      const claimed = await tx.vehicle.updateMany({
        where: {
          id: row.id,
          OR: [
            { status: 'SUBMITTED' },
            {
              status: 'UNDER_REVIEW',
              OR: [{ claimedById: null }, { claimExpiresAt: { lte: now } }],
            },
          ],
        },
        data: {
          status: 'UNDER_REVIEW',
          claimedById: officer.userId,
          claimExpiresAt: new Date(now.getTime() + REVIEW_CLAIM_TTL_MS),
          version: { increment: 1 },
        },
      });
      if (claimed.count !== 1) throw claimedByOther();
      const takeover = row.status === 'UNDER_REVIEW';
      await this.history(
        tx,
        row,
        officer,
        takeover ? 'claim_taken_over' : 'claimed',
        'UNDER_REVIEW',
      );
      await this.record(tx, officer, row, 'vehicle.review_claimed', meta, { takeover });
    });
    return this.summaryOf(caseId, officer);
  }

  /** UNDER_REVIEW -> SUBMITTED: the claim holder puts the vehicle back in the queue. */
  async release(
    officer: Principal,
    caseId: string,
    meta: RequestMeta,
  ): Promise<VehicleCaseSummaryResponse> {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lockAndLoad(tx, caseId, officer);
      this.assertHoldsClaim(row, officer, new Date());
      await tx.vehicle.update({
        where: { id: row.id },
        data: {
          status: 'SUBMITTED',
          claimedById: null,
          claimExpiresAt: null,
          version: { increment: 1 },
        },
      });
      await this.history(tx, row, officer, 'released', 'SUBMITTED');
      await this.record(tx, officer, row, 'vehicle.review_released', meta);
    });
    return this.summaryOf(caseId, officer);
  }

  async approve(
    officer: Principal,
    caseId: string,
    dto: ApproveVehicleDto,
    key: string,
    meta: RequestMeta,
  ): Promise<{ replayed: boolean; body: VehicleCaseSummaryResponse }> {
    return this.decide('approve', officer, caseId, dto, key, async (tx, row, now) => {
      this.assertHoldsClaim(row, officer, now);
      this.assertApprovable(row, now);
      await tx.vehicle.update({
        where: { id: row.id },
        data: {
          status: 'APPROVED',
          claimedById: null,
          claimExpiresAt: null,
          decidedById: officer.userId,
          decidedAt: now,
          decisionReasonCode: null,
          decisionNote: null,
          version: { increment: 1 },
        },
      });
      await tx.document.updateMany({
        where: { id: { in: row.evidence.map((e) => e.documentId) } },
        data: { reviewStatus: 'APPROVED', reviewedById: officer.userId, reviewedAt: now },
      });
      await this.history(tx, row, officer, 'approved', 'APPROVED', null, dto.note ?? null);
      await this.record(tx, officer, row, 'vehicle.approved', meta, {
        detailsMatch: true,
        ownerMatchesRegistration: true,
        documentsLegible: true,
        photosMatch: true,
      });
      await this.publish(tx, row, 'vehicle.approved', meta, 'approved');
    });
  }

  async reject(
    officer: Principal,
    caseId: string,
    dto: RejectVehicleDto,
    key: string,
    meta: RequestMeta,
  ): Promise<{ replayed: boolean; body: VehicleCaseSummaryResponse }> {
    return this.decide('reject', officer, caseId, dto, key, async (tx, row, now) => {
      this.assertHoldsClaim(row, officer, now);
      await tx.vehicle.update({
        where: { id: row.id },
        data: {
          status: 'REJECTED',
          claimedById: null,
          claimExpiresAt: null,
          decidedById: officer.userId,
          decidedAt: now,
          decisionReasonCode: dto.reasonCode,
          decisionNote: dto.note ?? null,
          version: { increment: 1 },
        },
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
      await this.record(tx, officer, row, 'vehicle.rejected', meta, { reasonCode: dto.reasonCode });
      await this.publish(tx, row, 'vehicle.rejected', meta, 'rejected', {
        reasonCode: dto.reasonCode,
      });
    });
  }

  /** APPROVED -> SUSPENDED. The internal note is never shown to the owner. */
  async suspend(
    officer: Principal,
    caseId: string,
    dto: SuspendVehicleDto,
    key: string,
    meta: RequestMeta,
  ): Promise<{ replayed: boolean; body: VehicleCaseSummaryResponse }> {
    return this.decide('suspend', officer, caseId, dto, key, async (tx, row, now) => {
      if (row.status !== 'APPROVED') throw invalidTransition();
      await tx.vehicle.update({
        where: { id: row.id },
        data: {
          status: 'SUSPENDED',
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
        'vehicle.suspended',
        meta,
        { reasonCode: dto.reasonCode },
        dto.note,
      );
      await this.publish(tx, row, 'vehicle.suspended', meta, 'suspended', {
        reasonCode: dto.reasonCode,
      });
    });
  }

  /**
   * SUSPENDED -> APPROVED. Re-checks owner, account and evidence. A suspension for suspected
   * fraud can only be lifted by an officer other than the one who imposed it (08 §7).
   */
  async reinstate(
    officer: Principal,
    caseId: string,
    note: string,
    key: string,
    meta: RequestMeta,
  ): Promise<{ replayed: boolean; body: VehicleCaseSummaryResponse }> {
    return this.decide('reinstate', officer, caseId, { note }, key, async (tx, row, now) => {
      if (row.status !== 'SUSPENDED') throw invalidTransition();
      if (row.decisionReasonCode === 'SUSPECTED_FRAUD' && row.decidedById === officer.userId) {
        throw new DomainError(ErrorCode.SECOND_APPROVER_REQUIRED, HttpStatus.CONFLICT);
      }
      this.assertApprovable(row, now);
      await tx.vehicle.update({
        where: { id: row.id },
        data: {
          status: 'APPROVED',
          decidedById: officer.userId,
          decidedAt: now,
          decisionReasonCode: null,
          decisionNote: null,
          version: { increment: 1 },
        },
      });
      await this.history(tx, row, officer, 'reinstated', 'APPROVED', null, note);
      await this.record(tx, officer, row, 'vehicle.reinstated', meta, {}, note);
      await this.publish(tx, row, 'vehicle.reinstated', meta, 'reinstated');
    });
  }

  /**
   * 60-second URL to a case document or photo, audited with the reason. While a case is open
   * (SUBMITTED or UNDER_REVIEW), only the officer holding the claim may open its evidence.
   */
  async documentUrl(
    officer: Principal,
    caseId: string,
    documentId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<PresignedRequest> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.load(tx, caseId, officer);
      const link = row.evidence.find((e) => e.documentId === documentId);
      if (link === undefined) throw notFound();
      if (
        (row.status === 'SUBMITTED' || row.status === 'UNDER_REVIEW') &&
        activeClaim(row, new Date()) !== officer.userId
      ) {
        throw new DomainError(ErrorCode.REVIEW_CLAIM_REQUIRED, HttpStatus.CONFLICT);
      }
      const request = await this.documents.staffDownloadUrl(
        tx,
        documentId,
        { userId: officer.userId, reason, caseType: 'vehicle', caseId: row.id },
        meta,
      );
      await this.audit.record(tx, {
        actor: { type: 'STAFF', userId: officer.userId },
        action: link.slot.startsWith('PHOTO_') ? 'vehicle.photo_viewed' : 'vehicle.document_viewed',
        target: { type: 'vehicle', id: row.id },
        reason,
        changes: { slot: link.slot },
        meta,
      });
      return request;
    });
  }

  // --- helpers ---------------------------------------------------------------

  /** Cases officers may see: anything that was ever submitted and is not archived. */
  private async load(
    db: Tx | PrismaService,
    caseId: string,
    officer: Principal,
  ): Promise<VehicleRow> {
    const row = await db.vehicle.findUnique({ where: { id: caseId }, include: VEHICLE_INCLUDE });
    if (row === null || !REVIEWABLE_STATUSES.includes(row.status)) throw notFound();
    if (row.ownerProfile.userId === officer.userId) throw notFound();
    return row;
  }

  private async lockAndLoad(tx: Tx, caseId: string, officer: Principal): Promise<VehicleRow> {
    const exists = await tx.vehicle.findUnique({ where: { id: caseId }, select: { id: true } });
    if (exists === null) throw notFound();
    await this.status.lock(tx, caseId);
    // Evidence that lapsed meanwhile changes an approved vehicle first.
    await this.status.apply(tx, caseId);
    return this.load(tx, caseId, officer);
  }

  /**
   * Exactly-once decision: the Idempotency-Key replays a retried request; the vehicle lock and
   * the claim check reject concurrent and repeated decisions (409).
   */
  private async decide(
    action: Decision,
    officer: Principal,
    caseId: string,
    dto: object,
    key: string,
    work: (tx: Tx, row: VehicleRow, now: Date) => Promise<void>,
  ): Promise<{ replayed: boolean; body: VehicleCaseSummaryResponse }> {
    const result = await this.idempotency.execute(
      {
        scope: `vehicles.review.${action}`,
        principal: `staff:${officer.userId}`,
        key,
        fingerprint: {
          method: 'POST',
          route: `/admin/vehicle-verifications/${caseId}/${action}`,
          body: dto,
        },
      },
      async (tx) => {
        const row = await this.lockAndLoad(tx, caseId, officer);
        await work(tx, row, new Date());
        return { status: 200, body: { vehicleId: row.id } };
      },
    );
    return { replayed: result.replayed, body: await this.summaryOf(caseId, officer) };
  }

  private async summaryOf(caseId: string, officer: Principal): Promise<VehicleCaseSummaryResponse> {
    return summary(await this.load(this.prisma, caseId, officer), officer.userId, new Date());
  }

  private assertHoldsClaim(row: VehicleRow, officer: Principal, now: Date): void {
    if (row.status !== 'UNDER_REVIEW') throw invalidTransition();
    if (activeClaim(row, now) !== officer.userId) {
      throw new DomainError(ErrorCode.REVIEW_CLAIM_REQUIRED, HttpStatus.CONFLICT);
    }
  }

  /** Owner, account, identity and evidence at decision time, inside the transaction. */
  private assertApprovable(row: VehicleRow, now: Date): void {
    const blockers = approvalBlockers(ownerFacts(row), evidenceFacts(row), addisToday(now));
    if (blockers.length > 0) {
      throw new DomainError(
        ErrorCode.VEHICLE_SUBMISSION_INCOMPLETE,
        HttpStatus.UNPROCESSABLE_ENTITY,
        blockers.map((code) => ({ field: 'case', code })),
      );
    }
  }

  private async history(
    tx: Tx,
    row: VehicleRow,
    officer: Principal,
    action: string,
    to: VehicleStatus,
    reasonCode: ReviewReasonCode | null = null,
    note: string | null = null,
  ): Promise<void> {
    await tx.vehicleReviewEvent.create({
      data: {
        vehicleId: row.id,
        actorUserId: officer.userId,
        action,
        fromStatus: row.status,
        toStatus: to,
        reasonCode,
        note,
      },
    });
  }

  private async record(
    tx: Tx,
    officer: Principal,
    row: VehicleRow,
    action: string,
    meta: RequestMeta,
    changes: Record<string, string | boolean> = {},
    reason?: string,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'STAFF', userId: officer.userId },
      action,
      target: { type: 'vehicle', id: row.id },
      changes: { from: row.status, ...changes },
      ...(reason === undefined ? {} : { reason }),
      meta,
    });
  }

  /** Outbox event and the owner's in-app notification (identifiers and codes only). */
  private async publish(
    tx: Tx,
    row: VehicleRow,
    eventType: string,
    meta: RequestMeta,
    key: 'approved' | 'rejected' | 'suspended' | 'reinstated',
    params: Record<string, string> = {},
  ): Promise<void> {
    const userId = row.ownerProfile.userId;
    await this.outbox.enqueue(tx, {
      aggregateType: 'vehicle',
      aggregateId: row.id,
      eventType,
      payload: { userId, vehicleId: row.id, ...params },
      requestId: meta.requestId,
    });
    await this.notifications.notify(tx, {
      recipientUserId: userId,
      eventType,
      dedupeKey: `${eventType}:${row.id}:${row.version + 1}`,
      titleKey: `notif.vehicle.${key}.title`,
      bodyKey: `notif.vehicle.${key}.body`,
      params,
      deepLink: '/vehicles',
    });
  }
}
