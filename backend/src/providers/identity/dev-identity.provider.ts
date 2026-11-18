import { timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { randomToken } from '../../common/crypto/random.js';
import {
  type AuthorizationRequest,
  type CallbackErrorKind,
  classifyOidcCallbackError,
  type CodeExchange,
  IdentityProvider,
  IdentityProviderError,
  pkceChallenge,
  type ProviderIdentity,
} from './identity-provider.js';

export const DEV_CLIENT_ID = 'dev-client';
const CODE_TTL_MS = 60_000;
const MAX_CODES = 1000;
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

export interface DevPerson {
  readonly subject: string;
  readonly fullName: string;
  readonly dateOfBirth: string;
}

/** Synthetic people offered on the dev consent page. Not real persons. */
export const DEFAULT_DEV_PERSON: DevPerson = Object.freeze({
  subject: 'dev-person-abebe',
  fullName: 'Abebe Bikila Demissie',
  dateOfBirth: '1990-08-07',
});

export const DEV_PERSONS: readonly DevPerson[] = Object.freeze([
  DEFAULT_DEV_PERSON,
  { subject: 'dev-person-tirunesh', fullName: 'Tirunesh Dibaba Kenene', dateOfBirth: '1985-06-01' },
  { subject: 'dev-person-haile', fullName: 'Haile Gebrselassie', dateOfBirth: '1973-04-18' },
]);

/**
 * What the dev consent page can simulate. `approve` and `decline` mirror real user choices;
 * the others exercise failure handling end to end.
 */
export const DEV_OUTCOMES = [
  'approve',
  'decline',
  'provider_error',
  'session_timeout',
  'slow',
  'bad_signature',
  'wrong_nonce',
] as const;
export type DevOutcome = (typeof DEV_OUTCOMES)[number];

export interface DevAuthorization {
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

interface IssuedCode {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly nonce: string;
  readonly person: DevPerson;
  readonly outcome: DevOutcome;
  readonly expiresAt: number;
}

function neverAnswer(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const timeout = (): void => {
      reject(new IdentityProviderError('TIMEOUT', 'dev provider did not answer'));
    };
    if (signal.aborted) timeout();
    else signal.addEventListener('abort', timeout, { once: true });
  });
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * DEVELOPMENT/TEST ONLY [IMPL]. Imitates an OIDC provider closely enough to run the real
 * flow: the same state, nonce and PKCE S256 checks, a one-time code that expires after 60 s,
 * and eSignet's callback error values. It returns synthetic identities, so config
 * validation rejects it in staging and production. Codes live in process memory.
 */
export class DevIdentityProvider extends IdentityProvider {
  readonly code = 'DEV' as const;
  readonly slug = 'dev';
  readonly available = true;
  private readonly logger = new Logger('DevIdentity');
  private readonly codes = new Map<string, IssuedCode>();

  constructor(
    private readonly publicApiBaseUrl: string,
    /** The only redirect URI this fake provider will send browsers to. */
    private readonly callbackUrl: string,
  ) {
    super();
  }

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  authorizationUrl(request: AuthorizationRequest): string {
    const url = new URL('/api/v1/dev/identity/authorize', this.publicApiBaseUrl);
    url.search = new URLSearchParams({
      client_id: DEV_CLIENT_ID,
      response_type: 'code',
      redirect_uri: request.redirectUri,
      scope: 'openid profile',
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      ui_locales: request.locale,
    }).toString();
    return url.toString();
  }

  /** Validates an authorization request like a provider would; null if it is invalid. */
  parseAuthorization(query: Record<string, unknown>): DevAuthorization | null {
    const value = (name: string): string | undefined =>
      typeof query[name] === 'string' ? query[name] : undefined;
    const redirectUri = value('redirect_uri');
    const state = value('state');
    const nonce = value('nonce');
    const codeChallenge = value('code_challenge');
    if (
      value('client_id') !== DEV_CLIENT_ID ||
      value('response_type') !== 'code' ||
      value('code_challenge_method') !== 'S256' ||
      redirectUri !== this.callbackUrl ||
      state === undefined ||
      !BASE64URL_43.test(state) ||
      nonce === undefined ||
      !BASE64URL_43.test(nonce) ||
      codeChallenge === undefined ||
      !BASE64URL_43.test(codeChallenge)
    ) {
      return null;
    }
    return { redirectUri, state, nonce, codeChallenge };
  }

  /** The user's choice on the consent page; returns where to send the browser. */
  decide(authorization: DevAuthorization, outcome: DevOutcome, person: DevPerson): string {
    const target = new URL(authorization.redirectUri);
    const error = (
      {
        decline: 'consent_request_rejected',
        provider_error: 'unknown_error',
        session_timeout: 'transaction_timeout',
      } as Partial<Record<DevOutcome, string>>
    )[outcome];
    if (error !== undefined) {
      target.search = new URLSearchParams({ error, state: authorization.state }).toString();
      return target.toString();
    }
    this.evictExpired();
    const code = randomToken();
    this.codes.set(code, {
      challenge: authorization.codeChallenge,
      redirectUri: authorization.redirectUri,
      nonce: authorization.nonce,
      person,
      outcome,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    target.search = new URLSearchParams({ code, state: authorization.state }).toString();
    return target.toString();
  }

  exchange(input: CodeExchange): Promise<ProviderIdentity> {
    const issued = this.codes.get(input.code);
    // One-time code, as at a real provider.
    this.codes.delete(input.code);
    if (
      issued === undefined ||
      issued.expiresAt <= Date.now() ||
      issued.redirectUri !== input.redirectUri ||
      !sameString(pkceChallenge(input.codeVerifier), issued.challenge)
    ) {
      return Promise.reject(
        new IdentityProviderError('INVALID_GRANT', 'unknown, used or expired code'),
      );
    }
    // Never answers: the caller's timeout must end the attempt.
    if (issued.outcome === 'slow') return neverAnswer(input.signal);
    if (issued.outcome === 'bad_signature') {
      return Promise.reject(
        new IdentityProviderError('INVALID_RESPONSE', 'ID token signature invalid'),
      );
    }
    this.logger.log({ outcome: issued.outcome }, 'Dev identity code exchanged');
    return Promise.resolve({
      subject: issued.person.subject,
      nonce: issued.outcome === 'wrong_nonce' ? randomToken() : issued.nonce,
      assuranceLevel: 'dev:synthetic',
      fullName: issued.person.fullName,
      dateOfBirth: issued.person.dateOfBirth,
      claimNames: ['sub', 'name', 'birthdate'],
    });
  }

  classifyCallbackError(error: string): CallbackErrorKind {
    return classifyOidcCallbackError(error);
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [code, issued] of this.codes) {
      if (issued.expiresAt <= now) this.codes.delete(code);
    }
    if (this.codes.size >= MAX_CODES) this.codes.clear();
  }
}
