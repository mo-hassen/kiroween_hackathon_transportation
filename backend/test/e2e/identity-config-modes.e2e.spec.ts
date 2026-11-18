import { randomUUID } from 'node:crypto';
import { randomToken } from '../../src/common/crypto/random.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { bearer, flushRateLimits, http, registerCustomer } from '../helpers/auth-helpers.js';
import { FAKE_ACR, FakeOidcProvider, generateRsaJwkPair } from '../helpers/fake-oidc-provider.js';
import {
  APP_RETURN,
  confirmReturn,
  localPath,
  overview,
  parseReturn,
  startVerification,
  verifyIdentity,
} from '../helpers/identity-helpers.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('identity provider disabled (the default outside development)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { IDENTITY_PROVIDER: 'disabled' } });
  });
  afterAll(async () => {
    await testApp.close();
  });
  beforeEach(flushRateLimits);

  it('fails closed: no attempt is created and nothing is verified', async () => {
    const customer = await registerCustomer(testApp.app);
    const res = await startVerification(testApp.app, customer.tokens, { expect: 503 });
    expect(res.body.code).toBe('IDENTITY_UNAVAILABLE');
    expect(await overview(testApp.app, customer.tokens)).toMatchObject({
      identityStatus: 'UNVERIFIED',
      canStart: false,
      latest: null,
    });
  });

  it('does not mount the dev consent page, and the callback accepts nothing', async () => {
    await http(testApp.app).get('/api/v1/dev/identity/authorize').expect(404);
    const res = await http(testApp.app)
      .get(`/api/v1/identity/callback/dev?code=x&state=${randomToken()}`)
      .expect(303);
    expect(res.headers['location']).toBe(APP_RETURN);
  });
});

describe('identity provider timeout', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { IDENTITY_PROVIDER_TIMEOUT_MS: '1000' } });
  });
  afterAll(async () => {
    await testApp.close();
  });
  beforeEach(flushRateLimits);

  it('ends the attempt as a provider failure when the provider does not answer', async () => {
    const customer = await registerCustomer(testApp.app);
    const startedAt = Date.now();
    const id = await verifyIdentity(testApp.app, customer.tokens, undefined, 'slow');
    expect(Date.now() - startedAt).toBeLessThan(8000);
    expect(await overview(testApp.app, customer.tokens)).toMatchObject({
      identityStatus: 'UNVERIFIED',
      canStart: true,
      latest: { id, status: 'FAILED', reason: 'PROVIDER_UNAVAILABLE' },
    });
    const row = await testApp.app.get(PrismaService).identityVerification.findUniqueOrThrow({
      where: { id },
    });
    expect(row.outcomeCode).toBe('PROVIDER_TIMEOUT');
  });
});

describe('eSignet adapter wired end to end (against a simulated OIDC provider)', () => {
  let testApp: TestApp;
  let fake: FakeOidcProvider;
  const clientId = 'mobility-test-client';

  beforeAll(async () => {
    const client = await generateRsaJwkPair('client-e2e');
    fake = await FakeOidcProvider.start({ clientId, clientPublicJwk: client.publicJwk });
    testApp = await createTestApp({
      env: {
        IDENTITY_PROVIDER: 'esignet',
        IDENTITY_ESIGNET_ISSUER: fake.issuer,
        IDENTITY_ESIGNET_CLIENT_ID: clientId,
        IDENTITY_ESIGNET_CLIENT_PRIVATE_KEY: Buffer.from(
          JSON.stringify(client.privateJwk),
        ).toString('base64'),
        IDENTITY_ESIGNET_ACCEPTED_ACR: FAKE_ACR,
        PUBLIC_API_BASE_URL: 'http://localhost:3000',
      },
    });
  });
  afterAll(async () => {
    await testApp.close();
    await fake.close();
  });
  beforeEach(flushRateLimits);

  /** Browser: provider authorize -> 302 to our callback -> 303 to the app. */
  async function completeAtFake(authorizationUrl: string, mode = 'ok'): Promise<string> {
    const url = new URL(authorizationUrl);
    url.searchParams.set('test_mode', mode);
    const atProvider = await fetch(url, { redirect: 'manual' });
    expect(atProvider.status).toBe(302);
    const callback = atProvider.headers.get('location') ?? '';
    expect(callback.startsWith('http://localhost:3000/api/v1/identity/callback/fayda?')).toBe(true);
    const res = await http(testApp.app).get(localPath(callback)).expect(303);
    return res.headers['location'] as string;
  }

  it('verifies with discovery, PKCE, private_key_jwt and signed tokens; the app learns no claims', async () => {
    const customer = await registerCustomer(testApp.app);
    const started = await startVerification(testApp.app, customer.tokens);
    const { verification, authorizationUrl } = started.body.data;
    expect(verification.provider).toBe('FAYDA_ESIGNET');
    expect((authorizationUrl as string).startsWith(`${fake.issuer}/authorize?`)).toBe(true);
    const returnUrl = await completeAtFake(authorizationUrl as string);
    expect(parseReturn(returnUrl).verification).toBe(verification.id);
    expect(returnUrl.startsWith(`${APP_RETURN}?`)).toBe(true);
    await confirmReturn(testApp.app, customer.tokens, returnUrl);
    expect(await overview(testApp.app, customer.tokens)).toMatchObject({
      identityStatus: 'VERIFIED',
      verifiedName: 'Almaz Ayana Eba',
    });
    const row = await testApp.app.get(PrismaService).identityVerification.findUniqueOrThrow({
      where: { id: verification.id as string },
    });
    expect(row.assuranceLevel).toBe(FAKE_ACR);
  });

  it.each([
    ['foreign_key', 'FAILED', 'INVALID_RESPONSE'],
    ['wrong_audience', 'FAILED', 'INVALID_RESPONSE'],
    ['token_server_error', 'FAILED', 'PROVIDER_UNAVAILABLE'],
    ['low_acr', 'REJECTED', 'ASSURANCE_TOO_LOW'],
  ])('a provider answer with %s ends as %s (%s)', async (mode, status, outcome) => {
    const customer = await registerCustomer(testApp.app);
    const started = await startVerification(testApp.app, customer.tokens);
    await completeAtFake(started.body.data.authorizationUrl as string, mode);
    const row = await testApp.app.get(PrismaService).identityVerification.findUniqueOrThrow({
      where: { id: started.body.data.verification.id as string },
    });
    expect({ status: row.status, outcome: row.outcomeCode }).toEqual({ status, outcome });
  });

  it('answers 503 when the provider cannot be reached at start', async () => {
    const offline = await createTestApp({
      env: {
        IDENTITY_PROVIDER: 'esignet',
        IDENTITY_ESIGNET_ISSUER: 'http://127.0.0.1:9',
        IDENTITY_ESIGNET_CLIENT_ID: clientId,
        IDENTITY_ESIGNET_CLIENT_PRIVATE_KEY: Buffer.from(
          JSON.stringify((await generateRsaJwkPair('offline')).privateJwk),
        ).toString('base64'),
        PUBLIC_API_BASE_URL: 'http://localhost:3000',
      },
    });
    try {
      const customer = await registerCustomer(offline.app);
      const res = await http(offline.app)
        .post('/api/v1/identity/verifications')
        .set(bearer(customer.tokens))
        .set('Idempotency-Key', randomUUID())
        .send({ consent: true })
        .expect(503);
      expect(res.body.code).toBe('IDENTITY_UNAVAILABLE');
    } finally {
      await offline.close();
    }
  });
});
