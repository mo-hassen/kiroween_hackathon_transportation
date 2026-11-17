import { createParamDecorator, type ExecutionContext, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { DomainError, ErrorCode } from '../http/problem-details.js';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;

/** Validates a required `Idempotency-Key` header (a client-generated UUID). */
export function readIdempotencyKey(value: string | string[] | undefined): string {
  if (value === undefined || value === '') {
    throw new DomainError(ErrorCode.IDEMPOTENCY_KEY_REQUIRED, HttpStatus.BAD_REQUEST);
  }
  if (Array.isArray(value) || !KEY_FORMAT.test(value)) {
    throw new DomainError(ErrorCode.IDEMPOTENCY_KEY_INVALID, HttpStatus.BAD_REQUEST);
  }
  return value;
}

export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string =>
    readIdempotencyKey(context.switchToHttp().getRequest<Request>().headers['idempotency-key']),
);
