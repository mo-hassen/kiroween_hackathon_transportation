import { randomToken } from '../../common/crypto/random.js';
import { DEFAULT_DEV_PERSON, DevIdentityProvider } from './dev-identity.provider.js';
import { IdentityProviderError, pkceChallenge } from './identity-provider.js';

const BASE = 'http://localhost:3000';
const CALLBACK = `${BASE}/api/v1/identity/callback/dev`;

function setup() {
  const provider = new DevIdentityProvider(BASE, CALLBACK);
  const session = { state: randomToken(), nonce: randomToken(), codeVerifier: randomToken(48) };
  const url = new URL(
    provider.authorizationUrl({
      state: session.state,
      nonce: session.nonce,
      codeChallenge: pkceChallenge(session.codeVerifier),
      redirectUri: CALLBACK,
      locale: 'en',
    }),
  );
  const authorization = provider.parseAuthorization(Object.fromEntries(url.searchParams));
  if (authorization === null) throw new Error('authorization rejected');
  return { provider, session, url, authorization };
}

function codeFrom(redirect: string): string {
  return new URL(redirect).searchParams.get('code') ?? '';
}

const signal = () => AbortSignal.timeout(2000);

describe('DevIdentityProvider (development/test only)', () => {
  it('points at the local consent page with a standard OIDC request', () => {
    const { url, session } = setup();
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/api/v1/dev/identity/authorize`);
    expect(url.searchParams.get('state')).toBe(session.state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.search).not.toContain(session.codeVerifier);
  });

  it('only redirects to the configured callback (no open redirect)', () => {
    const { provider, url } = setup();
    const params = Object.fromEntries(url.searchParams);
    expect(
      provider.parseAuthorization({ ...params, redirect_uri: 'https://evil.example/cb' }),
    ).toBeNull();
    expect(provider.parseAuthorization({ ...params, code_challenge_method: 'plain' })).toBeNull();
    expect(provider.parseAuthorization({ ...params, state: 'short' })).toBeNull();
    expect(provider.parseAuthorization({ ...params, client_id: 'other' })).toBeNull();
  });

  it('issues a one-time code bound to the PKCE verifier and returns the synthetic person', async () => {
    const { provider, session, authorization } = setup();
    const code = codeFrom(provider.decide(authorization, 'approve', DEFAULT_DEV_PERSON));
    const input = {
      code,
      codeVerifier: session.codeVerifier,
      redirectUri: CALLBACK,
      signal: signal(),
    };
    const identity = await provider.exchange(input);
    expect(identity).toMatchObject({
      subject: DEFAULT_DEV_PERSON.subject,
      nonce: session.nonce,
      fullName: DEFAULT_DEV_PERSON.fullName,
      dateOfBirth: DEFAULT_DEV_PERSON.dateOfBirth,
    });
    await expect(provider.exchange(input)).rejects.toMatchObject({ kind: 'INVALID_GRANT' });
  });

  it('rejects a code redeemed with another verifier or redirect URI', async () => {
    const { provider, authorization } = setup();
    const code = codeFrom(provider.decide(authorization, 'approve', DEFAULT_DEV_PERSON));
    await expect(
      provider.exchange({
        code,
        codeVerifier: randomToken(48),
        redirectUri: CALLBACK,
        signal: signal(),
      }),
    ).rejects.toMatchObject({ kind: 'INVALID_GRANT' });
  });

  it('returns eSignet error values for declined and timed-out sessions', () => {
    const { provider, authorization } = setup();
    const declined = new URL(provider.decide(authorization, 'decline', DEFAULT_DEV_PERSON));
    expect(declined.searchParams.get('error')).toBe('consent_request_rejected');
    expect(declined.searchParams.get('state')).toBe(authorization.state);
    expect(declined.searchParams.get('code')).toBeNull();
    expect(provider.classifyCallbackError('consent_request_rejected')).toBe('DECLINED');
    const timedOut = new URL(provider.decide(authorization, 'session_timeout', DEFAULT_DEV_PERSON));
    expect(provider.classifyCallbackError(timedOut.searchParams.get('error') ?? '')).toBe(
      'EXPIRED',
    );
  });

  it('simulates an invalid signature, a foreign nonce and a provider that never answers', async () => {
    const { provider, session, authorization } = setup();
    const run = (outcome: 'bad_signature' | 'wrong_nonce' | 'slow', abort = signal()) =>
      provider.exchange({
        code: codeFrom(provider.decide(authorization, outcome, DEFAULT_DEV_PERSON)),
        codeVerifier: session.codeVerifier,
        redirectUri: CALLBACK,
        signal: abort,
      });
    await expect(run('bad_signature')).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    expect((await run('wrong_nonce')).nonce).not.toBe(session.nonce);
    const error = await run('slow', AbortSignal.timeout(50)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdentityProviderError);
    expect((error as IdentityProviderError).kind).toBe('TIMEOUT');
  });
});
