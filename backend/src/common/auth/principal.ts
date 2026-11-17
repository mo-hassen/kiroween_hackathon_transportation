import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AccountStatus, AccountType, StaffRole } from '../../generated/prisma/client.js';
import { unauthenticatedError } from '../http/problem-details.js';

/** The authenticated caller, built by AuthenticationGuard from the token AND the database. */
export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
  readonly accountType: AccountType;
  readonly status: AccountStatus;
  /** Active staff roles loaded from the database on every request (empty for customers). */
  readonly roles: readonly StaffRole[];
  /** Last full authentication of this session (password, plus TOTP for staff). */
  readonly authenticatedAt: Date;
}

export type AuthenticatedRequest = Request & { principal?: Principal; id?: unknown };

/** Injects the Principal. Fails closed if a route is reached without one. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (principal === undefined) {
      throw unauthenticatedError();
    }
    return principal;
  },
);
