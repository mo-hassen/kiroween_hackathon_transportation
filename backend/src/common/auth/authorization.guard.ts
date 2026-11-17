import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError, ErrorCode, unauthenticatedError } from '../http/problem-details.js';
import {
  ADMIN_AREA,
  RECENT_AUTHENTICATION,
  REQUIRED_PERMISSION,
} from './authorization.decorators.js';
import { hasPermission, type Permission } from './permissions.js';
import type { AuthenticatedRequest, Principal } from './principal.js';
import { IS_PUBLIC } from './public.decorator.js';

/** Step-up window for sensitive staff actions (role changes, staff creation). */
export const RECENT_AUTHENTICATION_MAX_AGE_MS = 5 * 60 * 1000;

export type AuthorizationDecision = 'ALLOW' | 'NOT_FOUND' | 'FORBIDDEN' | 'REAUTHENTICATE';

/** Pure decision function, table-tested in authorization.guard.spec.ts. */
export function decideAuthorization(
  principal: Principal,
  rules: { adminArea: boolean; permission: Permission | undefined; recentAuthentication: boolean },
  now: Date,
): AuthorizationDecision {
  const staffOnly = rules.adminArea || rules.permission !== undefined;
  if (staffOnly && principal.accountType !== 'STAFF') return 'NOT_FOUND';
  if (rules.permission !== undefined && !hasPermission(principal.roles, rules.permission))
    return 'FORBIDDEN';
  if (
    rules.recentAuthentication &&
    now.getTime() - principal.authenticatedAt.getTime() > RECENT_AUTHENTICATION_MAX_AGE_MS
  ) {
    return 'REAUTHENTICATE';
  }
  return 'ALLOW';
}

/**
 * Role/permission layer, run after AuthenticationGuard. Customers on admin routes get 404
 * (the admin API is not revealed); staff without the permission get 403. Resource-level
 * checks (ownership) live in services and policies.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets) === true) {
      return true;
    }
    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (principal === undefined) throw unauthenticatedError();

    const decision = decideAuthorization(
      principal,
      {
        adminArea:
          this.reflector.getAllAndOverride<boolean | undefined>(ADMIN_AREA, targets) === true,
        permission: this.reflector.getAllAndOverride<Permission | undefined>(
          REQUIRED_PERMISSION,
          targets,
        ),
        recentAuthentication:
          this.reflector.getAllAndOverride<boolean | undefined>(RECENT_AUTHENTICATION, targets) ===
          true,
      },
      new Date(),
    );
    switch (decision) {
      case 'ALLOW':
        return true;
      case 'NOT_FOUND':
        throw new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
      case 'FORBIDDEN':
        throw new DomainError(ErrorCode.FORBIDDEN, HttpStatus.FORBIDDEN);
      case 'REAUTHENTICATE':
        // 403, not 401: the session is valid, so clients must not try a token refresh.
        throw new DomainError(ErrorCode.REAUTHENTICATION_REQUIRED, HttpStatus.FORBIDDEN);
    }
  }
}
