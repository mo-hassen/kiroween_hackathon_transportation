import { randomUUID } from 'node:crypto';
import { randomToken } from '../../src/common/crypto/random.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { IdentityExpiryService } from '../../src/modules/identity/identity-expiry.service.js';
import {
  bearer,
  type Customer,
  flushRateLimits,
  http,
  login,
  registerCustomer,
  seedStaff,
  staffLogin,
} from '../helpers/auth-helpers.js';
import {
  completeAtDevProvider,
  confirmReturn,
  overview,
  parseReturn,
  startVerification,
  uniqueSubject,
} from '../helpers/identity-helpers.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/**
 * Same-device confirmation: the defence against cross-device consent phishing (a provider
 * link forwarded to another person). See docs/reports/phase-04.md §12.
 */
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
const MINUTE = 60_000;

async function attempt(id: string) {
  return prisma.identityVerification.findUniqueOrThrow({ where: { id } });
}

/** The attacker starts on their own account; the victim completes the forwarded link. */
async function forwardedLink(): Promise<{
  attacker: Customer;
  victim: Customer;
  id: string;
  victimSubject: string;
  returnUrl: string;
}> {
  const attacker = await registerCustomer(app());
  const victim = await registerCustomer(app());
  const started = await startVerification(app(), attacker.tokens);
  const victimSubject = uniqueSubject();
  // The victim's browser: authenticates as the victim at the provider and consents.
  const { returnUrl } = await completeAtDevProvider(
    app(),
    started.body.data.authorizationUrl as string,
    { subject: victimSubject, name: 'Victim Person' },
  );
  return {
    attacker,
    victim,
    id: started.body.data.verification.id as string,
    victimSubject,
    returnUrl,
  };
}

describe('cross-device consent phishing (forwarded provider link)', () => {
  it("the provider step alone does not link the victim's identity to the attacker's account", async () => {
    const { attacker, id } = await forwardedLink();
    expect(await overview(app(), attacker.tokens)).toMatchObject({
      identityStatus: 'PENDING',
      verifiedName: null,
      latest: { id, status: 'PENDING' },
    });
    const row = await attempt(id);
    expect(row).toMatchObject({ status: 'PENDING', subjectHmac: null, verifiedClaimsEnc: null });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: attacker.userId } });
    expect(user.identitySubjectHmac).toBeNull();
  });

  it('the attacker cannot confirm without the token that only reached the victim browser', async () => {
    const { attacker, id } = await forwardedLink();
    for (let i = 0; i < 3; i += 1) {
      const res = await http(app())
        .post(`/api/v1/identity/verifications/${id}/confirm`)
        .set(bearer(attacker.tokens))
        .send({ confirmation: randomToken() })
        .expect(400);
      expect(res.body.code).toBe('IDENTITY_CONFIRMATION_INVALID');
    }
    expect((await attempt(id)).status).toBe('PENDING');
    const rejected = await prisma.auditLog.findMany({
      where: { targetId: id, action: 'identity.confirmation_rejected' },
    });
    expect(rejected.map((r) => (r.changes as { problem: string }).problem)).toEqual([
      'WRONG_TOKEN',
      'WRONG_TOKEN',
      'WRONG_TOKEN',
    ]);
  });

  it("the victim's own app cannot complete the attacker's attempt (404, not their attempt)", async () => {
    const { victim, id, returnUrl } = await forwardedLink();
    await confirmReturn(app(), victim.tokens, returnUrl, 404);
    expect((await attempt(id)).status).toBe('PENDING');
    expect((await overview(app(), victim.tokens)).identityStatus).toBe('UNVERIFIED');
  });

  it('an unconfirmed result expires and is erased; the victim can still verify their own account', async () => {
    const { attacker, victim, id, victimSubject } = await forwardedLink();
    await testApp.app.get(IdentityExpiryService).sweep(new Date(Date.now() + 11 * MINUTE));
    const row = await attempt(id);
    expect(row).toMatchObject({
      status: 'EXPIRED',
      outcomeCode: 'CONFIRMATION_EXPIRED',
      pendingResultEnc: null,
      confirmationHash: null,
      subjectHmac: null,
    });
    expect(await overview(app(), attacker.tokens)).toMatchObject({
      identityStatus: 'UNVERIFIED',
      latest: { status: 'EXPIRED', reason: 'SESSION_EXPIRED' },
    });

    // The victim's identity was never bound, so the victim is not locked out.
    const own = await startVerification(app(), victim.tokens);
    const done = await completeAtDevProvider(app(), own.body.data.authorizationUrl as string, {
      subject: victimSubject,
    });
    await confirmReturn(app(), victim.tokens, done.returnUrl);
    expect((await overview(app(), victim.tokens)).identityStatus).toBe('VERIFIED');
  });
});

describe('confirmation binding', () => {
  async function started(customer: Customer) {
    const res = await startVerification(app(), customer.tokens);
    const done = await completeAtDevProvider(app(), res.body.data.authorizationUrl as string);
    return { id: res.body.data.verification.id as string, returnUrl: done.returnUrl };
  }

  it('is bound to the session that started the attempt, even for the same account', async () => {
    const customer = await registerCustomer(app());
    const { id, returnUrl } = await started(customer);
    const otherSession = await login(app(), customer.phone, customer.password, customer.device);
    expect(otherSession.sessionId).not.toBe(customer.tokens.sessionId);
    const res = await confirmReturn(app(), otherSession, returnUrl, 400);
    expect(res.body.code).toBe('IDENTITY_CONFIRMATION_INVALID');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { targetId: id, action: 'identity.confirmation_rejected' },
    });
    expect(audit.changes).toEqual({ problem: 'OTHER_SESSION' });
    // The initiating session still can.
    await confirmReturn(app(), customer.tokens, returnUrl);
    expect((await attempt(id)).status).toBe('VERIFIED');
  });

  it('rejects an expired confirmation and expires the attempt', async () => {
    const customer = await registerCustomer(app());
    const { id, returnUrl } = await started(customer);
    await prisma.identityVerification.update({
      where: { id },
      data: { confirmationExpiresAt: new Date(Date.now() - 1000) },
    });
    await confirmReturn(app(), customer.tokens, returnUrl, 400);
    expect(await attempt(id)).toMatchObject({
      status: 'EXPIRED',
      outcomeCode: 'CONFIRMATION_EXPIRED',
    });
  });

  it('cannot confirm before the provider answered', async () => {
    const customer = await registerCustomer(app());
    const res = await startVerification(app(), customer.tokens);
    const id = res.body.data.verification.id as string;
    const err = await http(app())
      .post(`/api/v1/identity/verifications/${id}/confirm`)
      .set(bearer(customer.tokens))
      .send({ confirmation: randomToken() })
      .expect(400);
    expect(err.body.code).toBe('IDENTITY_CONFIRMATION_INVALID');
  });

  it('a repeated confirmation reports the outcome and changes nothing', async () => {
    const customer = await registerCustomer(app());
    const { id, returnUrl } = await started(customer);
    await confirmReturn(app(), customer.tokens, returnUrl);
    const version = (await attempt(id)).version;
    const again = await confirmReturn(app(), customer.tokens, returnUrl);
    expect(again.body.data.status).toBe('VERIFIED');
    expect((await attempt(id)).version).toBe(version);
  });

  it('keeps the held result encrypted and never stores the token', async () => {
    const customer = await registerCustomer(app());
    const subject = uniqueSubject();
    const res = await startVerification(app(), customer.tokens);
    const id = res.body.data.verification.id as string;
    const { returnUrl } = await completeAtDevProvider(
      app(),
      res.body.data.authorizationUrl as string,
      { subject },
    );
    const token = parseReturn(returnUrl).confirmation ?? '';
    const row = await attempt(id);
    const serialized = JSON.stringify({
      ...row,
      pendingResultEnc: Buffer.from(row.pendingResultEnc ?? []).toString('latin1'),
    });
    expect(serialized).not.toContain(subject);
    expect(serialized).not.toContain(token);
    expect(row.confirmationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(testApp.logs()).not.toContain(token);
  });

  it('validates input and access', async () => {
    const customer = await registerCustomer(app());
    const { id } = await started(customer);
    await http(app())
      .post(`/api/v1/identity/verifications/${id}/confirm`)
      .send({ confirmation: randomToken() })
      .expect(401);
    const bad = await http(app())
      .post(`/api/v1/identity/verifications/${id}/confirm`)
      .set(bearer(customer.tokens))
      .send({ confirmation: 'short' })
      .expect(400);
    expect(bad.body.errors).toContainEqual({ field: 'confirmation', code: 'MATCHES' });
    await http(app())
      .post(`/api/v1/identity/verifications/${randomUUID()}/confirm`)
      .set(bearer(customer.tokens))
      .send({ confirmation: randomToken() })
      .expect(404);
    const officer = await staffLogin(app(), await seedStaff(app(), ['VERIFICATION_OFFICER']));
    await http(app())
      .post(`/api/v1/identity/verifications/${id}/confirm`)
      .set(bearer(officer))
      .send({ confirmation: randomToken() })
      .expect(404);
  });
});
