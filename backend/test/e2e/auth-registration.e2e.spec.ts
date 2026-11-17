import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import {
  flushRateLimits,
  http,
  latestSms,
  newDevice,
  registerCustomer,
  requestRegistrationCode,
  STRONG_PASSWORD,
  uniquePhone,
} from '../helpers/auth-helpers.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('registration (journey J1)', () => {
  let testApp: TestApp;
  let prisma: PrismaService;
  const app = () => testApp.app;

  beforeAll(async () => {
    testApp = await createTestApp();
    prisma = testApp.app.get(PrismaService);
  });
  afterAll(async () => {
    await testApp.close();
  });
  beforeEach(flushRateLimits);

  const registerBody = (phone: string, otp: string, overrides: Record<string, unknown> = {}) => ({
    phone,
    otp,
    password: STRONG_PASSWORD,
    displayName: 'Abebe Kebede',
    preferredLocale: 'am',
    device: newDevice(),
    ...overrides,
  });

  it('sends a 6-digit code and creates an ACTIVE customer with a trusted device', async () => {
    const phone = uniquePhone();
    const code = await requestRegistrationCode(app(), phone);
    expect(code).toMatch(/^\d{6}$/);

    const body = registerBody(phone, code);
    const res = await http(app())
      .post('/api/v1/auth/register')
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(201);
    expect(Object.keys(res.body.data)).toEqual(['userId']);

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: res.body.data.userId },
      include: { devices: true },
    });
    expect(user).toMatchObject({
      status: 'ACTIVE',
      accountType: 'CUSTOMER',
      preferredLocale: 'am',
      identityStatus: 'UNVERIFIED',
    });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.devices[0]?.trustedAt).not.toBeNull();
    expect(
      await prisma.auditLog.count({ where: { action: 'auth.registered', targetId: user.id } }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { eventType: 'user.registered', aggregateId: user.id },
      }),
    ).toBe(1);
  });

  it('accepts local phone formats and normalizes them', async () => {
    const phone = uniquePhone();
    const local = `0${phone.slice(4)}`;
    await http(app()).post('/api/v1/auth/otp').send({ phone: local }).expect(202);
    expect((await latestSms(app(), phone))?.template).toBe('otp.register');
  });

  it('stores only a keyed hash of the code', async () => {
    const phone = uniquePhone();
    const code = await requestRegistrationCode(app(), phone);
    const challenge = await prisma.otpChallenge.findFirstOrThrow({ where: { phoneE164: phone } });
    expect(challenge.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(challenge)).not.toContain(code);
  });

  describe('idempotency', () => {
    it('replays the stored response for a retried request with the same key', async () => {
      const phone = uniquePhone();
      const body = registerBody(phone, await requestRegistrationCode(app(), phone));
      const key = randomUUID();
      const first = await http(app())
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      const retry = await http(app())
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      expect(retry.body).toEqual(first.body);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(await prisma.user.count({ where: { phoneE164: phone } })).toBe(1);
    });

    it('creates exactly one account under concurrent duplicates', async () => {
      const phone = uniquePhone();
      const body = registerBody(phone, await requestRegistrationCode(app(), phone));
      const key = randomUUID();
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          http(app()).post('/api/v1/auth/register').set('Idempotency-Key', key).send(body),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      expect(new Set(results.map((r) => r.body.data.userId as string)).size).toBe(1);
      expect(await prisma.user.count({ where: { phoneE164: phone } })).toBe(1);
    });

    it('rejects the same key with a different body (422)', async () => {
      const phone = uniquePhone();
      const body = registerBody(phone, await requestRegistrationCode(app(), phone));
      const key = randomUUID();
      await http(app())
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      const res = await http(app())
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', key)
        .send({ ...body, displayName: 'Someone Else' })
        .expect(422);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('requires a well-formed key', async () => {
      const body = registerBody(uniquePhone(), '123456');
      expect(
        (await http(app()).post('/api/v1/auth/register').send(body).expect(400)).body.code,
      ).toBe('IDEMPOTENCY_KEY_REQUIRED');
      const bad = await http(app())
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', 'bad key!')
        .send(body)
        .expect(400);
      expect(bad.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
    });

    it('does not cache failures: the same key works after the problem is fixed', async () => {
      const phone = uniquePhone();
      const code = await requestRegistrationCode(app(), phone);
      const key = randomUUID();
      const wrong = code === '000000' ? '111111' : '000000';
      await http(app())
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', key)
        .send(registerBody(phone, wrong))
        .expect(400);
      await http(app())
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', key)
        .send(registerBody(phone, code))
        .expect(201);
    });
  });

  describe('codes', () => {
    it('rejects a wrong code, and locks the challenge after 5 attempts even for the right code', async () => {
      const phone = uniquePhone();
      const code = await requestRegistrationCode(app(), phone);
      const wrong = code === '999999' ? '888888' : '999999';
      for (let i = 0; i < 5; i += 1) {
        const res = await http(app())
          .post('/api/v1/auth/register')
          .set('Idempotency-Key', randomUUID())
          .send(registerBody(phone, wrong));
        expect(res.body.code).toBe('OTP_INVALID');
      }
      const res = await http(app())
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', randomUUID())
        .send(registerBody(phone, code));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('OTP_INVALID');
    });

    it('rejects an expired code', async () => {
      const phone = uniquePhone();
      const code = await requestRegistrationCode(app(), phone);
      await prisma.otpChallenge.updateMany({
        where: { phoneE164: phone },
        data: { createdAt: new Date(Date.now() - 600_000), expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await http(app())
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', randomUUID())
        .send(registerBody(phone, code));
      expect(res.body.code).toBe('OTP_INVALID');
    });

    it('only accepts the newest code', async () => {
      const phone = uniquePhone();
      const first = await requestRegistrationCode(app(), phone);
      const second = await requestRegistrationCode(app(), phone);
      if (first !== second) {
        const res = await http(app())
          .post('/api/v1/auth/register')
          .set('Idempotency-Key', randomUUID())
          .send(registerBody(phone, first));
        expect(res.body.code).toBe('OTP_INVALID');
      }
      await http(app())
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', randomUUID())
        .send(registerBody(phone, second))
        .expect(201);
    });

    it('cannot reuse a consumed code', async () => {
      const phone = uniquePhone();
      const code = await requestRegistrationCode(app(), phone);
      await http(app())
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', randomUUID())
        .send(registerBody(phone, code))
        .expect(201);
      const res = await http(app())
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', randomUUID())
        .send(registerBody(phone, code));
      expect(res.body.code).toBe('OTP_INVALID');
    });
  });

  describe('account enumeration', () => {
    it('answers identically for registered and new numbers, and texts the owner instead', async () => {
      const existing = await registerCustomer(app());
      const fresh = uniquePhone();
      const a = await http(app()).post('/api/v1/auth/otp').send({ phone: existing.phone });
      const b = await http(app()).post('/api/v1/auth/otp').send({ phone: fresh });
      expect(a.status).toBe(202);
      expect(b.status).toBe(202);
      expect(a.body).toEqual(b.body);
      expect((await latestSms(app(), existing.phone))?.template).toBe('account.exists');
      expect((await latestSms(app(), existing.phone))?.text).not.toMatch(/\d{6}/);
      expect((await latestSms(app(), fresh))?.template).toBe('otp.register');
    });

    it('fails registration of an existing number with the same error as a wrong code', async () => {
      const existing = await registerCustomer(app());
      const res = await http(app())
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', randomUUID())
        .send(registerBody(existing.phone, '123456'))
        .expect(400);
      expect(res.body.code).toBe('OTP_INVALID');
    });
  });

  describe('password policy', () => {
    it.each([
      ['too short', 'Short1!', 'MIN_LENGTH'],
      ['common', 'basketball', 'PASSWORD_TOO_COMMON'],
      ['repetitive', 'zqzqzqzqzqzq', 'PASSWORD_REPETITIVE'],
    ])(
      'rejects a %s password with a field code, without consuming the code',
      async (_label, password, code) => {
        const phone = uniquePhone();
        const otp = await requestRegistrationCode(app(), phone);
        const res = await http(app())
          .post('/api/v1/auth/register')
          .set('Idempotency-Key', randomUUID())
          .send(registerBody(phone, otp, { password }))
          .expect(400);
        expect(res.body.errors).toContainEqual({ field: 'password', code });
        await http(app())
          .post('/api/v1/auth/register')
          .set('Idempotency-Key', randomUUID())
          .send(registerBody(phone, otp))
          .expect(201);
      },
    );

    it('rejects a password containing the phone number', async () => {
      const phone = uniquePhone();
      const otp = await requestRegistrationCode(app(), phone);
      const res = await http(app())
        .post('/api/v1/auth/register')
        .set('Idempotency-Key', randomUUID())
        .send(registerBody(phone, otp, { password: `my-${phone.slice(4)}-pw` }))
        .expect(400);
      expect(res.body.errors).toContainEqual({
        field: 'password',
        code: 'PASSWORD_CONTAINS_PHONE',
      });
    });
  });

  describe('rate limits', () => {
    it('limits codes per phone (3 per 15 minutes) with Retry-After', async () => {
      const phone = uniquePhone();
      for (let i = 0; i < 3; i += 1)
        await http(app()).post('/api/v1/auth/otp').send({ phone }).expect(202);
      const blocked = await http(app()).post('/api/v1/auth/otp').send({ phone }).expect(429);
      expect(blocked.body.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('limits codes per IP (20 per hour) across numbers', async () => {
      for (let i = 0; i < 20; i += 1)
        await http(app()).post('/api/v1/auth/otp').send({ phone: uniquePhone() }).expect(202);
      await http(app()).post('/api/v1/auth/otp').send({ phone: uniquePhone() }).expect(429);
    });

    it('applies the same limit to unregistered and registered numbers', async () => {
      const existing = await registerCustomer(app());
      await flushRateLimits();
      for (let i = 0; i < 3; i += 1)
        await http(app()).post('/api/v1/auth/otp').send({ phone: existing.phone }).expect(202);
      await http(app()).post('/api/v1/auth/otp').send({ phone: existing.phone }).expect(429);
    });
  });

  it('never writes passwords or codes to logs or the audit trail', async () => {
    const phone = uniquePhone();
    const code = await requestRegistrationCode(app(), phone);
    await http(app())
      .post('/api/v1/auth/register')
      .set('Idempotency-Key', randomUUID())
      .send(registerBody(phone, code))
      .expect(201);
    const logs = testApp.logs();
    expect(logs).not.toContain(STRONG_PASSWORD);
    expect(logs).not.toContain(code);
    const audit = JSON.stringify(
      await prisma.auditLog.findMany({ take: 500, orderBy: { seq: 'desc' } }),
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    );
    expect(audit).not.toContain(STRONG_PASSWORD);
    expect(audit).not.toContain(phone);
  });
});
