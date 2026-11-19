import type {
  AccountStatus,
  DocumentUploadStatus,
  DriverEligibility,
  IdentityStatus,
  ReviewStatus,
} from '../../generated/prisma/client.js';

/**
 * Driver verification rules (docs/architecture/02-domain-model-and-rules.md §3.3 and §3.5).
 * Plain data and pure functions, tested exhaustively. The migration's trigger enforces the
 * same transition table in the database.
 */

/** Review transitions of a driver licence case. */
export const REVIEW_TRANSITIONS: Readonly<Record<ReviewStatus, readonly ReviewStatus[]>> =
  Object.freeze({
    // Driver submits.
    DRAFT: ['SUBMITTED'],
    // Officer claims.
    SUBMITTED: ['UNDER_REVIEW'],
    // Release or claim takeover (UNDER_REVIEW -> UNDER_REVIEW with another officer), decision.
    UNDER_REVIEW: ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'],
    // Driver edits to resubmit.
    REJECTED: ['DRAFT'],
    // Licence expiry (job); officer suspension.
    APPROVED: ['EXPIRED', 'SUSPENDED'],
    // Officer reinstates; expiry still applies while suspended.
    SUSPENDED: ['APPROVED', 'EXPIRED'],
    // Driver enters a renewed licence.
    EXPIRED: ['DRAFT'],
  });

export function canTransition(from: ReviewStatus, to: ReviewStatus): boolean {
  return REVIEW_TRANSITIONS[from].includes(to);
}

/** Statuses in which the driver may still change the licence details or documents. */
export const EDITABLE_STATUSES: readonly ReviewStatus[] = ['DRAFT', 'REJECTED', 'EXPIRED'];

export const REVIEW_CLAIM_TTL_MS = 30 * 60_000;

/** Addis Ababa is UTC+3 all year (no DST); licence dates are local calendar dates. */
const ADDIS_OFFSET_MS = 3 * 60 * 60 * 1000;

export function addisToday(now: Date = new Date()): string {
  return new Date(now.getTime() + ADDIS_OFFSET_MS).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` of a Prisma @db.Date value (stored as UTC midnight). */
export function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || isoDate(date) !== value ? null : date;
}

/**
 * Licence number: upper case, separators (space, hyphen, slash, dot) removed, 4-20 letters
 * or digits. [LEGAL][ASSUMPTION] No official Ethiopian format is assumed beyond that.
 */
export function normalizeLicenseNumber(input: string): string | null {
  const value = input.toUpperCase().replace(/[\s\-/.]/g, '');
  return /^[A-Z0-9]{4,20}$/.test(value) ? value : null;
}

/**
 * Licence categories as printed on the licence. [LEGAL] The official Ethiopian category
 * codes and which categories may drive which vehicle types commercially are not confirmed
 * (docs/architecture/12, L-4), so codes are stored as given: 1-10 distinct codes of 1-10
 * upper-case letters, digits or hyphens. Category-to-vehicle matching is Phase 7+.
 */
export function normalizeCategories(input: readonly string[]): string[] | null {
  const codes = input.map((code) => code.trim().toUpperCase());
  if (codes.length < 1 || codes.length > 10) return null;
  if (!codes.every((code) => /^[A-Z0-9][A-Z0-9-]{0,9}$/.test(code))) return null;
  return new Set(codes).size === codes.length ? codes : null;
}

export type EligibilityBlocker =
  | 'ACCOUNT_NOT_ACTIVE'
  | 'IDENTITY_NOT_VERIFIED'
  | 'LICENSE_MISSING'
  | 'LICENSE_NOT_APPROVED'
  | 'LICENSE_EXPIRED'
  | 'DOCUMENTS_NOT_APPROVED'
  | 'DRIVER_SUSPENDED';

export interface EligibilityFacts {
  readonly accountStatus: AccountStatus;
  readonly identityStatus: IdentityStatus;
  readonly suspended: boolean;
  readonly license: {
    readonly reviewStatus: ReviewStatus;
    readonly expiresOn: string;
    readonly documents: readonly {
      readonly purpose: string;
      readonly uploadStatus: DocumentUploadStatus;
      readonly reviewStatus: ReviewStatus;
    }[];
  } | null;
}

export interface EligibilityResult {
  readonly status: DriverEligibility;
  readonly blockers: readonly EligibilityBlocker[];
}

const REQUIRED_PURPOSES = ['DRIVER_LICENSE_FRONT', 'DRIVER_LICENSE_BACK'];

/**
 * 02 §3.5 for Phase 5: eligible = account ACTIVE ∧ identity VERIFIED ∧ licence APPROVED and
 * not expired ∧ front and back documents AVAILABLE and APPROVED ∧ profile not suspended.
 * (Category-to-vehicle matching needs vehicles: Phase 7.)
 */
export function evaluateEligibility(facts: EligibilityFacts, today: string): EligibilityResult {
  const blockers: EligibilityBlocker[] = [];
  if (facts.suspended) blockers.push('DRIVER_SUSPENDED');
  if (facts.accountStatus !== 'ACTIVE') blockers.push('ACCOUNT_NOT_ACTIVE');
  if (facts.identityStatus !== 'VERIFIED') blockers.push('IDENTITY_NOT_VERIFIED');
  const license = facts.license;
  if (license === null) {
    blockers.push('LICENSE_MISSING');
  } else {
    if (license.expiresOn <= today) blockers.push('LICENSE_EXPIRED');
    if (license.reviewStatus !== 'APPROVED') blockers.push('LICENSE_NOT_APPROVED');
    const approved = REQUIRED_PURPOSES.every((purpose) =>
      license.documents.some(
        (document) =>
          document.purpose === purpose &&
          document.uploadStatus === 'AVAILABLE' &&
          document.reviewStatus === 'APPROVED',
      ),
    );
    if (!approved) blockers.push('DOCUMENTS_NOT_APPROVED');
  }
  if (facts.suspended) return { status: 'SUSPENDED', blockers };
  return { status: blockers.length === 0 ? 'ELIGIBLE' : 'INELIGIBLE', blockers };
}

export type SubmissionProblem =
  | 'IDENTITY_NOT_VERIFIED'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'LICENSE_EXPIRED'
  | 'LICENSE_NOT_YET_ISSUED'
  | 'FRONT_DOCUMENT_MISSING'
  | 'BACK_DOCUMENT_MISSING';

export interface SubmissionFacts {
  readonly accountStatus: AccountStatus;
  readonly identityStatus: IdentityStatus;
  readonly issuedOn: string;
  readonly expiresOn: string;
  readonly documents: readonly {
    readonly purpose: string;
    readonly uploadStatus: DocumentUploadStatus;
    readonly reviewStatus: ReviewStatus;
  }[];
}

/** What blocks a submission. Documents must be AVAILABLE and never reviewed (DRAFT). */
export function submissionProblems(facts: SubmissionFacts, today: string): SubmissionProblem[] {
  const problems: SubmissionProblem[] = [];
  if (facts.accountStatus !== 'ACTIVE') problems.push('ACCOUNT_NOT_ACTIVE');
  if (facts.identityStatus !== 'VERIFIED') problems.push('IDENTITY_NOT_VERIFIED');
  if (facts.expiresOn <= today) problems.push('LICENSE_EXPIRED');
  if (facts.issuedOn > today) problems.push('LICENSE_NOT_YET_ISSUED');
  const usable = (purpose: string): boolean =>
    facts.documents.some(
      (document) =>
        document.purpose === purpose &&
        document.uploadStatus === 'AVAILABLE' &&
        document.reviewStatus === 'DRAFT',
    );
  if (!usable('DRIVER_LICENSE_FRONT')) problems.push('FRONT_DOCUMENT_MISSING');
  if (!usable('DRIVER_LICENSE_BACK')) problems.push('BACK_DOCUMENT_MISSING');
  return problems;
}

/** Reason codes an officer may use, per decision. */
export const REJECT_REASONS = [
  'BLURRY',
  'MISMATCH_NAME',
  'EXPIRED',
  'NOT_OWNER',
  'INCOMPLETE',
  'INVALID_LICENSE_DETAILS',
  'SUSPECTED_FRAUD',
  'OTHER',
] as const;
export const SUSPEND_REASONS = ['SUSPECTED_FRAUD', 'SAFETY_CONCERN', 'NOT_OWNER', 'OTHER'] as const;
