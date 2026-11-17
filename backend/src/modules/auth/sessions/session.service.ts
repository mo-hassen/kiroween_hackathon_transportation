import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AccessTokenService } from '../../../common/auth/access-token.service.js';
import { AuditService } from '../../../common/audit/audit.service.js';
import { randomToken } from '../../../common/crypto/random.js';
import { sha256Hex } from '../../../common/crypto/secret-hasher.js';
import type { RequestMeta } from '../../../common/http/request-meta.js';
import { OutboxService } from '../../../common/outbox/outbox.service.js';
import type { AccountType, Prisma, StaffRole } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { AUTH_POLICY } from '../auth-policy.js';
import { DeviceService } from './device.service.js';

export const REFRESH_TOKEN_PREFIX = 'rt_';

export interface TokenPair {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly sessionId: string;
}

export type RevokeReason =
  | 'LOGOUT'
  | 'REVOKED_BY_USER'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET'
  | 'REFRESH_TOKEN_REUSE'
  | 'CREDENTIALS_RESET';

type RotationOutcome =
  | { readonly kind: 'ROTATED'; readonly pair: TokenPair }
  | { readonly kind: 'REUSE_DETECTED' }
  | { readonly kind: 'INVALID' };

interface SessionOwner {
  readonly userId: string;
  readonly accountType: AccountType;
  readonly roles: readonly StaffRole[];
}

const SESSION_USER_SELECT = {
  id: true,
  userId: true,
  deviceId: true,
  revokedAt: true,
  expiresAt: true,
  rotatedAt: true,
  currentTokenHash: true,
  user: {
    select: {
      accountType: true,
      status: true,
      staffRoles: { where: { revokedAt: null }, select: { role: true } },
    },
  },
} as const;

/**
 * Sessions and rotating refresh tokens (docs/architecture/07-security-architecture.md §1).
 *
 * Refresh tokens are opaque 256-bit values; only SHA-256 digests are stored. Every refresh
 * rotates the token and records the retired digest. Presenting a retired token again is
 * treated as theft: the whole session is revoked and the user is notified (outbox). One
 * exception: the immediately previous token is accepted for a short grace period, because
 * on unreliable mobile networks the response carrying the new token can be lost.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AccessTokenService,
    private readonly devices: DeviceService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async create(
    db: Prisma.TransactionClient,
    owner: SessionOwner,
    deviceId: string | null,
    meta: RequestMeta,
  ): Promise<TokenPair> {
    const refreshToken = this.newRefreshToken();
    const ttl =
      owner.accountType === 'STAFF'
        ? AUTH_POLICY.staffSessionTtlMs
        : AUTH_POLICY.customerSessionTtlMs;
    const session = await db.session.create({
      data: {
        userId: owner.userId,
        deviceId,
        refreshTokenFamily: randomUUID(),
        currentTokenHash: sha256Hex(refreshToken),
        expiresAt: new Date(Date.now() + ttl),
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
      select: { id: true, expiresAt: true },
    });
    return this.pair(owner, session.id, refreshToken, session.expiresAt);
  }

  /** Rotates a refresh token. Returns `null` for any invalid, expired, revoked or reused token. */
  async rotate(refreshToken: string, meta: RequestMeta): Promise<TokenPair | null> {
    if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return null;
    const hash = sha256Hex(refreshToken);
    // Decide inside the transaction, but only report failure after it commits, so a
    // detected reuse (session revocation, audit, notification) is never rolled back.
    const outcome = await this.prisma.$transaction(async (tx): Promise<RotationOutcome> => {
      const current = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM sessions WHERE current_token_hash = ${hash} FOR UPDATE`;
      if (current[0] !== undefined) return this.rotateCurrent(tx, current[0].id, meta);

      const previous = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM sessions WHERE previous_token_hash = ${hash} FOR UPDATE`;
      if (previous[0] !== undefined) return this.handlePrevious(tx, previous[0].id, meta);

      const retired = await tx.retiredRefreshToken.findUnique({
        where: { tokenHash: hash },
        select: { sessionId: true },
      });
      if (retired !== null) {
        await this.revokeForReuse(tx, retired.sessionId, meta);
        return { kind: 'REUSE_DETECTED' };
      }
      return { kind: 'INVALID' };
    });
    return outcome.kind === 'ROTATED' ? outcome.pair : null;
  }

  /** Finds the session a refresh token belongs to (current, previous or retired). */
  async findSessionIdByRefreshToken(refreshToken: string): Promise<string | null> {
    if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return null;
    const hash = sha256Hex(refreshToken);
    const session = await this.prisma.session.findFirst({
      where: { OR: [{ currentTokenHash: hash }, { previousTokenHash: hash }] },
      select: { id: true },
    });
    if (session !== null) return session.id;
    const retired = await this.prisma.retiredRefreshToken.findUnique({
      where: { tokenHash: hash },
      select: { sessionId: true },
    });
    return retired?.sessionId ?? null;
  }

  /** Logout by refresh token. Unknown tokens are ignored, so the response reveals nothing. */
  async logout(refreshToken: string, meta: RequestMeta): Promise<void> {
    const sessionId = await this.findSessionIdByRefreshToken(refreshToken);
    if (sessionId === null) return;
    await this.prisma.$transaction(async (tx) => {
      const session = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { userId: true, user: { select: { accountType: true } } },
      });
      if (!(await this.revoke(tx, sessionId, 'LOGOUT'))) return;
      await this.audit.record(tx, {
        actor: { type: this.actorType(session.user.accountType), userId: session.userId },
        action: 'auth.logout',
        target: { type: 'session', id: sessionId },
        meta,
      });
    });
  }

  async revoke(
    db: Prisma.TransactionClient,
    sessionId: string,
    reason: RevokeReason,
  ): Promise<boolean> {
    const result = await db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    return result.count === 1;
  }

  async revokeAllForUser(
    db: Prisma.TransactionClient,
    userId: string,
    reason: RevokeReason,
    exceptSessionId?: string,
  ): Promise<number> {
    const result = await db.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId === undefined ? {} : { id: { not: exceptSessionId } }),
      },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    return result.count;
  }

  private async rotateCurrent(
    tx: Prisma.TransactionClient,
    sessionId: string,
    meta: RequestMeta,
  ): Promise<RotationOutcome> {
    const session = await tx.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { ...SESSION_USER_SELECT, previousTokenHash: true },
    });
    if (!this.isUsable(session)) return { kind: 'INVALID' };
    if (session.previousTokenHash !== null) {
      await tx.retiredRefreshToken.create({
        data: { tokenHash: session.previousTokenHash, sessionId },
      });
    }
    const refreshToken = this.newRefreshToken();
    await tx.session.update({
      where: { id: sessionId },
      data: {
        previousTokenHash: session.currentTokenHash,
        currentTokenHash: sha256Hex(refreshToken),
        rotatedAt: new Date(),
        lastUsedAt: new Date(),
        ip: meta.ip ?? null,
      },
    });
    if (session.deviceId !== null) {
      await tx.device.update({ where: { id: session.deviceId }, data: { lastSeenAt: new Date() } });
    }
    return {
      kind: 'ROTATED',
      pair: await this.pair(this.owner(session), sessionId, refreshToken, session.expiresAt),
    };
  }

  private async handlePrevious(
    tx: Prisma.TransactionClient,
    sessionId: string,
    meta: RequestMeta,
  ): Promise<RotationOutcome> {
    const session = await tx.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: SESSION_USER_SELECT,
    });
    if (session.revokedAt !== null) return { kind: 'INVALID' };
    const withinGrace =
      session.rotatedAt !== null &&
      Date.now() - session.rotatedAt.getTime() <= AUTH_POLICY.refreshRetryGraceMs;
    if (!withinGrace) {
      await this.revokeForReuse(tx, sessionId, meta);
      return { kind: 'REUSE_DETECTED' };
    }
    if (!this.isUsable(session)) return { kind: 'INVALID' };
    // Network retry: replace the (never received) current token with a new one.
    await tx.retiredRefreshToken.create({
      data: { tokenHash: session.currentTokenHash, sessionId },
    });
    const refreshToken = this.newRefreshToken();
    await tx.session.update({
      where: { id: sessionId },
      data: { currentTokenHash: sha256Hex(refreshToken), lastUsedAt: new Date() },
    });
    await this.audit.record(tx, {
      actor: { type: this.actorType(session.user.accountType), userId: session.userId },
      action: 'auth.refresh_retried',
      target: { type: 'session', id: sessionId },
      meta,
    });
    return {
      kind: 'ROTATED',
      pair: await this.pair(this.owner(session), sessionId, refreshToken, session.expiresAt),
    };
  }

  private async revokeForReuse(
    tx: Prisma.TransactionClient,
    sessionId: string,
    meta: RequestMeta,
  ): Promise<void> {
    const session = await tx.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        userId: true,
        deviceId: true,
        revokedAt: true,
        user: { select: { accountType: true } },
      },
    });
    if (session.revokedAt !== null) return;
    await this.revoke(tx, sessionId, 'REFRESH_TOKEN_REUSE');
    if (session.deviceId !== null) await this.devices.untrust(tx, session.deviceId);
    await this.audit.record(tx, {
      actor: { type: this.actorType(session.user.accountType), userId: session.userId },
      action: 'auth.refresh_token_reused',
      target: { type: 'session', id: sessionId },
      reason: 'A rotated refresh token was presented again; the session was revoked.',
      meta,
    });
    await this.outbox.enqueue(tx, {
      aggregateType: 'user',
      aggregateId: session.userId,
      eventType: 'auth.session_compromised',
      payload: { userId: session.userId, sessionId },
      requestId: meta.requestId,
    });
  }

  private isUsable(session: {
    revokedAt: Date | null;
    expiresAt: Date;
    user: { status: string };
  }): boolean {
    return (
      session.revokedAt === null &&
      session.expiresAt > new Date() &&
      ['ACTIVE', 'SUSPENDED', 'LOCKED'].includes(session.user.status)
    );
  }

  private owner(session: {
    userId: string;
    user: { accountType: AccountType; staffRoles: { role: StaffRole }[] };
  }): SessionOwner {
    return {
      userId: session.userId,
      accountType: session.user.accountType,
      roles: session.user.staffRoles.map((assignment) => assignment.role),
    };
  }

  private actorType(accountType: AccountType): 'USER' | 'STAFF' {
    return accountType === 'STAFF' ? 'STAFF' : 'USER';
  }

  private newRefreshToken(): string {
    return `${REFRESH_TOKEN_PREFIX}${randomToken(32)}`;
  }

  private async pair(
    owner: SessionOwner,
    sessionId: string,
    refreshToken: string,
    expiresAt: Date,
  ): Promise<TokenPair> {
    const access = await this.tokens.issue(
      { userId: owner.userId, sessionId, accountType: owner.accountType },
      owner.roles,
    );
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: expiresAt,
      sessionId,
    };
  }
}
