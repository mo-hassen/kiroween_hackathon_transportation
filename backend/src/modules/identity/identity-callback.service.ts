import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { assertVisible, ownedByPrincipal } from '../../common/auth/policy.js';
import type { Principal } from '../../common/auth/principal.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { FieldEncryption } from '../../common/crypto/field-encryption.js';
import { randomToken } from '../../common/crypto/random.js';
import { hexDigestsEqual, SecretHasher, sha256Hex } from '../../common/crypto/secret-hasher.js';
import { DomainError, ErrorCode } from '../../common/http/problem-details.js';
import type { RequestMeta } from '../../common/http/request-meta.js';
import { OutboxService } from '../../common/outbox/outbox.service.js';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import type { IdentityProviderCode, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import {
  IdentityProvider,
  IdentityProviderError,
  type ProviderIdentity,
} from '../../providers/identity/identity-provider.js';
import { normalizeBirthdate } from '../../providers/identity/esignet-identity.provider.js';
import type { VerificationResponse } from './dto/identity.dto.js';
import { IdentityExpiryService } from './identity-expiry.service.js';
import {
  claimsAad,
  IDENTITY_CONFIRMATION_TTL_MS,
  IDENTITY_LIMITS,
  IDENTITY_RATE_LIMITS,
  pendingResultAad,
} from './identity-policy.js';
import { addMonths, OutcomeCode } from './identity-state.js';
import { IdentityTransitions, type PendingAttempt } from './identity-transitions.js';
import {
  IdentityVerificationService,
  safeError,
  toVerificationResponse,
  type VerifiedClaims,
} from './identity-verification.service.js';

const PROVIDER = { type: 'PROVIDER' } as const;
const STATE_FORMAT = /^[A-Za-z0-9_-]{43}$/;
// Printable ASCII without spaces; real codes are short opaque strings.
const CODE_FORMAT = /^[\x21-\x7e]+$/;
const ERROR_FORMAT = /^[\x20-\x7e]{1,100}$/;

export interface CallbackQuery {
  readonly code?: unknown;
  readonly state?: unknown;
  readonly error?: unknown;
}

type Decision =
  | { readonly kind: 'VERIFIED'; readonly identity: ValidIdentity }
  | {
      readonly kind: 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'REJECTED';
      readonly code: OutcomeCode;
    };

interface ValidIdentity {
  readonly subject: string;
  readonly assuranceLevel: string | null;
  readonly claims: VerifiedClaims;
  readonly claimNames: readonly string[];
}

/** Maps typed adapter failures to attempt outcomes. */
function failureDecision(error: unknown): Decision {
  if (!(error instanceof IdentityProviderError)) {
    return { kind: 'FAILED', code: OutcomeCode.PROVIDER_ERROR };
  }
  switch (error.kind) {
    case 'TIMEOUT':
      return { kind: 'FAILED', code: OutcomeCode.PROVIDER_TIMEOUT };
    case 'UNAVAILABLE':
      return { kind: 'FAILED', code: OutcomeCode.PROVIDER_UNAVAILABLE };
    case 'MISCONFIGURED':
      return { kind: 'FAILED', code: OutcomeCode.PROVIDER_MISCONFIGURED };
    case 'INVALID_GRANT':
      return { kind: 'FAILED', code: OutcomeCode.INVALID_GRANT };
    case 'INVALID_RESPONSE':
      return { kind: 'FAILED', code: OutcomeCode.INVALID_RESPONSE };
    case 'INSUFFICIENT_ASSURANCE':
      return { kind: 'REJECTED', code: OutcomeCode.ASSURANCE_TOO_LOW };
  }
}

/** Collapses whitespace; rejects control characters. */
function cleanName(value: string): string | null {
  const name = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (
    name.length === 0 ||
    name.length > IDENTITY_LIMITS.fullNameMaxLength ||
    /\p{Cc}/u.test(name)
  ) {
    return null;
  }
  return name;
}

/**
 * Independent checks of what the adapter returned (defence in depth: the adapter verified
 * signatures; this verifies the binding to our session and the shape of every value).
 */
export function validateProviderIdentity(
  identity: ProviderIdentity,
  expectedNonce: string,
  today: Date = new Date(),
): ValidIdentity | null {
  if (
    identity.nonce === undefined ||
    !hexDigestsEqual(sha256Hex(identity.nonce), sha256Hex(expectedNonce))
  ) {
    return null;
  }
  const subject = identity.subject;
  if (
    typeof subject !== 'string' ||
    subject.length === 0 ||
    subject.length > IDENTITY_LIMITS.subjectMaxLength ||
    !/^[\x21-\x7e]+$/.test(subject)
  ) {
    return null;
  }
  const fullName = identity.fullName === undefined ? null : cleanName(identity.fullName);
  if (fullName === null) return null;
  let dateOfBirth: string | null = null;
  if (identity.dateOfBirth !== undefined) {
    dateOfBirth = normalizeBirthdate(identity.dateOfBirth);
    if (dateOfBirth === null || new Date(`${dateOfBirth}T00:00:00Z`) > today) return null;
  }
  const assurance = identity.assuranceLevel ?? null;
  if (assurance !== null && assurance.length > IDENTITY_LIMITS.assuranceMaxLength) return null;
  return {
    subject,
    assuranceLevel: assurance,
    claims: { fullName, dateOfBirth },
    claimNames: identity.claimNames.filter((name) => /^[A-Za-z0-9_#.-]{1,64}$/.test(name)),
  };
}

/**
 * The provider's browser redirect (GET /identity/callback/:provider). Unauthenticated by
 * nature, so it trusts nothing in the request except the state value, which is
 * single-use: the first callback claims it atomically and every later one is ignored.
 * The browser is then sent back to the app with only the verification id; never a code,
 * token or claim.
 */
@Injectable()
export class IdentityCallbackService {
  private readonly logger = new Logger('IdentityCallback');

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: IdentityProvider,
    private readonly verifications: IdentityVerificationService,
    private readonly transitions: IdentityTransitions,
    private readonly expiry: IdentityExpiryService,
    private readonly hasher: SecretHasher,
    private readonly encryption: FieldEncryption,
    private readonly rateLimits: RateLimitService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Returns the URL to redirect the browser to. */
  async handle(slug: string, query: CallbackQuery, meta: RequestMeta): Promise<string> {
    await this.rateLimits.consume(IDENTITY_RATE_LIMITS.callbackPerIp, meta.ip ?? 'unknown');
    const providerCode = this.provider.code;
    const state = query.state;
    if (
      !this.provider.available ||
      providerCode === null ||
      slug !== this.provider.slug ||
      typeof state !== 'string' ||
      !STATE_FORMAT.test(state)
    ) {
      return this.returnUrl();
    }

    // Claim the state: one statement, so concurrent replays cannot both pass.
    const now = new Date();
    const [claimed] = await this.prisma.identityVerification.updateManyAndReturn({
      where: { stateHash: sha256Hex(state), provider: providerCode, callbackReceivedAt: null },
      data: { callbackReceivedAt: now },
      select: {
        id: true,
        userId: true,
        status: true,
        previousIdentityStatus: true,
        sessionExpiresAt: true,
        requestSecretsEnc: true,
      },
    });
    if (claimed === undefined) {
      await this.recordReplay(state, meta);
      return this.returnUrl();
    }
    if (claimed.status !== 'PENDING' || claimed.requestSecretsEnc === null) {
      // Cancelled or replaced before the provider answered: nothing to do.
      return this.returnUrl(claimed.id);
    }

    const decision = await this.decide(claimed, query, now, providerCode);
    if (decision.kind !== 'VERIFIED') {
      await this.apply(claimed, decision, providerCode, meta);
      return this.returnUrl(claimed.id);
    }
    // A valid result does NOT link the identity yet. Whoever completed the provider step
    // in this browser may not be the account holder (a forwarded link: cross-device consent
    // phishing). The result waits for the app session that started the attempt to present
    // the one-time token, which only travels through this browser's return link.
    const token = await this.holdForConfirmation(claimed.id, decision.identity, providerCode, meta);
    return token === null ? this.returnUrl(claimed.id) : this.returnUrl(claimed.id, token);
  }

  /**
   * Same-device confirmation (POST /identity/verifications/:id/confirm). Only the account
   * holder's session that started the attempt can complete it, and only with the token from
   * the return link. Every failure answers the same 400, and changes nothing.
   */
  async confirm(
    principal: Principal,
    verificationId: string,
    token: string,
    meta: RequestMeta,
  ): Promise<VerificationResponse> {
    if (principal.accountType !== 'CUSTOMER') {
      throw new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
    }
    await this.rateLimits.consume(IDENTITY_RATE_LIMITS.confirmPerUser, principal.userId);
    const attempt = assertVisible(
      principal,
      await this.prisma.identityVerification.findUnique({
        where: { id: verificationId },
        select: {
          id: true,
          userId: true,
          status: true,
          provider: true,
          previousIdentityStatus: true,
          initiatedSessionId: true,
          pendingResultEnc: true,
          confirmationHash: true,
          confirmationExpiresAt: true,
        },
      }),
      ownedByPrincipal,
    );
    // Already finished (e.g. a retried confirmation): report the outcome, change nothing.
    if (attempt.status !== 'PENDING') return this.view(attempt.id);

    const { pendingResultEnc, confirmationHash, confirmationExpiresAt } = attempt;
    let problem: string | null = null;
    if (pendingResultEnc === null || confirmationHash === null || confirmationExpiresAt === null) {
      problem = 'NO_RESULT';
    } else if (confirmationExpiresAt <= new Date()) {
      problem = 'EXPIRED';
    } else if (attempt.initiatedSessionId !== principal.sessionId) {
      problem = 'OTHER_SESSION';
    } else if (!hexDigestsEqual(sha256Hex(token), confirmationHash)) {
      problem = 'WRONG_TOKEN';
    }
    if (problem !== null || pendingResultEnc === null) {
      await this.audit.record(this.prisma, {
        actor: { type: 'USER', userId: principal.userId },
        action: 'identity.confirmation_rejected',
        target: { type: 'identity_verification', id: attempt.id },
        changes: { problem },
        meta,
      });
      if (problem === 'EXPIRED') await this.expiry.expireDueForUser(principal.userId);
      throw new DomainError(ErrorCode.IDENTITY_CONFIRMATION_INVALID, HttpStatus.BAD_REQUEST);
    }

    const identity = JSON.parse(
      this.encryption
        .decrypt(Buffer.from(pendingResultEnc), pendingResultAad(attempt.id))
        .toString('utf8'),
    ) as ValidIdentity;
    await this.apply(attempt, { kind: 'VERIFIED', identity }, attempt.provider, meta);
    return this.view(attempt.id);
  }

  /** Stores the validated result encrypted; returns the raw one-time token, or null. */
  private async holdForConfirmation(
    verificationId: string,
    identity: ValidIdentity,
    providerCode: IdentityProviderCode,
    meta: RequestMeta,
  ): Promise<string | null> {
    const token = randomToken(32);
    const held = await this.prisma.$transaction(async (tx) => {
      const result = await tx.identityVerification.updateMany({
        where: { id: verificationId, status: 'PENDING', confirmationHash: null },
        data: {
          pendingResultEnc: new Uint8Array(
            this.encryption.encrypt(
              Buffer.from(JSON.stringify(identity)),
              pendingResultAad(verificationId),
            ),
          ),
          confirmationHash: sha256Hex(token),
          confirmationExpiresAt: new Date(Date.now() + IDENTITY_CONFIRMATION_TTL_MS),
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) return false;
      await this.audit.record(tx, {
        actor: PROVIDER,
        action: 'identity.result_received',
        target: { type: 'identity_verification', id: verificationId },
        changes: { provider: providerCode, claimNames: [...identity.claimNames] },
        meta,
      });
      return true;
    });
    return held ? token : null;
  }

  private async view(verificationId: string): Promise<VerificationResponse> {
    return toVerificationResponse(
      await this.prisma.identityVerification.findUniqueOrThrow({
        where: { id: verificationId },
        select: {
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
        },
      }),
    );
  }

  private async decide(
    attempt: { id: string; sessionExpiresAt: Date; requestSecretsEnc: Uint8Array | null },
    query: CallbackQuery,
    now: Date,
    providerCode: IdentityProviderCode,
  ): Promise<Decision> {
    if (attempt.sessionExpiresAt <= now) {
      return { kind: 'EXPIRED', code: OutcomeCode.SESSION_EXPIRED };
    }
    if (query.error !== undefined) {
      const error =
        typeof query.error === 'string' && ERROR_FORMAT.test(query.error) ? query.error : '';
      switch (this.provider.classifyCallbackError(error)) {
        case 'DECLINED':
          return { kind: 'CANCELLED', code: OutcomeCode.DECLINED_AT_PROVIDER };
        case 'EXPIRED':
          return { kind: 'EXPIRED', code: OutcomeCode.PROVIDER_SESSION_EXPIRED };
        case 'FAILED':
          return { kind: 'FAILED', code: OutcomeCode.PROVIDER_ERROR };
      }
    }
    const code = query.code;
    if (
      typeof code !== 'string' ||
      code.length > IDENTITY_LIMITS.codeMaxLength ||
      !CODE_FORMAT.test(code) ||
      attempt.requestSecretsEnc === null
    ) {
      return { kind: 'FAILED', code: OutcomeCode.INVALID_RESPONSE };
    }

    const secrets = this.verifications.decryptSecrets(attempt.id, attempt.requestSecretsEnc);
    let identity: ProviderIdentity;
    try {
      identity = await this.exchangeWithTimeout(code, secrets.codeVerifier);
    } catch (error) {
      this.logger.warn(
        { verificationId: attempt.id, provider: providerCode, err: safeError(error) },
        'Identity provider exchange failed',
      );
      return failureDecision(error);
    }
    const valid = validateProviderIdentity(identity, secrets.nonce, now);
    if (valid === null) {
      this.logger.warn(
        { verificationId: attempt.id, provider: providerCode },
        'Identity provider response failed validation',
      );
      return { kind: 'FAILED', code: OutcomeCode.INVALID_RESPONSE };
    }
    return { kind: 'VERIFIED', identity: valid };
  }

  /** The adapter gets an abort signal; the race guarantees the bound even if it ignores it. */
  private async exchangeWithTimeout(code: string, codeVerifier: string): Promise<ProviderIdentity> {
    const timeoutMs = this.config.identity.providerTimeoutMs;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new IdentityProviderError('TIMEOUT', 'provider did not answer in time'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.provider.exchange({
          code,
          codeVerifier,
          redirectUri: this.verifications.redirectUri,
          signal: controller.signal,
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async apply(
    attempt: PendingAttempt,
    decision: Decision,
    providerCode: IdentityProviderCode,
    meta: RequestMeta,
  ): Promise<void> {
    await this.prisma
      .$transaction(async (tx) => {
        const account = await this.transitions.lockAccount(tx, attempt.userId);
        if (decision.kind !== 'VERIFIED') {
          await this.transitions.endPending(
            tx,
            account,
            attempt,
            decision.kind,
            decision.code,
            PROVIDER,
            meta,
          );
          return;
        }
        if (account.identityStatus !== 'PENDING') {
          // A staff action changed the account while the provider answered.
          await this.transitions.endPending(
            tx,
            account,
            attempt,
            'CANCELLED',
            OutcomeCode.CLOSED_BY_STAFF,
            PROVIDER,
            meta,
          );
          return;
        }

        const { identity } = decision;
        const subjectHmac = this.hasher.hmacHex('identity', `${providerCode}:${identity.subject}`);
        // Re-verification must present the identity already bound to this account.
        let rejection: OutcomeCode | null =
          account.identitySubjectHmac !== null && account.identitySubjectHmac !== subjectHmac
            ? OutcomeCode.IDENTITY_MISMATCH
            : null;
        // BR-ID-2: one national identity, one account.
        if (rejection === null && account.identitySubjectHmac === null) {
          const holder = await tx.user.findUnique({
            where: { identitySubjectHmac: subjectHmac },
            select: { id: true },
          });
          if (holder !== null) rejection = OutcomeCode.IDENTITY_ALREADY_LINKED;
        }
        if (rejection !== null) {
          const ended = await this.transitions.endPending(
            tx,
            account,
            attempt,
            'REJECTED',
            rejection,
            PROVIDER,
            meta,
            { subjectHmac },
          );
          if (ended !== null) await this.flagDuplicate(tx, attempt, rejection, meta);
          return;
        }

        // The re-verification replaces the attempt that asked for it (first, so that only
        // one attempt holds the current identity at any time).
        const replaced = await tx.identityVerification.findMany({
          where: {
            userId: attempt.userId,
            status: 'REVERIFICATION_REQUIRED',
            id: { not: attempt.id },
          },
          select: { id: true },
        });
        for (const old of replaced) {
          await this.transitions.moveAttempt(
            tx,
            old.id,
            ['REVERIFICATION_REQUIRED'],
            'SUPERSEDED',
            {
              outcomeCode: OutcomeCode.REPLACED_BY_REVERIFICATION,
              // The newer attempt holds the current claims: drop the old copy.
              verifiedClaimsEnc: null,
            },
          );
        }

        const now = new Date();
        const validUntil = addMonths(now, this.config.identity.validityMonths);
        const verified = await this.transitions.moveAttempt(
          tx,
          attempt.id,
          ['PENDING'],
          'VERIFIED',
          {
            completedAt: now,
            requestSecretsEnc: null,
            subjectHmac,
            verifiedAt: now,
            validUntil,
            assuranceLevel: identity.assuranceLevel,
            verifiedClaimsEnc: new Uint8Array(
              this.encryption.encrypt(
                Buffer.from(JSON.stringify(identity.claims)),
                claimsAad(attempt.id),
              ),
            ),
          },
        );
        // Cancelled or replaced meanwhile: roll back the supersede above as well.
        if (!verified) throw new AttemptNoLongerPending();

        const firstLink = account.identitySubjectHmac === null;
        await this.transitions.setAccountStatus(
          tx,
          account,
          'VERIFIED',
          firstLink ? { identitySubjectHmac: subjectHmac } : {},
        );
        await this.audit.record(tx, {
          actor: PROVIDER,
          action: 'identity.verification_verified',
          target: { type: 'identity_verification', id: attempt.id },
          changes: {
            provider: providerCode,
            assuranceLevel: identity.assuranceLevel,
            claimNames: [...identity.claimNames],
            validUntil: validUntil.toISOString(),
          },
          meta,
        });
        if (firstLink) {
          await this.audit.record(tx, {
            actor: PROVIDER,
            action: 'identity.linked',
            target: { type: 'user', id: attempt.userId },
            changes: { verificationId: attempt.id, provider: providerCode },
            meta,
          });
        }
        await this.outbox.enqueue(tx, {
          aggregateType: 'identity_verification',
          aggregateId: attempt.id,
          eventType: 'identity.verified',
          payload: { userId: attempt.userId, verificationId: attempt.id },
          requestId: meta.requestId,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof AttemptNoLongerPending) return;
        // Two accounts finishing with the same new identity at the same moment: the unique
        // index on users.identity_subject_hmac stops the second. Record it as a rejection.
        if (decision.kind === 'VERIFIED' && isUniqueViolation(error)) {
          return this.apply(
            attempt,
            { kind: 'REJECTED', code: OutcomeCode.IDENTITY_ALREADY_LINKED },
            providerCode,
            meta,
          );
        }
        throw error;
      });
  }

  /** BR-ID-2 "rejected and flagged": a risk event for verification officers. */
  private async flagDuplicate(
    tx: Prisma.TransactionClient,
    attempt: PendingAttempt,
    code: OutcomeCode,
    meta: RequestMeta,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: PROVIDER,
      action: 'identity.duplicate_detected',
      target: { type: 'identity_verification', id: attempt.id },
      changes: { outcomeCode: code },
      meta,
    });
    await this.outbox.enqueue(tx, {
      aggregateType: 'identity_verification',
      aggregateId: attempt.id,
      eventType: 'identity.duplicate_detected',
      payload: { userId: attempt.userId, verificationId: attempt.id, outcomeCode: code },
      requestId: meta.requestId,
    });
  }

  /** A known state presented again: audited against its attempt. Unknown states are not. */
  private async recordReplay(state: string, meta: RequestMeta): Promise<void> {
    const known = await this.prisma.identityVerification.findUnique({
      where: { stateHash: sha256Hex(state) },
      select: { id: true },
    });
    if (known === null) {
      this.logger.warn('Identity callback with an unknown state');
      return;
    }
    this.logger.warn({ verificationId: known.id }, 'Identity callback replayed');
    await this.audit.record(this.prisma, {
      actor: PROVIDER,
      action: 'identity.callback_replayed',
      target: { type: 'identity_verification', id: known.id },
      meta,
    });
  }

  /**
   * The app return link. It carries the attempt id and, after a valid result, the one-time
   * confirmation token: never an authorization code, OAuth token or identity claim.
   */
  private returnUrl(verificationId?: string, confirmation?: string): string {
    const url = new URL(this.config.identity.appReturnUrl);
    if (verificationId !== undefined) url.searchParams.set('verification', verificationId);
    if (confirmation !== undefined) url.searchParams.set('confirmation', confirmation);
    return url.toString();
  }
}

/** Rolls the completion transaction back when the attempt changed while the provider answered. */
class AttemptNoLongerPending extends Error {}

/** A unique violation on one of the subject indexes (not any unique violation). */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, meta } = error as { code?: unknown; meta?: unknown };
  return (
    code === 'P2002' && /subject_hmac_key|verified_subject_key/.test(JSON.stringify(meta ?? {}))
  );
}
