import { bootstrapSuperAdmin } from '../../src/cli/bootstrap.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import {
  bearer,
  flushRateLimits,
  http,
  newDevice,
  seedStaff,
  staffLogin,
  totpCode,
  uniquePhone,
} from '../helpers/auth-helpers.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('SMS disabled (the default outside development: no provider integrated)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { SMS_PROVIDER: 'disabled' } });
  });
  afterAll(async () => {
    await testApp.close();
  });
  beforeEach(flushRateLimits);

  it('fails closed with 503 SMS_UNAVAILABLE for every number alike', async () => {
    for (const path of ['/api/v1/auth/otp', '/api/v1/auth/password/reset/request']) {
      const res = await http(testApp.app).post(path).send({ phone: uniquePhone() }).expect(503);
      expect(res.body.code).toBe('SMS_UNAVAILABLE');
    }
  });

  it('does not mount the dev SMS inbox', async () => {
    await http(testApp.app)
      .get('/api/v1/dev/sms/messages')
      .query({ phone: uniquePhone() })
      .expect(404);
  });
});

describe('staff IP allow-list', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { STAFF_IP_ALLOWLIST: '10.20.0.0/16' } });
  });
  afterAll(async () => {
    await testApp.close();
  });
  beforeEach(flushRateLimits);

  it('rejects staff logins from outside the list with the generic error', async () => {
    const staff = await seedStaff(testApp.app, ['SUPPORT']);
    const res = await http(testApp.app)
      .post('/api/v1/auth/staff/login')
      .send({
        phone: staff.phone,
        password: staff.password,
        totpCode: totpCode(staff.secret),
        device: newDevice('WEB'),
      })
      .expect(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('staff IP allow-list including the caller', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { STAFF_IP_ALLOWLIST: '127.0.0.1,::1' } });
  });
  afterAll(async () => {
    await testApp.close();
  });
  beforeEach(flushRateLimits);

  it('admits staff from an allowed address', async () => {
    const tokens = await staffLogin(testApp.app, await seedStaff(testApp.app, ['SUPPORT']));
    await http(testApp.app).get('/api/v1/me').set(bearer(tokens)).expect(200);
  });
});

describe('bootstrap of the first super administrator (CLI core)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });
  afterAll(async () => {
    await testApp.close();
  });

  it('creates exactly one pending super admin with an activation code, then refuses', async () => {
    const prisma = testApp.app.get(PrismaService);
    // Other suites seed super admins directly; start from a state without any.
    const existing = await prisma.staffRoleAssignment.findMany({
      where: { role: 'SUPER_ADMIN' },
      select: { id: true },
    });
    await prisma.staffRoleAssignment.deleteMany({
      where: { id: { in: existing.map((e) => e.id) } },
    });

    const phone = uniquePhone();
    const [first, second] = await Promise.all([
      bootstrapSuperAdmin(testApp.app, { phoneE164: phone, displayName: 'First Admin' }),
      bootstrapSuperAdmin(testApp.app, { phoneE164: uniquePhone(), displayName: 'Second Admin' }),
    ]);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(['ALREADY_BOOTSTRAPPED', 'CREATED']);
    const created = first.kind === 'CREATED' ? first : second;
    if (created.kind !== 'CREATED') throw new Error('unreachable');
    expect(created.activation.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: created.userId },
      include: { staffRoles: true },
    });
    expect(user).toMatchObject({ accountType: 'STAFF', status: 'PENDING_ACTIVATION' });
    expect(user.staffRoles.map((r) => r.role)).toEqual(['SUPER_ADMIN']);
    expect(
      await prisma.auditLog.count({
        where: { action: 'staff.bootstrapped', targetId: created.userId },
      }),
    ).toBe(1);

    expect(
      (await bootstrapSuperAdmin(testApp.app, { phoneE164: uniquePhone(), displayName: 'Third' }))
        .kind,
    ).toBe('ALREADY_BOOTSTRAPPED');
  });
});
