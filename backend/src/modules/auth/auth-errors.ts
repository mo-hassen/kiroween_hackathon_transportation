import { HttpStatus } from '@nestjs/common';
import { DomainError, ErrorCode } from '../../common/http/problem-details.js';
import type { AccountStatus } from '../../generated/prisma/client.js';

/** The same error for unknown phone, wrong password, locked account and wrong TOTP. */
export function invalidCredentials(status: HttpStatus = HttpStatus.UNAUTHORIZED): DomainError {
  return new DomainError(ErrorCode.INVALID_CREDENTIALS, status);
}

/** The same error for a wrong, expired, exhausted or never-issued code or ticket. */
export function otpInvalid(): DomainError {
  return new DomainError(ErrorCode.OTP_INVALID, HttpStatus.BAD_REQUEST);
}

/** Statuses that may log in. SUSPENDED/LOCKED sessions are read-only (BR-ACC-3). */
export const LOGIN_STATUSES: ReadonlySet<AccountStatus> = new Set([
  'ACTIVE',
  'SUSPENDED',
  'LOCKED',
]);

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
