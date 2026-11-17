import { HttpStatus, ValidationPipe, type ValidationError } from '@nestjs/common';
import { DomainError, ErrorCode, type FieldError } from '../http/problem-details.js';

/** `isNotEmpty` -> `IS_NOT_EMPTY`; whitelist violations become `UNKNOWN_FIELD`. */
export function constraintToCode(constraint: string): string {
  if (constraint === 'whitelistValidation') return 'UNKNOWN_FIELD';
  return constraint.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** Flattens nested class-validator errors into `{ field: 'a.b', code }` pairs. Values are never echoed. */
export function toFieldErrors(errors: readonly ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent === '' ? error.property : `${parent}.${error.property}`;
    const own = Object.keys(error.constraints ?? {}).map((constraint) => ({
      field,
      code: constraintToCode(constraint),
    }));
    return [...own, ...toFieldErrors(error.children ?? [], field)];
  });
}

/**
 * Global request validation. Unknown properties are rejected (mass-assignment protection)
 * and payloads are transformed into DTO class instances.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    stopAtFirstError: false,
    exceptionFactory: (errors) =>
      new DomainError(ErrorCode.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, toFieldErrors(errors)),
  });
}
