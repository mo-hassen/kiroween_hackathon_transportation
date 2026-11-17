import type { BlockList } from 'node:net';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { buildIpAllowlist, ipAllowed } from '../../../common/auth/authentication.guard.js';
import { AuditService } from '../../../common/audit/audit.service.js';
import { FieldEncryption } from '../../../common/crypto/field-encryption.js';
import { normalizeActivationCode } from '../../../common/crypto/random.js';
import { DomainError, ErrorCode } from '../../../common/http/problem-details.js';
import type { RequestMeta } from '../../../common/http/request-meta.js';
import { RateLimitService } from '../../../common/rate-limit/rate-limit.service.js';
import { APP_CONFIG, type AppConfig } from '../../../config/app-config.js';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { invalidCredentials, otpInvalid } from '../auth-errors.js';
import { AUTH_POLICY, AUTH_RATE_LIMITS } from '../auth-policy.js';
import type {
  StaffActivateConfirmDto,
  StaffActivateDto,
  StaffLoginDto,
} from '../dto/staff-requests.dto.js';
import { isLocked } from '../login/lockout.js';
import { LoginFailuresService } from '../login/login-failures.service.js';
import { OtpChallengeService } from '../otp/otp-challenge.service.js';
import { PasswordService } from '../password/password.service.js';
import { DeviceService } from '../sessions/device.service.js';
import { SessionService, type TokenPair } from '../sessions/session.service.js';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

export const TOTP_ISSUER = 'Kiroween Mobility';

export function mfaSecretAad(userId: string): string {
  return `users.mfa_secret_enc:${userId}`;
}

export interface StaffEnrollment {
  readonly enrollmentTicket: string;
  readonly totpSecret: string;
  readonly otpauthUri: string;
  readonly expiresAt: Date;
}

/**
 * Staff authentication: password + TOTP on every login, 12-hour sessions, step-up
 * re-authentication for sensitive actions, and activation with a one-time code issued by
 * a super administrator (docs/architecture/07-security-architecture.md §1).
 */
@Injectable()
export class StaffAuthService {
  private readonly ipAllowlist: BlockList | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly devices: DeviceService,
    private readonly otp: OtpChallengeService,
    private readonly failures: LoginFailuresService,
    private readonly rateLimits: RateLimitService,
    private readonly audit: AuditService,
    @Inject(FieldEncryption) private readonly encryption: FieldEncryption,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.ipAllowlist = buildIpAllowlist(config.auth.staffIpAllowlist);
  }

  async login(dto: StaffLoginDto, meta: RequestMeta): Promise<TokenPair> {
    await this.rateLimits.consume(AUTH_RATE_LIMITS.loginPerIp, meta.ip ?? 'unknown');
    if (!ipAllowed(this.ipAllowlist, meta.ip)) {
      // Same answer as wrong credentials: the allow-list is not revealed.
      await this.passwords.verifyDummy(dto.password);
      throw invalidCredentials();
    }
    await this.rateLimits.consume(AUTH_RATE_LIMITS.loginPerPhone, dto.phone);
    const user = await this.prisma.user.findUnique({
      where: { phoneE164: dto.phone },
      select: { id: true, accountType: true, status: true, passwordHash: true, lockedUntil: true },
    });
    const candidate = user?.accountType === 'STAFF' && user.status === 'ACTIVE' ? user : null;
    if (candidate === null || isLocked(candidate.lockedUntil, new Date())) {
      await this.passwords.verifyDummy(dto.password);
      await this.failures.recordUnknown(
        dto.phone,
        candidate === null ? 'UNKNOWN_ACCOUNT' : 'LOCKED',
        meta,
        candidate?.id,
      );
      throw invalidCredentials();
    }
    const passwordOk = await this.passwords.verify(candidate.passwordHash, dto.password);
    const step = passwordOk ? await this.consumeTotp(candidate.id, dto.totpCode) : null;
    if (step === null) {
      await this.failures.recordWrongSecret(candidate, meta);
      throw invalidCredentials();
    }

    return this.prisma.$transaction(async (tx) => {
      await this.failures.reset(tx, candidate.id);
      const device = await this.devices.upsert(tx, candidate.id, dto.device, { trust: false });
      const roles = await tx.staffRoleAssignment.findMany({
        where: { userId: candidate.id, revokedAt: null },
        select: { role: true },
      });
      await this.audit.record(tx, {
        actor: { type: 'STAFF', userId: candidate.id },
        action: 'auth.staff_login_succeeded',
        target: { type: 'user', id: candidate.id },
        meta,
      });
      return this.sessions.create(
        tx,
        { userId: candidate.id, accountType: 'STAFF', roles: roles.map((r) => r.role) },
        device.id,
        meta,
      );
    });
  }

  /** Step-up: re-enter password + TOTP; refreshes the session's authentication time. */
  async reauthenticate(
    principal: { userId: string; sessionId: string },
    password: string,
    totpCode: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.rateLimits.consume(AUTH_RATE_LIMITS.sensitivePerUser, principal.userId);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: principal.userId },
      select: { id: true, accountType: true, passwordHash: true },
    });
    const passwordOk = await this.passwords.verify(user.passwordHash, password);
    const step = passwordOk ? await this.consumeTotp(user.id, totpCode) : null;
    if (step === null) {
      await this.audit.record(this.prisma, {
        actor: { type: 'STAFF', userId: user.id },
        action: 'auth.staff_reauthentication_failed',
        target: { type: 'session', id: principal.sessionId },
        meta,
      });
      // 400, not 401: the session itself is still valid.
      throw invalidCredentials(HttpStatus.BAD_REQUEST);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.session.update({
        where: { id: principal.sessionId },
        data: { authenticatedAt: new Date() },
      });
      await this.audit.record(tx, {
        actor: { type: 'STAFF', userId: user.id },
        action: 'auth.staff_reauthenticated',
        target: { type: 'session', id: principal.sessionId },
        meta,
      });
    });
  }

  /** Step 1 of activation: one-time code + new password -> TOTP secret to enroll. */
  async activate(dto: StaffActivateDto, meta: RequestMeta): Promise<StaffEnrollment> {
    await this.rateLimits.consume(AUTH_RATE_LIMITS.codeVerifyPerIp, meta.ip ?? 'unknown');
    this.passwords.assertAcceptable(dto.newPassword, 'newPassword', { phoneE164: dto.phone });
    const passwordHash = await this.passwords.hash(dto.newPassword);
    const challenge = await this.otp.attemptLatest(
      'STAFF_ACTIVATION',
      dto.phone,
      normalizeActivationCode(dto.activationCode),
    );
    const userId = challenge?.userId;
    if (challenge === null || userId == null) throw otpInvalid();

    const secret = generateTotpSecret();
    const result = await this.prisma.$transaction(async (tx) => {
      if (!(await this.otp.consume(tx, challenge.id))) return null;
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { accountType: true, status: true, displayName: true },
      });
      if (user?.accountType !== 'STAFF' || user.status !== 'PENDING_ACTIVATION') return null;
      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          mfaSecretEnc: new Uint8Array(this.encryption.encrypt(secret, mfaSecretAad(userId))),
          mfaEnrolledAt: null,
          mfaLastUsedStep: null,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      const enrollment = await this.otp.issue(tx, {
        purpose: 'STAFF_MFA_ENROLLMENT',
        phoneE164: dto.phone,
        userId,
        code: null,
        withTicket: true,
        ttlMs: AUTH_POLICY.staffEnrollmentTtlMs,
        maxAttempts: AUTH_POLICY.staffEnrollmentMaxAttempts,
      });
      await this.audit.record(tx, {
        actor: { type: 'STAFF', userId },
        action: 'staff.password_set',
        target: { type: 'user', id: userId },
        meta,
      });
      return { enrollment, accountName: user.displayName ?? 'staff' };
    });
    if (result?.enrollment.ticket == null) throw otpInvalid();
    return {
      enrollmentTicket: result.enrollment.ticket,
      totpSecret: base32Encode(secret),
      otpauthUri: otpauthUri({ secret, accountName: result.accountName, issuer: TOTP_ISSUER }),
      expiresAt: result.enrollment.expiresAt,
    };
  }

  /** Step 2 of activation: prove the authenticator works; the account becomes ACTIVE. */
  async confirmEnrollment(dto: StaffActivateConfirmDto, meta: RequestMeta): Promise<void> {
    await this.rateLimits.consume(AUTH_RATE_LIMITS.codeVerifyPerIp, meta.ip ?? 'unknown');
    const challenge = await this.otp.attemptByTicket(
      'STAFF_MFA_ENROLLMENT',
      dto.enrollmentTicket,
      null,
    );
    const userId = challenge?.userId;
    if (challenge === null || userId == null) throw otpInvalid();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, mfaSecretEnc: true },
    });
    if (user?.status !== 'PENDING_ACTIVATION' || user.mfaSecretEnc === null) throw otpInvalid();
    const step = verifyTotp(
      this.encryption.decrypt(Buffer.from(user.mfaSecretEnc), mfaSecretAad(userId)),
      dto.totpCode,
      Date.now(),
    );
    if (step === null) throw otpInvalid();

    const done = await this.prisma.$transaction(async (tx) => {
      if (!(await this.otp.consume(tx, challenge.id))) return false;
      await tx.user.update({
        where: { id: userId },
        data: { status: 'ACTIVE', mfaEnrolledAt: new Date(), mfaLastUsedStep: BigInt(step) },
      });
      await this.audit.record(tx, {
        actor: { type: 'STAFF', userId },
        action: 'staff.activated',
        target: { type: 'user', id: userId },
        changes: { status: { from: 'PENDING_ACTIVATION', to: 'ACTIVE' } },
        meta,
      });
      return true;
    });
    if (!done) throw otpInvalid();
  }

  /**
   * Verifies a TOTP code and records its step atomically, so a code (even an intercepted
   * one) cannot be replayed within its validity window.
   */
  private async consumeTotp(userId: string, code: string): Promise<number | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mfaSecretEnc: true, mfaEnrolledAt: true },
    });
    if (user?.mfaSecretEnc == null || user.mfaEnrolledAt === null) return null;
    let secret: Buffer;
    try {
      secret = this.encryption.decrypt(Buffer.from(user.mfaSecretEnc), mfaSecretAad(userId));
    } catch {
      throw new DomainError(ErrorCode.INTERNAL_ERROR, HttpStatus.INTERNAL_SERVER_ERROR);
    }
    const step = verifyTotp(secret, code, Date.now());
    if (step === null) return null;
    const claimed = await this.prisma.user.updateMany({
      where: {
        id: userId,
        OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: BigInt(step) } }],
      },
      data: { mfaLastUsedStep: BigInt(step) },
    });
    return claimed.count === 1 ? step : null;
  }
}
