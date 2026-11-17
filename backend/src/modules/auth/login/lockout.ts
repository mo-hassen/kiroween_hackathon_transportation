/**
 * Account lockout with exponential backoff (docs/architecture/07-security-architecture.md):
 * after 5 consecutive failures the account is locked for 1 minute, doubling with every
 * further failure, capped at 24 hours. While locked even the correct password fails with
 * the generic INVALID_CREDENTIALS, so the lock itself reveals nothing.
 *
 * The lock only blocks new logins. Existing sessions keep working; otherwise an attacker
 * could lock a victim out of the session they are already using.
 */
export const LOCKOUT_THRESHOLD = 5;
const BASE_LOCK_MS = 60_000;
const MAX_LOCK_MS = 24 * 60 * 60_000;

export function lockoutDurationMs(consecutiveFailures: number): number {
  if (consecutiveFailures < LOCKOUT_THRESHOLD) return 0;
  const exponent = Math.min(consecutiveFailures - LOCKOUT_THRESHOLD, 20);
  return Math.min(BASE_LOCK_MS * 2 ** exponent, MAX_LOCK_MS);
}

export function lockedUntilAfter(consecutiveFailures: number, now: Date): Date | null {
  const duration = lockoutDurationMs(consecutiveFailures);
  return duration === 0 ? null : new Date(now.getTime() + duration);
}

export function isLocked(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil > now;
}
