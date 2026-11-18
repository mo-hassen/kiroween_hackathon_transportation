import { randomUUID } from 'node:crypto';
import { randomToken } from '../../src/common/crypto/random.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { IdentityExpiryService } from '../../src/modules/identity/identity-expiry.service.js';
import {
  bearer,
  type Customer,
  flushRateLimits,
  http,
  registerCustomer,
  seedStaff,
  staffLogin,
  type Tokens,
} from '../helpers/auth-helpers.js';
import {
  APP_RETURN,
  completeAtDevProvider,
  confirmReturn,
  devCallbackPath,
  parseReturn,
  overview,
  seedLapsedAttempt,
  startVerification,
  uniqueSubject,
  verifyIdentity,
} from '../helpers/identity-helpers.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/** Journey J2 end to end with the dev provider (08 §4), plus the Phase 4 security checks. */
let testApp: TestApp;
let prisma: PrismaService;

beforeAll(async () => {
  testApp = await createTestApp();
  prisma = testApp.app.get(PrismaService);
});
afterAll(async () => {
  await testApp.close();
});
beforeEach(flushRateLimits);

const app = () => testApp.app;
const newCustomer = (): Promise<Customer> => registerCustomer(app());
const MONTH_MS = 31 * 24 * 60 * 60 * 1000;

async function attemptRow(id: string) {
  return prisma.identityVerification.findUniqueOrThrow({ where: { id } });
}
async function auditActions(targetId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: { targetId },
    orderBy: { seq: 'asc' },
    select: { action: true },
  });
  return rows.map((row) => row.action);
}
async function outboxEvents(aggregateId: string): Promise<string[]> {
  const rows = await prisma.outboxEvent.findMany({
    where: { aggregateId },
    orderBy: { createdAt: 'asc' },
    select: { eventType: true },
  });
  return rows.map((row) => row.eventType);
}

describe('identity verification: successful flow', () => {
  it('verifies through the provider, links the identity and returns only status data', async () => {
    const customer = await newCustomer();
    expect(await overview(app(), customer.tokens)).toMatchObject({
      identityStatus: 'UNVERIFIED',
      canStart: true,
      latest: null,
    });

    const started = await startVerification(app(), customer.tokens, { locale: 'am' });
    const { verification, authorizationUrl } = started.body.data;
    expect(verification).toMatchObject({ status: 'PENDING', reason: null, provider: 'DEV' });
    expect(new URL(authorizationUrl).searchParams.get('ui_locales')).toBe('am');
    expect(new URL(authorizationUrl).searchParams.get('code_challenge_method')).toBe('S256');
    expect((await overview(app(), customer.tokens)).identityStatus).toBe('PENDING');

    const subject = uniqueSubject();
    const { returnUrl, confirmation } = await completeAtDevProvider(app(), authorizationUrl, {
      subject,
      name: 'Meseret Defar Tola',
    });
    // Back to the app with the id and a one-time confirmation token only: no code, state,
    // OAuth token or claim.
    expect(returnUrl).toBe(
      `${APP_RETURN}?verification=${verification.id}&confirmation=${confirmation}`,
    );
    expect(confirmation).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(returnUrl).not.toMatch(/code=|state=|token|Meseret/);

    // The provider step alone links nothing: the app session must confirm.
    expect((await overview(app(), customer.tokens)).identityStatus).toBe('PENDING');
    const confirmed = await confirmReturn(app(), customer.tokens, returnUrl);
    expect(confirmed.body.data).toMatchObject({ id: verification.id, status: 'VERIFIED' });

    const status = await overview(app(), customer.tokens);
    expect(status).toMatchObject({
      identityStatus: 'VERIFIED',
      canStart: false,
      verifiedName: 'Meseret Defar Tola',
      latest: { id: verification.id, status: 'VERIFIED', reason: null },
    });
    const validMs = Date.parse(status.validUntil ?? '') - Date.parse(status.verifiedAt ?? '');
    expect(validMs).toBeGreaterThan(23 * MONTH_MS);
    expect(validMs).toBeLessThan(25 * MONTH_MS);
    const me = await http(app()).get('/api/v1/me').set(bearer(customer.tokens)).expect(200);
    expect(me.body.data.identityStatus).toBe('VERIFIED');

    const own = await http(app())
      .get(`/api/v1/identity/verifications/${verification.id}`)
      .set(bearer(customer.tokens))
      .expect(200);
    expect(Object.keys(own.body.data).sort()).toEqual(
      [
        'completedAt',
        'createdAt',
        'id',
        'provider',
        'reason',
        'sessionExpiresAt',
        'status',
        'validUntil',
        'verifiedAt',
      ].sort(),
    );
  });

  it('stores only hashes and encrypted minimal claims, and audits and queues events', async () => {
    const customer = await newCustomer();
    const subject = uniqueSubject();
    const id = await verifyIdentity(app(), customer.tokens, subject);
    const row = await attemptRow(id);
    expect(row.requestSecretsEnc).toBeNull();
    expect(row.subjectHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(row.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(row.verifiedClaimsEnc ?? []).toString('utf8')).not.toContain('Abebe');
    expect(JSON.stringify(row)).not.toContain(subject);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(user.identitySubjectHmac).toBe(row.subjectHmac);

    expect(await auditActions(id)).toEqual([
      'identity.verification_started',
      'identity.result_received',
      'identity.verification_verified',
    ]);
    expect(await auditActions(customer.userId)).toContain('identity.linked');
    expect(await outboxEvents(id)).toEqual(['identity.verified']);

    // Audit rows and logs carry names of claims, never values, codes or secrets.
    const audits = await prisma.auditLog.findMany({
      where: { targetId: { in: [id, customer.userId] } },
    });
    const serialized = JSON.stringify(audits, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(serialized).not.toContain(subject);
    expect(serialized).not.toContain('Abebe');
    expect(serialized).toContain('claimNames');
    expect(testApp.logs()).not.toContain(subject);
    expect(testApp.logs()).not.toMatch(/code=|state=/);
  });
});

describe('identity verification: unsuccessful outcomes', () => {
  async function runOutcome(
    outcome: 'decline' | 'provider_error' | 'session_timeout' | 'bad_signature' | 'wrong_nonce',
  ) {
    const customer = await newCustomer();
    const id = await verifyIdentity(app(), customer.tokens, uniqueSubject(), outcome);
    return { customer, id, status: await overview(app(), customer.tokens) };
  }

  it('declined consent cancels the attempt and restores the account status', async () => {
    const { status, id } = await runOutcome('decline');
    expect(status).toMatchObject({
      identityStatus: 'UNVERIFIED',
      canStart: true,
      latest: { status: 'CANCELLED', reason: 'DECLINED_AT_PROVIDER' },
    });
    expect(await auditActions(id)).toEqual([
      'identity.verification_started',
      'identity.verification_cancelled',
    ]);
  });

  it('a provider error fails the attempt with a retry-able state', async () => {
    const { status } = await runOutcome('provider_error');
    expect(status).toMatchObject({
      identityStatus: 'UNVERIFIED',
      canStart: true,
      latest: { status: 'FAILED', reason: 'VERIFICATION_FAILED' },
    });
  });

  it('a session that timed out at the provider expires the attempt', async () => {
    const { status } = await runOutcome('session_timeout');
    expect(status.latest).toMatchObject({ status: 'EXPIRED', reason: 'SESSION_EXPIRED' });
    expect(status.identityStatus).toBe('UNVERIFIED');
  });

  it('an invalid provider response (bad signature) is never accepted', async () => {
    const { status, id } = await runOutcome('bad_signature');
    expect(status.latest).toMatchObject({ status: 'FAILED', reason: 'VERIFICATION_FAILED' });
    expect((await attemptRow(id)).outcomeCode).toBe('INVALID_RESPONSE');
  });

  it('a token issued for another session (nonce mismatch) is never accepted', async () => {
    const { status, id, customer } = await runOutcome('wrong_nonce');
    expect(status.latest?.status).toBe('FAILED');
    expect((await attemptRow(id)).outcomeCode).toBe('INVALID_RESPONSE');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(user.identitySubjectHmac).toBeNull();
  });

  it('a callback after the session lapsed expires the attempt', async () => {
    const customer = await newCustomer();
    const { id, state } = await seedLapsedAttempt(app(), customer.userId);
    const res = await http(app())
      .get(`/api/v1/identity/callback/dev?code=${randomToken()}&state=${state}`)
      .expect(303);
    expect(res.headers['location']).toBe(`${APP_RETURN}?verification=${id}`);
    expect((await attemptRow(id)).status).toBe('EXPIRED');
    expect((await overview(app(), customer.tokens)).identityStatus).toBe('UNVERIFIED');
  });

  it('an abandoned session expires when the account next reads its status', async () => {
    const customer = await newCustomer();
    const { id } = await seedLapsedAttempt(app(), customer.userId);
    const status = await overview(app(), customer.tokens);
    expect(status).toMatchObject({
      identityStatus: 'UNVERIFIED',
      canStart: true,
      latest: { id, status: 'EXPIRED', reason: 'SESSION_EXPIRED' },
    });
    expect(await auditActions(id)).toEqual(['identity.verification_expired']);
  });

  it('the user can cancel an open attempt; repeating the cancel is harmless', async () => {
    const customer = await newCustomer();
    const started = await startVerification(app(), customer.tokens);
    const id = started.body.data.verification.id as string;
    for (let i = 0; i < 2; i += 1) {
      const res = await http(app())
        .post(`/api/v1/identity/verifications/${id}/cancel`)
        .set(bearer(customer.tokens))
        .expect(200);
      expect(res.body.data).toMatchObject({ status: 'CANCELLED', reason: 'CANCELLED' });
    }
    expect((await overview(app(), customer.tokens)).identityStatus).toBe('UNVERIFIED');
    // The provider answering afterwards changes nothing.
    const late = await completeAtDevProvider(app(), started.body.data.authorizationUrl as string);
    expect(late.confirmation).toBeNull();
    expect((await attemptRow(id)).status).toBe('CANCELLED');
  });
});

describe('identity verification: state machine', () => {
  it('rejects invalid transitions', async () => {
    const customer = await newCustomer();
    const id = await verifyIdentity(app(), customer.tokens);
    const cancel = await http(app())
      .post(`/api/v1/identity/verifications/${id}/cancel`)
      .set(bearer(customer.tokens))
      .expect(409);
    expect(cancel.body.code).toBe('INVALID_STATE_TRANSITION');
    const again = await startVerification(app(), customer.tokens, { expect: 409 });
    expect(again.body.code).toBe('IDENTITY_VERIFICATION_NOT_ALLOWED');
  });

  it('a new start replaces the open attempt; the old link can no longer verify', async () => {
    const customer = await newCustomer();
    const first = await startVerification(app(), customer.tokens);
    const second = await startVerification(app(), customer.tokens);
    const firstId = first.body.data.verification.id as string;
    expect((await attemptRow(firstId)).status).toBe('SUPERSEDED');

    expect(
      (await completeAtDevProvider(app(), first.body.data.authorizationUrl as string)).confirmation,
    ).toBeNull();
    expect((await attemptRow(firstId)).status).toBe('SUPERSEDED');
    expect((await overview(app(), customer.tokens)).identityStatus).toBe('PENDING');

    const second2 = await completeAtDevProvider(app(), second.body.data.authorizationUrl as string);
    await confirmReturn(app(), customer.tokens, second2.returnUrl);
    expect((await overview(app(), customer.tokens)).identityStatus).toBe('VERIFIED');
  });

  it('a verified identity expires after its validity period and can be renewed by the same person only', async () => {
    const customer = await newCustomer();
    const subject = uniqueSubject();
    const firstId = await verifyIdentity(app(), customer.tokens, subject);
    const expiry = testApp.app.get(IdentityExpiryService);
    expect(await expiry.sweep(new Date(Date.now() + 25 * MONTH_MS))).toBeGreaterThanOrEqual(1);

    expect(await overview(app(), customer.tokens)).toMatchObject({
      identityStatus: 'EXPIRED',
      canStart: true,
      verifiedName: null,
      latest: { id: firstId, status: 'EXPIRED', reason: 'VALIDITY_ENDED' },
    });
    expect(await outboxEvents(firstId)).toEqual(['identity.verified', 'identity.expired']);

    // Another person on this account: rejected, generic reason, flagged.
    const other = await verifyIdentity(app(), customer.tokens, uniqueSubject());
    expect((await overview(app(), customer.tokens)).latest).toMatchObject({
      id: other,
      status: 'REJECTED',
      reason: 'VERIFICATION_REJECTED',
    });
    expect((await attemptRow(other)).outcomeCode).toBe('IDENTITY_MISMATCH');
    expect(await auditActions(other)).toContain('identity.duplicate_detected');

    // The same person renews.
    await verifyIdentity(app(), customer.tokens, subject);
    expect((await overview(app(), customer.tokens)).identityStatus).toBe('VERIFIED');
  });
});

describe('identity verification: identity linking (BR-ID-2)', () => {
  it('one identity links to one account; a second account is rejected without saying why', async () => {
    const subject = uniqueSubject();
    const first = await newCustomer();
    await verifyIdentity(app(), first.tokens, subject);

    const second = await newCustomer();
    const duplicateId = await verifyIdentity(app(), second.tokens, subject);
    const duplicate = await overview(app(), second.tokens);
    expect(duplicate).toMatchObject({
      identityStatus: 'REJECTED',
      canStart: true,
      verifiedName: null,
      latest: { status: 'REJECTED', reason: 'VERIFICATION_REJECTED' },
    });
    expect((await attemptRow(duplicateId)).outcomeCode).toBe('IDENTITY_ALREADY_LINKED');
    expect(await auditActions(duplicateId)).toContain('identity.duplicate_detected');
    expect(await outboxEvents(duplicateId)).toEqual([
      'identity.rejected',
      'identity.duplicate_detected',
    ]);
    expect((await overview(app(), first.tokens)).identityStatus).toBe('VERIFIED');

    // Enumeration resistance: the duplicate looks exactly like any other rejection.
    const third = await newCustomer();
    await verifyIdentity(app(), third.tokens, uniqueSubject());
    await testApp.app.get(IdentityExpiryService).sweep(new Date(Date.now() + 25 * MONTH_MS));
    await verifyIdentity(app(), third.tokens, uniqueSubject()); // IDENTITY_MISMATCH
    const mismatch = await overview(app(), third.tokens);
    const visible = (o: typeof duplicate) => ({
      identityStatus: o.identityStatus,
      canStart: o.canStart,
      verifiedName: o.verifiedName,
      latest: {
        status: o.latest?.status,
        reason: o.latest?.reason,
        keys: Object.keys(o.latest ?? {}).sort(),
      },
    });
    expect(visible(mismatch)).toEqual(visible(duplicate));
  });

  it('two accounts finishing with the same new identity at once: exactly one wins', async () => {
    const subject = uniqueSubject();
    const a = await newCustomer();
    const b = await newCustomer();
    const startA = await startVerification(app(), a.tokens);
    const startB = await startVerification(app(), b.tokens);
    const [pathA, pathB] = await Promise.all([
      devCallbackPath(app(), startA.body.data.authorizationUrl as string, { subject }),
      devCallbackPath(app(), startB.body.data.authorizationUrl as string, { subject }),
    ]);
    const [retA, retB] = await Promise.all([
      http(app()).get(pathA).expect(303),
      http(app()).get(pathB).expect(303),
    ]);
    await Promise.all([
      confirmReturn(app(), a.tokens, retA.headers['location'] as string),
      confirmReturn(app(), b.tokens, retB.headers['location'] as string),
    ]);
    const statuses = [
      (await overview(app(), a.tokens)).identityStatus,
      (await overview(app(), b.tokens)).identityStatus,
    ].sort();
    expect(statuses).toEqual(['REJECTED', 'VERIFIED']);
  });
});

describe('identity verification: callback security', () => {
  it('a replayed callback is ignored and audited', async () => {
    const customer = await newCustomer();
    const started = await startVerification(app(), customer.tokens);
    const id = started.body.data.verification.id as string;
    const { callbackPath, returnUrl } = await completeAtDevProvider(
      app(),
      started.body.data.authorizationUrl as string,
    );
    const before = await attemptRow(id);

    const replay = await http(app()).get(callbackPath).expect(303);
    expect(replay.headers['location']).toBe(APP_RETURN);
    const after = await attemptRow(id);
    expect(after.version).toBe(before.version);
    expect(after.callbackReceivedAt?.toISOString()).toBe(before.callbackReceivedAt?.toISOString());
    expect(await auditActions(id)).toContain('identity.callback_replayed');
    // The original return link still completes it (once).
    await confirmReturn(app(), customer.tokens, returnUrl);
    expect((await attemptRow(id)).status).toBe('VERIFIED');
    await confirmReturn(app(), customer.tokens, returnUrl);
    expect((await attemptRow(id)).version).toBe(after.version + 1);
  });

  it('concurrent copies of one callback are processed once', async () => {
    const customer = await newCustomer();
    const started = await startVerification(app(), customer.tokens);
    const id = started.body.data.verification.id as string;
    const path = await devCallbackPath(app(), started.body.data.authorizationUrl as string);
    const results = await Promise.all([1, 2, 3, 4].map(() => http(app()).get(path)));
    expect(results.map((r) => r.status)).toEqual([303, 303, 303, 303]);
    expect(
      results.filter((r) => parseReturn(r.headers['location'] as string).verification === id),
    ).toHaveLength(1);
    const actions = await auditActions(id);
    expect(actions.filter((a) => a === 'identity.result_received')).toHaveLength(1);
    expect(actions.filter((a) => a === 'identity.callback_replayed')).toHaveLength(3);
  });

  it('forged, malformed or foreign-provider states change nothing and reveal nothing', async () => {
    const customer = await newCustomer();
    const started = await startVerification(app(), customer.tokens);
    const id = started.body.data.verification.id as string;
    const state =
      new URL(started.body.data.authorizationUrl as string).searchParams.get('state') ?? '';
    for (const path of [
      `/api/v1/identity/callback/dev?code=abc&state=${randomToken()}`,
      '/api/v1/identity/callback/dev?code=abc&state=short',
      '/api/v1/identity/callback/dev?code=abc',
      `/api/v1/identity/callback/dev?code=abc&state=${state}&state=${state}`,
      `/api/v1/identity/callback/fayda?code=abc&state=${state}`,
    ]) {
      const res = await http(app()).get(path).expect(303);
      expect({ path, location: res.headers['location'] }).toEqual({ path, location: APP_RETURN });
    }
    const row = await attemptRow(id);
    expect(row).toMatchObject({ status: 'PENDING', callbackReceivedAt: null });
  });

  it('a code obtained for one session cannot complete another (PKCE binding)', async () => {
    const victim = await newCustomer();
    const attacker = await newCustomer();
    const victimStart = await startVerification(app(), victim.tokens);
    const attackerStart = await startVerification(app(), attacker.tokens);
    // The attacker authenticates (as themselves) and grafts their code onto the victim's state.
    const attackerCallback = new URL(
      `http://x${await devCallbackPath(app(), attackerStart.body.data.authorizationUrl as string)}`,
    );
    const victimState = new URL(victimStart.body.data.authorizationUrl as string).searchParams.get(
      'state',
    );
    await http(app())
      .get(
        `/api/v1/identity/callback/dev?code=${attackerCallback.searchParams.get('code') ?? ''}&state=${victimState ?? ''}`,
      )
      .expect(303);
    const victimId = victimStart.body.data.verification.id as string;
    expect(await attemptRow(victimId)).toMatchObject({
      status: 'FAILED',
      outcomeCode: 'INVALID_GRANT',
    });
    expect((await overview(app(), victim.tokens)).identityStatus).toBe('UNVERIFIED');
  });

  it('a client cannot set or forge any verification status', async () => {
    const customer = await newCustomer();
    for (const body of [
      { consent: true, status: 'VERIFIED' },
      { consent: true, identityStatus: 'VERIFIED' },
      { consent: true, provider: 'FAYDA_ESIGNET' },
      { consent: true, verifiedName: 'Someone' },
    ]) {
      const res = await http(app())
        .post('/api/v1/identity/verifications')
        .set(bearer(customer.tokens))
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(400);
      expect(res.body.errors).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_FIELD' }));
    }
    await http(app())
      .patch('/api/v1/me')
      .set(bearer(customer.tokens))
      .set('If-Match', '0')
      .send({ identityStatus: 'VERIFIED' })
      .expect(400);
    expect((await overview(app(), customer.tokens)).identityStatus).toBe('UNVERIFIED');
  });

  it('requires explicit consent', async () => {
    const customer = await newCustomer();
    for (const body of [{}, { consent: false }, { consent: 'true' }]) {
      const res = await http(app())
        .post('/api/v1/identity/verifications')
        .set(bearer(customer.tokens))
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(400);
      expect(res.body.errors).toContainEqual({ field: 'consent', code: 'EQUALS' });
    }
  });
});

describe('identity verification: idempotency', () => {
  it('a retried start returns the same attempt and URL; a different body is refused', async () => {
    const customer = await newCustomer();
    const key = randomUUID();
    const first = await startVerification(app(), customer.tokens, { key });
    const retry = await startVerification(app(), customer.tokens, { key });
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data).toEqual(first.body.data);
    expect(await prisma.identityVerification.count({ where: { userId: customer.userId } })).toBe(1);

    const changed = await http(app())
      .post('/api/v1/identity/verifications')
      .set(bearer(customer.tokens))
      .set('Idempotency-Key', key)
      .send({ consent: true, locale: 'am' })
      .expect(422);
    expect(changed.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    await http(app())
      .post('/api/v1/identity/verifications')
      .set(bearer(customer.tokens))
      .send({ consent: true })
      .expect(400);

    // After completion the replay shows the result and no longer offers a URL.
    const done = await completeAtDevProvider(app(), first.body.data.authorizationUrl as string);
    await confirmReturn(app(), customer.tokens, done.returnUrl);
    const late = await startVerification(app(), customer.tokens, { key });
    expect(late.body.data.verification.status).toBe('VERIFIED');
    expect(late.body.data.authorizationUrl).toBeNull();
  });

  it('the stored idempotent response holds no state, nonce or URL', async () => {
    const customer = await newCustomer();
    const key = randomUUID();
    const started = await startVerification(app(), customer.tokens, { key });
    const record = await prisma.idempotencyRecord.findFirstOrThrow({ where: { key } });
    const state =
      new URL(started.body.data.authorizationUrl as string).searchParams.get('state') ?? '';
    expect(JSON.stringify(record.responseBody)).not.toContain(state);
    expect(record.responseBody).toEqual({
      verificationId: started.body.data.verification.id,
      locale: 'en',
    });
  });

  it('limits how often verification can be started', async () => {
    const customer = await newCustomer();
    for (let i = 0; i < 10; i += 1) await startVerification(app(), customer.tokens);
    const limited = await startVerification(app(), customer.tokens, { expect: 429 });
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe('identity verification: authorization and IDOR', () => {
  let owner: Customer;
  let other: Customer;
  let ownerAttempt: string;
  let officer: Tokens;

  beforeAll(async () => {
    owner = await newCustomer();
    other = await newCustomer();
    ownerAttempt = (await startVerification(app(), owner.tokens)).body.data.verification
      .id as string;
    officer = await staffLogin(app(), await seedStaff(app(), ['VERIFICATION_OFFICER']));
  });

  it("another customer cannot read or cancel someone's verification (404)", async () => {
    await http(app())
      .get(`/api/v1/identity/verifications/${ownerAttempt}`)
      .set(bearer(other.tokens))
      .expect(404);
    await http(app())
      .post(`/api/v1/identity/verifications/${ownerAttempt}/cancel`)
      .set(bearer(other.tokens))
      .expect(404);
    expect((await attemptRow(ownerAttempt)).status).toBe('PENDING');
  });

  it('staff have no customer identity routes (404), unknown ids are 404, bad ids 400', async () => {
    await http(app())
      .get('/api/v1/identity/verifications/current')
      .set(bearer(officer))
      .expect(404);
    await http(app())
      .get(`/api/v1/identity/verifications/${ownerAttempt}`)
      .set(bearer(officer))
      .expect(404);
    await http(app())
      .post('/api/v1/identity/verifications')
      .set(bearer(officer))
      .set('Idempotency-Key', randomUUID())
      .send({ consent: true })
      .expect(404);
    await http(app())
      .get(`/api/v1/identity/verifications/${randomUUID()}`)
      .set(bearer(owner.tokens))
      .expect(404);
    await http(app())
      .get('/api/v1/identity/verifications/not-a-uuid')
      .set(bearer(owner.tokens))
      .expect(400);
  });

  it('requires authentication', async () => {
    await http(app()).get('/api/v1/identity/verifications/current').expect(401);
    await http(app()).post('/api/v1/identity/verifications').send({ consent: true }).expect(401);
  });
});

describe('identity verification: verification officer actions', () => {
  let officer: Tokens;
  const reason = { reason: 'Risk review after a support report' };

  beforeAll(async () => {
    officer = await staffLogin(app(), await seedStaff(app(), ['VERIFICATION_OFFICER']));
  });

  it('views verified claims only with a reason, and every view is audited', async () => {
    const customer = await newCustomer();
    const id = await verifyIdentity(app(), customer.tokens);
    await http(app())
      .get(`/api/v1/admin/identity-verifications/${id}`)
      .set(bearer(officer))
      .expect(400);
    const res = await http(app())
      .get(`/api/v1/admin/identity-verifications/${id}`)
      .query(reason)
      .set(bearer(officer))
      .expect(200);
    expect(res.body.data).toMatchObject({
      id,
      userId: customer.userId,
      status: 'VERIFIED',
      accountIdentityStatus: 'VERIFIED',
      verifiedFullName: 'Test Person',
      verifiedDateOfBirth: '1990-01-01',
      conflictingUserId: null,
    });
    const view = await prisma.auditLog.findFirstOrThrow({
      where: { targetId: id, action: 'identity.details_viewed' },
    });
    expect(view.reason).toBe(reason.reason);
  });

  it('shows which account holds an identity presented again', async () => {
    const subject = uniqueSubject();
    const holder = await newCustomer();
    await verifyIdentity(app(), holder.tokens, subject);
    const duplicate = await verifyIdentity(app(), (await newCustomer()).tokens, subject);
    const res = await http(app())
      .get(`/api/v1/admin/identity-verifications/${duplicate}`)
      .query(reason)
      .set(bearer(officer))
      .expect(200);
    expect(res.body.data).toMatchObject({
      status: 'REJECTED',
      outcomeCode: 'IDENTITY_ALREADY_LINKED',
      conflictingUserId: holder.userId,
      verifiedFullName: null,
    });
  });

  it('require re-verification -> the same person verifies again -> old attempt superseded', async () => {
    const customer = await newCustomer();
    const subject = uniqueSubject();
    const id = await verifyIdentity(app(), customer.tokens, subject);
    const res = await http(app())
      .post(`/api/v1/admin/identity-verifications/${id}/require-reverification`)
      .set(bearer(officer))
      .send(reason)
      .expect(200);
    expect(res.body.data).toEqual({
      id,
      status: 'REVERIFICATION_REQUIRED',
      accountIdentityStatus: 'REVERIFICATION_REQUIRED',
    });
    expect(await overview(app(), customer.tokens)).toMatchObject({
      identityStatus: 'REVERIFICATION_REQUIRED',
      canStart: true,
    });

    const renewed = await verifyIdentity(app(), customer.tokens, subject);
    expect((await overview(app(), customer.tokens)).identityStatus).toBe('VERIFIED');
    const old = await attemptRow(id);
    expect(old).toMatchObject({
      status: 'SUPERSEDED',
      outcomeCode: 'REPLACED_BY_REVERIFICATION',
      verifiedClaimsEnc: null,
    });
    expect((await attemptRow(renewed)).status).toBe('VERIFIED');
    expect(await outboxEvents(id)).toEqual([
      'identity.verified',
      'identity.reverification_required',
    ]);
  });

  it('suspension blocks new attempts and closes an open one; lifting requires re-verification', async () => {
    const customer = await newCustomer();
    const id = await verifyIdentity(app(), customer.tokens);
    await http(app())
      .post(`/api/v1/admin/identity-verifications/${id}/require-reverification`)
      .set(bearer(officer))
      .send(reason)
      .expect(200);
    const open = (await startVerification(app(), customer.tokens)).body.data.verification
      .id as string;

    const suspended = await http(app())
      .post(`/api/v1/admin/identity-verifications/${id}/suspend`)
      .set(bearer(officer))
      .send(reason)
      .expect(200);
    expect(suspended.body.data).toMatchObject({
      status: 'SUSPENDED',
      accountIdentityStatus: 'SUSPENDED',
    });
    expect(await attemptRow(open)).toMatchObject({
      status: 'CANCELLED',
      outcomeCode: 'CLOSED_BY_STAFF',
    });
    expect(await overview(app(), customer.tokens)).toMatchObject({
      identityStatus: 'SUSPENDED',
      canStart: false,
    });
    expect((await startVerification(app(), customer.tokens, { expect: 409 })).body.code).toBe(
      'IDENTITY_VERIFICATION_NOT_ALLOWED',
    );

    await http(app())
      .post(`/api/v1/admin/identity-verifications/${id}/require-reverification`)
      .set(bearer(officer))
      .send(reason)
      .expect(200);
    expect((await overview(app(), customer.tokens)).identityStatus).toBe('REVERIFICATION_REQUIRED');
  });

  it('refuses staff actions on attempts in other states, and without a reason', async () => {
    const customer = await newCustomer();
    const failed = await verifyIdentity(app(), customer.tokens, uniqueSubject(), 'provider_error');
    for (const action of ['suspend', 'require-reverification']) {
      const res = await http(app())
        .post(`/api/v1/admin/identity-verifications/${failed}/${action}`)
        .set(bearer(officer))
        .send(reason)
        .expect(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
      await http(app())
        .post(`/api/v1/admin/identity-verifications/${failed}/${action}`)
        .set(bearer(officer))
        .send({ reason: 'short' })
        .expect(400);
    }
    await http(app())
      .post(`/api/v1/admin/identity-verifications/${randomUUID()}/suspend`)
      .set(bearer(officer))
      .send(reason)
      .expect(404);
  });
});
