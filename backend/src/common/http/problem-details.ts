import { HttpStatus } from '@nestjs/common';

/**
 * Stable machine-readable error codes. Clients map these to localized messages;
 * the human-readable `title` is a generic English fallback only.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // Phase 3: authentication and request conventions.
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  OTP_INVALID: 'OTP_INVALID',
  ACCOUNT_RESTRICTED: 'ACCOUNT_RESTRICTED',
  REAUTHENTICATION_REQUIRED: 'REAUTHENTICATION_REQUIRED',
  SMS_UNAVAILABLE: 'SMS_UNAVAILABLE',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_INVALID: 'IDEMPOTENCY_KEY_INVALID',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  REQUEST_IN_PROGRESS: 'REQUEST_IN_PROGRESS',
  PRECONDITION_REQUIRED: 'PRECONDITION_REQUIRED',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  PHONE_IN_USE: 'PHONE_IN_USE',
  CANNOT_MODIFY_OWN_ACCOUNT: 'CANNOT_MODIFY_OWN_ACCOUNT',
  LAST_SUPER_ADMIN: 'LAST_SUPER_ADMIN',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const TITLES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'The request contains invalid fields',
  MALFORMED_REQUEST: 'The request body could not be read',
  PAYLOAD_TOO_LARGE: 'The request body is too large',
  UNSUPPORTED_MEDIA_TYPE: 'Unsupported content type',
  UNAUTHENTICATED: 'Authentication is required',
  FORBIDDEN: 'You are not allowed to perform this action',
  NOT_FOUND: 'The requested resource was not found',
  METHOD_NOT_ALLOWED: 'Method not allowed',
  CONFLICT: 'The request conflicts with the current state',
  RATE_LIMITED: 'Too many requests',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable',
  INTERNAL_ERROR: 'An unexpected error occurred',
  INVALID_CREDENTIALS: 'The phone number or password is incorrect',
  OTP_INVALID: 'The code is incorrect or has expired',
  ACCOUNT_RESTRICTED: 'This account cannot perform this action',
  REAUTHENTICATION_REQUIRED: 'Confirm your password and code to continue',
  SMS_UNAVAILABLE: 'Text messages cannot be sent right now',
  IDEMPOTENCY_KEY_REQUIRED: 'An Idempotency-Key header is required',
  IDEMPOTENCY_KEY_INVALID: 'The Idempotency-Key header is invalid',
  IDEMPOTENCY_KEY_REUSED: 'The Idempotency-Key was used for a different request',
  REQUEST_IN_PROGRESS: 'The same request is still being processed',
  PRECONDITION_REQUIRED: 'An If-Match header is required',
  VERSION_CONFLICT: 'The resource was changed by another request',
  PHONE_IN_USE: 'The phone number is already registered',
  CANNOT_MODIFY_OWN_ACCOUNT: 'You cannot change your own staff access',
  LAST_SUPER_ADMIN: 'At least one super administrator must remain',
};

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  400: ErrorCode.MALFORMED_REQUEST,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  405: ErrorCode.METHOD_NOT_ALLOWED,
  409: ErrorCode.CONFLICT,
  413: ErrorCode.PAYLOAD_TOO_LARGE,
  415: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
  428: ErrorCode.PRECONDITION_REQUIRED,
  429: ErrorCode.RATE_LIMITED,
  503: ErrorCode.SERVICE_UNAVAILABLE,
};

export interface FieldError {
  readonly field: string;
  readonly code: string;
}

/** RFC 9457 problem details body, as returned by every error response. */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  readonly errors?: readonly FieldError[];
}

export function titleFor(code: ErrorCode): string {
  return TITLES[code];
}

export function codeForStatus(status: number): ErrorCode {
  return (
    STATUS_TO_CODE[status] ??
    (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.MALFORMED_REQUEST)
  );
}

export function problemType(code: string): string {
  return `urn:mobility:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}

/**
 * Error thrown by application code for expected failures. Its code and status are
 * returned to the client; its message is logged but never sent.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: HttpStatus,
    readonly fieldErrors: readonly FieldError[] = [],
    readonly title?: string,
    /** Response headers to send with the error, e.g. Retry-After or WWW-Authenticate. */
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(code);
    this.name = 'DomainError';
  }
}

export function rateLimitedError(retryAfterSeconds: number): DomainError {
  return new DomainError(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, [], undefined, {
    'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))),
  });
}

export function unauthenticatedError(): DomainError {
  return new DomainError(ErrorCode.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, [], undefined, {
    'WWW-Authenticate': 'Bearer',
  });
}

export function validationError(field: string, code: string): DomainError {
  return new DomainError(ErrorCode.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, [{ field, code }]);
}
