import { HttpStatus, Injectable } from '@nestjs/common';
import { assertVisible, ownedByPrincipal } from '../../common/auth/policy.js';
import type { Principal } from '../../common/auth/principal.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { DomainError, ErrorCode, validationError } from '../../common/http/problem-details.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AUTH_RATE_LIMITS } from '../auth/auth-policy.js';
import { PasswordService } from '../auth/password/password.service.js';
import { DeviceService } from '../auth/sessions/device.service.js';
import { SessionService } from '../auth/sessions/session.service.js';
import type { ChangePasswordDto, MeResponse, SessionResponse, UpdateMeDto } from './me.dto.js';

/** Own account, sessions and devices: "O" in the permission matrix for every role. */
@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly devices: DeviceService,
    private readonly passwords: PasswordService,
    private readonly rateLimits: RateLimitService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async get(principal: Principal): Promise<MeResponse> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: {
        id: true,
        phoneE164: true,
        displayName: true,
        preferredLocale: true,
        accountType: true,
        status: true,
        identityStatus: true,
        createdAt: true,
        version: true,
      },
    });
    return {
      id: user.id,
      phone: user.phoneE164,
      displayName: user.displayName,
      preferredLocale: user.preferredLocale,
      accountType: user.accountType,
      status: user.status,
      identityStatus: user.identityStatus,
      roles: [...principal.roles],
      createdAt: user.createdAt.toISOString(),
      version: user.version,
    };
  }

  /** Optimistic concurrency: the caller must send the version it read (If-Match). */
  async update(
    principal: Principal,
    ifMatch: string | undefined,
    dto: UpdateMeDto,
    meta: RequestMeta,
  ): Promise<MeResponse> {
    if (ifMatch === undefined || ifMatch === '') {
      throw new DomainError(ErrorCode.PRECONDITION_REQUIRED, HttpStatus.PRECONDITION_REQUIRED);
    }
    const expectedVersion = Number(ifMatch.replace(/^W\//, '').replaceAll('"', ''));
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0)
      throw validationError('If-Match', 'INVALID_VERSION');

    const fields = Object.entries(dto)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    if (fields.length === 0) return this.get(principal);

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: principal.userId, version: expectedVersion },
        data: {
          ...(dto.displayName === undefined ? {} : { displayName: dto.displayName }),
          ...(dto.preferredLocale === undefined ? {} : { preferredLocale: dto.preferredLocale }),
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1)
        throw new DomainError(ErrorCode.VERSION_CONFLICT, HttpStatus.CONFLICT);
      await this.audit.record(tx, {
        actor: {
          type: principal.accountType === 'STAFF' ? 'STAFF' : 'USER',
          userId: principal.userId,
        },
        action: 'account.profile_updated',
        target: { type: 'user', id: principal.userId },
        changes: { fields },
        meta,
      });
    });
    return this.get(principal);
  }

  async listSessions(principal: Principal): Promise<SessionResponse[]> {
    const sessions = await this.prisma.session.findMany({
      where: { userId: principal.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        device: { select: { platform: true, model: true, appVersion: true, trustedAt: true } },
      },
    });
    return sessions.map((session) => ({
      id: session.id,
      current: session.id === principal.sessionId,
      device:
        session.device === null
          ? null
          : {
              platform: session.device.platform,
              model: session.device.model,
              appVersion: session.device.appVersion,
              trusted: session.device.trustedAt !== null,
            },
      createdAt: session.createdAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
    }));
  }

  /**
   * Ends one of the caller's sessions. Another user's (or an already ended) session is
   * reported as 404. Revoking another device also removes its trust, so signing in there
   * again needs a new SMS code.
   */
  async revokeSession(principal: Principal, sessionId: string, meta: RequestMeta): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, userId: true, deviceId: true },
    });
    const owned = assertVisible(principal, session, ownedByPrincipal);
    await this.prisma.$transaction(async (tx) => {
      await this.sessions.revoke(tx, owned.id, 'REVOKED_BY_USER');
      if (owned.id !== principal.sessionId && owned.deviceId !== null) {
        await this.devices.untrust(tx, owned.deviceId);
      }
      await this.audit.record(tx, {
        actor: {
          type: principal.accountType === 'STAFF' ? 'STAFF' : 'USER',
          userId: principal.userId,
        },
        action: 'auth.session_revoked',
        target: { type: 'session', id: owned.id },
        changes: { currentSession: owned.id === principal.sessionId },
        meta,
      });
    });
  }

  /** Requires the current password; ends all other sessions and removes other devices' trust. */
  async changePassword(
    principal: Principal,
    dto: ChangePasswordDto,
    meta: RequestMeta,
  ): Promise<void> {
    await this.rateLimits.consume(AUTH_RATE_LIMITS.sensitivePerUser, principal.userId);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: { phoneE164: true, passwordHash: true },
    });
    if (!(await this.passwords.verify(user.passwordHash, dto.currentPassword))) {
      await this.audit.record(this.prisma, {
        actor: {
          type: principal.accountType === 'STAFF' ? 'STAFF' : 'USER',
          userId: principal.userId,
        },
        action: 'auth.password_change_failed',
        target: { type: 'user', id: principal.userId },
        meta,
      });
      // 400 with a field error, not 401: the session is valid and must not be refreshed.
      throw validationError('currentPassword', 'INCORRECT');
    }
    this.passwords.assertAcceptable(dto.newPassword, 'newPassword', { phoneE164: user.phoneE164 });
    const passwordHash = await this.passwords.hash(dto.newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: principal.userId },
        data: { passwordHash, passwordChangedAt: new Date() },
      });
      const current = await tx.session.findUniqueOrThrow({
        where: { id: principal.sessionId },
        select: { deviceId: true },
      });
      const revoked = await this.sessions.revokeAllForUser(
        tx,
        principal.userId,
        'PASSWORD_CHANGED',
        principal.sessionId,
      );
      await this.devices.untrustAll(tx, principal.userId, current.deviceId ?? undefined);
      await this.audit.record(tx, {
        actor: {
          type: principal.accountType === 'STAFF' ? 'STAFF' : 'USER',
          userId: principal.userId,
        },
        action: 'auth.password_changed',
        target: { type: 'user', id: principal.userId },
        changes: { otherSessionsRevoked: revoked },
        meta,
      });
      await this.outbox.enqueue(tx, {
        aggregateType: 'user',
        aggregateId: principal.userId,
        eventType: 'auth.password_changed',
        payload: { userId: principal.userId },
        requestId: meta.requestId,
      });
    });
  }
}
