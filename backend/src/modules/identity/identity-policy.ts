import type { RateLimitRule } from '../../common/rate-limit/rate-limit.service.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const IDENTITY_RATE_LIMITS = Object.freeze({
  // Each start creates a provider session; a person needs only a few.
  startPerUser: { name: 'identity-start-user-1h', limit: 10, windowMs: HOUR },
  // Public browser redirect target. State values are 256-bit, so this only limits noise.
  callbackPerIp: { name: 'identity-callback-ip-15m', limit: 60, windowMs: 15 * MINUTE },
  confirmPerUser: { name: 'identity-confirm-user-15m', limit: 10, windowMs: 15 * MINUTE },
} satisfies Record<string, RateLimitRule>);

/** How long a validated provider result waits for the app to confirm it. */
export const IDENTITY_CONFIRMATION_TTL_MS = 10 * MINUTE;

/** Limits on values returned by a provider, checked again after the adapter. */
export const IDENTITY_LIMITS = Object.freeze({
  subjectMaxLength: 255,
  fullNameMaxLength: 200,
  assuranceMaxLength: 200,
  codeMaxLength: 2048,
});

/** Associated data that binds encrypted columns to their row (see FieldEncryption). */
export const secretsAad = (verificationId: string): string =>
  `identity_verifications.request_secrets_enc:${verificationId}`;
export const claimsAad = (verificationId: string): string =>
  `identity_verifications.verified_claims_enc:${verificationId}`;
export const pendingResultAad = (verificationId: string): string =>
  `identity_verifications.pending_result_enc:${verificationId}`;
