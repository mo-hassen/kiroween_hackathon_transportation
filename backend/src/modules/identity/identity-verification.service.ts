import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { assertVisible, ownedByPrincipal } from '../../common/auth/policy.js';
import type { Principal } from '../../common/auth/principal.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { FieldEncryption } from '../../common/crypto/field-encryption.js';
import { randomToken } from '../../common/crypto/random.js';
import { sha256Hex } from '../../common/crypto/secret-hasher.js';
import { uuidv7 } from '../../common/crypto/uuid.js';
import { DomainError, ErrorCode } from '../../common/http/problem-details.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { IdempotencyService } from '../../common/idempotency/idempotency.service.js';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import type { IdentityVerification, Locale } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import {
  IdentityProvider,
  identityCallbackUrl,
  pkceChallenge,
} from '../../providers/identity/identity-provider.js';
import type {
  IdentityOverviewResponse,
  StartVerificationDto,
  StartVerificationResponse,
  VerificationResponse,
} from './dto/identity.dto.js';
import { IdentityExpiryService } from './identity-expiry.service.js';
import { claimsAad, IDENTITY_RATE_LIMITS, secretsAad } from './identity-policy.js';
import { canStart, clientReason, OutcomeCode } from './identity-state.js';
import { IdentityTransitions, invalidTransition } from './identity-transitions.js';

/** Encrypted at rest on the attempt until it leaves PENDING. Never sent to the client. */
export interface RequestSecrets {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

export interface VerifiedClaims {
  readonly fullName: string;
  readonly dateOfBirth: string | null;
}

export interface StartResult {
  readonly status: number;
  readonly replayed: boolean;
  readonly body: StartVerificationResponse;
}

type AttemptView = Pick<
  IdentityVerification,
  | 'id'
  | 'userId'
  | 'status'
  | 'outcomeCode'
  | 'provider'
  | 'createdAt'
  | 'sessionExpiresAt'
  | 'completedAt'
  | 'verifiedAt'
  | 'validUntil'
>;

const ATTEMPT_VIEW = {
  id: true,
  userId: true,
  status: true,
  outcomeCode: true,
  provider: true,
  createdAt: true,
  sessionExpiresAt: true,
  completedAt: true,
  verifiedAt: true,
  validUntil: true,
} as const;

/** Customer identity routes are 404 for staff: staff accounts have no customer identity. */
function assertCustomer(principal: Principal): void {
  if (principal.accountType !== 'CUSTOMER') {
    throw new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
  }
}

export function identityUnavailable(): DomainError {
  return new DomainError(ErrorCode.IDENTITY_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE);
}

export function toVerificationResponse(attempt: AttemptView): VerificationResponse {
  return {
    id: attempt.id,
    status: attempt.status,
    reason: clientReason(attempt.status, attempt.outcomeCode),
    provider: attempt.provider,
    createdAt: attempt.createdAt.toISOString(),
    sessionExpiresAt: attempt.sessionExpiresAt.toISOString(),
    completedAt: attempt.completedAt?.toISOString() ?? null,
    verifiedAt: attempt.verifiedAt?.toISOString() ?? null,
    validUntil: attempt.validUntil?.toISOString() ?? null,
  };
}

/**
 * Journey J2 for the account holder (docs/architecture/08-identity-and-verification.md §4):
 * start (consent), read status, cancel. The result itself is only ever written by
 * IdentityCallbackService from a validated provider response.
 */
@Injectable()
export class IdentityVerificationService {
  private readonly logger = new Logger('IdentityVerification');

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: IdentityProvider,
    private readonly transitions: IdentityTransitions,
    private readonly expiry: IdentityExpiryService,
    private readonly idempotency: IdempotencyService,
    private readonly rateLimits: RateLimitService,
    private readonly encryption: FieldEncryption,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get redirectUri(): string {
    return identityCallbackUrl(this.config.identity.publicApiBaseUrl, this.provider.slug);
  }

  /**
   * Creates a PENDING attempt (replacing an open one) and returns the provider URL.
   * Idempotent: a retry with the same key returns the same attempt and URL. The stored
   * idempotent response holds only the attempt id; the URL is rebuilt from the encrypted
   * session values, so no state or nonce is kept in plain text.
   */
  async start(
    principal: Principal,
    dto: StartVerificationDto,
    idempotencyKey: string,
    meta: RequestMeta,
  ): Promise<StartResult> {
    assertCustomer(principal);
    const providerCode = this.provider.code;
    if (!this.provider.available || providerCode === null) throw identityUnavailable();
    await this.rateLimits.consume(IDENTITY_RATE_LIMITS.startPerUser, principal.userId);
    try {
      await this.provider.prepare(AbortSignal.timeout(this.config.identity.providerTimeoutMs));
    } catch (error) {
      this.logger.warn({ err: safeError(error) }, 'Identity provider not ready');
      throw identityUnavailable();
    }
    const locale: Locale = dto.locale ?? 'en';

    const result = await this.idempotency.execute(
      {
        scope: 'identity.start',
        principal: `user:${principal.userId}`,
        key: idempotencyKey,
        fingerprint: { method: 'POST', route: '/identity/verifications', body: dto },
      },
      async (tx) => {
        const now = new Date();
        const account = await this.expiry.expireDue(
          tx,
          await this.transitions.lockAccount(tx, principal.userId),
          now,
        );
        if (!canStart(account.identityStatus)) {
          throw new DomainError(ErrorCode.IDENTITY_VERIFICATION_NOT_ALLOWED, HttpStatus.CONFLICT);
        }

        // A new start replaces the open attempt and inherits the status it would restore.
        let previous = account.identityStatus;
        const open = await tx.identityVerification.findFirst({
          where: { userId: principal.userId, status: 'PENDING' },
          select: { id: true, previousIdentityStatus: true },
        });
        if (open !== null) {
          await this.transitions.moveAttempt(tx, open.id, ['PENDING'], 'SUPERSEDED', {
            outcomeCode: OutcomeCode.REPLACED_BY_NEW_ATTEMPT,
            completedAt: now,
            requestSecretsEnc: null,
          });
          previous = open.previousIdentityStatus;
          await this.audit.record(tx, {
            actor: { type: 'USER', userId: principal.userId },
            action: 'identity.verification_superseded',
            target: { type: 'identity_verification', id: open.id },
            meta,
          });
        }

        const id = uuidv7(now.getTime());
        const secrets: RequestSecrets = {
          state: randomToken(32),
          nonce: randomToken(32),
          // 64 base64url characters (RFC 7636 allows 43-128).
          codeVerifier: randomToken(48),
        };
        await tx.identityVerification.create({
          data: {
            id,
            userId: principal.userId,
            // The only session allowed to confirm the result (same-device binding).
            initiatedSessionId: principal.sessionId,
            provider: providerCode,
            previousIdentityStatus: previous,
            consentedAt: now,
            stateHash: sha256Hex(secrets.state),
            requestSecretsEnc: new Uint8Array(
              this.encryption.encrypt(Buffer.from(JSON.stringify(secrets)), secretsAad(id)),
            ),
            sessionExpiresAt: new Date(now.getTime() + this.config.identity.sessionTtlMs),
          },
        });
        await this.transitions.setAccountStatus(tx, account, 'PENDING');
        await this.audit.record(tx, {
          actor: { type: 'USER', userId: principal.userId },
          action: 'identity.verification_started',
          target: { type: 'identity_verification', id },
          changes: { provider: providerCode, consent: true, locale },
          meta,
        });
        return { status: 201, body: { verificationId: id, locale } };
      },
    );

    const stored = result.body as { verificationId: string; locale: Locale };
    return {
      status: result.status,
      replayed: result.replayed,
      body: await this.present(principal, stored.verificationId, stored.locale),
    };
  }

  /** The attempt plus, while it can still be completed, its provider URL. */
  private async present(
    principal: Principal,
    verificationId: string,
    locale: Locale,
  ): Promise<StartVerificationResponse> {
    const attempt = await this.prisma.identityVerification.findUniqueOrThrow({
      where: { id: verificationId },
      select: { ...ATTEMPT_VIEW, callbackReceivedAt: true, requestSecretsEnc: true },
    });
    const owned = assertVisible(principal, attempt, ownedByPrincipal);
    const open =
      owned.status === 'PENDING' &&
      owned.callbackReceivedAt === null &&
      owned.sessionExpiresAt > new Date() &&
      owned.requestSecretsEnc !== null;
    let authorizationUrl: string | null = null;
    if (open && owned.requestSecretsEnc !== null) {
      const secrets = this.decryptSecrets(owned.id, owned.requestSecretsEnc);
      authorizationUrl = this.provider.authorizationUrl({
        state: secrets.state,
        nonce: secrets.nonce,
        codeChallenge: pkceChallenge(secrets.codeVerifier),
        redirectUri: this.redirectUri,
        locale,
      });
    }
    return { verification: toVerificationResponse(owned), authorizationUrl };
  }

  async overview(principal: Principal): Promise<IdentityOverviewResponse> {
    assertCustomer(principal);
    await this.expiry.expireDueForUser(principal.userId);
    const [user, latest, current] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: principal.userId },
        select: { identityStatus: true },
      }),
      this.prisma.identityVerification.findFirst({
        where: { userId: principal.userId },
        orderBy: { createdAt: 'desc' },
        select: ATTEMPT_VIEW,
      }),
      this.prisma.identityVerification.findFirst({
        where: { userId: principal.userId, status: 'VERIFIED' },
        select: { id: true, verifiedAt: true, validUntil: true, verifiedClaimsEnc: true },
      }),
    ]);
    const claims =
      current?.verifiedClaimsEnc == null
        ? null
        : this.decryptClaims(current.id, current.verifiedClaimsEnc);
    return {
      identityStatus: user.identityStatus,
      canStart: this.provider.available && canStart(user.identityStatus),
      verifiedName: user.identityStatus === 'VERIFIED' ? (claims?.fullName ?? null) : null,
      verifiedAt: current?.verifiedAt?.toISOString() ?? null,
      validUntil: current?.validUntil?.toISOString() ?? null,
      latest: latest === null ? null : toVerificationResponse(latest),
    };
  }

  /** Own attempts only; any other id (another user's, unknown) is 404. */
  async get(principal: Principal, verificationId: string): Promise<VerificationResponse> {
    assertCustomer(principal);
    await this.expiry.expireDueForUser(principal.userId);
    const attempt = await this.prisma.identityVerification.findUnique({
      where: { id: verificationId },
      select: ATTEMPT_VIEW,
    });
    return toVerificationResponse(assertVisible(principal, attempt, ownedByPrincipal));
  }

  /** Cancels the caller's open attempt. Repeating a cancellation is answered the same way. */
  async cancel(
    principal: Principal,
    verificationId: string,
    meta: RequestMeta,
  ): Promise<VerificationResponse> {
    assertCustomer(principal);
    return this.prisma.$transaction(async (tx) => {
      const account = await this.expiry.expireDue(
        tx,
        await this.transitions.lockAccount(tx, principal.userId),
      );
      const attempt = assertVisible(
        principal,
        await tx.identityVerification.findUnique({
          where: { id: verificationId },
          select: { ...ATTEMPT_VIEW, previousIdentityStatus: true },
        }),
        ownedByPrincipal,
      );
      const alreadyCancelled =
        attempt.status === 'CANCELLED' && attempt.outcomeCode === OutcomeCode.CANCELLED_BY_USER;
      if (!alreadyCancelled) {
        if (attempt.status !== 'PENDING') throw invalidTransition();
        const ended = await this.transitions.endPending(
          tx,
          account,
          attempt,
          'CANCELLED',
          OutcomeCode.CANCELLED_BY_USER,
          { type: 'USER', userId: principal.userId },
          meta,
        );
        if (ended === null) throw invalidTransition();
      }
      return toVerificationResponse(
        await tx.identityVerification.findUniqueOrThrow({
          where: { id: verificationId },
          select: ATTEMPT_VIEW,
        }),
      );
    });
  }

  decryptSecrets(verificationId: string, payload: Uint8Array): RequestSecrets {
    const value = JSON.parse(
      this.encryption.decrypt(Buffer.from(payload), secretsAad(verificationId)).toString('utf8'),
    ) as RequestSecrets;
    return value;
  }

  decryptClaims(verificationId: string, payload: Uint8Array): VerifiedClaims {
    return JSON.parse(
      this.encryption.decrypt(Buffer.from(payload), claimsAad(verificationId)).toString('utf8'),
    ) as VerifiedClaims;
  }
}

/** Error facts that are safe to log (never messages from providers or tokens). */
export function safeError(error: unknown): { name: string; kind?: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === 'string' ? { name: error.name, kind } : { name: error.name };
}
