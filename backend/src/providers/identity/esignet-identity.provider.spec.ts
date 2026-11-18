import type { JWK } from 'jose';
import {
  FAKE_ACR,
  type FakeMode,
  FakeOidcProvider,
  generateRsaJwkPair,
} from '../../../test/helpers/fake-oidc-provider.js';
import { randomToken } from '../../common/crypto/random.js';
import type { EsignetConfig } from '../../config/app-config.js';
import { EsignetIdentityProvider, normalizeBirthdate } from './esignet-identity.provider.js';
import { IdentityProviderError, pkceChallenge } from './identity-provider.js';

const CLIENT_ID = 'mobility-relying-party';
const REDIRECT_URI = 'https://api.example.et/api/v1/identity/callback/fayda';

let fake: FakeOidcProvider;
let clientKeys: { privateJwk: JWK; publicJwk: JWK };
let userinfoKeys: { privateJwk: JWK; publicJwk: JWK };

beforeAll(async () => {
  clientKeys = await generateRsaJwkPair('client-2026');
  userinfoKeys = await generateRsaJwkPair('enc-2026', 'RSA-OAEP-256');
  fake = await FakeOidcProvider.start({
    clientId: CLIENT_ID,
    clientPublicJwk: clientKeys.publicJwk,
    userinfoPublicJwk: userinfoKeys.publicJwk,
  });
});
afterAll(async () => {
  await fake.close();
});

function adapter(overrides: Partial<EsignetConfig> = {}): EsignetIdentityProvider {
  return new EsignetIdentityProvider({
    issuer: fake.issuer,
    clientId: CLIENT_ID,
    clientPrivateJwk: clientKeys.privateJwk,
    userinfoPrivateJwk: userinfoKeys.privateJwk,
    scopes: ['openid', 'profile'],
    claims: ['name', 'birthdate'],
    acrValues: 'mosip:idp:acr:biometrics',
    acceptedAcr: [FAKE_ACR],
    claimsLocale: 'en',
    ...overrides,
  });
}

function newSession() {
  return { state: randomToken(), nonce: randomToken(), codeVerifier: randomToken(48) };
}

async function authorize(provider: EsignetIdentityProvider, mode: FakeMode = 'ok') {
  const session = newSession();
  await provider.prepare(AbortSignal.timeout(5000));
  const url = provider.authorizationUrl({
    state: session.state,
    nonce: session.nonce,
    codeChallenge: pkceChallenge(session.codeVerifier),
    redirectUri: REDIRECT_URI,
    locale: 'am',
  });
  const { code } = fake.authorize(url, { mode, subject: `psut-${mode}-${randomToken(6)}` });
  return { session, url, code };
}

async function exchange(provider: EsignetIdentityProvider, mode: FakeMode, timeoutMs = 5000) {
  const { session, code } = await authorize(provider, mode);
  return provider.exchange({
    code,
    codeVerifier: session.codeVerifier,
    redirectUri: REDIRECT_URI,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function failure(promise: Promise<unknown>): Promise<IdentityProviderError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IdentityProviderError);
  return error as IdentityProviderError;
}

async function failureKind(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IdentityProviderError);
  return (error as IdentityProviderError).kind;
}

describe('EsignetIdentityProvider (against a simulated OIDC provider)', () => {
  it('builds the authorization request of the VeriFayda 2 guide, without secrets', async () => {
    const { session, url } = await authorize(adapter());
    const params = new URL(url).searchParams;
    expect(url.startsWith(`${fake.issuer}/authorize?`)).toBe(true);
    expect(Object.fromEntries(params)).toMatchObject({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: 'openid profile',
      state: session.state,
      nonce: session.nonce,
      code_challenge: pkceChallenge(session.codeVerifier),
      code_challenge_method: 'S256',
      ui_locales: 'am',
      claims_locales: 'en',
      acr_values: 'mosip:idp:acr:biometrics',
    });
    expect(JSON.parse(params.get('claims') ?? '{}')).toEqual({
      userinfo: { name: { essential: true }, birthdate: { essential: true } },
      id_token: {},
    });
    expect(url).not.toContain(session.codeVerifier);
  });

  it('exchanges the code with PKCE and a private_key_jwt assertion and maps minimal claims', async () => {
    const provider = adapter();
    const { session, code } = await authorize(provider);
    const identity = await provider.exchange({
      code,
      codeVerifier: session.codeVerifier,
      redirectUri: REDIRECT_URI,
      signal: AbortSignal.timeout(5000),
    });
    expect(identity).toMatchObject({
      nonce: session.nonce,
      assuranceLevel: FAKE_ACR,
      fullName: 'Almaz Ayana Eba',
      dateOfBirth: '1991-11-21',
      claimNames: ['aud', 'birthdate', 'iat', 'iss', 'name', 'sub'],
    });
    expect(identity.subject).toMatch(/^psut-ok-/);
    const form = fake.tokenRequests.at(-1);
    expect(form?.get('code_verifier')).toBe(session.codeVerifier);
    expect(form?.get('client_secret')).toBeNull();
    expect(form?.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
  });

  it('decrypts encrypted user information (JWE) with the configured key', async () => {
    expect((await exchange(adapter(), 'encrypted_userinfo')).fullName).toBe('Almaz Ayana Eba');
  });

  it('fails closed on encrypted user information without a decryption key', async () => {
    expect(
      await failureKind(exchange(adapter({ userinfoPrivateJwk: undefined }), 'encrypted_userinfo')),
    ).toBe('MISCONFIGURED');
  });

  it.each<[FakeMode, string]>([
    ['wrong_issuer', 'INVALID_RESPONSE'],
    ['wrong_audience', 'INVALID_RESPONSE'],
    ['expired_id_token', 'INVALID_RESPONSE'],
    ['foreign_key', 'INVALID_RESPONSE'],
    ['missing_nonce', 'INVALID_RESPONSE'],
    ['userinfo_sub_mismatch', 'INVALID_RESPONSE'],
    ['unsigned_userinfo', 'INVALID_RESPONSE'],
    ['bad_birthdate', 'INVALID_RESPONSE'],
    ['low_acr', 'INSUFFICIENT_ASSURANCE'],
    ['token_server_error', 'UNAVAILABLE'],
    ['invalid_grant', 'INVALID_GRANT'],
  ])('rejects a provider answer with %s as %s', async (mode, kind) => {
    expect(await failureKind(exchange(adapter(), mode))).toBe(kind);
  });

  it('times out when the provider does not answer', async () => {
    expect(await failureKind(exchange(adapter(), 'hang', 300))).toBe('TIMEOUT');
  });

  it('accepts any acr when no accepted list is configured', async () => {
    expect((await exchange(adapter({ acceptedAcr: [] }), 'low_acr')).assuranceLevel).toBe(
      'mosip:idp:acr:static-code',
    );
  });

  it('cannot reuse a code, or redeem it with another session verifier', async () => {
    const provider = adapter();
    const { session, code } = await authorize(provider);
    const input = {
      code,
      codeVerifier: session.codeVerifier,
      redirectUri: REDIRECT_URI,
      signal: AbortSignal.timeout(5000),
    };
    await provider.exchange(input);
    expect(await failureKind(provider.exchange(input))).toBe('INVALID_GRANT');

    const other = await authorize(provider);
    expect(
      await failureKind(
        provider.exchange({ ...input, code: other.code, codeVerifier: randomToken(48) }),
      ),
    ).toBe('INVALID_GRANT');
  });

  it('rejects a client assertion signed with an unregistered key (invalid_client)', async () => {
    const stranger = await generateRsaJwkPair('stranger');
    expect(
      await failureKind(exchange(adapter({ clientPrivateJwk: stranger.privateJwk }), 'ok')),
    ).toBe('MISCONFIGURED');
  });

  it('refuses a discovery document whose issuer differs from the configured one', async () => {
    const provider = adapter({ issuer: `${fake.issuer}/` });
    expect(await failureKind(provider.prepare(AbortSignal.timeout(5000)))).toBe('MISCONFIGURED');
  });

  it('reports an unreachable provider as UNAVAILABLE', async () => {
    const provider = adapter({ issuer: 'http://127.0.0.1:9' });
    expect(await failureKind(provider.prepare(AbortSignal.timeout(5000)))).toBe('UNAVAILABLE');
  });

  it('requires prepare() before building an authorization URL', () => {
    expect(() =>
      adapter().authorizationUrl({
        state: 's',
        nonce: 'n',
        codeChallenge: 'c',
        redirectUri: REDIRECT_URI,
        locale: 'en',
      }),
    ).toThrow(IdentityProviderError);
  });

  it('never puts provider data into error messages', async () => {
    const provider = adapter();
    const { code } = await authorize(provider, 'invalid_grant');
    const error = await failure(
      provider.exchange({
        code,
        codeVerifier: randomToken(48),
        redirectUri: REDIRECT_URI,
        signal: AbortSignal.timeout(5000),
      }),
    );
    expect(`${error.message} ${error.detail}`).not.toContain(code);
  });

  it('maps eSignet callback errors', () => {
    const provider = adapter();
    expect(provider.classifyCallbackError('consent_request_rejected')).toBe('DECLINED');
    expect(provider.classifyCallbackError('consent_details_rejected')).toBe('DECLINED');
    expect(provider.classifyCallbackError('access_denied')).toBe('DECLINED');
    expect(provider.classifyCallbackError('transaction_timeout')).toBe('EXPIRED');
    expect(provider.classifyCallbackError('invalid_transaction')).toBe('EXPIRED');
    expect(provider.classifyCallbackError('anything_else')).toBe('FAILED');
  });
});

describe('normalizeBirthdate', () => {
  it.each([
    ['1991/11/21', '1991-11-21'],
    ['1991-11-21', '1991-11-21'],
    [' 2000-02-29 ', '2000-02-29'],
    ['1999-02-29', null],
    ['21/11/1991', null],
    ['1991-13-01', null],
    ['', null],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeBirthdate(input)).toBe(expected);
  });
});
