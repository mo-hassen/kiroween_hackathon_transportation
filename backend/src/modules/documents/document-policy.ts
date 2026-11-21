import type { AccountType, DocumentPurpose } from '../../generated/prisma/client.js';
import type { RateLimitRule } from '../../common/rate-limit/rate-limit.service.js';
import { ALLOWED_MIME_TYPES, type AllowedMimeType } from './file-inspection.js';

/** Images only: re-encoded without metadata. PDFs are not accepted for owner documents. */
const IMAGE_TYPES: readonly AllowedMimeType[] = ['image/jpeg', 'image/png', 'image/webp'];

const MB = 1024 * 1024;

export interface PurposePolicy {
  readonly accountTypes: readonly AccountType[];
  readonly mimeTypes: readonly AllowedMimeType[];
  readonly maxBytes: number;
}

/**
 * Who may upload what (07 §4: documents ≤ 10 MB, photos ≤ 5 MB). Later phases add their
 * purposes here; a purpose without a policy cannot be uploaded.
 */
export const PURPOSE_POLICIES: Readonly<Record<DocumentPurpose, PurposePolicy>> = Object.freeze({
  DRIVER_LICENSE_FRONT: {
    accountTypes: ['CUSTOMER'],
    mimeTypes: ALLOWED_MIME_TYPES,
    maxBytes: 10 * MB,
  },
  DRIVER_LICENSE_BACK: {
    accountTypes: ['CUSTOMER'],
    mimeTypes: ALLOWED_MIME_TYPES,
    maxBytes: 10 * MB,
  },
  // Phase 6: organization owners (photos of paper documents).
  OWNER_TIN: { accountTypes: ['CUSTOMER'], mimeTypes: IMAGE_TYPES, maxBytes: 10 * MB },
  OWNER_BUSINESS_LICENSE: { accountTypes: ['CUSTOMER'], mimeTypes: IMAGE_TYPES, maxBytes: 10 * MB },
  OWNER_REPRESENTATIVE_LETTER: {
    accountTypes: ['CUSTOMER'],
    mimeTypes: IMAGE_TYPES,
    maxBytes: 10 * MB,
  },
});

export const DOCUMENT_LIMITS = Object.freeze({
  /** Hard ceiling for any document (matches the database CHECK). */
  maxBytes: 10 * MB,
  uploadUrlTtlSeconds: 5 * 60,
  downloadUrlTtlSeconds: 60,
  /** A completion that crashed mid-way may be taken over after this. */
  processingTimeoutMs: 2 * 60_000,
  /** An object may be uploaded until the intent expires (plus clock tolerance). */
  uploadGraceMs: 60_000,
});

export const DOCUMENT_RATE_LIMITS = Object.freeze({
  // 04 "Uploads per user 30 / hour".
  intentsPerUser: { name: 'documents-intent-user-1h', limit: 30, windowMs: 60 * 60_000 },
  completePerUser: { name: 'documents-complete-user-1h', limit: 60, windowMs: 60 * 60_000 },
  downloadsPerUser: { name: 'documents-download-user-1m', limit: 60, windowMs: 60_000 },
} satisfies Record<string, RateLimitRule>);

export function uploadKeyFor(documentId: string): string {
  return `incoming/${documentId}`;
}

export function storageKeyFor(documentId: string, now: Date): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `documents/${year}/${month}/${documentId}`;
}

export function fileExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return 'pdf';
  }
}
