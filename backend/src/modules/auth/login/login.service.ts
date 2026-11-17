import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service.js';
import type { RequestMeta } from '../../../common/http/request-meta.js';
import { RateLimitService } from '../../../common/rate-limit/rate-limit.service.js';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { SmsSender } from '../../../providers/sms/sms-sender.service.js';
import { invalidCredentials, LOGIN_STATUSES, otpInvalid } from '../auth-errors.js';
import { AUTH_POLICY, AUTH_RATE_LIMITS } from '../auth-policy.js';
import type { LoginDto, LoginOtpDto } from '../dto/auth-requests.dto.js';
import { OtpChallengeService } from '../otp/otp-challenge.service.js';
import { PasswordService } from '../password/password.service.js';
import { DeviceService } from '../sessions/device.service.js';
import { SessionService, type TokenPair } from '../sessions/session.service.js';
import { LoginFailuresService } from './login-failures.service.js';
import { isLocked } from './lockout.js';

export type LoginResult =
  | { readonly kind: 'AUTHENTICATED'; readonly pair: TokenPair }
  | { readonly kind: 'OTP_REQUIRED'; readonly loginTicket: string; readonly otpExpiresAt: Date };

/**
 * Customer login (phone + password), with new-device step-up by SMS code
 * (docs/architecture/07-security-architecture.md §1 and §8).
 *
 * Unknown numbers, staff numbers, closed accounts, locked accounts and wrong passwords all
 * get the same 401 INVALID_CREDENTIALS after the same amount of password-hashing work.
 * Suspended accounts can log in, but their sessions are read-only (BR-ACC-3, enforced by
 * AuthenticationGuard); GET /me shows the status.
 */
@Injectable()
export class LoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly devices: DeviceService,
    private readonly otp: OtpChallengeService,
    private readonly sms: SmsSender,
    private readonly failures: LoginFailuresService,
    private readonly rateLimits: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  async login(dto: LoginDto, meta: RequestMeta): Promise<LoginResult> {
    await this.rateLimits.consume(AUTH_RATE_LIMITS.loginPerIp, meta.ip ?? 'unknown');
    await this.rateLimits.consume(AUTH_RATE_LIMITS.loginPerPhone, dto.phone);

    const user = await this.prisma.user.findUnique({
      where: { phoneE164: dto.phone },
      select: {
        id: true,
        accountType: true,
        status: true,
        passwordHash: true,
        lockedUntil: true,
        preferredLocale: true,
      },
    });
    const candidate =
      user?.accountType === 'CUSTOMER' && LOGIN_STATUSES.has(user.status) ? user : null;

    if (candidate === null) {
      await this.passwords.verifyDummy(dto.password);
      await this.failures.recordUnknown(dto.phone, 'UNKNOWN_ACCOUNT', meta);
      throw invalidCredentials();
    }
    if (isLocked(candidate.lockedUntil, new Date())) {
      await this.passwords.verifyDummy(dto.password);
      await this.failures.recordUnknown(dto.phone, 'LOCKED', meta, candidate.id);
      throw invalidCredentials();
    }
    if (!(await this.passwords.verify(candidate.passwordHash, dto.password))) {
      await this.failures.recordWrongSecret(candidate, meta);
      throw invalidCredentials();
    }
    const device = await this.devices.find(this.prisma, candidate.id, dto.device.installationId);
    if (device?.trustedAt != null) {
      const pair = await this.prisma.$transaction(async (tx) => {
        await this.failures.reset(tx, candidate.id);
        const updated = await this.devices.upsert(tx, candidate.id, dto.device, { trust: false });
        await this.recordSuccess(tx, candidate.id, false, meta);
        return this.sessions.create(
          tx,
          { userId: candidate.id, accountType: 'CUSTOMER', roles: [] },
          updated.id,
          meta,
        );
      });
      return { kind: 'AUTHENTICATED', pair };
    }

    // New or untrusted installation: correct password, but prove phone possession too.
    this.sms.assertAvailable();
    await this.rateLimits.consume(AUTH_RATE_LIMITS.otpSendPerPhone, dto.phone);
    await this.rateLimits.consume(AUTH_RATE_LIMITS.otpSendPerPhoneDaily, dto.phone);
    const issued = await this.prisma.$transaction(async (tx) => {
      await this.devices.upsert(tx, candidate.id, dto.device, { trust: false });
      const challenge = await this.otp.issue(tx, {
        purpose: 'LOGIN_STEP_UP',
        phoneE164: dto.phone,
        userId: candidate.id,
        installationId: dto.device.installationId,
        ttlMs: AUTH_POLICY.otpTtlMs,
        maxAttempts: AUTH_POLICY.otpMaxAttempts,
        withTicket: true,
      });
      await this.audit.record(tx, {
        actor: { type: 'USER', userId: candidate.id },
        action: 'auth.login_step_up_required',
        target: { type: 'user', id: candidate.id },
        changes: { platform: dto.device.platform },
        meta,
      });
      return challenge;
    });
    if (issued.code === null || issued.ticket === null)
      throw new Error('Step-up challenge must have a code and ticket');
    this.sms.sendInBackground(
      dto.phone,
      'otp.login_step_up',
      candidate.preferredLocale,
      issued.code,
    );
    return { kind: 'OTP_REQUIRED', loginTicket: issued.ticket, otpExpiresAt: issued.expiresAt };
  }

  async verifyStepUp(dto: LoginOtpDto, meta: RequestMeta): Promise<TokenPair> {
    await this.rateLimits.consume(AUTH_RATE_LIMITS.codeVerifyPerIp, meta.ip ?? 'unknown');
    const challenge = await this.otp.attemptByTicket('LOGIN_STEP_UP', dto.loginTicket, dto.otp);
    if (challenge?.userId == null || challenge.installationId !== dto.device.installationId) {
      throw otpInvalid();
    }
    const userId = challenge.userId;
    const pair = await this.prisma.$transaction(async (tx) => {
      if (!(await this.otp.consume(tx, challenge.id))) return null;
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { accountType: true, status: true },
      });
      if (user?.accountType !== 'CUSTOMER' || !LOGIN_STATUSES.has(user.status)) return null;
      await this.failures.reset(tx, userId);
      const device = await this.devices.upsert(tx, userId, dto.device, { trust: true });
      await this.recordSuccess(tx, userId, true, meta);
      return this.sessions.create(
        tx,
        { userId, accountType: 'CUSTOMER', roles: [] },
        device.id,
        meta,
      );
    });
    if (pair === null) throw otpInvalid();
    return pair;
  }

  private async recordSuccess(
    tx: Parameters<AuditService['record']>[0],
    userId: string,
    stepUp: boolean,
    meta: RequestMeta,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: { type: 'USER', userId },
      action: 'auth.login_succeeded',
      target: { type: 'user', id: userId },
      changes: { newDeviceVerified: stepUp },
      meta,
    });
  }
}
