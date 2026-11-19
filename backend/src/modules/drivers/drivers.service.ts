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
import type { DocumentPurpose, Prisma, ReviewStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { DocumentsService, toDocumentResponse } from '../documents/documents.service.js';
import type { DocumentResponse } from '../documents/dto/document.dto.js';
import { DriverEligibilityService } from './driver-eligibility.service.js';
import {
  addisToday,
  EDITABLE_STATUSES,
  isoDate,
  normalizeCategories,
  normalizeLicenseNumber,
  parseIsoDate,
  submissionProblems,
} from './driver-rules.js';
import type {
  DriverProfileDto,
  DriverProfileResponse,
  EligibilityResponse,
  LicenseDetailsDto,
  LicenseResponse,
} from './dto/driver.dto.js';

type Tx = Prisma.TransactionClient;

export const licenseNumberAad = (licenseId: string): string =>
  `driver_licenses.license_number_enc:${licenseId}`;

const LICENSE_INCLUDE = {
  documents: { include: { document: true } },
} satisfies Prisma.DriverLicenseInclude;
type LicenseWithDocuments = Prisma.DriverLicenseGetPayload<{ include: typeof LICENSE_INCLUDE }>;

function notFound(): DomainError {
  return new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
}

function invalidTransition(): DomainError {
  return new DomainError(ErrorCode.INVALID_STATE_TRANSITION, HttpStatus.CONFLICT);
}

/** Driver routes are customer-only: staff accounts cannot hold customer profiles (01 §4). */
function assertCustomer(principal: Principal): void {
  if (principal.accountType !== 'CUSTOMER') throw notFound();
}

export function parseIfMatch(ifMatch: string | undefined): number {
  if (ifMatch === undefined || ifMatch === '') {
    throw new DomainError(ErrorCode.PRECONDITION_REQUIRED, HttpStatus.PRECONDITION_REQUIRED);
  }
  const version = Number(ifMatch.replace(/^W\//, '').replaceAll('"', ''));
  if (!Number.isInteger(version) || version < 0)
    throw validationError('If-Match', 'INVALID_VERSION');
  return version;
}

export function toLicenseResponse(license: LicenseWithDocuments): LicenseResponse {
  const document = (purpose: DocumentPurpose): DocumentResponse | null => {
    const link = license.documents.find((d) => d.purpose === purpose);
    return link === undefined ? null : toDocumentResponse(link.document);
  };
  return {
    id: license.id,
    licenseNumberMasked: `••••${license.licenseNumberLast4}`,
    categories: [...license.categories],
    issuedOn: isoDate(license.issuedOn),
    expiresOn: isoDate(license.expiresOn),
    issuingAuthority: license.issuingAuthority,
    reviewStatus: license.reviewStatus,
    submittedAt: license.submittedAt?.toISOString() ?? null,
    decidedAt: license.decidedAt?.toISOString() ?? null,
    // Suspension notes are internal; rejection reasons and notes are for the driver.
    decisionReasonCode: license.reviewStatus === 'REJECTED' ? license.decisionReasonCode : null,
    decisionNote: license.reviewStatus === 'REJECTED' ? license.decisionNote : null,
    frontDocument: document('DRIVER_LICENSE_FRONT'),
    backDocument: document('DRIVER_LICENSE_BACK'),
    editable: EDITABLE_STATUSES.includes(license.reviewStatus),
    version: license.version,
  };
}

/** Validated, normalized licence details (field errors use the DTO field names). */
interface ValidDetails {
  readonly number: string;
  readonly categories: string[];
  readonly issuedOn: Date;
  readonly expiresOn: Date;
  readonly issuingAuthority: string;
}

function validateDetails(dto: LicenseDetailsDto, today: string): ValidDetails {
  const number = normalizeLicenseNumber(dto.licenseNumber);
  if (number === null) throw validationError('licenseNumber', 'INVALID_FORMAT');
  const categories = normalizeCategories(dto.categories);
  if (categories === null) throw validationError('categories', 'INVALID_FORMAT');
  const issuedOn = parseIsoDate(dto.issuedOn);
  if (issuedOn === null) throw validationError('issuedOn', 'IS_DATE');
  const expiresOn = parseIsoDate(dto.expiresOn);
  if (expiresOn === null) throw validationError('expiresOn', 'IS_DATE');
  if (dto.issuedOn > today) throw validationError('issuedOn', 'IN_FUTURE');
  if (dto.expiresOn <= dto.issuedOn) throw validationError('expiresOn', 'BEFORE_ISSUE_DATE');
  if (dto.expiresOn <= today) throw validationError('expiresOn', 'EXPIRED');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(dto.issuingAuthority)) {
    throw validationError('issuingAuthority', 'INVALID_CHARACTERS');
  }
  return { number, categories, issuedOn, expiresOn, issuingAuthority: dto.issuingAuthority };
}

function isLicenseNumberConflict(error: unknown): boolean {
  const { code, meta } = (error ?? {}) as { code?: unknown; meta?: unknown };
  return code === 'P2002' && /license_number_hmac/.test(JSON.stringify(meta ?? {}));
}

/**
 * The account holder's driver profile, licence and verification request (journey J3). The
 * review decision itself is only made by DriverReviewService (verification officers).
 */
@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
    private readonly eligibility: DriverEligibilityService,
    private readonly idempotency: IdempotencyService,
    private readonly encryption: FieldEncryption,
    private readonly hasher: SecretHasher,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private actor(principal: Principal): { type: 'USER'; userId: string } {
    return { type: 'USER' as const, userId: principal.userId };
  }

  private async ownProfile(principal: Principal): Promise<{ id: string; version: number }> {
    assertCustomer(principal);
    const profile = await this.prisma.driverProfile.findUnique({
      where: { userId: principal.userId },
      select: { id: true, version: true },
    });
    if (profile === null)
      throw new DomainError(ErrorCode.DRIVER_PROFILE_REQUIRED, HttpStatus.CONFLICT);
    return profile;
  }

  /** Creates the profile, or returns the existing one (repeat-safe). */
  async createProfile(
    principal: Principal,
    dto: DriverProfileDto,
    meta: RequestMeta,
  ): Promise<{ created: boolean; body: DriverProfileResponse }> {
    assertCustomer(principal);
    const existing = await this.prisma.driverProfile.findUnique({
      where: { userId: principal.userId },
      select: { id: true },
    });
    if (existing !== null) return { created: false, body: await this.profile(principal) };
    try {
      await this.prisma.$transaction(async (tx) => {
        const profile = await tx.driverProfile.create({
          data: {
            userId: principal.userId,
            yearsLicensed: dto.yearsLicensed ?? null,
            bio: dto.bio ?? null,
            homeSubCity: dto.homeSubCity ?? null,
          },
        });
        await this.audit.record(tx, {
          actor: this.actor(principal),
          action: 'driver.profile_created',
          target: { type: 'driver_profile', id: profile.id },
          meta,
        });
        await this.outbox.enqueue(tx, {
          aggregateType: 'driver_profile',
          aggregateId: profile.id,
          eventType: 'driver.profile_created',
          payload: { userId: principal.userId, driverProfileId: profile.id },
          requestId: meta.requestId,
        });
      });
    } catch (error) {
      // A concurrent create won: report the existing profile.
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== 'P2002') throw error;
      return { created: false, body: await this.profile(principal) };
    }
    return { created: true, body: await this.profile(principal) };
  }

  async profile(principal: Principal): Promise<DriverProfileResponse> {
    assertCustomer(principal);
    await this.eligibility.refreshForUser(principal.userId);
    const profile = await this.prisma.driverProfile.findUnique({
      where: { userId: principal.userId },
      include: {
        user: { select: { identityStatus: true } },
        license: { include: LICENSE_INCLUDE },
      },
    });
    if (profile === null) throw notFound();
    const result = await this.eligibility.evaluate(this.prisma, profile.id);
    return {
      id: profile.id,
      yearsLicensed: profile.yearsLicensed,
      bio: profile.bio,
      homeSubCity: profile.homeSubCity,
      identityStatus: profile.user.identityStatus,
      eligibility: { status: result.status, blockers: [...result.blockers] },
      suspendedReason: profile.suspendedReason,
      license: profile.license === null ? null : toLicenseResponse(profile.license),
      version: profile.version,
    };
  }

  async eligibilityOf(principal: Principal): Promise<EligibilityResponse> {
    const profile = await this.ownProfile(principal);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.eligibility.lockProfile(tx, profile.id);
      return this.eligibility.refresh(tx, profile.id, this.actor(principal));
    });
    return { status: result.status, blockers: [...result.blockers] };
  }

  async updateProfile(
    principal: Principal,
    ifMatch: string | undefined,
    dto: DriverProfileDto,
    meta: RequestMeta,
  ): Promise<DriverProfileResponse> {
    const expected = parseIfMatch(ifMatch);
    const profile = await this.ownProfile(principal);
    const fields = Object.entries(dto)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    if (fields.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.driverProfile.updateMany({
          where: { id: profile.id, version: expected },
          data: {
            ...(dto.yearsLicensed === undefined ? {} : { yearsLicensed: dto.yearsLicensed }),
            ...(dto.bio === undefined ? {} : { bio: dto.bio }),
            ...(dto.homeSubCity === undefined ? {} : { homeSubCity: dto.homeSubCity }),
            version: { increment: 1 },
          },
        });
        if (updated.count !== 1)
          throw new DomainError(ErrorCode.VERSION_CONFLICT, HttpStatus.CONFLICT);
        await this.audit.record(tx, {
          actor: this.actor(principal),
          action: 'driver.profile_updated',
          target: { type: 'driver_profile', id: profile.id },
          changes: { fields },
          meta,
        });
      });
    }
    return this.profile(principal);
  }

  async createLicense(
    principal: Principal,
    dto: LicenseDetailsDto,
    meta: RequestMeta,
  ): Promise<LicenseResponse> {
    const profile = await this.ownProfile(principal);
    const details = validateDetails(dto, addisToday());
    const id = uuidv7();
    const license = await this.prisma
      .$transaction(async (tx) => {
        await this.eligibility.lockProfile(tx, profile.id);
        if ((await tx.driverLicense.count({ where: { driverProfileId: profile.id } })) > 0) {
          throw invalidTransition();
        }
        const created = await tx.driverLicense.create({
          data: {
            id,
            driverProfileId: profile.id,
            ...this.numberColumns(id, details.number),
            categories: details.categories,
            issuedOn: details.issuedOn,
            expiresOn: details.expiresOn,
            issuingAuthority: details.issuingAuthority,
          },
          include: LICENSE_INCLUDE,
        });
        await tx.driverReviewEvent.create({
          data: {
            driverLicenseId: id,
            actorUserId: principal.userId,
            action: 'created',
            toStatus: 'DRAFT',
          },
        });
        await this.audit.record(tx, {
          actor: this.actor(principal),
          action: 'driver.license_saved',
          target: { type: 'driver_license', id },
          changes: { categories: details.categories, expiresOn: dto.expiresOn },
          meta,
        });
        return created;
      })
      .catch((error: unknown) => this.rethrowLicenseConflict(error, principal, meta));
    return toLicenseResponse(license);
  }

  async updateLicense(
    principal: Principal,
    licenseId: string,
    ifMatch: string | undefined,
    dto: LicenseDetailsDto,
    meta: RequestMeta,
  ): Promise<LicenseResponse> {
    const expected = parseIfMatch(ifMatch);
    const profile = await this.ownProfile(principal);
    const details = validateDetails(dto, addisToday());
    const license = await this.prisma
      .$transaction(async (tx) => {
        await this.eligibility.lockProfile(tx, profile.id);
        const current = await this.ownLicense(tx, profile.id, licenseId);
        if (!EDITABLE_STATUSES.includes(current.reviewStatus)) throw invalidTransition();
        if (current.version !== expected)
          throw new DomainError(ErrorCode.VERSION_CONFLICT, HttpStatus.CONFLICT);
        // Leaving REJECTED/EXPIRED first (details are frozen outside DRAFT).
        await this.reopen(tx, current.id, current.reviewStatus, principal);
        await tx.driverLicense.update({
          where: { id: current.id },
          data: {
            ...this.numberColumns(current.id, details.number),
            categories: details.categories,
            issuedOn: details.issuedOn,
            expiresOn: details.expiresOn,
            issuingAuthority: details.issuingAuthority,
            version: { increment: 1 },
          },
        });
        await this.audit.record(tx, {
          actor: this.actor(principal),
          action: 'driver.license_saved',
          target: { type: 'driver_license', id: current.id },
          changes: { categories: details.categories, expiresOn: dto.expiresOn },
          meta,
        });
        return tx.driverLicense.findUniqueOrThrow({
          where: { id: current.id },
          include: LICENSE_INCLUDE,
        });
      })
      .catch((error: unknown) => this.rethrowLicenseConflict(error, principal, meta));
    return toLicenseResponse(license);
  }

  async attachDocument(
    principal: Principal,
    licenseId: string,
    purpose: DocumentPurpose,
    documentId: string,
    meta: RequestMeta,
  ): Promise<LicenseResponse> {
    const profile = await this.ownProfile(principal);
    const license = await this.prisma.$transaction(async (tx) => {
      await this.eligibility.lockProfile(tx, profile.id);
      const current = await this.ownLicense(tx, profile.id, licenseId);
      if (!EDITABLE_STATUSES.includes(current.reviewStatus)) throw invalidTransition();
      await this.documents.assertAttachable(tx, principal.userId, documentId, purpose, current.id);
      await this.reopen(tx, current.id, current.reviewStatus, principal);
      await tx.driverLicenseDocument.upsert({
        where: { driverLicenseId_purpose: { driverLicenseId: current.id, purpose } },
        create: { driverLicenseId: current.id, documentId, purpose },
        update: { documentId },
      });
      await tx.driverLicense.update({
        where: { id: current.id },
        data: { version: { increment: 1 } },
      });
      await this.audit.record(tx, {
        actor: this.actor(principal),
        action: 'driver.license_document_attached',
        target: { type: 'driver_license', id: current.id },
        changes: { purpose, documentId },
        meta,
      });
      return tx.driverLicense.findUniqueOrThrow({
        where: { id: current.id },
        include: LICENSE_INCLUDE,
      });
    });
    return toLicenseResponse(license);
  }

  /** DRAFT -> SUBMITTED. Idempotent: a retry with the same key replays the first answer. */
  async submit(
    principal: Principal,
    licenseId: string,
    idempotencyKey: string,
    meta: RequestMeta,
  ): Promise<{ status: number; replayed: boolean; body: LicenseResponse }> {
    const profile = await this.ownProfile(principal);
    const result = await this.idempotency.execute(
      {
        scope: 'drivers.submit',
        principal: `user:${principal.userId}`,
        key: idempotencyKey,
        fingerprint: {
          method: 'POST',
          route: `/drivers/me/licenses/${licenseId}/submit`,
          body: {},
        },
      },
      async (tx) => {
        await this.eligibility.lockProfile(tx, profile.id);
        const license = await this.ownLicense(tx, profile.id, licenseId);
        if (license.reviewStatus !== 'DRAFT') throw invalidTransition();
        const user = await tx.user.findUniqueOrThrow({
          where: { id: principal.userId },
          select: { status: true, identityStatus: true },
        });
        const problems = submissionProblems(
          {
            accountStatus: user.status,
            identityStatus: user.identityStatus,
            issuedOn: isoDate(license.issuedOn),
            expiresOn: isoDate(license.expiresOn),
            documents: license.documents.map((link) => ({
              purpose: link.purpose,
              uploadStatus: link.document.uploadStatus,
              reviewStatus: link.document.reviewStatus,
            })),
          },
          addisToday(),
        );
        if (problems.length > 0) {
          throw new DomainError(
            ErrorCode.DRIVER_SUBMISSION_INCOMPLETE,
            HttpStatus.UNPROCESSABLE_ENTITY,
            problems.map((code) => ({ field: 'license', code })),
          );
        }
        const now = new Date();
        await tx.driverLicense.update({
          where: { id: license.id },
          data: {
            reviewStatus: 'SUBMITTED',
            submittedAt: now,
            decidedAt: null,
            decidedById: null,
            decisionReasonCode: null,
            decisionNote: null,
            version: { increment: 1 },
          },
        });
        await tx.document.updateMany({
          where: { id: { in: license.documents.map((link) => link.documentId) } },
          data: { reviewStatus: 'SUBMITTED' },
        });
        await tx.driverReviewEvent.create({
          data: {
            driverLicenseId: license.id,
            actorUserId: principal.userId,
            action: 'submitted',
            fromStatus: 'DRAFT',
            toStatus: 'SUBMITTED',
          },
        });
        await this.audit.record(tx, {
          actor: this.actor(principal),
          action: 'driver.verification_submitted',
          target: { type: 'driver_license', id: license.id },
          meta,
        });
        await this.outbox.enqueue(tx, {
          aggregateType: 'driver_license',
          aggregateId: license.id,
          eventType: 'driver.verification_submitted',
          payload: { userId: principal.userId, driverLicenseId: license.id },
          requestId: meta.requestId,
        });
        return { status: 200, body: { driverLicenseId: license.id } };
      },
    );
    const license = await this.prisma.driverLicense.findUniqueOrThrow({
      where: { id: licenseId },
      include: LICENSE_INCLUDE,
    });
    return { status: result.status, replayed: result.replayed, body: toLicenseResponse(license) };
  }

  private async ownLicense(
    tx: Tx,
    profileId: string,
    licenseId: string,
  ): Promise<LicenseWithDocuments> {
    const license = await tx.driverLicense.findUnique({
      where: { id: licenseId },
      include: LICENSE_INCLUDE,
    });
    if (license?.driverProfileId !== profileId) throw notFound();
    return license;
  }

  /** REJECTED | EXPIRED -> DRAFT when the driver starts changing the request again. */
  private async reopen(
    tx: Tx,
    licenseId: string,
    status: ReviewStatus,
    principal: Principal,
  ): Promise<void> {
    if (status === 'DRAFT') return;
    await tx.driverLicense.update({ where: { id: licenseId }, data: { reviewStatus: 'DRAFT' } });
    await tx.driverReviewEvent.create({
      data: {
        driverLicenseId: licenseId,
        actorUserId: principal.userId,
        action: 'reopened',
        fromStatus: status,
        toStatus: 'DRAFT',
      },
    });
  }

  private numberColumns(
    licenseId: string,
    number: string,
  ): {
    licenseNumberEnc: Uint8Array<ArrayBuffer>;
    licenseNumberHmac: string;
    licenseNumberLast4: string;
  } {
    return {
      licenseNumberEnc: new Uint8Array(
        this.encryption.encrypt(Buffer.from(number), licenseNumberAad(licenseId)),
      ),
      licenseNumberHmac: this.hasher.hmacHex('license', number),
      licenseNumberLast4: number.slice(-4),
    };
  }

  /** Duplicate licence numbers: 409, flagged for officers (S-1 document fraud). */
  private async rethrowLicenseConflict(
    error: unknown,
    principal: Principal,
    meta: RequestMeta,
  ): Promise<never> {
    if (!isLicenseNumberConflict(error)) throw error;
    await this.audit.record(this.prisma, {
      actor: this.actor(principal),
      action: 'driver.duplicate_license_detected',
      target: { type: 'user', id: principal.userId },
      meta,
    });
    throw new DomainError(ErrorCode.LICENSE_NUMBER_IN_USE, HttpStatus.CONFLICT);
  }
}
