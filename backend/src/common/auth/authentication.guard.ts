import { BlockList, isIP } from 'node:net';
import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import type { AccountStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { DomainError, ErrorCode, unauthenticatedError } from '../http/problem-details.js';
import { requestMetaFrom } from '../http/request-meta.js';
import { RateLimitService } from '../rate-limit/rate-limit.service.js';
import { AccessTokenService } from './access-token.service.js';
import { ALLOW_RESTRICTED_ACCOUNT } from './authorization.decorators.js';
import type { AuthenticatedRequest } from './principal.js';
import { IS_PUBLIC } from './public.decorator.js';

/** Statuses that may hold a session. PENDING_* and CLOSED accounts are rejected. */
const SESSION_STATUSES: ReadonlySet<AccountStatus> = new Set(['ACTIVE', 'SUSPENDED', 'LOCKED']);
/** BR-ACC-3: these accounts are read-only unless a route opts in. */
const RESTRICTED_STATUSES: ReadonlySet<AccountStatus> = new Set(['SUSPENDED', 'LOCKED']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** True when no allow-list is configured or the IP is inside it. */
export function ipAllowed(list: BlockList | null, ip: string | undefined): boolean {
  if (list === null) return true;
  if (ip === undefined || isIP(ip) === 0) return false;
  return list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

export function buildIpAllowlist(entries: readonly string[]): BlockList | null {
  if (entries.length === 0) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', prefix] = entry.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(prefix), family);
  }
  return list;
}

/**
 * Global, fail-closed authentication (docs/architecture/07-security-architecture.md §2).
 *
 * Every route requires a valid access token unless marked @Public(). The token only names
 * the session: the session, the account status and the staff roles are re-read from the
 * database on every request, so logout, revocation, suspension and role changes take
 * effect immediately.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  private readonly staffAllowlist: BlockList | null;

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
    private readonly prisma: PrismaService,
    private readonly rateLimits: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.staffAllowlist = buildIpAllowlist(config.auth.staffIpAllowlist);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets) === true) {
      return true;
    }
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);
    const claims = token === null ? null : await this.tokens.verify(token);
    if (claims === null) throw unauthenticatedError();

    const session = await this.prisma.session.findUnique({
      where: { id: claims.sessionId },
      select: {
        userId: true,
        revokedAt: true,
        expiresAt: true,
        authenticatedAt: true,
        user: {
          select: {
            accountType: true,
            status: true,
            staffRoles: { where: { revokedAt: null }, select: { role: true } },
          },
        },
      },
    });
    const now = new Date();
    if (
      session === null ||
      session.userId !== claims.userId ||
      session.revokedAt !== null ||
      session.expiresAt <= now ||
      session.user.accountType !== claims.accountType ||
      !SESSION_STATUSES.has(session.user.status)
    ) {
      throw unauthenticatedError();
    }
    if (session.user.accountType === 'STAFF' && !this.isAllowedStaffIp(request)) {
      throw unauthenticatedError();
    }
    if (
      RESTRICTED_STATUSES.has(session.user.status) &&
      !SAFE_METHODS.has(request.method.toUpperCase()) &&
      this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_RESTRICTED_ACCOUNT, targets) !==
        true
    ) {
      throw new DomainError(ErrorCode.ACCOUNT_RESTRICTED, HttpStatus.FORBIDDEN);
    }

    await this.rateLimits.consume(
      { name: 'user-default', limit: this.config.rateLimit.perMinute, windowMs: 60_000 },
      session.userId,
    );

    request.principal = {
      userId: session.userId,
      sessionId: claims.sessionId,
      accountType: session.user.accountType,
      status: session.user.status,
      roles: session.user.staffRoles.map((assignment) => assignment.role),
      authenticatedAt: session.authenticatedAt,
    };
    return true;
  }

  private isAllowedStaffIp(request: AuthenticatedRequest): boolean {
    return ipAllowed(this.staffAllowlist, requestMetaFrom(request).ip);
  }
}
