import { randomUUID } from 'node:crypto';
import { DiscoveryModule } from '@nestjs/core';
import type { Test } from 'supertest';
import {
  bearer,
  flushRateLimits,
  http,
  login,
  registerCustomer,
  seedStaff,
  staffLogin,
  type Tokens,
  uniquePhone,
} from '../helpers/auth-helpers.js';
import { startVerification } from '../helpers/identity-helpers.js';
import { collectRoutes } from '../helpers/routes.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/**
 * Authorization matrix (docs/architecture/07-security-architecture.md §2): every protected
 * route is called as every actor and the status is asserted. The first test fails when a
 * protected route exists without a row here, so new endpoints cannot skip this check.
 */
const ACTORS = [
  'anonymous',
  'customer',
  'otherCustomer',
  'support',
  'verificationOfficer',
  'finance',
  'superAdmin',
] as const;
type Actor = (typeof ACTORS)[number];

interface Fixtures {
  tokens: Record<Exclude<Actor, 'anonymous'>, Tokens>;
  /** A second session of `otherCustomer`: target for IDOR attempts. */
  otherCustomerSpareSessionId: string;
  /** An open identity verification of `otherCustomer`: target for IDOR attempts. */
  otherCustomerVerificationId: string;
  /** A SUPPORT staff member that the super admin may manage. */
  managedStaffId: string;
}

interface Row {
  readonly route: string;
  readonly call: (agent: ReturnType<typeof http>, fx: Fixtures) => Test;
  readonly expect: Record<Actor, number>;
}

const everyone = (anonymous: number, others: number): Record<Actor, number> => ({
  anonymous,
  customer: others,
  otherCustomer: others,
  support: others,
  verificationOfficer: others,
  finance: others,
  superAdmin: others,
});
const superAdminOnly = (ok: number): Record<Actor, number> => ({
  anonymous: 401,
  customer: 404,
  otherCustomer: 404,
  support: 403,
  verificationOfficer: 403,
  finance: 403,
  superAdmin: ok,
});

/** Customer routes: `customer` is a stranger to otherCustomer's data; staff get 404. */
const customersOnly = (customer: number, otherCustomer: number): Record<Actor, number> => ({
  anonymous: 401,
  customer,
  otherCustomer,
  support: 404,
  verificationOfficer: 404,
  finance: 404,
  superAdmin: 404,
});
const verificationOfficerOnly = (ok: number): Record<Actor, number> => ({
  anonymous: 401,
  customer: 404,
  otherCustomer: 404,
  support: 403,
  verificationOfficer: ok,
  finance: 403,
  superAdmin: 403,
});

const ROWS: Row[] = [
  { route: 'GET me', call: (a) => a.get('/api/v1/me'), expect: everyone(401, 200) },
  {
    route: 'PATCH me',
    call: (a) => a.patch('/api/v1/me').set('If-Match', '0').send({}),
    expect: everyone(401, 200),
  },
  {
    route: 'GET me/sessions',
    call: (a) => a.get('/api/v1/me/sessions'),
    expect: everyone(401, 200),
  },
  {
    route: 'POST me/password',
    call: (a) =>
      a
        .post('/api/v1/me/password')
        .send({ currentPassword: 'definitely-wrong', newPassword: 'Another-Strong-Pass-9' }),
    expect: everyone(401, 400),
  },
  {
    // IDOR: only the owner may end the session; everyone else sees 404.
    route: 'DELETE me/sessions/:id',
    call: (a, fx) => a.delete(`/api/v1/me/sessions/${fx.otherCustomerSpareSessionId}`),
    expect: { ...everyone(401, 404), otherCustomer: 204 },
  },
  {
    route: 'GET admin/staff',
    call: (a) => a.get('/api/v1/admin/staff'),
    expect: superAdminOnly(200),
  },
  {
    route: 'POST admin/staff',
    call: (a) =>
      a
        .post('/api/v1/admin/staff')
        .send({ phone: uniquePhone(), displayName: 'Matrix Staff', roles: ['SUPPORT'] }),
    expect: superAdminOnly(201),
  },
  {
    route: 'POST admin/staff/:id/roles',
    call: (a, fx) =>
      a.post(`/api/v1/admin/staff/${fx.managedStaffId}/roles`).send({ role: 'FINANCE' }),
    expect: superAdminOnly(200),
  },
  {
    route: 'DELETE admin/staff/:id/roles/:role',
    call: (a, fx) => a.delete(`/api/v1/admin/staff/${fx.managedStaffId}/roles/FINANCE`),
    expect: superAdminOnly(200),
  },
  {
    route: 'POST admin/staff/:id/credentials/reset',
    call: (a, fx) => a.post(`/api/v1/admin/staff/${fx.managedStaffId}/credentials/reset`),
    expect: superAdminOnly(200),
  },
  // Phase 4: identity. Customers only (staff have no customer identity: 404); own data only.
  {
    route: 'GET identity/verifications/current',
    call: (a) => a.get('/api/v1/identity/verifications/current'),
    expect: customersOnly(200, 200),
  },
  {
    route: 'GET identity/verifications/:id',
    call: (a, fx) => a.get(`/api/v1/identity/verifications/${fx.otherCustomerVerificationId}`),
    expect: customersOnly(404, 200),
  },
  {
    // 400 for the owner: no provider result to confirm (and a random token).
    route: 'POST identity/verifications/:id/confirm',
    call: (a, fx) =>
      a
        .post(`/api/v1/identity/verifications/${fx.otherCustomerVerificationId}/confirm`)
        .send({ confirmation: 'A'.repeat(43) }),
    expect: customersOnly(404, 400),
  },
  {
    // Runs before the start row below, which would replace this attempt.
    route: 'POST identity/verifications/:id/cancel',
    call: (a, fx) =>
      a.post(`/api/v1/identity/verifications/${fx.otherCustomerVerificationId}/cancel`),
    expect: customersOnly(404, 200),
  },
  {
    route: 'POST identity/verifications',
    call: (a) =>
      a
        .post('/api/v1/identity/verifications')
        .set('Idempotency-Key', randomUUID())
        .send({ consent: true }),
    expect: customersOnly(201, 201),
  },
  {
    route: 'GET admin/identity-verifications/:id',
    call: (a, fx) =>
      a
        .get(`/api/v1/admin/identity-verifications/${fx.otherCustomerVerificationId}`)
        .query({ reason: 'Authorization matrix check' }),
    expect: verificationOfficerOnly(200),
  },
  {
    // 409: the officer passes authorization; the attempt is not in a verified state.
    route: 'POST admin/identity-verifications/:id/require-reverification',
    call: (a, fx) =>
      a
        .post(
          `/api/v1/admin/identity-verifications/${fx.otherCustomerVerificationId}/require-reverification`,
        )
        .send({ reason: 'Authorization matrix check' }),
    expect: verificationOfficerOnly(409),
  },
  {
    route: 'POST admin/identity-verifications/:id/suspend',
    call: (a, fx) =>
      a
        .post(`/api/v1/admin/identity-verifications/${fx.otherCustomerVerificationId}/suspend`)
        .send({ reason: 'Authorization matrix check' }),
    expect: verificationOfficerOnly(409),
  },
  {
    route: 'POST auth/staff/reauthenticate',
    call: (a) =>
      a
        .post('/api/v1/auth/staff/reauthenticate')
        .send({ password: 'wrong-password', totpCode: '000000' }),
    expect: {
      anonymous: 401,
      customer: 404,
      otherCustomer: 404,
      support: 400,
      verificationOfficer: 400,
      finance: 400,
      superAdmin: 400,
    },
  },
];

const normalizeRoute = (route: string) => route.replace(/:[a-z]+/g, ':param');

describe('authorization matrix', () => {
  let testApp: TestApp;
  let fixtures: Fixtures;

  beforeAll(async () => {
    testApp = await createTestApp({ extraModules: [DiscoveryModule] });
    await flushRateLimits();
    const app = testApp.app;
    const customer = await registerCustomer(app);
    const other = await registerCustomer(app);
    const spare = await login(app, other.phone, other.password, other.device);
    const managed = await seedStaff(app, ['SUPPORT']);
    fixtures = {
      tokens: {
        customer: customer.tokens,
        otherCustomer: other.tokens,
        support: await staffLogin(app, await seedStaff(app, ['SUPPORT'])),
        verificationOfficer: await staffLogin(app, await seedStaff(app, ['VERIFICATION_OFFICER'])),
        finance: await staffLogin(app, await seedStaff(app, ['FINANCE'])),
        superAdmin: await staffLogin(app, await seedStaff(app, ['SUPER_ADMIN'])),
      },
      otherCustomerSpareSessionId: spare.sessionId,
      otherCustomerVerificationId: (await startVerification(app, other.tokens)).body.data
        .verification.id as string,
      managedStaffId: managed.userId,
    };
  });
  afterAll(async () => {
    await testApp.close();
  });

  it('has a row for every protected route', () => {
    const protectedRoutes = collectRoutes(testApp)
      .filter((route) => !route.isPublic)
      .map((route) => normalizeRoute(route.route))
      .sort();
    expect(ROWS.map((row) => normalizeRoute(row.route)).sort()).toEqual(protectedRoutes);
  });

  for (const row of ROWS) {
    it(`${row.route}: ${ACTORS.map((actor) => `${actor}=${row.expect[actor]}`).join(' ')}`, async () => {
      const results: Partial<Record<Actor, number>> = {};
      for (const actor of ACTORS) {
        const agent = http(testApp.app);
        let call = row.call(agent, fixtures);
        if (actor !== 'anonymous') call = call.set(bearer(fixtures.tokens[actor]));
        results[actor] = (await call).status;
      }
      expect(results).toEqual(row.expect);
    });
  }

  it('never answers 403 where the caller has no relationship with the resource (404 instead)', async () => {
    const res = await http(testApp.app)
      .delete(`/api/v1/me/sessions/${randomUUID()}`)
      .set(bearer(fixtures.tokens.superAdmin));
    expect(res.status).toBe(404);
  });
});
