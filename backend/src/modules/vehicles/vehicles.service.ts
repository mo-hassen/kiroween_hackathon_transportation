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
import type { Prisma, VehicleEvidenceSlot, VehicleStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { assertAttachableToVehicle, toDocumentResponse } from '../documents/documents.service.js';
import { parseIfMatch } from '../drivers/drivers.service.js';
import { ownerBlockers } from '../owners/owner-rules.js';
import { OwnerStatusService } from '../owners/owner-status.service.js';
import type {
  AttachVehicleEvidenceDto,
  CreateVehicleDto,
  UpdateVehicleDto,
  VehicleEvidenceItem,
  VehicleListResponse,
  VehicleResponse,
  VehicleStatusResponse,
} from './dto/vehicle.dto.js';
import {
  addisToday,
  ARCHIVABLE_STATUSES,
  EDITABLE_STATUSES,
  type EvidenceFacts,
  EVIDENCE_SLOTS,
  EXPIRING_SLOTS,
  isoDate,
  maskIdentifier,
  normalizeDisplayText,
  normalizeEngineNumber,
  normalizePlate,
  normalizeVin,
  parseIsoDate,
  purposeOfSlot,
  REQUIRED_SLOTS,
  submissionProblems,
  validSeats,
  validYear,
  vehicleEligibility,
  type OwnerFacts,
} from './vehicle-rules.js';
import { VehicleStatusService } from './vehicle-status.service.js';

export const vinAad = (vehicleId: string): string => `vehicles.vin_enc:${vehicleId}`;
export const engineNumberAad = (vehicleId: string): string =>
  `vehicles.engine_number_enc:${vehicleId}`;

export const VEHICLE_INCLUDE = {
  evidence: { include: { document: true } },
  ownerProfile: {
    select: {
      id: true,
      userId: true,
      ownerType: true,
      verificationStatus: true,
      organizationName: true,
      user: {
        select: { status: true, identityStatus: true, displayName: true, phoneE164: true },
      },
    },
  },
} satisfies Prisma.VehicleInclude;
export type VehicleRow = Prisma.VehicleGetPayload<{ include: typeof VEHICLE_INCLUDE }>;

/** Active (not archived) vehicles per owner: a sanity limit, not a business rule. */
const MAX_ACTIVE_VEHICLES = 50;
const PHOTO_SLOTS: readonly VehicleEvidenceSlot[] = EVIDENCE_SLOTS.filter((s) =>
  s.startsWith('PHOTO_'),
);

function notFound(): DomainError {
  return new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
}
function invalidTransition(): DomainError {
  return new DomainError(ErrorCode.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT);
}
/** Owner routes are customer-only: staff accounts cannot hold customer profiles (01 §4). */
function assertCustomer(principal: Principal): void {
  if (principal.accountType !== 'CUSTOMER') throw notFound();
}
function uniqueTarget(error: unknown): 'plate' | 'vin' | null {
  const { code, meta } = (error ?? {}) as { code?: unknown; meta?: unknown };
  if (code !== 'P2002') return null;
  const text = JSON.stringify(meta ?? {});
  if (/plate_key/.test(text)) return 'plate';
  if (/vin_key/.test(text)) return 'vin';
  return null;
}

export function evidenceFacts(row: VehicleRow): EvidenceFacts[] {
  return row.evidence.map((e) => ({
    slot: e.slot,
    uploadStatus: e.document.uploadStatus,
    reviewStatus: e.document.reviewStatus,
    expiresOn: e.expiresOn === null ? null : isoDate(e.expiresOn),
  }));
}
export function ownerFacts(row: VehicleRow): OwnerFacts {
  return {
    accountStatus: row.ownerProfile.user.status,
    identityStatus: row.ownerProfile.user.identityStatus,
    ownerStatus: row.ownerProfile.verificationStatus,
  };
}
export function evidenceItems(row: VehicleRow): VehicleEvidenceItem[] {
  return EVIDENCE_SLOTS.map((slot) => {
    const link = row.evidence.find((e) => e.slot === slot);
    return {
      slot,
      required: REQUIRED_SLOTS.includes(slot),
      expiresOn: link?.expiresOn == null ? null : isoDate(link.expiresOn),
      document: link === undefined ? null : toDocumentResponse(link.document),
    };
  });
}

type Validated = Fields & { plateParts?: NonNullable<ReturnType<typeof normalizePlate>> };

interface Fields {
  vehicleType?: CreateVehicleDto['vehicleType'];
  make?: string;
  model?: string;
  year?: number;
  color?: string;
  seats?: number;
  transmission?: CreateVehicleDto['transmission'];
  fuelType?: CreateVehicleDto['fuelType'];
  plateRegion?: string;
  plateCode?: string;
  plateNumber?: string;
  vin?: string;
  engineNumber?: string;
}

/**
 * The signed-in owner's vehicles (journey J5, FR-5). Only a VERIFIED owner registers vehicles;
 * the owner always comes from the principal; officers decide in VehicleReviewService.
 */
@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownerStatus: OwnerStatusService,
    private readonly status: VehicleStatusService,
    private readonly idempotency: IdempotencyService,
    private readonly encryption: FieldEncryption,
    private readonly hasher: SecretHasher,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private actor(principal: Principal): { type: 'USER'; userId: string } {
    return { type: 'USER' as const, userId: principal.userId };
  }

  /** The caller's owner profile (409 when there is none). */
  private async ownProfile(principal: Principal): Promise<{ id: string }> {
    assertCustomer(principal);
    await this.ownerStatus.refreshForUser(principal.userId);
    const profile = await this.prisma.ownerProfile.findUnique({
      where: { userId: principal.userId },
      select: { id: true },
    });
    if (profile === null)
      throw new DomainError(ErrorCode.OWNER_PROFILE_REQUIRED, HttpStatus.CONFLICT);
    return profile;
  }

  /** Writes need a VERIFIED owner on an ACTIVE account with a VERIFIED identity. */
  private async assertOwnerCanRegister(
    db: Prisma.TransactionClient,
    profileId: string,
  ): Promise<void> {
    const profile = await db.ownerProfile.findUniqueOrThrow({
      where: { id: profileId },
      select: {
        verificationStatus: true,
        user: { select: { status: true, identityStatus: true } },
      },
    });
    const problems = ownerBlockers({
      accountStatus: profile.user.status,
      identityStatus: profile.user.identityStatus,
      status: profile.verificationStatus,
    });
    if (problems.length > 0) {
      throw new DomainError(
        ErrorCode.OWNER_NOT_VERIFIED,
        HttpStatus.CONFLICT,
        problems.map((code) => ({ field: 'owner', code })),
      );
    }
  }

  async create(
    principal: Principal,
    dto: CreateVehicleDto,
    meta: RequestMeta,
  ): Promise<{ created: boolean; body: VehicleResponse }> {
    const profile = await this.ownProfile(principal);
    const fields = this.validate(dto, true);
    const id = uuidv7();
    const active = await this.prisma.vehicle.count({
      where: { ownerProfileId: profile.id, status: { not: 'ARCHIVED' } },
    });
    if (active >= MAX_ACTIVE_VEHICLES) throw validationError('vehicles', 'TOO_MANY');
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.assertOwnerCanRegister(tx, profile.id);
        await tx.vehicle.create({
          data: { ...this.columns(id, fields), id, ownerProfileId: profile.id },
        });
        await tx.vehicleReviewEvent.create({
          data: {
            vehicleId: id,
            actorUserId: principal.userId,
            action: 'created',
            toStatus: 'DRAFT',
          },
        });
        await this.audit.record(tx, {
          actor: this.actor(principal),
          action: 'vehicle.created',
          target: { type: 'vehicle', id },
          changes: { vehicleType: dto.vehicleType, year: dto.year },
          meta,
        });
        await this.outbox.enqueue(tx, {
          aggregateType: 'vehicle',
          aggregateId: id,
          eventType: 'vehicle.created',
          payload: { userId: principal.userId, vehicleId: id },
          requestId: meta.requestId,
        });
      });
    } catch (error) {
      const target = uniqueTarget(error);
      if (target === null) throw error;
      const existing = await this.ownDraftWithPlate(profile.id, fields);
      // A retry of the same request: the owner's own draft is returned, not an error.
      if (target === 'plate' && existing !== null) {
        return { created: false, body: this.present(existing) };
      }
      await this.duplicate(principal, target, meta);
    }
    return { created: true, body: await this.get(principal, id) };
  }

  private async ownDraftWithPlate(profileId: string, fields: Fields): Promise<VehicleRow | null> {
    const plate = normalizePlate({
      region: fields.plateRegion ?? '',
      code: fields.plateCode ?? '',
      number: fields.plateNumber ?? '',
    });
    if (plate === null) return null;
    return this.prisma.vehicle.findFirst({
      where: { ownerProfileId: profileId, plateKey: plate.normalized, status: 'DRAFT' },
      include: VEHICLE_INCLUDE,
    });
  }

  async list(principal: Principal): Promise<VehicleListResponse> {
    const profile = await this.optionalProfile(principal);
    if (profile === null) return { items: [] };
    await this.status.refreshForOwner(profile.id);
    const rows = await this.prisma.vehicle.findMany({
      where: { ownerProfileId: profile.id, status: { not: 'ARCHIVED' } },
      include: VEHICLE_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { items: rows.map((row) => this.present(row)) };
  }

  /** Reading never needs a verified owner; an owner without a profile has no vehicles. */
  private async optionalProfile(principal: Principal): Promise<{ id: string } | null> {
    assertCustomer(principal);
    await this.ownerStatus.refreshForUser(principal.userId);
    return this.prisma.ownerProfile.findUnique({
      where: { userId: principal.userId },
      select: { id: true },
    });
  }

  /** Someone else's vehicle is a 404, exactly like a vehicle that does not exist. */
  private async owned(
    db: Prisma.TransactionClient | PrismaService,
    principal: Principal,
    id: string,
  ): Promise<VehicleRow> {
    const row = await db.vehicle.findUnique({ where: { id }, include: VEHICLE_INCLUDE });
    if (row === null || row.ownerProfile.userId !== principal.userId) throw notFound();
    return row;
  }

  async get(principal: Principal, id: string): Promise<VehicleResponse> {
    const profile = await this.optionalProfile(principal);
    if (profile === null) throw notFound();
    await this.status.refreshForOwner(profile.id);
    return this.present(await this.owned(this.prisma, principal, id));
  }

  async statusOf(principal: Principal, id: string): Promise<VehicleStatusResponse> {
    const body = await this.get(principal, id);
    return {
      status: body.status,
      submissionProblems: body.submissionProblems,
      eligibility: body.eligibility,
    };
  }

  async update(
    principal: Principal,
    id: string,
    ifMatch: string | undefined,
    dto: UpdateVehicleDto,
    meta: RequestMeta,
  ): Promise<VehicleResponse> {
    const expected = parseIfMatch(ifMatch);
    const profile = await this.ownProfile(principal);
    const changed = Object.entries(dto)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    if (changed.length === 0) return this.get(principal, id);
    const fields = this.validate(dto, false);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.owned(tx, principal, id);
        await this.status.lock(tx, id);
        const current = await this.owned(tx, principal, id);
        if (current.version !== expected) {
          throw new DomainError(ErrorCode.VERSION_CONFLICT, HttpStatus.CONFLICT);
        }
        await this.assertOwnerCanRegister(tx, profile.id);
        const material = changed.some((key) =>
          [
            'vehicleType',
            'make',
            'model',
            'year',
            'plateRegion',
            'plateCode',
            'plateNumber',
            'vin',
            'engineNumber',
          ].includes(key),
        );
        const approved = current.status === 'APPROVED';
        if (!EDITABLE_STATUSES.includes(current.status) && !approved) {
          throw invalidTransition();
        }
        const data = this.updateColumns(current, fields);
        let next: VehicleStatus = current.status;
        if (EDITABLE_STATUSES.includes(current.status) && current.status !== 'DRAFT')
          next = 'DRAFT';
        if (approved && material) next = 'SUBMITTED';
        if (next === 'SUBMITTED') await this.assertComplete(tx, current);
        await tx.vehicle.update({
          where: { id },
          data: {
            ...data,
            ...(next === current.status ? {} : { status: next }),
            ...(next === 'SUBMITTED' ? this.newCase(new Date()) : {}),
            version: { increment: 1 },
          },
        });
        if (next !== current.status) {
          await this.event(
            tx,
            id,
            principal,
            next === 'SUBMITTED' ? 'resubmitted' : 'edited',
            current.status,
            next,
          );
          if (next === 'SUBMITTED') await this.markEvidenceSubmitted(tx, current);
        }
        await this.audit.record(tx, {
          actor: this.actor(principal),
          action: 'vehicle.updated',
          target: { type: 'vehicle', id },
          // Field names only: never the values (VIN and engine number are sensitive).
          changes: {
            fields: changed,
            ...(next === current.status ? {} : { from: current.status, to: next }),
          },
          meta,
        });
        if (next === 'SUBMITTED') await this.publishSubmitted(tx, principal, id, meta);
      });
    } catch (error) {
      const target = uniqueTarget(error);
      if (target !== null) await this.duplicate(principal, target, meta);
      throw error;
    }
    return this.get(principal, id);
  }

  async attachEvidence(
    principal: Principal,
    id: string,
    slot: VehicleEvidenceSlot,
    dto: AttachVehicleEvidenceDto,
    meta: RequestMeta,
  ): Promise<VehicleResponse> {
    const profile = await this.ownProfile(principal);
    const expiresOn = this.evidenceExpiry(slot, dto.expiresOn);
    await this.prisma.$transaction(async (tx) => {
      await this.owned(tx, principal, id);
      await this.status.lock(tx, id);
      const current = await this.owned(tx, principal, id);
      // Ownership first: someone else's document is 404 whatever this vehicle looks like.
      await assertAttachableToVehicle(
        tx,
        principal.userId,
        dto.documentId,
        purposeOfSlot(slot),
        id,
        slot,
      );
      await this.assertOwnerCanRegister(tx, profile.id);
      const approved = current.status === 'APPROVED';
      if (!EDITABLE_STATUSES.includes(current.status) && !approved) throw invalidTransition();
      const replaced = current.evidence.some((e) => e.slot === slot);
      await tx.vehicleDocument.upsert({
        where: { vehicleId_slot: { vehicleId: id, slot } },
        create: {
          vehicleId: id,
          slot,
          documentId: dto.documentId,
          purpose: purposeOfSlot(slot),
          expiresOn,
        },
        update: { documentId: dto.documentId, expiresOn },
      });
      let next: VehicleStatus = current.status;
      if (EDITABLE_STATUSES.includes(current.status) && current.status !== 'DRAFT') next = 'DRAFT';
      // New evidence on an approved vehicle is re-verified (the evidence is the proof).
      if (approved) next = 'SUBMITTED';
      if (next === 'SUBMITTED') {
        const fresh = await this.owned(tx, principal, id);
        await this.assertComplete(tx, fresh);
      }
      await tx.vehicle.update({
        where: { id },
        data: {
          ...(next === current.status ? {} : { status: next }),
          ...(next === 'SUBMITTED' ? this.newCase(new Date()) : {}),
          version: { increment: 1 },
        },
      });
      if (next !== current.status) {
        await this.event(
          tx,
          id,
          principal,
          next === 'SUBMITTED' ? 'resubmitted' : 'edited',
          current.status,
          next,
        );
      }
      if (next === 'SUBMITTED') {
        await this.markEvidenceSubmitted(tx, await this.owned(tx, principal, id));
        await this.publishSubmitted(tx, principal, id, meta);
      }
      await this.audit.record(tx, {
        actor: this.actor(principal),
        action: PHOTO_SLOTS.includes(slot) ? 'vehicle.photo_attached' : 'vehicle.document_attached',
        target: { type: 'vehicle', id },
        changes: { slot, documentId: dto.documentId, replaced },
        meta,
      });
    });
    return this.get(principal, id);
  }

  /**
   * DRAFT (or REJECTED or EXPIRED, which return to DRAFT first) -> SUBMITTED. Idempotent: a
   * retry with the same key replays the first answer. Everything is re-checked in the same
   * transaction that changes the status.
   */
  async submit(
    principal: Principal,
    id: string,
    idempotencyKey: string,
    meta: RequestMeta,
  ): Promise<{ replayed: boolean; body: VehicleResponse }> {
    const profile = await this.ownProfile(principal);
    const result = await this.idempotency.execute(
      {
        scope: 'vehicles.submit',
        principal: `user:${principal.userId}`,
        key: idempotencyKey,
        fingerprint: { method: 'POST', route: `/vehicles/${id}/submit`, body: {} },
      },
      async (tx) => {
        await this.owned(tx, principal, id);
        await this.status.lock(tx, id);
        await this.status.apply(tx, id);
        const current = await this.owned(tx, principal, id);
        if (!EDITABLE_STATUSES.includes(current.status)) throw invalidTransition();
        await this.assertOwnerCanRegister(tx, profile.id);
        await this.assertComplete(tx, current);
        if (current.status !== 'DRAFT') {
          await tx.vehicle.update({ where: { id }, data: { status: 'DRAFT' } });
          await this.event(tx, id, principal, 'edited', current.status, 'DRAFT');
        }
        await tx.vehicle.update({
          where: { id },
          data: { status: 'SUBMITTED', ...this.newCase(new Date()), version: { increment: 1 } },
        });
        await this.markEvidenceSubmitted(tx, current);
        await this.event(tx, id, principal, 'submitted', 'DRAFT', 'SUBMITTED');
        await this.audit.record(tx, {
          actor: this.actor(principal),
          action: 'vehicle.submitted',
          target: { type: 'vehicle', id },
          changes: { from: current.status },
          meta,
        });
        await this.outbox.enqueue(tx, {
          aggregateType: 'vehicle',
          aggregateId: id,
          eventType: 'vehicle.submitted',
          payload: { userId: principal.userId, vehicleId: id },
          requestId: meta.requestId,
        });
        return { status: 200, body: { vehicleId: id } };
      },
    );
    return { replayed: result.replayed, body: await this.get(principal, id) };
  }

  /** Removes the vehicle from the owner's list and frees its plate and VIN. Idempotent. */
  async archive(principal: Principal, id: string, meta: RequestMeta): Promise<VehicleResponse> {
    await this.ownProfile(principal);
    await this.prisma.$transaction(async (tx) => {
      await this.owned(tx, principal, id);
      await this.status.lock(tx, id);
      const current = await this.owned(tx, principal, id);
      if (current.status === 'ARCHIVED') return;
      if (!ARCHIVABLE_STATUSES.includes(current.status)) throw invalidTransition();
      await tx.vehicle.update({
        where: { id },
        data: {
          status: 'ARCHIVED',
          archivedAt: new Date(),
          plateKey: null,
          vinKey: null,
          version: { increment: 1 },
        },
      });
      await this.event(tx, id, principal, 'archived', current.status, 'ARCHIVED');
      await this.audit.record(tx, {
        actor: this.actor(principal),
        action: 'vehicle.archived',
        target: { type: 'vehicle', id },
        changes: { from: current.status },
        meta,
      });
    });
    return this.present(await this.owned(this.prisma, principal, id));
  }

  // --- helpers ---------------------------------------------------------------

  /** Everything a submission needs, evaluated inside the caller's transaction. */
  private async assertComplete(tx: Prisma.TransactionClient, row: VehicleRow): Promise<void> {
    const fresh = await tx.vehicle.findUniqueOrThrow({
      where: { id: row.id },
      include: VEHICLE_INCLUDE,
    });
    const problems = submissionProblems(ownerFacts(fresh), evidenceFacts(fresh), addisToday());
    if (problems.length > 0) {
      throw new DomainError(
        ErrorCode.VEHICLE_SUBMISSION_INCOMPLETE,
        HttpStatus.UNPROCESSABLE_ENTITY,
        problems.map((code) => ({ field: 'vehicle', code })),
      );
    }
  }

  /** A new review case: nothing from an earlier decision carries over. */
  private newCase(now: Date): Prisma.VehicleUncheckedUpdateInput {
    return {
      submittedAt: now,
      claimedById: null,
      claimExpiresAt: null,
      decidedById: null,
      decidedAt: null,
      decisionReasonCode: null,
      decisionNote: null,
    };
  }

  private async markEvidenceSubmitted(
    tx: Prisma.TransactionClient,
    row: VehicleRow,
  ): Promise<void> {
    const fresh = await tx.vehicleDocument.findMany({
      where: { vehicleId: row.id },
      select: { documentId: true },
    });
    await tx.document.updateMany({
      where: { id: { in: fresh.map((d) => d.documentId) }, reviewStatus: 'DRAFT' },
      data: { reviewStatus: 'SUBMITTED' },
    });
  }

  private async publishSubmitted(
    tx: Prisma.TransactionClient,
    principal: Principal,
    id: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: this.actor(principal),
      action: 'vehicle.submitted',
      target: { type: 'vehicle', id },
      changes: { from: 'APPROVED' },
      meta,
    });
    await this.outbox.enqueue(tx, {
      aggregateType: 'vehicle',
      aggregateId: id,
      eventType: 'vehicle.submitted',
      payload: { userId: principal.userId, vehicleId: id },
      requestId: meta.requestId,
    });
  }

  private async event(
    tx: Prisma.TransactionClient,
    vehicleId: string,
    principal: Principal,
    action: string,
    from: VehicleStatus,
    to: VehicleStatus,
  ): Promise<void> {
    await tx.vehicleReviewEvent.create({
      data: { vehicleId, actorUserId: principal.userId, action, fromStatus: from, toStatus: to },
    });
  }

  private evidenceExpiry(slot: VehicleEvidenceSlot, value: string | undefined): Date | null {
    if (!EXPIRING_SLOTS.includes(slot)) {
      if (value !== undefined) throw validationError('expiresOn', 'NOT_ALLOWED');
      return null;
    }
    if (value === undefined) throw validationError('expiresOn', 'REQUIRED');
    const date = parseIsoDate(value);
    if (date === null) throw validationError('expiresOn', 'INVALID_DATE');
    if (value < addisToday()) throw validationError('expiresOn', 'IN_THE_PAST');
    // Insurance and inspection certificates are valid for a year or two, never decades.
    if (value > addisToday(new Date(Date.now() + 10 * 366 * 86_400_000))) {
      throw validationError('expiresOn', 'TOO_FAR');
    }
    return date;
  }

  /** Server-side rules on top of the DTO's shape checks. [full] requires the mandatory fields. */
  private validate(dto: Fields, full: boolean): Validated {
    const out: Validated = {};
    if (dto.vehicleType !== undefined) out.vehicleType = dto.vehicleType;
    if (dto.make !== undefined) {
      const make = normalizeDisplayText(dto.make, 60);
      if (make === null) throw validationError('make', 'INVALID_FORMAT');
      out.make = make;
    }
    if (dto.model !== undefined) {
      const model = normalizeDisplayText(dto.model, 60);
      if (model === null) throw validationError('model', 'INVALID_FORMAT');
      out.model = model;
    }
    if (dto.year !== undefined) {
      if (!validYear(dto.year)) throw validationError('year', 'OUT_OF_RANGE');
      out.year = dto.year;
    }
    if (dto.color !== undefined) {
      const color = normalizeDisplayText(dto.color, 30);
      if (color === null) throw validationError('color', 'INVALID_FORMAT');
      out.color = color;
    }
    if (dto.seats !== undefined) {
      if (!validSeats(dto.seats)) throw validationError('seats', 'OUT_OF_RANGE');
      out.seats = dto.seats;
    }
    if (dto.transmission !== undefined) out.transmission = dto.transmission;
    if (dto.fuelType !== undefined) out.fuelType = dto.fuelType;
    const plateGiven = [dto.plateRegion, dto.plateCode, dto.plateNumber].filter(
      (p) => p !== undefined,
    );
    if (plateGiven.length > 0) {
      if (plateGiven.length !== 3) {
        throw validationError(
          dto.plateRegion === undefined
            ? 'plateRegion'
            : dto.plateCode === undefined
              ? 'plateCode'
              : 'plateNumber',
          'REQUIRED',
        );
      }
      const parts = normalizePlate({
        region: dto.plateRegion as string,
        code: dto.plateCode as string,
        number: dto.plateNumber as string,
      });
      if (parts === null) throw validationError('plateNumber', 'INVALID_FORMAT');
      out.plateRegion = parts.region;
      out.plateCode = parts.code;
      out.plateNumber = parts.number;
      out.plateParts = parts;
    }
    if (dto.vin !== undefined) {
      const vin = normalizeVin(dto.vin);
      if (vin === null) throw validationError('vin', 'INVALID_FORMAT');
      out.vin = vin;
    }
    if (dto.engineNumber !== undefined) {
      const engine = normalizeEngineNumber(dto.engineNumber);
      if (engine === null) throw validationError('engineNumber', 'INVALID_FORMAT');
      out.engineNumber = engine;
    }
    if (full) {
      for (const key of [
        'vehicleType',
        'make',
        'model',
        'year',
        'seats',
        'transmission',
        'fuelType',
        'plateRegion',
      ] as const) {
        if (out[key] === undefined) throw validationError(key, 'REQUIRED');
      }
    }
    return out;
  }

  private sensitiveColumns(id: string, fields: Fields): Prisma.VehicleUncheckedUpdateInput {
    const data: Prisma.VehicleUncheckedUpdateInput = {};
    if (fields.vin !== undefined) {
      const hmac = this.hasher.hmacHex('vin', fields.vin);
      data.vinEnc = new Uint8Array(this.encryption.encrypt(Buffer.from(fields.vin), vinAad(id)));
      data.vinHmac = hmac;
      data.vinKey = hmac;
      data.vinLast4 = fields.vin.slice(-4);
    }
    if (fields.engineNumber !== undefined) {
      data.engineNumberEnc = new Uint8Array(
        this.encryption.encrypt(Buffer.from(fields.engineNumber), engineNumberAad(id)),
      );
    }
    return data;
  }

  private columns(
    id: string,
    fields: Validated,
  ): Omit<Prisma.VehicleUncheckedCreateInput, 'id' | 'ownerProfileId'> {
    const plate = fields.plateParts as NonNullable<typeof fields.plateParts>;
    return {
      vehicleType: fields.vehicleType as NonNullable<Fields['vehicleType']>,
      make: fields.make as string,
      model: fields.model as string,
      year: fields.year as number,
      color: fields.color ?? null,
      seats: fields.seats as number,
      transmission: fields.transmission as NonNullable<Fields['transmission']>,
      fuelType: fields.fuelType as NonNullable<Fields['fuelType']>,
      plateRegion: plate.region,
      plateCode: plate.code,
      plateNumber: plate.number,
      plateNormalized: plate.normalized,
      plateKey: plate.normalized,
      ...(this.sensitiveColumns(id, fields) as Partial<Prisma.VehicleUncheckedCreateInput>),
    };
  }

  private updateColumns(
    current: VehicleRow,
    fields: Validated,
  ): Prisma.VehicleUncheckedUpdateInput {
    const data: Prisma.VehicleUncheckedUpdateInput = {
      ...(fields.vehicleType === undefined ? {} : { vehicleType: fields.vehicleType }),
      ...(fields.make === undefined ? {} : { make: fields.make }),
      ...(fields.model === undefined ? {} : { model: fields.model }),
      ...(fields.year === undefined ? {} : { year: fields.year }),
      ...(fields.color === undefined ? {} : { color: fields.color }),
      ...(fields.seats === undefined ? {} : { seats: fields.seats }),
      ...(fields.transmission === undefined ? {} : { transmission: fields.transmission }),
      ...(fields.fuelType === undefined ? {} : { fuelType: fields.fuelType }),
      ...this.sensitiveColumns(current.id, fields),
    };
    if (fields.plateParts !== undefined) {
      data.plateRegion = fields.plateParts.region;
      data.plateCode = fields.plateParts.code;
      data.plateNumber = fields.plateParts.number;
      data.plateNormalized = fields.plateParts.normalized;
      data.plateKey = fields.plateParts.normalized;
    }
    return data;
  }

  /** Duplicate plate or VIN: 409, flagged for officers; the other account is never revealed. */
  private async duplicate(
    principal: Principal,
    target: 'plate' | 'vin',
    meta: RequestMeta,
  ): Promise<never> {
    await this.audit.record(this.prisma, {
      actor: this.actor(principal),
      action:
        target === 'plate' ? 'vehicle.duplicate_plate_detected' : 'vehicle.duplicate_vin_detected',
      target: { type: 'user', id: principal.userId },
      meta,
    });
    throw new DomainError(
      target === 'plate' ? ErrorCode.PLATE_IN_USE : ErrorCode.VIN_IN_USE,
      HttpStatus.CONFLICT,
    );
  }

  present(row: VehicleRow): VehicleResponse {
    const today = addisToday();
    const editable = EDITABLE_STATUSES.includes(row.status);
    const facts = evidenceFacts(row);
    const owner = ownerFacts(row);
    const decided = row.status === 'REJECTED' || row.status === 'SUSPENDED';
    return {
      id: row.id,
      vehicleType: row.vehicleType,
      make: row.make,
      model: row.model,
      year: row.year,
      color: row.color,
      seats: row.seats,
      transmission: row.transmission,
      fuelType: row.fuelType,
      plate: { region: row.plateRegion, code: row.plateCode, number: row.plateNumber },
      vinMasked: row.vinLast4 === null ? null : maskIdentifier(row.vinLast4),
      engineNumberOnFile: row.engineNumberEnc !== null,
      status: row.status,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      decidedAt: decided ? (row.decidedAt?.toISOString() ?? null) : null,
      decisionReasonCode: decided ? row.decisionReasonCode : null,
      // Suspension notes are internal; only a rejection note is for the owner.
      decisionNote: row.status === 'REJECTED' ? row.decisionNote : null,
      editable,
      evidence: evidenceItems(row),
      submissionProblems: editable ? submissionProblems(owner, facts, today) : [],
      eligibility: vehicleEligibility(row.status, owner, facts, today),
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    };
  }
}
