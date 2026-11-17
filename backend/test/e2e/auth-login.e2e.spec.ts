import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { PasswordService } from '../../src/modules/auth/password/password.service.js';
import {
  bearer,
  flushRateLimits,
  http,
  latestCode,
  login,
  newDevice,
  pickTokens,
  registerCustomer,
  seedStaff,
  uniquePhone,
} from '../helpers/auth-helpers.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/** Problem body without the per-request id, for "identical response" comparisons. */
const shape = (body: Record<string, unknown>) => ({ ...body, requestId: undefined });

describe('customer login', () => {
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

  it('signs in on the trusted registration device and the access token works', async () => {
    const customer = await registerCustomer(app());
    const me = await http(app()).get('/api/v1/me').set(bearer(customer.tokens)).expect(200);
    expect(me.body.data).toMatchObject({
      id: customer.userId,
      phone: customer.phone,
      accountType: 'CUSTOMER',
      status: 'ACTIVE',
    });
    expect(customer.tokens.refreshToken).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
  });

  describe('new-device step-up (SMS code)', () => {
    it('requires a code from a new installation, then trusts it', async () => {
      const customer = await registerCustomer(app());
      const tablet = newDevice('IOS');
      const first = await http(app())
        .post('/api/v1/auth/login')
        .send({ phone: customer.phone, password: customer.password, device: tablet })
        .expect(200);
      expect(first.body.data).toMatchObject({ result: 'OTP_REQUIRED' });
      expect(first.body.data.accessToken).toBeUndefined();

      const code = await latestCode(app(), customer.phone);
      const verified = await http(app())
        .post('/api/v1/auth/login/verify')
        .send({ loginTicket: first.body.data.loginTicket, otp: code, device: tablet })
        .expect(200);
      await http(app())
        .get('/api/v1/me')
        .set(bearer(pickTokens(verified.body.data)))
        .expect(200);

      // Trusted now: no code the next time.
      await login(app(), customer.phone, customer.password, tablet);
    });

    it('rejects a wrong code, another installation, and a reused ticket', async () => {
      const customer = await registerCustomer(app());
      const tablet = newDevice('IOS');
      const start = await http(app())
        .post('/api/v1/auth/login')
        .send({ phone: customer.phone, password: customer.password, device: tablet });
      const ticket = start.body.data.loginTicket as string;
      const code = await latestCode(app(), customer.phone);

      const wrong = code === '000000' ? '111111' : '000000';
      expect(
        (
          await http(app())
            .post('/api/v1/auth/login/verify')
            .send({ loginTicket: ticket, otp: wrong, device: tablet })
        ).body.code,
      ).toBe('OTP_INVALID');
      expect(
        (
          await http(app())
            .post('/api/v1/auth/login/verify')
            .send({ loginTicket: ticket, otp: code, device: newDevice() })
        ).body.code,
      ).toBe('OTP_INVALID');
      await http(app())
        .post('/api/v1/auth/login/verify')
        .send({ loginTicket: ticket, otp: code, device: tablet })
        .expect(200);
      expect(
        (
          await http(app())
            .post('/api/v1/auth/login/verify')
            .send({ loginTicket: ticket, otp: code, device: tablet })
        ).body.code,
      ).toBe('OTP_INVALID');
    });

    it('exhausts the ticket after 5 wrong codes', async () => {
      const customer = await registerCustomer(app());
      const tablet = newDevice('IOS');
      const start = await http(app())
        .post('/api/v1/auth/login')
        .send({ phone: customer.phone, password: customer.password, device: tablet });
      const code = await latestCode(app(), customer.phone);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i += 1) {
        await http(app())
          .post('/api/v1/auth/login/verify')
          .send({ loginTicket: start.body.data.loginTicket, otp: wrong, device: tablet })
          .expect(400);
      }
      await http(app())
        .post('/api/v1/auth/login/verify')
        .send({ loginTicket: start.body.data.loginTicket, otp: code, device: tablet })
        .expect(400);
    });
  });

  describe('account enumeration', () => {
    it('answers unknown numbers, wrong passwords, staff numbers and locked accounts identically', async () => {
      const customer = await registerCustomer(app());
      const staff = await seedStaff(app(), ['SUPPORT']);
      const attempt = (phone: string, password: string) =>
        http(app()).post('/api/v1/auth/login').send({ phone, password, device: customer.device });

      const unknown = await attempt(uniquePhone(), 'whatever-password');
      const wrongPassword = await attempt(customer.phone, 'not-the-password');
      const staffOnCustomerLogin = await attempt(staff.phone, staff.password);
      for (const res of [unknown, wrongPassword, staffOnCustomerLogin]) {
        expect(res.status).toBe(401);
        expect(shape(res.body)).toEqual(shape(unknown.body));
      }
      expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('spends password-hashing work on unknown numbers and locked accounts too', async () => {
      const passwords = app().get(PasswordService);
      const verifyDummy = vi.spyOn(passwords, 'verifyDummy');
      const verify = vi.spyOn(passwords, 'verify');
      try {
        await http(app())
          .post('/api/v1/auth/login')
          .send({ phone: uniquePhone(), password: 'x', device: newDevice() })
          .expect(401);
        expect(verifyDummy).toHaveBeenCalledTimes(1);
        expect(verify).not.toHaveBeenCalled();

        const customer = await registerCustomer(app());
        verifyDummy.mockClear();
        await prisma.user.update({
          where: { id: customer.userId },
          data: { lockedUntil: new Date(Date.now() + 60_000) },
        });
        await http(app())
          .post('/api/v1/auth/login')
          .send({ phone: customer.phone, password: customer.password, device: customer.device })
          .expect(401);
        expect(verifyDummy).toHaveBeenCalledTimes(1);
      } finally {
        verifyDummy.mockRestore();
        verify.mockRestore();
      }
    });
  });

  describe('brute force', () => {
    it('limits attempts per phone (5 per 15 minutes) for any number', async () => {
      const phone = uniquePhone();
      for (let i = 0; i < 5; i += 1) {
        await http(app())
          .post('/api/v1/auth/login')
          .send({ phone, password: `guess-${i}`, device: newDevice() })
          .expect(401);
      }
      const blocked = await http(app())
        .post('/api/v1/auth/login')
        .send({ phone, password: 'guess-6', device: newDevice() })
        .expect(429);
      expect(blocked.body.code).toBe('RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('limits attempts per IP (30 per 15 minutes) across numbers (credential stuffing)', async () => {
      for (let i = 0; i < 30; i += 1) {
        await http(app())
          .post('/api/v1/auth/login')
          .send({ phone: uniquePhone(), password: 'leaked-password', device: newDevice() })
          .expect(401);
      }
      await http(app())
        .post('/api/v1/auth/login')
        .send({ phone: uniquePhone(), password: 'leaked-password', device: newDevice() })
        .expect(429);
    });

    it('locks the account after 5 wrong passwords: even the right password fails, generically', async () => {
      const customer = await registerCustomer(app());
      await flushRateLimits(); // registration's own login counted towards the per-phone limit
      for (let i = 0; i < 5; i += 1) {
        await http(app())
          .post('/api/v1/auth/login')
          .send({ phone: customer.phone, password: `wrong-${i}`, device: customer.device })
          .expect(401);
      }
      await flushRateLimits(); // isolate the account lock from the per-phone rate limit
      const locked = await http(app())
        .post('/api/v1/auth/login')
        .send({ phone: customer.phone, password: customer.password, device: customer.device });
      expect(locked.status).toBe(401);
      expect(locked.body.code).toBe('INVALID_CREDENTIALS');

      const user = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
      expect(user.failedLoginCount).toBe(5);
      expect(user.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
      expect(user.status).toBe('ACTIVE');
      expect(
        await prisma.auditLog.count({
          where: { action: 'auth.account_locked', targetId: customer.userId },
        }),
      ).toBe(1);

      // The session already in use keeps working (no lock-out of the real owner).
      await http(app()).get('/api/v1/me').set(bearer(customer.tokens)).expect(200);

      // After the lock expires the right password works and the counter resets.
      await prisma.user.update({
        where: { id: customer.userId },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      await login(app(), customer.phone, customer.password, customer.device);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).failedLoginCount,
      ).toBe(0);
    });

    it('doubles the lock for every further failure', async () => {
      const customer = await registerCustomer(app());
      await prisma.user.update({
        where: { id: customer.userId },
        data: { failedLoginCount: 6, lockedUntil: null },
      });
      const before = Date.now();
      await http(app())
        .post('/api/v1/auth/login')
        .send({ phone: customer.phone, password: 'wrong', device: customer.device })
        .expect(401);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
      expect(user.failedLoginCount).toBe(7);
      const lockMs = (user.lockedUntil?.getTime() ?? 0) - before;
      expect(lockMs).toBeGreaterThanOrEqual(239_000);
      expect(lockMs).toBeLessThanOrEqual(241_000 + 2_000);
    });
  });

  describe('account status', () => {
    it('lets a suspended account sign in read-only (BR-ACC-3)', async () => {
      const customer = await registerCustomer(app());
      await prisma.user.update({ where: { id: customer.userId }, data: { status: 'SUSPENDED' } });
      const tokens = await login(app(), customer.phone, customer.password, customer.device);
      const me = await http(app()).get('/api/v1/me').set(bearer(tokens)).expect(200);
      expect(me.body.data.status).toBe('SUSPENDED');
      const blocked = await http(app())
        .patch('/api/v1/me')
        .set(bearer(tokens))
        .set('If-Match', String(me.body.data.version))
        .send({ displayName: 'X' });
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('ACCOUNT_RESTRICTED');
      // Explicitly allowed exception: ending its own sessions.
      await http(app())
        .delete(`/api/v1/me/sessions/${customer.tokens.sessionId}`)
        .set(bearer(tokens))
        .expect(204);
    });

    it('treats a closed account as unknown and ends its sessions', async () => {
      const customer = await registerCustomer(app());
      await prisma.user.update({
        where: { id: customer.userId },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      const res = await http(app())
        .post('/api/v1/auth/login')
        .send({ phone: customer.phone, password: customer.password, device: customer.device });
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
      await http(app()).get('/api/v1/me').set(bearer(customer.tokens)).expect(401);
    });
  });

  it('never logs passwords or tokens', async () => {
    const customer = await registerCustomer(app());
    const logs = testApp.logs();
    expect(logs).not.toContain(customer.password);
    expect(logs).not.toContain(customer.tokens.refreshToken);
    expect(logs).not.toContain(customer.tokens.accessToken);
  });
});
