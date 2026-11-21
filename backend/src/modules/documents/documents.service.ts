import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { assertVisible } from '../../common/auth/policy.js';
import type { Principal } from '../../common/auth/principal.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { uuidv7 } from '../../common/crypto/uuid.js';
import { DomainError, ErrorCode, validationError } from '../../common/http/problem-details.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service.js';
import type { Document, DocumentPurpose, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import {
  ObjectStorage,
  ObjectTooLargeError,
  type PresignedRequest,
} from '../../infrastructure/storage/object-storage.js';
import { FileScanner, ScannerUnavailableError } from '../../providers/scanner/file-scanner.js';
import {
  DOCUMENT_LIMITS,
  DOCUMENT_RATE_LIMITS,
  fileExtension,
  PURPOSE_POLICIES,
  storageKeyFor,
  uploadKeyFor,
} from './document-policy.js';
import type {
  CreateUploadIntentDto,
  DocumentResponse,
  UploadIntentResponse,
} from './dto/document.dto.js';
import { InspectionError, inspectAndSanitize, sha256Hex } from './file-inspection.js';

type Tx = Prisma.TransactionClient;

/** Failure codes stored on a document and returned to its owner. */
export const DocumentFailure = {
  UPLOAD_EXPIRED: 'UPLOAD_EXPIRED',
  SIZE_MISMATCH: 'SIZE_MISMATCH',
  TOO_LARGE: 'TOO_LARGE',
  CHECKSUM_MISMATCH: 'CHECKSUM_MISMATCH',
  UNSUPPORTED_TYPE: 'UNSUPPORTED_TYPE',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  MALFORMED_FILE: 'MALFORMED_FILE',
  ACTIVE_CONTENT: 'ACTIVE_CONTENT',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  MALWARE_DETECTED: 'MALWARE_DETECTED',
} as const;
type DocumentFailure = (typeof DocumentFailure)[keyof typeof DocumentFailure];

export function toDocumentResponse(document: Document): DocumentResponse {
  return {
    id: document.id,
    purpose: document.purpose,
    uploadStatus: document.uploadStatus,
    reviewStatus: document.reviewStatus,
    mimeType: document.mimeType ?? document.declaredMimeType,
    sizeBytes: document.sizeBytes ?? document.declaredSizeBytes,
    failureCode: document.failureCode,
    createdAt: document.createdAt.toISOString(),
    processedAt: document.processedAt?.toISOString() ?? null,
  };
}

function notFound(): DomainError {
  return new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
}

/**
 * Private document storage (docs/architecture/07-security-architecture.md §4).
 *
 * The client uploads to a one-off incoming key with a 5-minute presigned PUT. Completion
 * reads the object back, verifies size, SHA-256 and the real file type, re-encodes images
 * (dropping all metadata), scans the original bytes, and only then writes the sole
 * downloadable copy under a different key. Re-uploading to the incoming key afterwards
 * changes nothing that is ever served.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger('Documents');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ObjectStorage,
    private readonly scanner: FileScanner,
    private readonly rateLimits: RateLimitService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async createUploadIntent(
    principal: Principal,
    dto: CreateUploadIntentDto,
    meta: RequestMeta,
  ): Promise<UploadIntentResponse> {
    const policy = PURPOSE_POLICIES[dto.purpose];
    if (!policy.accountTypes.includes(principal.accountType)) throw notFound();
    if (!(policy.mimeTypes as readonly string[]).includes(dto.mimeType)) {
      throw validationError('mimeType', 'UNSUPPORTED_TYPE');
    }
    if (dto.sizeBytes > policy.maxBytes) throw validationError('sizeBytes', 'TOO_LARGE');
    await this.assertPurposeAllowed(principal.userId, dto.purpose);
    await this.rateLimits.consume(DOCUMENT_RATE_LIMITS.intentsPerUser, principal.userId);

    const now = new Date();
    const id = uuidv7(now.getTime());
    const document = await this.prisma.$transaction(async (tx) => {
      const created = await tx.document.create({
        data: {
          id,
          ownerUserId: principal.userId,
          purpose: dto.purpose,
          uploadKey: uploadKeyFor(id),
          declaredMimeType: dto.mimeType,
          declaredSizeBytes: dto.sizeBytes,
          sha256: dto.sha256.toLowerCase(),
          uploadExpiresAt: new Date(now.getTime() + DOCUMENT_LIMITS.uploadUrlTtlSeconds * 1000),
        },
      });
      await this.audit.record(tx, {
        actor: { type: 'USER', userId: principal.userId },
        action: 'document.upload_initiated',
        target: { type: 'document', id },
        changes: { purpose: dto.purpose, mimeType: dto.mimeType, sizeBytes: dto.sizeBytes },
        meta,
      });
      return created;
    });
    const upload = await this.storage.presignPut(document.uploadKey, {
      contentType: dto.mimeType,
      contentLength: dto.sizeBytes,
      expiresInSeconds: DOCUMENT_LIMITS.uploadUrlTtlSeconds,
    });
    return { document: toDocumentResponse(document), upload: presentedRequest(upload) };
  }

  /**
   * Driver licence images need a driver profile; organization documents need an
   * ORGANIZATION owner profile (individual owners upload nothing).
   */
  private async assertPurposeAllowed(userId: string, purpose: DocumentPurpose): Promise<void> {
    if (purpose.startsWith('OWNER_')) {
      const owner = await this.prisma.ownerProfile.findUnique({
        where: { userId },
        select: { ownerType: true },
      });
      if (owner?.ownerType !== 'ORGANIZATION') {
        throw new DomainError(ErrorCode.OWNER_PROFILE_REQUIRED, HttpStatus.CONFLICT);
      }
      return;
    }
    if (purpose.startsWith('VEHICLE_')) {
      // Only a verified owner registers vehicles; nothing is stored for anyone else.
      const owner = await this.prisma.ownerProfile.findUnique({
        where: { userId },
        select: { verificationStatus: true },
      });
      if (owner === null)
        throw new DomainError(ErrorCode.OWNER_PROFILE_REQUIRED, HttpStatus.CONFLICT);
      if (owner.verificationStatus !== 'VERIFIED') {
        throw new DomainError(ErrorCode.OWNER_NOT_VERIFIED, HttpStatus.CONFLICT);
      }
      return;
    }
    if (purpose.startsWith('DRIVER_LICENSE_')) {
      const profile = await this.prisma.driverProfile.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (profile === null) {
        throw new DomainError(ErrorCode.DRIVER_PROFILE_REQUIRED, HttpStatus.CONFLICT);
      }
    }
  }

  async get(principal: Principal, documentId: string): Promise<DocumentResponse> {
    return toDocumentResponse(await this.owned(principal, documentId));
  }

  private async owned(principal: Principal, documentId: string): Promise<Document> {
    const document = await this.prisma.document.findUnique({ where: { id: documentId } });
    return assertVisible(principal, document, (p, d) => d.ownerUserId === p.userId);
  }

  /** Completes an upload. Safe to retry; concurrent calls are serialized by a claim. */
  async complete(
    principal: Principal,
    documentId: string,
    meta: RequestMeta,
  ): Promise<DocumentResponse> {
    await this.rateLimits.consume(DOCUMENT_RATE_LIMITS.completePerUser, principal.userId);
    const document = await this.owned(principal, documentId);
    if (!['PENDING_UPLOAD', 'UPLOADED', 'PROCESSING'].includes(document.uploadStatus)) {
      return toDocumentResponse(document);
    }

    const now = new Date();
    const staleBefore = new Date(now.getTime() - DOCUMENT_LIMITS.processingTimeoutMs);
    const claimed = await this.prisma.document.updateMany({
      where: {
        id: documentId,
        OR: [
          { uploadStatus: { in: ['PENDING_UPLOAD', 'UPLOADED'] } },
          { uploadStatus: 'PROCESSING', processingAt: { lt: staleBefore } },
        ],
      },
      data: { uploadStatus: 'PROCESSING', processingAt: now, version: { increment: 1 } },
    });
    if (claimed.count !== 1)
      throw new DomainError(ErrorCode.DOCUMENT_PROCESSING, HttpStatus.CONFLICT);

    try {
      return toDocumentResponse(await this.process(document, now, principal, meta));
    } catch (error) {
      // Anything unexpected: back to a retryable state, never AVAILABLE.
      await this.prisma.document.updateMany({
        where: { id: documentId, uploadStatus: 'PROCESSING' },
        data: { uploadStatus: 'UPLOADED', processingAt: null },
      });
      throw error;
    }
  }

  private async process(
    document: Document,
    now: Date,
    principal: Principal,
    meta: RequestMeta,
  ): Promise<Document> {
    const maxBytes = Math.min(
      PURPOSE_POLICIES[document.purpose].maxBytes,
      DOCUMENT_LIMITS.maxBytes,
    );
    const info = await this.storage.head(document.uploadKey);
    if (info === null) {
      if (now.getTime() > document.uploadExpiresAt.getTime() + DOCUMENT_LIMITS.uploadGraceMs) {
        return this.fail(document, DocumentFailure.UPLOAD_EXPIRED, principal, meta);
      }
      await this.prisma.document.update({
        where: { id: document.id },
        data: { uploadStatus: 'PENDING_UPLOAD', processingAt: null },
      });
      throw new DomainError(ErrorCode.UPLOAD_NOT_FOUND, HttpStatus.CONFLICT);
    }
    if (info.sizeBytes > maxBytes)
      return this.fail(document, DocumentFailure.TOO_LARGE, principal, meta);
    if (info.sizeBytes !== document.declaredSizeBytes) {
      return this.fail(document, DocumentFailure.SIZE_MISMATCH, principal, meta);
    }

    let bytes: Buffer | null;
    try {
      bytes = await this.storage.read(document.uploadKey, maxBytes);
    } catch (error) {
      if (error instanceof ObjectTooLargeError) {
        return this.fail(document, DocumentFailure.TOO_LARGE, principal, meta);
      }
      throw error;
    }
    if (bytes === null) throw new DomainError(ErrorCode.UPLOAD_NOT_FOUND, HttpStatus.CONFLICT);
    if (bytes.length !== document.declaredSizeBytes) {
      return this.fail(document, DocumentFailure.SIZE_MISMATCH, principal, meta);
    }
    if (sha256Hex(bytes) !== document.sha256) {
      return this.fail(document, DocumentFailure.CHECKSUM_MISMATCH, principal, meta);
    }

    let sanitized;
    try {
      sanitized = await inspectAndSanitize(bytes, document.declaredMimeType);
    } catch (error) {
      if (error instanceof InspectionError) return this.fail(document, error.code, principal, meta);
      throw error;
    }

    // Scan the bytes exactly as received (the payload, if any, is in the original).
    let scan;
    try {
      scan = await this.scanner.scan(bytes);
    } catch (error) {
      if (error instanceof ScannerUnavailableError) {
        this.logger.warn(
          { documentId: document.id, detail: error.detail },
          'Document scan unavailable',
        );
        await this.prisma.document.update({
          where: { id: document.id },
          data: { uploadStatus: 'UPLOADED', processingAt: null },
        });
        await this.audit.record(this.prisma, {
          actor: { type: 'SYSTEM' },
          action: 'document.scan_unavailable',
          target: { type: 'document', id: document.id },
          changes: { scanner: this.scanner.id },
        });
        throw new DomainError(ErrorCode.DOCUMENT_SCAN_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE);
      }
      throw error;
    }
    if (scan.verdict === 'INFECTED') {
      return this.fail(document, DocumentFailure.MALWARE_DETECTED, principal, meta, {
        scanner: scan.engine,
        signature: scan.signature,
      });
    }

    const storageKey = storageKeyFor(document.id, now);
    await this.storage.write(storageKey, sanitized.bytes, sanitized.mimeType);
    const available = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.document.update({
        where: { id: document.id },
        data: {
          uploadStatus: 'AVAILABLE',
          storageKey,
          mimeType: sanitized.mimeType,
          sizeBytes: sanitized.bytes.length,
          storedSha256: sha256Hex(sanitized.bytes),
          processedAt: new Date(),
          scanEngine: scan.engine,
          failureCode: null,
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        actor: { type: 'USER', userId: principal.userId },
        action: 'document.upload_completed',
        target: { type: 'document', id: document.id },
        changes: {
          mimeType: sanitized.mimeType,
          metadataRemoved: sanitized.metadataRemoved,
          scanner: scan.engine,
          verdict: 'CLEAN',
        },
        meta,
      });
      await this.outbox.enqueue(tx, {
        aggregateType: 'document',
        aggregateId: document.id,
        eventType: 'document.available',
        payload: {
          documentId: document.id,
          ownerUserId: document.ownerUserId,
          purpose: document.purpose,
        },
        requestId: meta.requestId,
      });
      return updated;
    });
    await this.deleteQuietly(document.uploadKey);
    return available;
  }

  private async fail(
    document: Document,
    code: DocumentFailure,
    principal: Principal,
    meta: RequestMeta,
    extra: Record<string, string> = {},
  ): Promise<Document> {
    const status = code === DocumentFailure.MALWARE_DETECTED ? 'INFECTED' : 'INVALID';
    const failed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.document.update({
        where: { id: document.id },
        data: {
          uploadStatus: status,
          failureCode: code,
          processedAt: new Date(),
          version: { increment: 1 },
        },
      });
      await this.audit.record(tx, {
        actor: { type: 'USER', userId: principal.userId },
        action: status === 'INFECTED' ? 'document.malware_detected' : 'document.validation_failed',
        target: { type: 'document', id: document.id },
        changes: { failureCode: code, ...extra },
        meta,
      });
      return updated;
    });
    await this.deleteQuietly(document.uploadKey);
    return failed;
  }

  private async deleteQuietly(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch {
      this.logger.warn('Could not delete an incoming document object');
    }
  }

  /** Owner download: 60-second URL to the processed copy. */
  async downloadUrl(principal: Principal, documentId: string): Promise<PresignedRequest> {
    await this.rateLimits.consume(DOCUMENT_RATE_LIMITS.downloadsPerUser, principal.userId);
    const document = await this.owned(principal, documentId);
    return this.signedGet(document);
  }

  /**
   * Staff download. The caller (a review service) has already checked the staff member's
   * permission and relationship to the case; this records the access with its reason.
   */
  async staffDownloadUrl(
    tx: Tx,
    documentId: string,
    staff: { userId: string; reason: string; caseType: string; caseId: string },
    meta: RequestMeta,
  ): Promise<PresignedRequest> {
    const document = await tx.document.findUnique({ where: { id: documentId } });
    if (document === null) throw notFound();
    await this.audit.record(tx, {
      actor: { type: 'STAFF', userId: staff.userId },
      action: 'document.viewed_by_staff',
      target: { type: 'document', id: document.id },
      reason: staff.reason,
      changes: { caseType: staff.caseType, caseId: staff.caseId, purpose: document.purpose },
      meta,
    });
    return this.signedGet(document);
  }

  private async signedGet(document: Document): Promise<PresignedRequest> {
    if (
      document.uploadStatus !== 'AVAILABLE' ||
      document.storageKey === null ||
      document.mimeType === null
    ) {
      throw new DomainError(ErrorCode.DOCUMENT_NOT_AVAILABLE, HttpStatus.CONFLICT);
    }
    return this.storage.presignGet(document.storageKey, {
      contentType: document.mimeType,
      // PDFs always download; images may be shown inline in the officer's browser.
      disposition: document.mimeType === 'application/pdf' ? 'attachment' : 'inline',
      fileName: `${document.purpose.toLowerCase()}.${fileExtension(document.mimeType)}`,
      expiresInSeconds: DOCUMENT_LIMITS.downloadUrlTtlSeconds,
    });
  }

  /**
   * A document the user may attach: own, the right purpose, AVAILABLE, never reviewed, not
   * attached elsewhere (the link table's unique key and trigger enforce this as well).
   */
  async assertAttachable(
    tx: Tx,
    userId: string,
    documentId: string,
    purpose: DocumentPurpose,
    attachedToLicenseId: string,
  ): Promise<void> {
    const document = await tx.document.findUnique({
      where: { id: documentId },
      include: { licenseLink: true },
    });
    if (document === null || document.ownerUserId !== userId) throw notFound();
    if (
      document.purpose !== purpose ||
      document.uploadStatus !== 'AVAILABLE' ||
      document.reviewStatus !== 'DRAFT' ||
      (document.licenseLink !== null &&
        document.licenseLink.driverLicenseId !== attachedToLicenseId)
    ) {
      throw new DomainError(ErrorCode.DOCUMENT_NOT_AVAILABLE, HttpStatus.CONFLICT);
    }
  }
}

/** Rejects anything an owner may not attach (same rules as licences, for owner links). */
export async function assertAttachableToOwner(
  tx: Tx,
  userId: string,
  documentId: string,
  purpose: DocumentPurpose,
  ownerProfileId: string,
): Promise<void> {
  const document = await tx.document.findUnique({
    where: { id: documentId },
    include: { ownerLink: true },
  });
  if (document === null || document.ownerUserId !== userId) throw notFound();
  if (
    document.purpose !== purpose ||
    document.uploadStatus !== 'AVAILABLE' ||
    document.reviewStatus !== 'DRAFT' ||
    (document.ownerLink !== null && document.ownerLink.ownerProfileId !== ownerProfileId)
  ) {
    throw new DomainError(ErrorCode.DOCUMENT_NOT_AVAILABLE, HttpStatus.CONFLICT);
  }
}

/**
 * Rejects anything an owner may not attach to a vehicle slot. Someone else's document is 404;
 * a document already linked to a different vehicle (or used elsewhere) is 409, so a photo of
 * vehicle A can never become evidence for vehicle B.
 */
export async function assertAttachableToVehicle(
  tx: Tx,
  userId: string,
  documentId: string,
  purpose: DocumentPurpose,
  vehicleId: string,
  slot: string,
): Promise<void> {
  const document = await tx.document.findUnique({
    where: { id: documentId },
    include: { vehicleLink: true, licenseLink: true, ownerLink: true },
  });
  if (document === null || document.ownerUserId !== userId) throw notFound();
  const link = document.vehicleLink;
  if (
    document.purpose !== purpose ||
    document.uploadStatus !== 'AVAILABLE' ||
    document.reviewStatus !== 'DRAFT' ||
    document.licenseLink !== null ||
    document.ownerLink !== null ||
    (link !== null && (link.vehicleId !== vehicleId || link.slot !== slot))
  ) {
    throw new DomainError(ErrorCode.DOCUMENT_NOT_AVAILABLE, HttpStatus.CONFLICT);
  }
}

function presentedRequest(request: PresignedRequest): UploadIntentResponse['upload'] {
  return {
    url: request.url,
    method: request.method,
    headers: { ...request.headers },
    expiresAt: request.expiresAt.toISOString(),
  };
}
