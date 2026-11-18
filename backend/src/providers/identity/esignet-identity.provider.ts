import { randomUUID } from 'node:crypto';
import {
  compactDecrypt,
  createLocalJWKSet,
  errors,
  type FlattenedJWSInput,
  importJWK,
  type JSONWebKeySet,
  type JWSHeaderParameters,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
  SignJWT,
} from 'jose';
import type { EsignetConfig } from '../../config/app-config.js';
import {
  type AuthorizationRequest,
  type CallbackErrorKind,
  classifyOidcCallbackError,
  type CodeExchange,
  IdentityProvider,
  IdentityProviderError,
  type ProviderIdentity,
} from './identity-provider.js';

/**
 * Fayda via eSignet: OIDC authorization code flow with PKCE and private_key_jwt
 * [ABSTRACTION -> EXTERNAL].
 *
 * Built from OpenID Connect Core 1.0, RFC 7636 (PKCE), RFC 7523 (JWT client assertion) and
 * the VeriFayda 2 (eSignet) relying-party integration guide published on NIDP's Confluence.
 * Every endpoint is read from the issuer's discovery document; nothing Fayda-specific is
 * hard-coded. It has been tested only against a simulated provider (signed test tokens);
 * running it against the real service needs NIDP onboarding (client id, registered
 * redirect URI, signing key) [EXTERNAL][LEGAL].
 *
 * Tokens are used once and discarded: they are never stored or logged.
 */

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface DiscoveryDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly userinfo_endpoint: string | undefined;
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_TTL_MS = 10 * 60 * 1000;
/** A key id the cached set does not know triggers a refetch, at most this often. */
const JWKS_REFRESH_COOLDOWN_MS = 30 * 1000;
const MAX_RESPONSE_CHARS = 256 * 1024;
const CLOCK_TOLERANCE_SECONDS = 60;
const CLIENT_ASSERTION_TTL_SECONDS = 120;
// VeriFayda 2: ID tokens, user information and client assertions use RS256 only.
const SIGNING_ALGORITHMS = ['RS256'];
const KEY_MANAGEMENT_ALGORITHMS = ['RSA-OAEP-256', 'RSA-OAEP'];
const CONTENT_ENCRYPTION_ALGORITHMS = ['A256GCM', 'A128GCM', 'A128CBC-HS256', 'A256CBC-HS512'];

function fail(kind: IdentityProviderError['kind'], detail: string): IdentityProviderError {
  return new IdentityProviderError(kind, detail);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `YYYY-MM-DD` or `YYYY/MM/DD` -> `YYYY-MM-DD`; null if it is not a real date. */
export function normalizeBirthdate(value: string): string | null {
  const match = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day] = match;
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** Plain claim, or the language-tagged form eSignet returns with several claims_locales. */
function localizedClaim(
  claims: Record<string, unknown>,
  name: string,
  locale: string,
): string | undefined {
  return stringField(claims, name) ?? stringField(claims, `${name}#${locale}`);
}

export class EsignetIdentityProvider extends IdentityProvider {
  readonly code = 'FAYDA_ESIGNET' as const;
  readonly slug = 'fayda';
  readonly available = true;

  private discovery: { doc: DiscoveryDocument; loadedAt: number } | undefined;
  private jwks: { resolve: ReturnType<typeof createLocalJWKSet>; loadedAt: number } | undefined;

  constructor(
    private readonly config: EsignetConfig,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  async prepare(signal: AbortSignal): Promise<void> {
    try {
      await this.loadDiscovery(signal);
    } catch (error) {
      throw this.classify(error, signal);
    }
  }

  authorizationUrl(request: AuthorizationRequest): string {
    const doc = this.discovery?.doc;
    if (doc === undefined) throw fail('MISCONFIGURED', 'prepare() was not called');
    const url = new URL(doc.authorization_endpoint);
    const params = url.searchParams;
    params.set('client_id', this.config.clientId);
    params.set('response_type', 'code');
    params.set('redirect_uri', request.redirectUri);
    params.set('scope', this.config.scopes.join(' '));
    params.set('state', request.state);
    params.set('nonce', request.nonce);
    params.set('code_challenge', request.codeChallenge);
    params.set('code_challenge_method', 'S256');
    params.set('ui_locales', request.locale);
    params.set('claims_locales', this.config.claimsLocale);
    if (this.config.acrValues !== undefined) params.set('acr_values', this.config.acrValues);
    if (this.config.claims.length > 0) {
      params.set(
        'claims',
        JSON.stringify({
          userinfo: Object.fromEntries(this.config.claims.map((c) => [c, { essential: true }])),
          id_token: {},
        }),
      );
    }
    return url.toString();
  }

  async exchange(input: CodeExchange): Promise<ProviderIdentity> {
    try {
      return await this.exchangeOrThrow(input);
    } catch (error) {
      throw this.classify(error, input.signal);
    }
  }

  classifyCallbackError(error: string): CallbackErrorKind {
    return classifyOidcCallbackError(error);
  }

  private async exchangeOrThrow(input: CodeExchange): Promise<ProviderIdentity> {
    const { signal } = input;
    const doc = await this.loadDiscovery(signal);

    // Token request authenticated with a fresh client assertion (private_key_jwt).
    const response = await this.fetchImpl(doc.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: this.config.clientId,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await this.clientAssertion(doc.token_endpoint),
        code_verifier: input.codeVerifier,
      }).toString(),
      signal,
      redirect: 'error',
    });
    const text = await readBody(response);
    if (!response.ok) throw tokenEndpointError(response.status, text);
    const tokens = asRecord(parseJson(text));
    const idToken = tokens === null ? undefined : stringField(tokens, 'id_token');
    const accessToken = tokens === null ? undefined : stringField(tokens, 'access_token');
    const tokenType = tokens === null ? undefined : stringField(tokens, 'token_type');
    if (
      idToken === undefined ||
      accessToken === undefined ||
      tokenType?.toLowerCase() !== 'bearer'
    ) {
      throw fail('INVALID_RESPONSE', 'token response is missing id_token/access_token');
    }

    // ID token: signature (JWKS), iss, aud, exp/iat with skew, required claims.
    const { payload: idClaims } = await jwtVerify(idToken, this.keyResolver(signal), {
      issuer: doc.issuer,
      audience: this.config.clientId,
      algorithms: SIGNING_ALGORITHMS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
      currentDate: new Date(this.now()),
    });
    const subject = idClaims.sub ?? '';
    const acr = typeof idClaims['acr'] === 'string' ? idClaims['acr'] : undefined;
    if (
      this.config.acceptedAcr.length > 0 &&
      (acr === undefined || !this.config.acceptedAcr.includes(acr))
    ) {
      throw fail('INSUFFICIENT_ASSURANCE', 'acr is not one of the accepted values');
    }

    let claims: Record<string, unknown> = {};
    if (this.config.claims.length > 0) {
      if (doc.userinfo_endpoint === undefined) {
        throw fail('MISCONFIGURED', 'claims requested but the provider has no userinfo endpoint');
      }
      claims = await this.userinfo(doc, accessToken, signal);
      if (claims['sub'] !== subject) {
        // OIDC Core §5.3.2: the userinfo subject must match the ID token.
        throw fail('INVALID_RESPONSE', 'userinfo sub does not match the ID token');
      }
    }

    const birthdate = stringField(claims, 'birthdate');
    const dateOfBirth = birthdate === undefined ? undefined : normalizeBirthdate(birthdate);
    if (dateOfBirth === null) throw fail('INVALID_RESPONSE', 'birthdate has an unknown format');
    return {
      subject,
      nonce: typeof idClaims['nonce'] === 'string' ? idClaims['nonce'] : undefined,
      assuranceLevel: acr,
      fullName: localizedClaim(claims, 'name', this.config.claimsLocale),
      dateOfBirth,
      claimNames: Object.keys(claims).sort(),
    };
  }

  /** Signed (JWS) or encrypted-then-signed (JWE) user information. Unsigned JSON is refused. */
  private async userinfo(
    doc: DiscoveryDocument,
    accessToken: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(doc.userinfo_endpoint ?? '', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/jwt' },
      signal,
      redirect: 'error',
    });
    const body = (await readBody(response)).trim();
    if (response.status >= 500) throw fail('UNAVAILABLE', `userinfo answered ${response.status}`);
    if (!response.ok) throw fail('INVALID_RESPONSE', `userinfo answered ${response.status}`);

    let jws = body;
    const parts = body.split('.').length;
    if (parts === 5) {
      if (this.config.userinfoPrivateJwk === undefined) {
        throw fail('MISCONFIGURED', 'encrypted userinfo received but no decryption key is set');
      }
      const key = await importJWK(this.config.userinfoPrivateJwk, 'RSA-OAEP-256');
      const { plaintext } = await compactDecrypt(body, key, {
        keyManagementAlgorithms: KEY_MANAGEMENT_ALGORITHMS,
        contentEncryptionAlgorithms: CONTENT_ENCRYPTION_ALGORITHMS,
      });
      jws = new TextDecoder().decode(plaintext);
    } else if (parts !== 3) {
      throw fail('INVALID_RESPONSE', 'userinfo is not a signed JWT');
    }
    const { payload } = await jwtVerify(jws, this.keyResolver(signal), {
      algorithms: SIGNING_ALGORITHMS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(this.now()),
    });
    // iss/aud are optional in eSignet user information; when present they must be ours.
    if (payload.iss !== undefined && payload.iss !== doc.issuer) {
      throw fail('INVALID_RESPONSE', 'userinfo issuer mismatch');
    }
    if (payload.aud !== undefined && !audienceIncludes(payload, this.config.clientId)) {
      throw fail('INVALID_RESPONSE', 'userinfo audience mismatch');
    }
    return payload;
  }

  private async clientAssertion(tokenEndpoint: string): Promise<string> {
    const key = await importJWK(this.config.clientPrivateJwk, 'RS256');
    const issuedAt = Math.floor(this.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({
        alg: 'RS256',
        typ: 'JWT',
        ...(typeof this.config.clientPrivateJwk.kid === 'string'
          ? { kid: this.config.clientPrivateJwk.kid }
          : {}),
      })
      .setIssuer(this.config.clientId)
      .setSubject(this.config.clientId)
      .setAudience(tokenEndpoint)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + CLIENT_ASSERTION_TTL_SECONDS)
      .setJti(randomUUID())
      .sign(key);
  }

  private keyResolver(signal: AbortSignal): JWTVerifyGetKey {
    return async (header: JWSHeaderParameters, token: FlattenedJWSInput) => {
      const cached = await this.loadJwks(signal, false);
      try {
        return await cached.resolve(header, token);
      } catch (error) {
        if (
          !(error instanceof errors.JWKSNoMatchingKey) ||
          this.now() - cached.loadedAt < JWKS_REFRESH_COOLDOWN_MS
        ) {
          throw error;
        }
        // Possible key rotation at the provider: refetch once.
        const fresh = await this.loadJwks(signal, true);
        return fresh.resolve(header, token);
      }
    };
  }

  private async loadJwks(
    signal: AbortSignal,
    force: boolean,
  ): Promise<{ resolve: ReturnType<typeof createLocalJWKSet>; loadedAt: number }> {
    if (!force && this.jwks !== undefined && this.now() - this.jwks.loadedAt < JWKS_TTL_MS) {
      return this.jwks;
    }
    const doc = await this.loadDiscovery(signal);
    const set = asRecord(await this.getJson(doc.jwks_uri, signal));
    if (set === null || !Array.isArray(set['keys'])) {
      throw fail('INVALID_RESPONSE', 'jwks_uri did not return a key set');
    }
    this.jwks = {
      resolve: createLocalJWKSet(set as unknown as JSONWebKeySet),
      loadedAt: this.now(),
    };
    return this.jwks;
  }

  private async loadDiscovery(signal: AbortSignal): Promise<DiscoveryDocument> {
    if (this.discovery !== undefined && this.now() - this.discovery.loadedAt < DISCOVERY_TTL_MS) {
      return this.discovery.doc;
    }
    const issuer = this.config.issuer.replace(/\/$/, '');
    const raw = asRecord(await this.getJson(`${issuer}/.well-known/openid-configuration`, signal));
    if (raw === null) throw fail('INVALID_RESPONSE', 'discovery document is not an object');
    const doc: DiscoveryDocument = {
      issuer: stringField(raw, 'issuer') ?? '',
      authorization_endpoint: stringField(raw, 'authorization_endpoint') ?? '',
      token_endpoint: stringField(raw, 'token_endpoint') ?? '',
      jwks_uri: stringField(raw, 'jwks_uri') ?? '',
      userinfo_endpoint: stringField(raw, 'userinfo_endpoint'),
    };
    // OIDC Discovery §4.3: the issuer in the document must equal the configured issuer.
    if (doc.issuer !== this.config.issuer) {
      throw fail('MISCONFIGURED', 'discovery issuer does not match IDENTITY_ESIGNET_ISSUER');
    }
    const secure = new URL(this.config.issuer).protocol === 'https:';
    for (const endpoint of [
      doc.authorization_endpoint,
      doc.token_endpoint,
      doc.jwks_uri,
      ...(doc.userinfo_endpoint === undefined ? [] : [doc.userinfo_endpoint]),
    ]) {
      if (!URL.canParse(endpoint) || (secure && new URL(endpoint).protocol !== 'https:')) {
        throw fail('MISCONFIGURED', 'discovery endpoint is not an https URL');
      }
    }
    const methods = raw['code_challenge_methods_supported'];
    if (Array.isArray(methods) && !methods.includes('S256')) {
      throw fail('MISCONFIGURED', 'provider does not support PKCE S256');
    }
    this.discovery = { doc, loadedAt: this.now() };
    return doc;
  }

  private async getJson(url: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
      redirect: 'error',
    });
    const text = await readBody(response);
    if (response.status >= 500) throw fail('UNAVAILABLE', `provider answered ${response.status}`);
    if (!response.ok) throw fail('MISCONFIGURED', `provider answered ${response.status}`);
    return parseJson(text);
  }

  /** Every failure becomes a typed error; nothing provider-supplied is copied into it. */
  private classify(error: unknown, signal: AbortSignal): IdentityProviderError {
    if (error instanceof IdentityProviderError) return error;
    if (signal.aborted) return fail('TIMEOUT', 'provider did not answer in time');
    if (error instanceof errors.JOSEError) return fail('INVALID_RESPONSE', error.code);
    if (error instanceof SyntaxError) return fail('INVALID_RESPONSE', 'malformed JSON');
    return fail('UNAVAILABLE', 'provider request failed');
  }
}

function audienceIncludes(payload: JWTPayload, clientId: string): boolean {
  return Array.isArray(payload.aud) ? payload.aud.includes(clientId) : payload.aud === clientId;
}

async function readBody(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) throw fail('INVALID_RESPONSE', 'response too large');
  return text;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** Token endpoint errors (OAuth 2.0 §5.2 and the VeriFayda 2 guide §3.2). */
function tokenEndpointError(status: number, body: string): IdentityProviderError {
  if (status >= 500) return fail('UNAVAILABLE', `token endpoint answered ${status}`);
  let code: string | undefined;
  try {
    const record = asRecord(JSON.parse(body));
    code = record === null ? undefined : stringField(record, 'error');
  } catch {
    code = undefined;
  }
  switch (code) {
    case 'invalid_grant':
    case 'invalid_transaction':
      return fail('INVALID_GRANT', 'authorization code rejected');
    case 'invalid_client':
    case 'invalid_assertion':
    case 'invalid_client_id':
    case 'invalid_redirect_uri':
    case 'invalid_assertion_type':
    case 'unauthorized_client':
    case 'invalid_request':
      return fail('MISCONFIGURED', `token endpoint rejected the client (${code})`);
    default:
      return fail('INVALID_RESPONSE', `token endpoint answered ${status}`);
  }
}
