import { ConflictException, HttpStatus, NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { classifyException } from './problem-details.filter.js';
import { DomainError, ErrorCode, problemType } from './problem-details.js';

describe('classifyException', () => {
  it('keeps the code, status and field errors of a DomainError', () => {
    const result = classifyException(
      new DomainError(
        'LISTING_NOT_AVAILABLE',
        HttpStatus.CONFLICT,
        [{ field: 'x', code: 'Y' }],
        'Taken',
      ),
    );
    expect(result).toEqual({
      status: 409,
      code: 'LISTING_NOT_AVAILABLE',
      title: 'Taken',
      errors: [{ field: 'x', code: 'Y' }],
      unexpected: false,
    });
  });

  it('maps Nest HTTP exceptions by status without exposing their message', () => {
    const result = classifyException(new NotFoundException('row 42 missing in table users'));
    expect(result.code).toBe(ErrorCode.NOT_FOUND);
    expect(result.title).not.toContain('users');
    expect(classifyException(new ConflictException()).code).toBe(ErrorCode.CONFLICT);
  });

  it('maps throttling to RATE_LIMITED', () => {
    expect(classifyException(new ThrottlerException()).code).toBe(ErrorCode.RATE_LIMITED);
  });

  it('maps body-parser errors', () => {
    expect(classifyException({ type: 'entity.too.large', status: 413 }).code).toBe(
      ErrorCode.PAYLOAD_TOO_LARGE,
    );
    expect(classifyException({ type: 'entity.parse.failed', status: 400 }).code).toBe(
      ErrorCode.MALFORMED_REQUEST,
    );
  });

  it('treats unknown errors as unexpected 500s', () => {
    const result = classifyException(new Error('connection string postgres://secret'));
    expect(result).toMatchObject({ status: 500, code: ErrorCode.INTERNAL_ERROR, unexpected: true });
    expect(result.title).not.toContain('secret');
  });

  it('does not trust a status on arbitrary objects without a middleware type', () => {
    expect(classifyException({ status: 404 }).status).toBe(500);
  });

  it('builds a stable problem type URN', () => {
    expect(problemType('LISTING_NOT_AVAILABLE')).toBe('urn:mobility:problem:listing-not-available');
  });
});
