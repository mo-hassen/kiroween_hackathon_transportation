import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service.js';
import type { RequestMeta } from '../../../common/http/request-meta.js';
import { OutboxService } from '../../../common/outbox/outbox.service.js';
import { RateLimitService } from '../../../common/rate-limit/rate-limit.service.js';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { otpInvalid } from '../auth-errors.js';
import { AUTH_RATE_LIMITS } from '../auth-policy.js';
import type { PasswordResetConfirmDto } from '../dto/auth-requests.dto.js';
import { OtpChallengeService } from '../otp/otp-challenge.service.js';
import { PasswordService } from '../password/password.service.js';
import { DeviceService } from '../sessions/device.service.js';
import { SessionService } from '../sessions/session.service.js';

/**
 * Password reset by SMS code (customers only). Ends every session, clears the lockout,
 * trusts only the installation that completed the reset, and notifies the user (outbox).
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpChallengeService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly devices: DeviceService,
    private readonly rateLimits: RateLimitService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async confirm(dto: PasswordResetConfirmDto, meta: RequestMeta): Promise<void> {
    this.passwords.assertAcceptable(dto.newPassword, 'newPassword', { phoneE164: dto.phone });
    await this.rateLimits.consume(AUTH_RATE_LIMITS.codeVerifyPerIp, meta.ip ?? 'unknown');
    const passwordHash = await this.passwords.hash(dto.newPassword);

    const challenge = await this.otp.attemptLatest('PASSWORD_RESET', dto.phone, dto.otp);
    const userId = challenge?.userId;
    if (challenge === null || userId == null) throw otpInvalid();

    const done = await this.prisma.$transaction(async (tx) => {
      if (!(await this.otp.consume(tx, challenge.id))) return false;
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { accountType: true, status: true },
      });
      if (
        user?.accountType !== 'CUSTOMER' ||
        !['ACTIVE', 'SUSPENDED', 'LOCKED'].includes(user.status)
      )
        return false;

      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      const revoked = await this.sessions.revokeAllForUser(tx, userId, 'PASSWORD_RESET');
      const device = await this.devices.upsert(tx, userId, dto.device, { trust: true });
      await this.devices.untrustAll(tx, userId, device.id);
      await this.audit.record(tx, {
        actor: { type: 'USER', userId },
        action: 'auth.password_reset_completed',
        target: { type: 'user', id: userId },
        changes: { sessionsRevoked: revoked },
        meta,
      });
      await this.outbox.enqueue(tx, {
        aggregateType: 'user',
        aggregateId: userId,
        eventType: 'auth.password_reset',
        payload: { userId },
        requestId: meta.requestId,
      });
      return true;
    });
    if (!done) throw otpInvalid();
  }
}
