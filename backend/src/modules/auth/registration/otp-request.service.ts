import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service.js';
import { SecretHasher } from '../../../common/crypto/secret-hasher.js';
import type { RequestMeta } from '../../../common/http/request-meta.js';
import { RateLimitService } from '../../../common/rate-limit/rate-limit.service.js';
import type { Locale } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { SmsSender } from '../../../providers/sms/sms-sender.service.js';
import { AUTH_POLICY, AUTH_RATE_LIMITS } from '../auth-policy.js';
import { OtpChallengeService } from '../otp/otp-challenge.service.js';

export const OTP_ACCEPTED = Object.freeze({
  accepted: true as const,
  expiresInSeconds: AUTH_POLICY.otpTtlMs / 1000,
});

/**
 * Sends registration and password-reset codes without revealing whether a number is
 * registered (docs/architecture/07-security-architecture.md §1, Enumeration):
 *
 * - every call gets the same 202 body and the same rate limits;
 * - registering an existing number sends an "account exists" SMS instead of a code;
 * - resetting an unknown number sends nothing;
 * - SMS delivery runs in the background, so its latency does not leak either.
 */
@Injectable()
export class OtpRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpChallengeService,
    private readonly sms: SmsSender,
    private readonly rateLimits: RateLimitService,
    private readonly audit: AuditService,
    private readonly hasher: SecretHasher,
  ) {}

  async requestRegistrationCode(
    phoneE164: string,
    locale: Locale,
    meta: RequestMeta,
  ): Promise<void> {
    await this.preflight(phoneE164, meta);
    const existing = await this.prisma.user.findUnique({
      where: { phoneE164 },
      select: { id: true, preferredLocale: true },
    });
    const code = await this.prisma.$transaction(async (tx) => {
      const issued =
        existing === null
          ? await this.otp.issue(tx, {
              purpose: 'REGISTER',
              phoneE164,
              ttlMs: AUTH_POLICY.otpTtlMs,
              maxAttempts: AUTH_POLICY.otpMaxAttempts,
            })
          : null;
      await this.recordRequest(
        tx,
        phoneE164,
        'REGISTER',
        existing === null ? 'CODE_SENT' : 'ACCOUNT_EXISTS_NOTICE',
        meta,
      );
      return issued?.code ?? null;
    });
    if (existing !== null) {
      this.sms.sendInBackground(phoneE164, 'account.exists', existing.preferredLocale);
    } else if (code !== null) {
      this.sms.sendInBackground(phoneE164, 'otp.register', locale, code);
    }
  }

  async requestPasswordResetCode(phoneE164: string, meta: RequestMeta): Promise<void> {
    await this.preflight(phoneE164, meta);
    const user = await this.prisma.user.findUnique({
      where: { phoneE164 },
      select: { id: true, accountType: true, status: true, preferredLocale: true },
    });
    // Staff passwords are reset by a super administrator, never by SMS.
    const eligible =
      user !== null &&
      user.accountType === 'CUSTOMER' &&
      ['ACTIVE', 'SUSPENDED', 'LOCKED'].includes(user.status);
    const code = await this.prisma.$transaction(async (tx) => {
      const issued = eligible
        ? await this.otp.issue(tx, {
            purpose: 'PASSWORD_RESET',
            phoneE164,
            userId: user.id,
            ttlMs: AUTH_POLICY.otpTtlMs,
            maxAttempts: AUTH_POLICY.otpMaxAttempts,
          })
        : null;
      await this.recordRequest(
        tx,
        phoneE164,
        'PASSWORD_RESET',
        eligible ? 'CODE_SENT' : 'NO_ELIGIBLE_ACCOUNT',
        meta,
      );
      return issued?.code ?? null;
    });
    if (eligible && code !== null) {
      this.sms.sendInBackground(phoneE164, 'otp.password_reset', user.preferredLocale, code);
    }
  }

  private async preflight(phoneE164: string, meta: RequestMeta): Promise<void> {
    this.sms.assertAvailable();
    await this.rateLimits.consume(AUTH_RATE_LIMITS.otpSendPerIp, meta.ip ?? 'unknown');
    await this.rateLimits.consume(AUTH_RATE_LIMITS.otpSendPerPhone, phoneE164);
    await this.rateLimits.consume(AUTH_RATE_LIMITS.otpSendPerPhoneDaily, phoneE164);
  }

  private async recordRequest(
    tx: Parameters<AuditService['record']>[0],
    phoneE164: string,
    purpose: string,
    outcome: string,
    meta: RequestMeta,
  ): Promise<void> {
    // The phone number is stored as a keyed hash: correlatable for abuse, not readable.
    await this.audit.record(tx, {
      actor: { type: 'USER' },
      action: 'auth.otp_requested',
      target: { type: 'phone_hash', id: this.hasher.hmacHex('subject', phoneE164) },
      changes: { purpose, outcome },
      meta,
    });
  }
}
