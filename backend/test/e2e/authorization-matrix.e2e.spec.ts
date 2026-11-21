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
import {
  LICENSE_DETAILS,
  licenseJpeg,
  preparedDriver,
  uniqueLicenseNumber,
  uploadDocument,
} from '../helpers/document-helpers.js';
import { startVerification } from '../helpers/identity-helpers.js';
import {
  attachOwnerDocument,
  ORG_APPROVAL,
  preparedOwner,
  uniqueTin,
  uploadOwnerDocument,
} from '../helpers/owner-helpers.js';
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
  /** Phase 5: otherCustomer's draft licence and an AVAILABLE licence image. */
  otherCustomerLicenseId: string;
  otherCustomerDocumentId: string;
  /** A submitted driver case (another driver) and its front image. */
  caseId: string;
  caseDocumentId: string;
  /** Phase 6: otherCustomer's organization owner document, and a submitted owner case. */
  otherCustomerOwnerDocumentId: string;
  ownerCaseId: string;
  ownerCaseDocumentId: string;
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

/** Both customers get driver profiles; otherCustomer a draft licence; plus a submitted case. */
async function driverFixtures(
  app: TestApp['app'],
  customer: Tokens,
  other: Tokens,
): Promise<
  Pick<Fixtures, 'otherCustomerLicenseId' | 'otherCustomerDocumentId' | 'caseId' | 'caseDocumentId'>
> {
  for (const tokens of [customer, other]) {
    await http(app).post('/api/v1/drivers/me').set(bearer(tokens)).send({}).expect(201);
  }
  const licence = await http(app)
    .post('/api/v1/drivers/me/licenses')
    .set(bearer(other))
    .send({ ...LICENSE_DETAILS, licenseNumber: uniqueLicenseNumber() })
    .expect(201);
  const documentId = await uploadDocument(app, other, await licenseJpeg(), 'DRIVER_LICENSE_FRONT');
  const driver = await preparedDriver(app, { submit: true });
  return {
    otherCustomerLicenseId: licence.body.data.id as string,
    otherCustomerDocumentId: documentId,
    caseId: driver.licenseId,
    caseDocumentId: driver.frontId,
  };
}

const sha = 'a'.repeat(64);
const DRIVER_ROUTE = (customer: number, otherCustomer: number): Record<Actor, number> => ({
  anonymous: 401,
  customer,
  otherCustomer,
  support: 404,
  verificationOfficer: 404,
  finance: 404,
  superAdmin: 404,
});
const driverReviewer = (ok: number): Record<Actor, number> => ({
  anonymous: 401,
  customer: 404,
  otherCustomer: 404,
  support: 403,
  verificationOfficer: ok,
  finance: 403,
  superAdmin: 403,
});

const PHASE5_ROWS: Row[] = [
  {
    route: 'POST documents',
    call: (a) =>
      a.post('/api/v1/documents').send({
        purpose: 'DRIVER_LICENSE_FRONT',
        mimeType: 'image/jpeg',
        sizeBytes: 100,
        sha256: sha,
      }),
    expect: DRIVER_ROUTE(201, 201),
  },
  {
    route: 'GET documents/:id',
    call: (a, fx) => a.get(`/api/v1/documents/${fx.otherCustomerDocumentId}`),
    expect: DRIVER_ROUTE(404, 200),
  },
  {
    route: 'POST documents/:id/complete',
    call: (a, fx) => a.post(`/api/v1/documents/${fx.otherCustomerDocumentId}/complete`),
    expect: DRIVER_ROUTE(404, 200),
  },
  {
    route: 'GET documents/:id/url',
    call: (a, fx) => a.get(`/api/v1/documents/${fx.otherCustomerDocumentId}/url`),
    expect: DRIVER_ROUTE(404, 200),
  },
  {
    route: 'POST drivers/me',
    call: (a) => a.post('/api/v1/drivers/me').send({}),
    expect: DRIVER_ROUTE(200, 200),
  },
  {
    route: 'GET drivers/me',
    call: (a) => a.get('/api/v1/drivers/me'),
    expect: DRIVER_ROUTE(200, 200),
  },
  {
    route: 'PATCH drivers/me',
    call: (a) => a.patch('/api/v1/drivers/me').set('If-Match', '0').send({}),
    expect: DRIVER_ROUTE(200, 200),
  },
  {
    route: 'GET drivers/me/eligibility',
    call: (a) => a.get('/api/v1/drivers/me/eligibility'),
    expect: DRIVER_ROUTE(200, 200),
  },
  {
    // customer has none yet (201); otherCustomer already has one (409).
    route: 'POST drivers/me/licenses',
    call: (a) =>
      a
        .post('/api/v1/drivers/me/licenses')
        .send({ ...LICENSE_DETAILS, licenseNumber: uniqueLicenseNumber() }),
    expect: DRIVER_ROUTE(201, 409),
  },
  {
    route: 'PATCH drivers/me/licenses/:id',
    call: (a, fx) =>
      a
        .patch(`/api/v1/drivers/me/licenses/${fx.otherCustomerLicenseId}`)
        .set('If-Match', '999')
        .send({ ...LICENSE_DETAILS, licenseNumber: uniqueLicenseNumber() }),
    expect: DRIVER_ROUTE(404, 409),
  },
  {
    route: 'PUT drivers/me/licenses/:id/documents/:side',
    call: (a, fx) =>
      a
        .put(`/api/v1/drivers/me/licenses/${fx.otherCustomerLicenseId}/documents/front`)
        .send({ documentId: fx.otherCustomerDocumentId }),
    expect: DRIVER_ROUTE(404, 200),
  },
  {
    // 422 for the owner: identity not verified, back image missing.
    route: 'POST drivers/me/licenses/:id/submit',
    call: (a, fx) =>
      a
        .post(`/api/v1/drivers/me/licenses/${fx.otherCustomerLicenseId}/submit`)
        .set('Idempotency-Key', randomUUID()),
    expect: DRIVER_ROUTE(404, 422),
  },
  {
    route: 'GET admin/driver-verifications',
    call: (a) => a.get('/api/v1/admin/driver-verifications'),
    expect: driverReviewer(200),
  },
  {
    route: 'GET admin/driver-verifications/counts',
    call: (a) => a.get('/api/v1/admin/driver-verifications/counts'),
    expect: driverReviewer(200),
  },
  {
    route: 'GET admin/driver-verifications/:id',
    call: (a, fx) => a.get(`/api/v1/admin/driver-verifications/${fx.caseId}`),
    expect: driverReviewer(200),
  },
  {
    route: 'POST admin/driver-verifications/:id/claim',
    call: (a, fx) => a.post(`/api/v1/admin/driver-verifications/${fx.caseId}/claim`),
    expect: driverReviewer(200),
  },
  {
    // After the claim above: the officer holds it.
    route: 'GET admin/driver-verifications/:id/documents/:documentId/url',
    call: (a, fx) =>
      a
        .get(`/api/v1/admin/driver-verifications/${fx.caseId}/documents/${fx.caseDocumentId}/url`)
        .query({ reason: 'Authorization matrix check' }),
    expect: driverReviewer(200),
  },
  {
    route: 'POST admin/driver-verifications/:id/release',
    call: (a, fx) => a.post(`/api/v1/admin/driver-verifications/${fx.caseId}/release`),
    expect: driverReviewer(200),
  },
  {
    // 409 for the officer: released above, so not claimed.
    route: 'POST admin/driver-verifications/:id/approve',
    call: (a, fx) =>
      a
        .post(`/api/v1/admin/driver-verifications/${fx.caseId}/approve`)
        .send({ identityMatches: true, documentsLegible: true, detailsMatch: true }),
    expect: driverReviewer(409),
  },
  {
    route: 'POST admin/driver-verifications/:id/reject',
    call: (a, fx) =>
      a
        .post(`/api/v1/admin/driver-verifications/${fx.caseId}/reject`)
        .send({ reasonCode: 'BLURRY' }),
    expect: driverReviewer(409),
  },
  {
    route: 'POST admin/driver-verifications/:id/suspend',
    call: (a, fx) =>
      a
        .post(`/api/v1/admin/driver-verifications/${fx.caseId}/suspend`)
        .send({ reasonCode: 'OTHER', note: 'Authorization matrix check' }),
    expect: driverReviewer(409),
  },
  {
    route: 'POST admin/driver-verifications/:id/reinstate',
    call: (a, fx) =>
      a
        .post(`/api/v1/admin/driver-verifications/${fx.caseId}/reinstate`)
        .send({ note: 'Authorization matrix check' }),
    expect: driverReviewer(409),
  },
];
ROWS.push(...PHASE5_ROWS);

/**
 * Phase 6. Both customers are driver accounts (driverFixtures). otherCustomer is the owner
 * (an organization profile); customer is a different customer with no owner profile until
 * the first row creates an individual one. The case belongs to a third owner.
 */
async function ownerFixtures(
  app: TestApp['app'],
  other: Tokens,
): Promise<Pick<Fixtures, 'otherCustomerOwnerDocumentId' | 'ownerCaseId' | 'ownerCaseDocumentId'>> {
  await http(app)
    .post('/api/v1/owners/me')
    .set(bearer(other))
    .send({ ownerType: 'ORGANIZATION', organizationName: 'Matrix Transport PLC', tin: uniqueTin() })
    .expect(201);
  const documentId = await uploadOwnerDocument(app, other, 'tin');
  await attachOwnerDocument(app, other, 'tin', documentId);
  const owner = await preparedOwner(app, { submit: true });
  return {
    otherCustomerOwnerDocumentId: documentId,
    ownerCaseId: owner.profileId,
    ownerCaseDocumentId: owner.documents.tin!,
  };
}

const ownerReviewer = verificationOfficerOnly;
const decision = (path: string, body: object) => (a: ReturnType<typeof http>, fx: Fixtures) =>
  a
    .post(`/api/v1/admin/owner-verifications/${fx.ownerCaseId}/${path}`)
    .set('Idempotency-Key', randomUUID())
    .send(body);

const PHASE6_ROWS: Row[] = [
  {
    // customer creates an individual profile (201); otherCustomer already has one (200).
    route: 'POST owners/me',
    call: (a) => a.post('/api/v1/owners/me').send({ ownerType: 'INDIVIDUAL' }),
    expect: customersOnly(201, 200),
  },
  {
    route: 'GET owners/me',
    call: (a) => a.get('/api/v1/owners/me'),
    expect: customersOnly(200, 200),
  },
  {
    route: 'PATCH owners/me',
    call: (a) => a.patch('/api/v1/owners/me').set('If-Match', '0').send({}),
    expect: customersOnly(200, 200),
  },
  {
    route: 'GET owners/me/status',
    call: (a) => a.get('/api/v1/owners/me/status'),
    expect: customersOnly(200, 200),
  },
  {
    // Someone else's document: 404 for customer (IDOR); otherCustomer replaces its own.
    route: 'PUT owners/me/documents/:slot',
    call: (a, fx) =>
      a
        .put('/api/v1/owners/me/documents/tin')
        .send({ documentId: fx.otherCustomerOwnerDocumentId }),
    expect: customersOnly(404, 200),
  },
  {
    // 422 for both: identities not verified (and documents missing).
    route: 'POST owners/me/submit',
    call: (a) => a.post('/api/v1/owners/me/submit').set('Idempotency-Key', randomUUID()),
    expect: customersOnly(422, 422),
  },
  {
    route: 'GET admin/owner-verifications',
    call: (a) => a.get('/api/v1/admin/owner-verifications'),
    expect: ownerReviewer(200),
  },
  {
    route: 'GET admin/owner-verifications/counts',
    call: (a) => a.get('/api/v1/admin/owner-verifications/counts'),
    expect: ownerReviewer(200),
  },
  {
    route: 'GET admin/owner-verifications/:id',
    call: (a, fx) => a.get(`/api/v1/admin/owner-verifications/${fx.ownerCaseId}`),
    expect: ownerReviewer(200),
  },
  {
    route: 'POST admin/owner-verifications/:id/claim',
    call: (a, fx) => a.post(`/api/v1/admin/owner-verifications/${fx.ownerCaseId}/claim`),
    expect: ownerReviewer(200),
  },
  {
    // After the claim above: the officer holds it.
    route: 'GET admin/owner-verifications/:id/documents/:documentId/url',
    call: (a, fx) =>
      a
        .get(
          `/api/v1/admin/owner-verifications/${fx.ownerCaseId}/documents/${fx.ownerCaseDocumentId}/url`,
        )
        .query({ reason: 'Authorization matrix check' }),
    expect: ownerReviewer(200),
  },
  {
    // The officer holds the claim here (claimed above): the check runs (200).
    route: 'POST admin/owner-verifications/:id/tin-check',
    call: (a, fx) =>
      a
        .post(`/api/v1/admin/owner-verifications/${fx.ownerCaseId}/tin-check`)
        .send({ tin: '0000000000', reason: 'Authorization matrix check' }),
    expect: ownerReviewer(200),
  },
  {
    route: 'POST admin/owner-verifications/:id/release',
    call: (a, fx) => a.post(`/api/v1/admin/owner-verifications/${fx.ownerCaseId}/release`),
    expect: ownerReviewer(200),
  },
  {
    // 409 for the officer below: released above, so not claimed (or not VERIFIED/SUSPENDED).
    route: 'POST admin/owner-verifications/:id/approve',
    call: decision('approve', { identityConfirmed: true }),
    expect: ownerReviewer(409),
  },
  {
    route: 'POST admin/owner-verifications/:id/first-approval',
    call: decision('first-approval', ORG_APPROVAL),
    expect: ownerReviewer(409),
  },
  {
    route: 'POST admin/owner-verifications/:id/second-approval',
    call: decision('second-approval', ORG_APPROVAL),
    expect: ownerReviewer(409),
  },
  {
    route: 'POST admin/owner-verifications/:id/reject',
    call: decision('reject', { reasonCode: 'BLURRY' }),
    expect: ownerReviewer(409),
  },
  {
    route: 'POST admin/owner-verifications/:id/suspend',
    call: decision('suspend', { reasonCode: 'OTHER', note: 'Authorization matrix check' }),
    expect: ownerReviewer(409),
  },
  {
    route: 'POST admin/owner-verifications/:id/reinstate',
    call: decision('reinstate', { note: 'Authorization matrix check' }),
    expect: ownerReviewer(409),
  },
];
ROWS.push(...PHASE6_ROWS);

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
      ...(await driverFixtures(app, customer.tokens, other.tokens)),
      ...(await ownerFixtures(app, other.tokens)),
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
