import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service.js';
import type { RequestMeta } from '../../../common/http/request-meta.js';
import {
  IdempotencyService,
  type IdempotentResult,
} from '../../../common/idempotency/idempotency.service.js';
import { OutboxService } from '../../../common/outbox/outbox.service.js';
import { RateLimitService } from '../../../common/rate-limit/rate-limit.service.js';
import { isUniqueViolation, otpInvalid } from '../auth-errors.js';
import { AUTH_RATE_LIMITS } from '../auth-policy.js';
import type { RegisterDto } from '../dto/auth-requests.dto.js';
import { OtpChallengeService } from '../otp/otp-challenge.service.js';
import { PasswordService } from '../password/password.service.js';
import { DeviceService } from '../sessions/device.service.js';

/**
 * Creates a customer account after OTP proof (journey J1). The account starts ACTIVE and
 * the registering installation becomes a trusted device. Registration returns no tokens:
 * the response is stored for idempotent replay and must not contain secrets, so the app
 * logs in next (from the now-trusted device, without a second SMS).
 */
@Injectable()
export class RegistrationService {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly otp: OtpChallengeService,
    private readonly passwords: PasswordService,
    private readonly devices: DeviceService,
    private readonly rateLimits: RateLimitService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async register(
    dto: RegisterDto,
    idempotencyKey: string,
    meta: RequestMeta,
  ): Promise<IdempotentResult> {
    this.passwords.assertAcceptable(dto.password, 'password', { phoneE164: dto.phone });
    await this.rateLimits.consume(AUTH_RATE_LIMITS.codeVerifyPerIp, meta.ip ?? 'unknown');
    // Hash first: every outcome (unknown number, wrong code, success) costs the same time.
    const passwordHash = await this.passwords.hash(dto.password);

    return this.idempotency.execute(
      {
        scope: 'auth.register',
        principal: 'anonymous',
        key: idempotencyKey,
        fingerprint: { method: 'POST', route: '/auth/register', body: dto },
      },
      async (tx) => {
        const challenge = await this.otp.attemptLatest('REGISTER', dto.phone, dto.otp);
        if (challenge === null || !(await this.otp.consume(tx, challenge.id))) throw otpInvalid();

        // A number registered after the code was sent: same generic error as a wrong code.
        if (
          (await tx.user.findUnique({ where: { phoneE164: dto.phone }, select: { id: true } })) !==
          null
        ) {
          throw otpInvalid();
        }
        const user = await tx.user
          .create({
            data: {
              phoneE164: dto.phone,
              passwordHash,
              passwordChangedAt: new Date(),
              accountType: 'CUSTOMER',
              status: 'ACTIVE',
              displayName: dto.displayName,
              preferredLocale: dto.preferredLocale ?? 'en',
            },
            select: { id: true },
          })
          .catch((error: unknown) => {
            throw isUniqueViolation(error) ? otpInvalid() : error;
          });

        await this.devices.upsert(tx, user.id, dto.device, { trust: true });
        await this.audit.record(tx, {
          actor: { type: 'USER', userId: user.id },
          action: 'auth.registered',
          target: { type: 'user', id: user.id },
          changes: { platform: dto.device.platform },
          meta,
        });
        await this.outbox.enqueue(tx, {
          aggregateType: 'user',
          aggregateId: user.id,
          eventType: 'user.registered',
          payload: { userId: user.id },
          requestId: meta.requestId,
        });
        return { status: 201, body: { userId: user.id } };
      },
    );
  }
}
