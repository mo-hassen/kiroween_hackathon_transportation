import { HttpStatus } from '@nestjs/common';
import { DomainError, ErrorCode } from '../http/problem-details.js';
import type { Principal } from './principal.js';

/**
 * Resource-level authorization helpers (docs/architecture/07-security-architecture.md §2).
 * A resource the caller has no relationship with is reported as 404, never 403, so IDs
 * cannot be probed.
 */
export type Policy<T> = (principal: Principal, resource: T) => boolean;

export function assertVisible<T>(
  principal: Principal,
  resource: T | null | undefined,
  policy: Policy<T>,
): T {
  if (resource === null || resource === undefined || !policy(principal, resource)) {
    throw new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
  }
  return resource;
}

/** O (own resources only) in the permission matrix: the resource belongs to the caller. */
export const ownedByPrincipal: Policy<{ readonly userId: string }> = (principal, resource) =>
  resource.userId === principal.userId;
