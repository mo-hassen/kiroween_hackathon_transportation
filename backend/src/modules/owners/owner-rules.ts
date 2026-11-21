import type {
  AccountStatus,
  DocumentPurpose,
  DocumentUploadStatus,
  IdentityStatus,
  OwnerType,
  OwnerVerificationStatus,
  ReviewReasonCode,
  ReviewStatus,
} from '../../generated/prisma/client.js';

/**
 * Owner verification rules (docs/architecture/02-domain-model-and-rules.md §3.4). Pure
 * functions: the services and the database trigger `owner_profiles_guard` enforce the same
 * table, and test/integration/owner-db-constraints.spec.ts checks they agree.
 */
export const OWNER_TRANSITIONS: Readonly<
  Record<OwnerVerificationStatus, readonly OwnerVerificationStatus[]>
> = Object.freeze({
  UNVERIFIED: ['PENDING'],
  PENDING: ['VERIFIED', 'REJECTED'],
  REJECTED: ['PENDING'],
  VERIFIED: ['SUSPENDED', 'EXPIRED', 'REVERIFICATION_REQUIRED'],
  SUSPENDED: ['VERIFIED', 'REVERIFICATION_REQUIRED'],
  EXPIRED: ['PENDING'],
  REVERIFICATION_REQUIRED: ['PENDING'],
});

export function canTransition(from: OwnerVerificationStatus, to: OwnerVerificationStatus): boolean {
  return OWNER_TRANSITIONS[from].includes(to);
}

/** The owner may change details and documents (and submit) only in these statuses. */
export const EDITABLE_STATUSES: readonly OwnerVerificationStatus[] = [
  'UNVERIFIED',
  'REJECTED',
  'EXPIRED',
  'REVERIFICATION_REQUIRED',
];

/** The owner type itself may only change before a first submission or after a rejection. */
export const TYPE_CHANGE_STATUSES: readonly OwnerVerificationStatus[] = ['UNVERIFIED', 'REJECTED'];

export const OWNER_REJECT_REASONS: readonly ReviewReasonCode[] = [
  'BLURRY',
  'MISMATCH_NAME',
  'EXPIRED',
  'INCOMPLETE',
  'INVALID_ORGANIZATION_DETAILS',
  'REPRESENTATIVE_NOT_AUTHORIZED',
  'SUSPECTED_FRAUD',
  'OTHER',
];
export const OWNER_SUSPEND_REASONS: readonly ReviewReasonCode[] = [
  'SUSPECTED_FRAUD',
  'SAFETY_CONCERN',
  'NOT_OWNER',
  'OTHER',
];

/** Organization documents (08 §7). Individual owners need no owner-specific document. */
export const ORGANIZATION_DOCUMENTS: readonly DocumentPurpose[] = [
  'OWNER_TIN',
  'OWNER_BUSINESS_LICENSE',
  'OWNER_REPRESENTATIVE_LETTER',
];

export function requiredDocuments(type: OwnerType): readonly DocumentPurpose[] {
  return type === 'ORGANIZATION' ? ORGANIZATION_DOCUMENTS : [];
}

/**
 * [ASSUMPTION] No official Ethiopian TIN format is used: upper case, spaces, hyphens,
 * slashes and dots removed, then 4–20 letters and digits. Officers compare it with the TIN
 * document; the HMAC only detects reuse across accounts.
 */
export function normalizeTin(input: string): string | null {
  const value = input.toUpperCase().replace(/[\s\-/.]/g, '');
  return /^[A-Z0-9]{4,20}$/.test(value) ? value : null;
}

/** Trimmed, inner whitespace collapsed, 2–200 characters, no control characters. */
export function normalizeOrganizationName(input: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input)) return null;
  const value = input.trim().replace(/\s+/g, ' ');
  return value.length >= 2 && value.length <= 200 ? value : null;
}

export function maskTin(last4: string): string {
  return `••••${last4}`;
}

export interface LinkedDocumentFacts {
  readonly purpose: DocumentPurpose;
  readonly uploadStatus: DocumentUploadStatus;
  readonly reviewStatus: ReviewStatus;
}

export type SubmissionProblem =
  | 'ACCOUNT_NOT_ACTIVE'
  | 'IDENTITY_NOT_VERIFIED'
  | 'ORGANIZATION_DETAILS_MISSING'
  | 'TIN_DOCUMENT_MISSING'
  | 'BUSINESS_LICENSE_MISSING'
  | 'REPRESENTATIVE_LETTER_MISSING';

const MISSING: Readonly<Record<string, SubmissionProblem>> = {
  OWNER_TIN: 'TIN_DOCUMENT_MISSING',
  OWNER_BUSINESS_LICENSE: 'BUSINESS_LICENSE_MISSING',
  OWNER_REPRESENTATIVE_LETTER: 'REPRESENTATIVE_LETTER_MISSING',
};

export interface SubmissionFacts {
  readonly accountStatus: AccountStatus;
  readonly identityStatus: IdentityStatus;
  readonly ownerType: OwnerType;
  readonly hasOrganizationDetails: boolean;
  readonly documents: readonly LinkedDocumentFacts[];
}

/**
 * What blocks a submission. A required document must be AVAILABLE and never part of an
 * earlier decision (a decided document is never resubmitted: new upload).
 */
export function submissionProblems(facts: SubmissionFacts): SubmissionProblem[] {
  const problems: SubmissionProblem[] = [];
  if (facts.accountStatus !== 'ACTIVE') problems.push('ACCOUNT_NOT_ACTIVE');
  if (facts.identityStatus !== 'VERIFIED') problems.push('IDENTITY_NOT_VERIFIED');
  if (facts.ownerType === 'ORGANIZATION' && !facts.hasOrganizationDetails) {
    problems.push('ORGANIZATION_DETAILS_MISSING');
  }
  for (const purpose of requiredDocuments(facts.ownerType)) {
    const usable = facts.documents.some(
      (d) => d.purpose === purpose && d.uploadStatus === 'AVAILABLE' && d.reviewStatus === 'DRAFT',
    );
    if (!usable) problems.push(MISSING[purpose] as SubmissionProblem);
  }
  return problems;
}

export type ApprovalBlocker = 'ACCOUNT_NOT_ACTIVE' | 'IDENTITY_NOT_VERIFIED' | 'DOCUMENTS_MISSING';

export interface ApprovalFacts {
  readonly accountStatus: AccountStatus;
  readonly identityStatus: IdentityStatus;
  readonly ownerType: OwnerType;
  readonly documents: readonly LinkedDocumentFacts[];
}

/** Re-checked inside every approval transaction (not only at submission). */
export function approvalBlockers(facts: ApprovalFacts): ApprovalBlocker[] {
  const blockers: ApprovalBlocker[] = [];
  if (facts.accountStatus !== 'ACTIVE') blockers.push('ACCOUNT_NOT_ACTIVE');
  if (facts.identityStatus !== 'VERIFIED') blockers.push('IDENTITY_NOT_VERIFIED');
  const complete = requiredDocuments(facts.ownerType).every((purpose) =>
    facts.documents.some((d) => d.purpose === purpose && d.uploadStatus === 'AVAILABLE'),
  );
  if (!complete) blockers.push('DOCUMENTS_MISSING');
  return blockers;
}

export type ApprovalAction = 'APPROVE_INDIVIDUAL' | 'FIRST_APPROVAL' | 'SECOND_APPROVAL';

/**
 * Four-eyes rule for organizations [ASSUMPTION 08 §7]: a first approval by one officer, then
 * a second approval by a different officer. Individuals have a single approval. Returns the
 * reason the action is refused, or null when it is allowed for this officer.
 */
export function approvalRefusal(
  action: ApprovalAction,
  owner: { readonly ownerType: OwnerType; readonly firstApprovedById: string | null },
  officerId: string,
):
  | 'WRONG_OWNER_TYPE'
  | 'ALREADY_FIRST_APPROVED'
  | 'FIRST_APPROVAL_REQUIRED'
  | 'SAME_OFFICER'
  | null {
  switch (action) {
    case 'APPROVE_INDIVIDUAL':
      return owner.ownerType === 'INDIVIDUAL' ? null : 'WRONG_OWNER_TYPE';
    case 'FIRST_APPROVAL':
      if (owner.ownerType !== 'ORGANIZATION') return 'WRONG_OWNER_TYPE';
      return owner.firstApprovedById === null ? null : 'ALREADY_FIRST_APPROVED';
    case 'SECOND_APPROVAL':
      if (owner.ownerType !== 'ORGANIZATION') return 'WRONG_OWNER_TYPE';
      if (owner.firstApprovedById === null) return 'FIRST_APPROVAL_REQUIRED';
      return owner.firstApprovedById === officerId ? 'SAME_OFFICER' : null;
  }
}

/**
 * Verified owners lose verification when their identity does: EXPIRED when the identity
 * expired (BR-ID-3), REVERIFICATION_REQUIRED for any other non-verified identity. Returns
 * the new status, or null when nothing changes.
 */
export function statusAfterIdentityCheck(
  status: OwnerVerificationStatus,
  identityStatus: IdentityStatus,
): OwnerVerificationStatus | null {
  if (status !== 'VERIFIED' || identityStatus === 'VERIFIED') return null;
  return identityStatus === 'EXPIRED' ? 'EXPIRED' : 'REVERIFICATION_REQUIRED';
}

export type OwnerBlocker =
  'ACCOUNT_NOT_ACTIVE' | 'IDENTITY_NOT_VERIFIED' | 'OWNER_NOT_VERIFIED' | 'OWNER_SUSPENDED';

/**
 * Whether the owner may use owner functionality that needs verification (Phase 7 onwards:
 * vehicles, listings). Computed, never stored or client-settable.
 */
export function ownerBlockers(facts: {
  readonly accountStatus: AccountStatus;
  readonly identityStatus: IdentityStatus;
  readonly status: OwnerVerificationStatus;
}): OwnerBlocker[] {
  const blockers: OwnerBlocker[] = [];
  if (facts.accountStatus !== 'ACTIVE') blockers.push('ACCOUNT_NOT_ACTIVE');
  if (facts.identityStatus !== 'VERIFIED') blockers.push('IDENTITY_NOT_VERIFIED');
  if (facts.status === 'SUSPENDED') blockers.push('OWNER_SUSPENDED');
  else if (facts.status !== 'VERIFIED') blockers.push('OWNER_NOT_VERIFIED');
  return blockers;
}
