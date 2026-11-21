import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../common/auth/principal.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { FieldEncryption } from '../../common/crypto/field-encryption.js';
import { SecretHasher } from '../../common/crypto/secret-hasher.js';
import { uuidv7 } from '../../common/crypto/uuid.js';
import { DomainError, ErrorCode, validationError } from '../../common/http/problem-details.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { IdempotencyService } from '../../common/idempotency/idempotency.service.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import type { DocumentPurpose, OwnerType, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { assertAttachableToOwner, toDocumentResponse } from '../documents/documents.service.js';
import { parseIfMatch } from '../drivers/drivers.service.js';
import type {
  CreateOwnerProfileDto,
  OwnerDocumentSlot,
  OwnerProfileResponse,
  OwnerStatusResponse,
  UpdateOwnerProfileDto,
} from './dto/owner.dto.js';
import {
  EDITABLE_STATUSES,
  type LinkedDocumentFacts,
  maskTin,
  normalizeOrganizationName,
  normalizeTin,
  ORGANIZATION_DOCUMENTS,
  ownerBlockers,
  submissionProblems,
  TYPE_CHANGE_STATUSES,
} from './owner-rules.js';
import { OwnerStatusService } from './owner-status.service.js';

export const tinAad = (ownerProfileId: string): string =>
  `owner_profiles.tin_enc:${ownerProfileId}`;

export const OWNER_INCLUDE = {
  documents: { include: { document: true } },
  user: { select: { status: true, identityStatus: true } },
} satisfies Prisma.OwnerProfileInclude;
export type OwnerWithDocuments = Prisma.OwnerProfileGetPayload<{ include: typeof OWNER_INCLUDE }>;

function notFound(): DomainError {
  return new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
}
function invalidTransition(): DomainError {
  return new DomainError(ErrorCode.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT);
}
function profileRequired(): DomainError {
  return new DomainError(ErrorCode.OWNER_PROFILE_REQUIRED, HttpStatus.CONFLICT);
}

/** Owner routes are customer-only: staff accounts cannot hold customer profiles (01 §4). */
function assertCustomer(principal: Principal): void {
  if (principal.accountType !== 'CUSTOMER') throw notFound();
}

function isTinConflict(error: unknown): boolean {
  const { code, meta } = (error ?? {}) as { code?: unknown; meta?: unknown };
  return code === 'P2002' && /tin_hmac/.test(JSON.stringify(meta ?? {}));
}

export function documentSlots(profile: OwnerWithDocuments): OwnerDocumentSlot[] {
  return ORGANIZATION_DOCUMENTS.filter(() => profile.ownerType === 'ORGANIZATION').map(
    (purpose) => {
      const link = profile.documents.find((d) => d.purpose === purpose);
      return { purpose, document: link === undefined ? null : toDocumentResponse(link.document) };
    },
  );
}

export function documentFacts(profile: OwnerWithDocuments): LinkedDocumentFacts[] {
  return profile.documents.map((link) => ({
    purpose: link.purpose,
    uploadStatus: link.document.uploadStatus,
    reviewStatus: link.document.reviewStatus,
  }));
}

interface OrganizationDetails {
  readonly name: string;
  readonly tin: string | undefined;
}

/**
 * The account holder's owner profile and verification request (journey J4, FR-4). Decisions
 * are only made by OwnerReviewService (verification officers with owners.review).
 */
@Injectable()
export class OwnersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly status: OwnerStatusService,
    private readonly idempotency: IdempotencyService,
    private readonly encryption: FieldEncryption,
    private readonly hasher: SecretHasher,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private actor(principal: Principal): { type: 'USER'; userId: string } {
    return { type: 'USER' as const, userId: principal.userId };
  }

  private async ownProfileId(principal: Principal): Promise<string> {
    assertCustomer(principal);
    const profile = await this.prisma.ownerProfile.findUnique({
      where: { userId: principal.userId },
      select: { id: true },
    });
    if (profile === null) throw profileRequired();
    return profile.id;
  }

  /** Creates the profile, or returns the existing one (repeat-safe). */
  async createProfile(
    principal: Principal,
    dto: CreateOwnerProfileDto,
    meta: RequestMeta,
  ): Promise<{ created: boolean; body: OwnerProfileResponse }> {
    assertCustomer(principal);
    const details = this.validateType(dto.ownerType, dto.organizationName, dto.tin, true);
    const existing = await this.prisma.ownerProfile.findUnique({
      where: { userId: principal.userId },
      select: { id: true },
    });
    if (existing !== null) return { created: false, body: await this.profile(principal) };
    const id = uuidv7();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.ownerProfile.create({
          data: {
            id,
            userId: principal.userId,
            ownerType: dto.ownerType,
            ...this.organizationColumns(id, details),
          },
        });
        await tx.ownerReviewEvent.create({
          data: {
            ownerProfileId: id,
            actorUserId: principal.userId,
            action: 'created',
            toStatus: 'UNVERIFIED',
          },
        });
        await this.audit.record(tx, {
          actor: this.actor(principal),
          action: 'owner.profile_created',
          target: { type: 'owner_profile', id },
          changes: { ownerType: dto.ownerType },
          meta,
        });
        await this.outbox.enqueue(tx, {
          aggregateType: 'owner_profile',
          aggregateId: id,
          eventType: 'owner.profile_created',
          payload: { userId: principal.userId, ownerProfileId: id, ownerType: dto.ownerType },
          requestId: meta.requestId,
        });
      });
    } catch (error) {
      if (isTinConflict(error)) await this.duplicateTin(principal, meta);
      // A concurrent create won: report the existing profile.
      if ((error as { code?: unknown } | null)?.code !== 'P2002') throw error;
      return { created: false, body: await this.profile(principal) };
    }
    return { created: true, body: await this.profile(principal) };
  }

  async profile(principal: Principal): Promise<OwnerProfileResponse> {
    assertCustomer(principal);
    await this.status.refreshForUser(principal.userId);
    const profile = await this.prisma.ownerProfile.findUnique({
      where: { userId: principal.userId },
      include: OWNER_INCLUDE,
    });
    if (profile === null) throw notFound();
    return this.present(profile);
  }

  async statusOf(principal: Principal): Promise<OwnerStatusResponse> {
    const body = await this.profile(principal);
    return {
      verificationStatus: body.verificationStatus,
      submissionProblems: body.submissionProblems,
      eligibility: body.eligibility,
    };
  }

  async updateProfile(
    principal: Principal,
    ifMatch: string | undefined,
    dto: UpdateOwnerProfileDto,
    meta: RequestMeta,
  ): Promise<OwnerProfileResponse> {
    const expected = parseIfMatch(ifMatch);
    const id = await this.ownProfileId(principal);
    const fields = Object.entries(dto)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    if (fields.length === 0) return this.profile(principal);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.status.lock(tx, id);
        const current = await tx.ownerProfile.findUniqueOrThrow({
          where: { id },
          include: OWNER_INCLUDE,
        });
        if (current.version !== expected) {
          throw new DomainError(ErrorCode.VERSION_CONFLICT, HttpStatus.CONFLICT);
        }
        if (!EDITABLE_STATUSES.includes(current.verificationStatus)) throw invalidTransition();
        const type = dto.ownerType ?? current.ownerType;
        const typeChanged = type !== current.ownerType;
        if (typeChanged && !TYPE_CHANGE_STATUSES.includes(current.verificationStatus)) {
          throw invalidTransition();
        }
        let data: Prisma.OwnerProfileUpdateInput;
        if (type === 'INDIVIDUAL') {
          this.validateType('INDIVIDUAL', dto.organizationName, dto.tin, false);
          data = {
            ownerType: 'INDIVIDUAL',
            organizationName: null,
            tinEnc: null,
            tinHmac: null,
            tinLast4: null,
          };
          // Organization documents no longer apply (removed while the type is still ORGANIZATION).
          if (typeChanged) await tx.ownerDocument.deleteMany({ where: { ownerProfileId: id } });
        } else {
          const details = this.validateType(
            'ORGANIZATION',
            dto.organizationName ?? (typeChanged ? undefined : (current.organizationName ?? '')),
            dto.tin,
            typeChanged,
          );
          data = {
            ownerType: 'ORGANIZATION',
            organizationName: details.name,
            ...(details.tin === undefined ? {} : this.tinColumns(id, details.tin)),
          };
        }
        await tx.ownerProfile.update({
          where: { id },
          data: { ...data, version: { increment: 1 } },
        });
        await this.audit.record(tx, {
          actor: this.actor(principal),
          action: 'owner.profile_updated',
          target: { type: 'owner_profile', id },
          // Field names only; never the values (the TIN is sensitive).
          changes: { fields, ...(typeChanged ? { ownerType: type } : {}) },
          meta,
        });
      });
    } catch (error) {
      if (isTinConflict(error)) await this.duplicateTin(principal, meta);
      throw error;
    }
    return this.profile(principal);
  }

  async attachDocument(
    principal: Principal,
    purpose: DocumentPurpose,
    documentId: string,
    meta: RequestMeta,
  ): Promise<OwnerProfileResponse> {
    const id = await this.ownProfileId(principal);
    await this.prisma.$transaction(async (tx) => {
      await this.status.lock(tx, id);
      const current = await tx.ownerProfile.findUniqueOrThrow({
        where: { id },
        include: OWNER_INCLUDE,
      });
      // Ownership first: someone else's document is 404 whatever this profile looks like.
      await assertAttachableToOwner(tx, principal.userId, documentId, purpose, id);
      if (current.ownerType !== 'ORGANIZATION') throw invalidTransition();
      if (!EDITABLE_STATUSES.includes(current.verificationStatus)) throw invalidTransition();
      const replaced = current.documents.some((d) => d.purpose === purpose);
      await tx.ownerDocument.upsert({
        where: { ownerProfileId_purpose: { ownerProfileId: id, purpose } },
        create: { ownerProfileId: id, documentId, purpose },
        update: { documentId },
      });
      await tx.ownerProfile.update({ where: { id }, data: { version: { increment: 1 } } });
      await this.audit.record(tx, {
        actor: this.actor(principal),
        action: replaced ? 'owner.document_replaced' : 'owner.document_attached',
        target: { type: 'owner_profile', id },
        changes: { purpose, documentId },
        meta,
      });
    });
    return this.profile(principal);
  }

  /**
   * UNVERIFIED | REJECTED | EXPIRED | REVERIFICATION_REQUIRED -> PENDING. Idempotent: a retry
   * with the same key replays the first answer.
   */
  async submit(
    principal: Principal,
    idempotencyKey: string,
    meta: RequestMeta,
  ): Promise<{ status: number; replayed: boolean; body: OwnerProfileResponse }> {
    const id = await this.ownProfileId(principal);
    // The identity must still be valid now: apply any due identity expiry first.
    await this.status.refreshForUser(principal.userId);
    const result = await this.idempotency.execute(
      {
        scope: 'owners.submit',
        principal: `user:${principal.userId}`,
        key: idempotencyKey,
        fingerprint: { method: 'POST', route: '/owners/me/submit', body: {} },
      },
      async (tx) => {
        await this.status.lock(tx, id);
        const profile = await tx.ownerProfile.findUniqueOrThrow({
          where: { id },
          include: OWNER_INCLUDE,
        });
        if (!EDITABLE_STATUSES.includes(profile.verificationStatus)) throw invalidTransition();
        const problems = submissionProblems({
          accountStatus: profile.user.status,
          identityStatus: profile.user.identityStatus,
          ownerType: profile.ownerType,
          hasOrganizationDetails: profile.organizationName !== null && profile.tinHmac !== null,
          documents: documentFacts(profile),
        });
        if (problems.length > 0) {
          throw new DomainError(
            ErrorCode.OWNER_SUBMISSION_INCOMPLETE,
            HttpStatus.UNPROCESSABLE_ENTITY,
            problems.map((code) => ({ field: 'owner', code })),
          );
        }
        await tx.ownerProfile.update({
          where: { id },
          data: {
            verificationStatus: 'PENDING',
            submittedAt: new Date(),
            // A new case: nothing from an earlier review carries over.
            firstApprovedById: null,
            firstApprovedAt: null,
            firstApprovalNote: null,
            verifiedById: null,
            verifiedAt: null,
            decidedById: null,
            decidedAt: null,
            decisionReasonCode: null,
            decisionNote: null,
            version: { increment: 1 },
          },
        });
        await tx.document.updateMany({
          where: { id: { in: profile.documents.map((d) => d.documentId) } },
          data: { reviewStatus: 'SUBMITTED' },
        });
        await tx.ownerReviewEvent.create({
          data: {
            ownerProfileId: id,
            actorUserId: principal.userId,
            action: 'submitted',
            fromStatus: profile.verificationStatus,
            toStatus: 'PENDING',
          },
        });
        await this.audit.record(tx, {
          actor: this.actor(principal),
          action: 'owner.verification_submitted',
          target: { type: 'owner_profile', id },
          changes: { from: profile.verificationStatus, ownerType: profile.ownerType },
          meta,
        });
        await this.outbox.enqueue(tx, {
          aggregateType: 'owner_profile',
          aggregateId: id,
          eventType: 'owner.verification_submitted',
          payload: { userId: principal.userId, ownerProfileId: id, ownerType: profile.ownerType },
          requestId: meta.requestId,
        });
        return { status: 200, body: { ownerProfileId: id } };
      },
    );
    return {
      status: result.status,
      replayed: result.replayed,
      body: await this.profile(principal),
    };
  }

  // --- helpers ---------------------------------------------------------------

  private present(profile: OwnerWithDocuments): OwnerProfileResponse {
    const editable = EDITABLE_STATUSES.includes(profile.verificationStatus);
    const blockers = ownerBlockers({
      accountStatus: profile.user.status,
      identityStatus: profile.user.identityStatus,
      status: profile.verificationStatus,
    });
    const decided =
      profile.verificationStatus === 'REJECTED' || profile.verificationStatus === 'SUSPENDED';
    return {
      id: profile.id,
      ownerType: profile.ownerType,
      organizationName: profile.organizationName,
      tinMasked: profile.tinLast4 === null ? null : maskTin(profile.tinLast4),
      verificationStatus: profile.verificationStatus,
      identityStatus: profile.user.identityStatus,
      submittedAt: profile.submittedAt?.toISOString() ?? null,
      decidedAt: profile.decidedAt?.toISOString() ?? null,
      decisionReasonCode: decided ? profile.decisionReasonCode : null,
      // Suspension notes are internal; only a rejection note is for the owner.
      decisionNote: profile.verificationStatus === 'REJECTED' ? profile.decisionNote : null,
      editable,
      typeChangeAllowed: TYPE_CHANGE_STATUSES.includes(profile.verificationStatus),
      documents: documentSlots(profile),
      submissionProblems: editable
        ? submissionProblems({
            accountStatus: profile.user.status,
            identityStatus: profile.user.identityStatus,
            ownerType: profile.ownerType,
            hasOrganizationDetails: profile.organizationName !== null && profile.tinHmac !== null,
            documents: documentFacts(profile),
          })
        : [],
      eligibility: { eligible: blockers.length === 0, blockers },
      version: profile.version,
    };
  }

  /**
   * Field rules per type. INDIVIDUAL takes no organization fields; ORGANIZATION needs a name
   * and, when [tinRequired], a TIN.
   */
  private validateType(
    type: OwnerType,
    organizationName: string | undefined,
    tin: string | undefined,
    tinRequired: boolean,
  ): OrganizationDetails {
    if (type === 'INDIVIDUAL') {
      if (organizationName !== undefined) throw validationError('organizationName', 'NOT_ALLOWED');
      if (tin !== undefined) throw validationError('tin', 'NOT_ALLOWED');
      return { name: '', tin: undefined };
    }
    if (organizationName === undefined) throw validationError('organizationName', 'REQUIRED');
    const name = normalizeOrganizationName(organizationName);
    if (name === null) throw validationError('organizationName', 'INVALID_FORMAT');
    if (tin === undefined) {
      if (tinRequired) throw validationError('tin', 'REQUIRED');
      return { name, tin: undefined };
    }
    const normalized = normalizeTin(tin);
    if (normalized === null) throw validationError('tin', 'INVALID_FORMAT');
    return { name, tin: normalized };
  }

  private organizationColumns(
    id: string,
    details: OrganizationDetails,
  ): Partial<Prisma.OwnerProfileUncheckedCreateInput> {
    if (details.tin === undefined) return {};
    return { organizationName: details.name, ...this.tinColumns(id, details.tin) };
  }

  private tinColumns(
    id: string,
    tin: string,
  ): { tinEnc: Uint8Array<ArrayBuffer>; tinHmac: string; tinLast4: string } {
    return {
      tinEnc: new Uint8Array(this.encryption.encrypt(Buffer.from(tin), tinAad(id))),
      tinHmac: this.hasher.hmacHex('tin', tin),
      tinLast4: tin.slice(-4),
    };
  }

  /** Duplicate TIN: 409, flagged for officers; the other account is never revealed. */
  private async duplicateTin(principal: Principal, meta: RequestMeta): Promise<never> {
    await this.audit.record(this.prisma, {
      actor: this.actor(principal),
      action: 'owner.duplicate_tin_detected',
      target: { type: 'user', id: principal.userId },
      meta,
    });
    throw new DomainError(ErrorCode.TIN_IN_USE, HttpStatus.CONFLICT);
  }
}
