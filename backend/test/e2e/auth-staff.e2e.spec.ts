import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { base32Decode, hotp, totpStep } from '../../src/modules/auth/staff/totp.js';
import {
  bearer,
  flushRateLimits,
  http,
  newDevice,
  registerCustomer,
  seedStaff,
  staffLogin,
  totpCode,
  uniquePhone,
} from '../helpers/auth-helpers.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

describe('staff authentication and administration', () => {
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

  describe('login (password + TOTP)', () => {
    it('signs in with password and current TOTP; the session lasts 12 hours', async () => {
      const staff = await seedStaff(app(), ['SUPPORT']);
      const tokens = await staffLogin(app(), staff);
      const me = await http(app()).get('/api/v1/me').set(bearer(tokens)).expect(200);
      expect(me.body.data).toMatchObject({ accountType: 'STAFF', roles: ['SUPPORT'] });
      const session = await prisma.session.findUniqueOrThrow({ where: { id: tokens.sessionId } });
      expect(
        Math.abs(session.expiresAt.getTime() - session.createdAt.getTime() - 12 * 3_600_000),
      ).toBeLessThan(5_000);
    });

    it('fails generically for a wrong TOTP, wrong password, customer number or unknown number', async () => {
      const staff = await seedStaff(app(), ['FINANCE']);
      const customer = await registerCustomer(app());
      const attempt = (phone: string, password: string, code: string) =>
        http(app())
          .post('/api/v1/auth/staff/login')
          .send({ phone, password, totpCode: code, device: newDevice('WEB') });
      const wrongTotp = totpCode(staff.secret, 5);
      for (const res of [
        await attempt(staff.phone, staff.password, wrongTotp),
        await attempt(staff.phone, 'wrong-password', totpCode(staff.secret)),
        await attempt(customer.phone, customer.password, '123456'),
        await attempt(uniquePhone(), 'whatever', '123456'),
      ]) {
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('INVALID_CREDENTIALS');
      }
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: staff.userId } })).failedLoginCount,
      ).toBe(2);
    });

    it('rejects a replayed TOTP code', async () => {
      const staff = await seedStaff(app(), ['SUPPORT']);
      const code = totpCode(staff.secret);
      const body = {
        phone: staff.phone,
        password: staff.password,
        totpCode: code,
        device: newDevice('WEB'),
      };
      await http(app()).post('/api/v1/auth/staff/login').send(body).expect(200);
      const replay = await http(app()).post('/api/v1/auth/staff/login').send(body).expect(401);
      expect(replay.body.code).toBe('INVALID_CREDENTIALS');
    });

    it('does not let staff use the customer login', async () => {
      const staff = await seedStaff(app(), ['SUPER_ADMIN']);
      const res = await http(app())
        .post('/api/v1/auth/login')
        .send({ phone: staff.phone, password: staff.password, device: newDevice() });
      expect(res.body.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('admin API authorization', () => {
    it('hides the admin API from customers (404) and forbids staff without the permission (403)', async () => {
      const customer = await registerCustomer(app());
      const finance = await staffLogin(app(), await seedStaff(app(), ['FINANCE']));
      const admin = await staffLogin(app(), await seedStaff(app(), ['SUPER_ADMIN']));
      await http(app()).get('/api/v1/admin/staff').expect(401);
      expect(
        (await http(app()).get('/api/v1/admin/staff').set(bearer(customer.tokens)).expect(404)).body
          .code,
      ).toBe('NOT_FOUND');
      expect(
        (await http(app()).get('/api/v1/admin/staff').set(bearer(finance)).expect(403)).body.code,
      ).toBe('FORBIDDEN');
      const list = await http(app()).get('/api/v1/admin/staff').set(bearer(admin)).expect(200);
      expect(Array.isArray(list.body.data)).toBe(true);
      expect(JSON.stringify(list.body)).not.toMatch(/password|mfaSecret|argon2/i);
    });

    it('takes role revocation into account on the very next request', async () => {
      const adminStaff = await seedStaff(app(), ['SUPER_ADMIN']);
      const admin = await staffLogin(app(), adminStaff);
      await http(app()).get('/api/v1/admin/staff').set(bearer(admin)).expect(200);
      await prisma.staffRoleAssignment.updateMany({
        where: { userId: adminStaff.userId },
        data: { revokedAt: new Date() },
      });
      await http(app()).get('/api/v1/admin/staff').set(bearer(admin)).expect(403);
    });
  });

  describe('staff lifecycle: create, activate with TOTP, manage roles', () => {
    it('creates staff, who activates with the one-time code and an authenticator app', async () => {
      const admin = await staffLogin(app(), await seedStaff(app(), ['SUPER_ADMIN']));
      const phone = uniquePhone();
      const created = await http(app())
        .post('/api/v1/admin/staff')
        .set(bearer(admin))
        .send({
          phone: `0${phone.slice(4)}`,
          displayName: 'Hanna Officer',
          roles: ['VERIFICATION_OFFICER'],
        })
        .expect(201);
      const { staff, activationCode } = created.body.data as {
        staff: { id: string; status: string };
        activationCode: string;
      };
      expect(staff.status).toBe('PENDING_ACTIVATION');
      expect(activationCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

      // Cannot sign in before activation.
      const early = await http(app())
        .post('/api/v1/auth/staff/login')
        .send({ phone, password: 'x', totpCode: '123456', device: newDevice('WEB') });
      expect(early.status).toBe(401);

      const password = 'Arat-Kilo-Office-77';
      const activation = await http(app())
        .post('/api/v1/auth/staff/activate')
        .send({ phone, activationCode: activationCode.toLowerCase(), newPassword: password })
        .expect(200);
      const secret = base32Decode(activation.body.data.totpSecret as string);
      expect(activation.body.data.otpauthUri).toMatch(/^otpauth:\/\/totp\//);

      // The activation code is single-use.
      await http(app())
        .post('/api/v1/auth/staff/activate')
        .send({ phone, activationCode, newPassword: password })
        .expect(400);

      const enrollmentTicket = activation.body.data.enrollmentTicket as string;
      // A code that is not current (5 steps ahead) does not enroll the authenticator.
      const wrong = await http(app())
        .post('/api/v1/auth/staff/activate/confirm')
        .send({ enrollmentTicket, totpCode: hotp(secret, totpStep(Date.now()) + 5) })
        .expect(400);
      expect(wrong.body.code).toBe('OTP_INVALID');
      await http(app())
        .post('/api/v1/auth/staff/activate/confirm')
        .send({ enrollmentTicket, totpCode: hotp(secret, totpStep(Date.now())) })
        .expect(204);
      // The enrollment ticket is single-use.
      await http(app())
        .post('/api/v1/auth/staff/activate/confirm')
        .send({ enrollmentTicket, totpCode: hotp(secret, totpStep(Date.now())) })
        .expect(400);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
      expect(user.status).toBe('ACTIVE');
      expect(user.mfaSecretEnc).not.toBeNull();
      expect(Buffer.from(user.mfaSecretEnc ?? new Uint8Array()).includes(secret)).toBe(false);

      const login = await http(app())
        .post('/api/v1/auth/staff/login')
        .send({
          phone,
          password,
          totpCode: hotp(secret, totpStep(Date.now()) + 1),
          device: newDevice('WEB'),
        })
        .expect(200);
      const me = await http(app())
        .get('/api/v1/me')
        .set('Authorization', `Bearer ${login.body.data.accessToken as string}`)
        .expect(200);
      expect(me.body.data.roles).toEqual(['VERIFICATION_OFFICER']);
    });

    it('requires a recent re-authentication for sensitive actions', async () => {
      const adminStaff = await seedStaff(app(), ['SUPER_ADMIN']);
      const admin = await staffLogin(app(), adminStaff);
      await prisma.session.update({
        where: { id: admin.sessionId },
        data: { authenticatedAt: new Date(Date.now() - 10 * 60_000) },
      });
      const stale = await http(app())
        .post('/api/v1/admin/staff')
        .set(bearer(admin))
        .send({ phone: uniquePhone(), displayName: 'X', roles: ['SUPPORT'] })
        .expect(403);
      expect(stale.body.code).toBe('REAUTHENTICATION_REQUIRED');

      const wrong = await http(app())
        .post('/api/v1/auth/staff/reauthenticate')
        .set(bearer(admin))
        .send({ password: adminStaff.password, totpCode: totpCode(adminStaff.secret, 3) })
        .expect(400);
      expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
      await http(app())
        .post('/api/v1/auth/staff/reauthenticate')
        .set(bearer(admin))
        .send({ password: adminStaff.password, totpCode: totpCode(adminStaff.secret, 1) })
        .expect(204);
      await http(app())
        .post('/api/v1/admin/staff')
        .set(bearer(admin))
        .send({ phone: uniquePhone(), displayName: 'New Support', roles: ['SUPPORT'] })
        .expect(201);
    });

    it('grants and revokes roles, but never on oneself, and keeps one super admin', async () => {
      const adminStaff = await seedStaff(app(), ['SUPER_ADMIN']);
      const admin = await staffLogin(app(), adminStaff);
      const target = await seedStaff(app(), ['SUPPORT']);

      const granted = await http(app())
        .post(`/api/v1/admin/staff/${target.userId}/roles`)
        .set(bearer(admin))
        .send({ role: 'FINANCE' })
        .expect(200);
      const roleNames = (body: unknown) =>
        (body as { data: { roles: { role: string }[] } }).data.roles.map((r) => r.role);
      expect(roleNames(granted.body).sort()).toEqual(['FINANCE', 'SUPPORT']);
      const revoked = await http(app())
        .delete(`/api/v1/admin/staff/${target.userId}/roles/SUPPORT`)
        .set(bearer(admin))
        .expect(200);
      expect(roleNames(revoked.body)).toEqual(['FINANCE']);

      const self = await http(app())
        .post(`/api/v1/admin/staff/${adminStaff.userId}/roles`)
        .set(bearer(admin))
        .send({ role: 'FINANCE' })
        .expect(403);
      expect(self.body.code).toBe('CANNOT_MODIFY_OWN_ACCOUNT');
      await http(app())
        .delete(`/api/v1/admin/staff/${adminStaff.userId}/roles/SUPER_ADMIN`)
        .set(bearer(admin))
        .expect(403);

      const customer = await registerCustomer(app());
      await http(app())
        .post(`/api/v1/admin/staff/${customer.userId}/roles`)
        .set(bearer(admin))
        .send({ role: 'SUPPORT' })
        .expect(404);
      await http(app())
        .delete(`/api/v1/admin/staff/${target.userId}/roles/ROOT`)
        .set(bearer(admin))
        .expect(400);

      expect(
        await prisma.auditLog.count({
          where: {
            action: 'staff.role_granted',
            targetId: target.userId,
            actorUserId: adminStaff.userId,
          },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: { action: 'staff.role_revoked', targetId: target.userId },
        }),
      ).toBe(1);
    });

    it('resets a staff member’s credentials: sessions end and re-activation is required', async () => {
      const admin = await staffLogin(app(), await seedStaff(app(), ['SUPER_ADMIN']));
      const target = await seedStaff(app(), ['FINANCE']);
      const targetTokens = await staffLogin(app(), target);
      const reset = await http(app())
        .post(`/api/v1/admin/staff/${target.userId}/credentials/reset`)
        .set(bearer(admin))
        .expect(200);
      expect(reset.body.data.staff.status).toBe('PENDING_ACTIVATION');
      expect(reset.body.data.activationCode).toMatch(/-/);
      await http(app()).get('/api/v1/me').set(bearer(targetTokens)).expect(401);
      const login = await http(app())
        .post('/api/v1/auth/staff/login')
        .send({
          phone: target.phone,
          password: target.password,
          totpCode: totpCode(target.secret, 1),
          device: newDevice('WEB'),
        });
      expect(login.status).toBe(401);
    });

    it('reports a duplicate phone number to the super admin', async () => {
      const admin = await staffLogin(app(), await seedStaff(app(), ['SUPER_ADMIN']));
      const customer = await registerCustomer(app());
      const res = await http(app())
        .post('/api/v1/admin/staff')
        .set(bearer(admin))
        .send({ phone: customer.phone, displayName: 'Dup', roles: ['SUPPORT'] })
        .expect(409);
      expect(res.body.code).toBe('PHONE_IN_USE');
    });
  });
});
