import type { IdentityStatus, IdentityVerificationStatus } from '../../generated/prisma/client.js';

/**
 * Identity state machines (docs/architecture/02-domain-model-and-rules.md §3.2, refined
 * in Phase 4). Plain data, tested exhaustively; the migration's triggers enforce the same
 * tables in the database, so no code path (or bug) can make another change.
 */

/** One attempt (`identity_verifications.status`). Terminal statuses map to []. */
export const ATTEMPT_TRANSITIONS: Readonly<
  Record<IdentityVerificationStatus, readonly IdentityVerificationStatus[]>
> = Object.freeze({
  PENDING: ['VERIFIED', 'REJECTED', 'FAILED', 'EXPIRED', 'CANCELLED', 'SUPERSEDED'],
  VERIFIED: ['EXPIRED', 'REVERIFICATION_REQUIRED', 'SUSPENDED'],
  REVERIFICATION_REQUIRED: ['SUSPENDED', 'SUPERSEDED'],
  SUSPENDED: ['REVERIFICATION_REQUIRED'],
  REJECTED: [],
  FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
  SUPERSEDED: [],
});

/** The account (`users.identity_status`). */
export const ACCOUNT_TRANSITIONS: Readonly<Record<IdentityStatus, readonly IdentityStatus[]>> =
  Object.freeze({
    UNVERIFIED: ['PENDING'],
    // Back to the status before the attempt when it ends without a result.
    PENDING: [
      'VERIFIED',
      'REJECTED',
      'UNVERIFIED',
      'EXPIRED',
      'REVERIFICATION_REQUIRED',
      'SUSPENDED',
    ],
    VERIFIED: ['EXPIRED', 'REVERIFICATION_REQUIRED', 'SUSPENDED'],
    REJECTED: ['PENDING'],
    EXPIRED: ['PENDING'],
    REVERIFICATION_REQUIRED: ['PENDING', 'SUSPENDED'],
    SUSPENDED: ['REVERIFICATION_REQUIRED'],
  });

/** Attempts that hold the account's current verified identity (at most one per user). */
export const CURRENT_ATTEMPT_STATUSES: readonly IdentityVerificationStatus[] = Object.freeze([
  'VERIFIED',
  'SUSPENDED',
  'REVERIFICATION_REQUIRED',
]);

export function canTransitionAttempt(
  from: IdentityVerificationStatus,
  to: IdentityVerificationStatus,
): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

export function canTransitionAccount(from: IdentityStatus, to: IdentityStatus): boolean {
  return ACCOUNT_TRANSITIONS[from].includes(to);
}

/**
 * Whether the account may start a verification. From PENDING a new start replaces the
 * open attempt (lost browser tab, expired link). VERIFIED and SUSPENDED may not start.
 */
export function canStart(status: IdentityStatus): boolean {
  return canTransitionAccount(status, 'PENDING') || status === 'PENDING';
}

export type AttemptOutcome = Extract<
  IdentityVerificationStatus,
  'VERIFIED' | 'REJECTED' | 'FAILED' | 'EXPIRED' | 'CANCELLED'
>;

/** Account status when an attempt leaves PENDING. Results stick; non-results restore. */
export function accountStatusAfter(
  outcome: AttemptOutcome,
  previous: IdentityStatus,
): IdentityStatus {
  switch (outcome) {
    case 'VERIFIED':
      return 'VERIFIED';
    case 'REJECTED':
      return 'REJECTED';
    case 'FAILED':
    case 'EXPIRED':
    case 'CANCELLED':
      return previous;
  }
}

/** Internal outcome codes (stored, shown to verification officers, written to audit). */
export const OutcomeCode = {
  // REJECTED
  IDENTITY_ALREADY_LINKED: 'IDENTITY_ALREADY_LINKED',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  ASSURANCE_TOO_LOW: 'ASSURANCE_TOO_LOW',
  // FAILED
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_MISCONFIGURED: 'PROVIDER_MISCONFIGURED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  INVALID_GRANT: 'INVALID_GRANT',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  // EXPIRED
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  PROVIDER_SESSION_EXPIRED: 'PROVIDER_SESSION_EXPIRED',
  VALIDITY_ENDED: 'VALIDITY_ENDED',
  // A valid provider result that the initiating app session never confirmed.
  CONFIRMATION_EXPIRED: 'CONFIRMATION_EXPIRED',
  // CANCELLED
  CANCELLED_BY_USER: 'CANCELLED_BY_USER',
  DECLINED_AT_PROVIDER: 'DECLINED_AT_PROVIDER',
  CLOSED_BY_STAFF: 'CLOSED_BY_STAFF',
  // SUPERSEDED
  REPLACED_BY_NEW_ATTEMPT: 'REPLACED_BY_NEW_ATTEMPT',
  REPLACED_BY_REVERIFICATION: 'REPLACED_BY_REVERIFICATION',
  // Staff actions
  STAFF_SUSPENDED: 'STAFF_SUSPENDED',
  STAFF_REVERIFICATION_REQUIRED: 'STAFF_REVERIFICATION_REQUIRED',
} as const;
export type OutcomeCode = (typeof OutcomeCode)[keyof typeof OutcomeCode];

/**
 * Coarse reason shown to the account holder. Every rejection looks the same, so the
 * response never says whether an identity is registered to another account.
 */
export type ClientReason =
  | 'VERIFICATION_REJECTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'VERIFICATION_FAILED'
  | 'SESSION_EXPIRED'
  | 'VALIDITY_ENDED'
  | 'CANCELLED'
  | 'DECLINED_AT_PROVIDER'
  | 'CLOSED_BY_SUPPORT'
  | 'REPLACED';

export const CLIENT_REASONS: readonly ClientReason[] = Object.freeze([
  'VERIFICATION_REJECTED',
  'PROVIDER_UNAVAILABLE',
  'VERIFICATION_FAILED',
  'SESSION_EXPIRED',
  'VALIDITY_ENDED',
  'CANCELLED',
  'DECLINED_AT_PROVIDER',
  'CLOSED_BY_SUPPORT',
  'REPLACED',
]);

export function clientReason(
  status: IdentityVerificationStatus,
  outcome: string | null,
): ClientReason | null {
  switch (status) {
    case 'REJECTED':
      return 'VERIFICATION_REJECTED';
    case 'FAILED':
      return outcome === OutcomeCode.PROVIDER_TIMEOUT ||
        outcome === OutcomeCode.PROVIDER_UNAVAILABLE ||
        outcome === OutcomeCode.PROVIDER_MISCONFIGURED
        ? 'PROVIDER_UNAVAILABLE'
        : 'VERIFICATION_FAILED';
    case 'EXPIRED':
      return outcome === OutcomeCode.VALIDITY_ENDED ? 'VALIDITY_ENDED' : 'SESSION_EXPIRED';
    case 'CANCELLED':
      if (outcome === OutcomeCode.DECLINED_AT_PROVIDER) return 'DECLINED_AT_PROVIDER';
      return outcome === OutcomeCode.CLOSED_BY_STAFF ? 'CLOSED_BY_SUPPORT' : 'CANCELLED';
    case 'SUPERSEDED':
      return 'REPLACED';
    case 'PENDING':
    case 'VERIFIED':
    case 'SUSPENDED':
    case 'REVERIFICATION_REQUIRED':
      return null;
  }
}

/** `validUntil` = verification time + N calendar months (UTC), clamped to the month end. */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}
