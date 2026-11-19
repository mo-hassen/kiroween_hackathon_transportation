import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { DriverEligibilityService } from '../../src/modules/drivers/driver-eligibility.service.js';
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
  APPROVE,
  attach,
  type Driver,
  LICENSE_DETAILS,
  licenseJpeg,
  preparedDriver,
  submit,
  uniqueLicenseNumber,
  uploadDocument,
  VIEW_REASON,
} from '../helpers/document-helpers.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

let testApp: TestApp;
let prisma: PrismaService;
let officer: Tokens;
let officerId: string;
let otherOfficer: Tokens;

beforeAll(async () => {
  testApp = await createTestApp();
  prisma = testApp.app.get(PrismaService);
  await flushRateLimits();
  const staff = await seedStaff(testApp.app, ['VERIFICATION_OFFICER']);
  officerId = staff.userId;
  officer = await staffLogin(testApp.app, staff);
  otherOfficer = await staffLogin(
    testApp.app,
    await seedStaff(testApp.app, ['VERIFICATION_OFFICER']),
  );
});
afterAll(async () => {
  await testApp.close();
});
beforeEach(flushRateLimits);

const app = () => testApp.app;
const admin = (path: string) => `/api/v1/admin/driver-verifications${path}`;
const license = (id: string) => prisma.driverLicense.findUniqueOrThrow({ where: { id } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON body in tests
async function me(tokens: Tokens): Promise<any> {
  return (await http(app()).get('/api/v1/drivers/me').set(bearer(tokens)).expect(200)).body.data;
}
async function auditActions(targetId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({ where: { targetId }, orderBy: { seq: 'asc' } });
  return rows.map((r) => r.action);
}
async function claimAndApprove(driver: Driver, tokens = officer) {
  await http(app())
    .post(admin(`/${driver.licenseId}/claim`))
    .set(bearer(tokens))
    .expect(200);
  return http(app())
    .post(admin(`/${driver.licenseId}/approve`))
    .set(bearer(tokens))
    .send(APPROVE)
    .expect(200);
}

describe('driver profile', () => {
  it('creates once (repeat returns the same), customers only, and is not eligible by itself', async () => {
    const customer = await registerCustomer(app());
    const first = await http(app())
      .post('/api/v1/drivers/me')
      .set(bearer(customer.tokens))
      .send({ homeSubCity: 'YEKA' })
      .expect(201);
    const again = await http(app())
      .post('/api/v1/drivers/me')
      .set(bearer(customer.tokens))
      .send({})
      .expect(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(first.body.data).toMatchObject({
      homeSubCity: 'YEKA',
      license: null,
      eligibility: {
        status: 'INELIGIBLE',
        blockers: expect.arrayContaining(['IDENTITY_NOT_VERIFIED', 'LICENSE_MISSING']),
      },
    });
    expect(await prisma.driverProfile.count({ where: { userId: customer.userId } })).toBe(1);
    expect(await auditActions(first.body.data.id as string)).toEqual(['driver.profile_created']);
    await http(app()).post('/api/v1/drivers/me').set(bearer(officer)).send({}).expect(404);
  });

  it('never accepts eligibility, suspension or review fields from the client', async () => {
    const customer = await registerCustomer(app());
    for (const body of [
      { eligibilityStatus: 'ELIGIBLE' },
      { suspendedReason: 'OTHER' },
      { reviewStatus: 'APPROVED' },
    ]) {
      const res = await http(app())
        .post('/api/v1/drivers/me')
        .set(bearer(customer.tokens))
        .send(body)
        .expect(400);
      expect(res.body.errors).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_FIELD' }));
    }
  });

  it('updates with optimistic concurrency (If-Match)', async () => {
    const customer = await registerCustomer(app());
    const created = await http(app())
      .post('/api/v1/drivers/me')
      .set(bearer(customer.tokens))
      .send({})
      .expect(201);
    await http(app())
      .patch('/api/v1/drivers/me')
      .set(bearer(customer.tokens))
      .send({ bio: 'x' })
      .expect(428);
    const updated = await http(app())
      .patch('/api/v1/drivers/me')
      .set(bearer(customer.tokens))
      .set('If-Match', String(created.body.data.version))
      .send({ yearsLicensed: 7, bio: 'Taxi driver since 2019' })
      .expect(200);
    expect(updated.body.data).toMatchObject({ yearsLicensed: 7, bio: 'Taxi driver since 2019' });
    await http(app())
      .patch('/api/v1/drivers/me')
      .set(bearer(customer.tokens))
      .set('If-Match', String(created.body.data.version))
      .send({ yearsLicensed: 8 })
      .expect(409);
    for (const body of [
      { yearsLicensed: 61 },
      { homeSubCity: 'NAIROBI' },
      { bio: 'x'.repeat(501) },
    ]) {
      await http(app())
        .patch('/api/v1/drivers/me')
        .set(bearer(customer.tokens))
        .set('If-Match', String(updated.body.data.version))
        .send(body)
        .expect(400);
    }
  });
});

describe('licence details', () => {
  let customer: Customer;
  beforeAll(async () => {
    customer = await registerCustomer(app());
    await http(app()).post('/api/v1/drivers/me').set(bearer(customer.tokens)).send({}).expect(201);
  });

  it.each<[string, Record<string, unknown>, string, string]>([
    [
      'expiry before issue',
      { issuedOn: '2024-05-01', expiresOn: '2024-01-01' },
      'expiresOn',
      'BEFORE_ISSUE_DATE',
    ],
    [
      'expired licence',
      { issuedOn: '2015-01-01', expiresOn: '2020-01-01' },
      'expiresOn',
      'EXPIRED',
    ],
    [
      'issued in the future',
      { issuedOn: '2099-01-01', expiresOn: '2100-01-01' },
      'issuedOn',
      'IN_FUTURE',
    ],
    ['impossible date', { issuedOn: '2023-02-30' }, 'issuedOn', 'IS_DATE'],
    ['bad number', { licenseNumber: 'AB_12$' }, 'licenseNumber', 'INVALID_FORMAT'],
    ['duplicate categories', { categories: ['B', 'b'] }, 'categories', 'INVALID_FORMAT'],
  ])('rejects %s', async (_label, change, field, code) => {
    const res = await http(app())
      .post('/api/v1/drivers/me/licenses')
      .set(bearer(customer.tokens))
      .send({ ...LICENSE_DETAILS, licenseNumber: uniqueLicenseNumber(), ...change })
      .expect(400);
    expect(res.body.errors).toContainEqual({ field, code });
  });

  it('rejects missing fields', async () => {
    await http(app())
      .post('/api/v1/drivers/me/licenses')
      .set(bearer(customer.tokens))
      .send({ licenseNumber: 'AB1234' })
      .expect(400);
  });

  it('stores the number encrypted with an HMAC, shows it masked, never logs it', async () => {
    const number = uniqueLicenseNumber();
    const res = await http(app())
      .post('/api/v1/drivers/me/licenses')
      .set(bearer(customer.tokens))
      .send({ ...LICENSE_DETAILS, licenseNumber: number })
      .expect(201);
    expect(res.body.data).toMatchObject({
      licenseNumberMasked: `••••${number.slice(-4)}`,
      reviewStatus: 'DRAFT',
      editable: true,
    });
    const row = await license(res.body.data.id as string);
    expect(Buffer.from(row.licenseNumberEnc).toString('latin1')).not.toContain(number);
    expect(row.licenseNumberHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(
      JSON.stringify(
        await prisma.auditLog.findMany({ where: { targetId: row.id } }),
        (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
      ),
    ).not.toContain(number);
    expect(testApp.logs()).not.toContain(number);
    // One licence per profile.
    await http(app())
      .post('/api/v1/drivers/me/licenses')
      .set(bearer(customer.tokens))
      .send({ ...LICENSE_DETAILS, licenseNumber: uniqueLicenseNumber() })
      .expect(409);
  });

  it('rejects a licence number registered to another account (normalized), and flags it', async () => {
    const holder = await preparedDriver(app(), { verified: false });
    const other = await registerCustomer(app());
    await http(app()).post('/api/v1/drivers/me').set(bearer(other.tokens)).send({}).expect(201);
    const spaced = `${holder.licenseNumber.slice(0, 3)} ${holder.licenseNumber.slice(3).toLowerCase()}`;
    const res = await http(app())
      .post('/api/v1/drivers/me/licenses')
      .set(bearer(other.tokens))
      .send({ ...LICENSE_DETAILS, licenseNumber: spaced })
      .expect(409);
    expect(res.body.code).toBe('LICENSE_NUMBER_IN_USE');
    expect(await auditActions(other.userId)).toContain('driver.duplicate_license_detected');
  });
});

describe('licence documents', () => {
  it("rejects another user's document, the wrong purpose and an unprocessed document", async () => {
    const driver = await preparedDriver(app(), { verified: false });
    const other = await preparedDriver(app(), { verified: false });
    // Cross-user: 404, as if it did not exist.
    await attach(app(), driver.tokens, driver.licenseId, 'front', other.frontId, 404);
    // A back image as the front.
    const back = await uploadDocument(
      app(),
      driver.tokens,
      await licenseJpeg('back'),
      'DRIVER_LICENSE_BACK',
    );
    expect(
      (await attach(app(), driver.tokens, driver.licenseId, 'front', back, 409)).body.code,
    ).toBe('DOCUMENT_NOT_AVAILABLE');
    // Not completed yet.
    const pending = await http(app())
      .post('/api/v1/documents')
      .set(bearer(driver.tokens))
      .send({
        purpose: 'DRIVER_LICENSE_FRONT',
        mimeType: 'image/jpeg',
        sizeBytes: 100,
        sha256: 'a'.repeat(64),
      })
      .expect(201);
    await attach(
      app(),
      driver.tokens,
      driver.licenseId,
      'front',
      pending.body.data.document.id as string,
      409,
    );
    // Another user's licence id: 404.
    await attach(app(), driver.tokens, other.licenseId, 'front', driver.frontId, 404);
    await http(app())
      .put(`/api/v1/drivers/me/licenses/${driver.licenseId}/documents/side`)
      .set(bearer(driver.tokens))
      .send({ documentId: driver.frontId })
      .expect(400);
  });
});

describe('submission', () => {
  it('requires verified identity', async () => {
    const driver = await preparedDriver(app(), { verified: false });
    const res = await submit(app(), driver.tokens, driver.licenseId, 422);
    expect(res.body).toMatchObject({ code: 'DRIVER_SUBMISSION_INCOMPLETE' });
    expect(res.body.errors).toContainEqual({ field: 'license', code: 'IDENTITY_NOT_VERIFIED' });
    expect((await license(driver.licenseId)).reviewStatus).toBe('DRAFT');
  });

  it('requires both documents', async () => {
    const customer = await registerCustomer(app());
    const { verifyIdentity } = await import('../helpers/identity-helpers.js');
    await verifyIdentity(app(), customer.tokens);
    await http(app()).post('/api/v1/drivers/me').set(bearer(customer.tokens)).send({}).expect(201);
    const created = await http(app())
      .post('/api/v1/drivers/me/licenses')
      .set(bearer(customer.tokens))
      .send({ ...LICENSE_DETAILS, licenseNumber: uniqueLicenseNumber() })
      .expect(201);
    const id = created.body.data.id as string;
    let res = await submit(app(), customer.tokens, id, 422);
    expect(res.body.errors).toEqual([
      { field: 'license', code: 'FRONT_DOCUMENT_MISSING' },
      { field: 'license', code: 'BACK_DOCUMENT_MISSING' },
    ]);
    const front = await uploadDocument(
      app(),
      customer.tokens,
      await licenseJpeg(),
      'DRIVER_LICENSE_FRONT',
    );
    await attach(app(), customer.tokens, id, 'front', front);
    res = await submit(app(), customer.tokens, id, 422);
    expect(res.body.errors).toEqual([{ field: 'license', code: 'BACK_DOCUMENT_MISSING' }]);
  });

  it('submits once (idempotent retry), freezes the details and requires an Idempotency-Key', async () => {
    const driver = await preparedDriver(app());
    await http(app())
      .post(`/api/v1/drivers/me/licenses/${driver.licenseId}/submit`)
      .set(bearer(driver.tokens))
      .expect(400);
    const key = randomUUID();
    const first = await submit(app(), driver.tokens, driver.licenseId, 200, key);
    const retry = await submit(app(), driver.tokens, driver.licenseId, 200, key);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(first.body.data).toMatchObject({ reviewStatus: 'SUBMITTED', editable: false });
    await submit(app(), driver.tokens, driver.licenseId, 409);
    await http(app())
      .patch(`/api/v1/drivers/me/licenses/${driver.licenseId}`)
      .set(bearer(driver.tokens))
      .set('If-Match', String(first.body.data.version))
      .send({ ...LICENSE_DETAILS, licenseNumber: uniqueLicenseNumber() })
      .expect(409);
    const docs = await prisma.document.findMany({
      where: { id: { in: [driver.frontId, driver.backId] } },
    });
    expect(docs.map((d) => d.reviewStatus)).toEqual(['SUBMITTED', 'SUBMITTED']);
    expect(await auditActions(driver.licenseId)).toContain('driver.verification_submitted');
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: driver.licenseId, eventType: 'driver.verification_submitted' },
      }),
    ).toBe(1);
  });

  it("a driver cannot read or submit another driver's licence (IDOR)", async () => {
    const a = await preparedDriver(app());
    const b = await preparedDriver(app());
    await submit(app(), b.tokens, a.licenseId, 404);
    await http(app())
      .patch(`/api/v1/drivers/me/licenses/${a.licenseId}`)
      .set(bearer(b.tokens))
      .set('If-Match', '0')
      .send({ ...LICENSE_DETAILS, licenseNumber: uniqueLicenseNumber() })
      .expect(404);
  });
});

describe('review queue', () => {
  it('approve: claim -> view documents (audited) -> approve -> ELIGIBLE, with history and events', async () => {
    const driver = await preparedDriver(app(), { submit: true });
    const queue = await http(app())
      .get(admin('?status=SUBMITTED&limit=50'))
      .set(bearer(officer))
      .expect(200);
    expect((queue.body.data.items as { id: string }[]).map((c: { id: string }) => c.id)).toContain(
      driver.licenseId,
    );

    // Documents are only for the officer holding the claim.
    const docPath = admin(`/${driver.licenseId}/documents/${driver.frontId}/url`);
    await http(app()).get(docPath).query(VIEW_REASON).set(bearer(officer)).expect(409);

    const claimed = await http(app())
      .post(admin(`/${driver.licenseId}/claim`))
      .set(bearer(officer))
      .expect(200);
    expect(claimed.body.data).toMatchObject({ reviewStatus: 'UNDER_REVIEW', claimedByMe: true });
    await http(app()).get(docPath).set(bearer(officer)).expect(400);
    const url = await http(app()).get(docPath).query(VIEW_REASON).set(bearer(officer)).expect(200);
    expect((await fetch(url.body.data.url as string)).status).toBe(200);
    const view = await prisma.auditLog.findFirstOrThrow({
      where: { targetId: driver.frontId, action: 'document.viewed_by_staff' },
    });
    expect(view).toMatchObject({ actorUserId: officerId, reason: VIEW_REASON.reason });
    await http(app()).get(docPath).query(VIEW_REASON).set(bearer(otherOfficer)).expect(409);

    const detail = await http(app())
      .get(admin(`/${driver.licenseId}`))
      .set(bearer(officer))
      .expect(200);
    expect(detail.body.data).toMatchObject({
      licenseNumber: driver.licenseNumber,
      identityStatus: 'VERIFIED',
      identityVerifiedName: 'Test Person',
      categories: ['B'],
    });
    expect(await auditActions(driver.licenseId)).toContain('driver.case_viewed');

    // Approval needs every confirmation.
    await http(app())
      .post(admin(`/${driver.licenseId}/approve`))
      .set(bearer(officer))
      .send({ identityMatches: true })
      .expect(400);
    const approved = await http(app())
      .post(admin(`/${driver.licenseId}/approve`))
      .set(bearer(officer))
      .send(APPROVE)
      .expect(200);
    expect(approved.body.data.reviewStatus).toBe('APPROVED');

    expect(await me(driver.tokens)).toMatchObject({
      eligibility: { status: 'ELIGIBLE', blockers: [] },
      license: { reviewStatus: 'APPROVED', editable: false },
    });
    const history = (
      await http(app())
        .get(admin(`/${driver.licenseId}`))
        .set(bearer(officer))
        .expect(200)
    ).body.data.history;
    expect((history as { action: string }[]).map((h) => h.action)).toEqual([
      'created',
      'submitted',
      'claimed',
      'approved',
    ]);
    expect(await auditActions(driver.licenseId)).toEqual(
      expect.arrayContaining(['driver.review_claimed', 'driver.approved']),
    );
    const profile = await prisma.driverProfile.findUniqueOrThrow({
      where: { userId: driver.userId },
    });
    expect(await auditActions(profile.id)).toContain('driver.eligibility_changed');
    expect(
      await prisma.notification.count({
        where: { recipientUserId: driver.userId, eventType: 'driver.approved' },
      }),
    ).toBe(1);
    expect(
      (await prisma.outboxEvent.findMany({ where: { aggregateId: driver.licenseId } })).map(
        (e) => e.eventType,
      ),
    ).toEqual(expect.arrayContaining(['driver.verification_submitted', 'driver.approved']));
  });

  it('reject with a reason -> the driver sees it, re-uploads and resubmits', async () => {
    const driver = await preparedDriver(app(), { submit: true });
    await http(app())
      .post(admin(`/${driver.licenseId}/claim`))
      .set(bearer(officer))
      .expect(200);
    await http(app())
      .post(admin(`/${driver.licenseId}/reject`))
      .set(bearer(officer))
      .send({})
      .expect(400);
    await http(app())
      .post(admin(`/${driver.licenseId}/reject`))
      .set(bearer(officer))
      .send({ reasonCode: 'SAFETY_CONCERN' })
      .expect(400);
    await http(app())
      .post(admin(`/${driver.licenseId}/reject`))
      .set(bearer(officer))
      .send({ reasonCode: 'BLURRY', note: 'The back image is out of focus.' })
      .expect(200);
    const rejected = await me(driver.tokens);
    expect(rejected.license).toMatchObject({
      reviewStatus: 'REJECTED',
      decisionReasonCode: 'BLURRY',
      decisionNote: 'The back image is out of focus.',
      editable: true,
    });
    expect(rejected.eligibility.status).toBe('INELIGIBLE');

    // Rejected documents cannot be submitted again: new uploads are needed.
    expect((await submit(app(), driver.tokens, driver.licenseId, 409)).body.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    const front = await uploadDocument(
      app(),
      driver.tokens,
      await licenseJpeg('front2'),
      'DRIVER_LICENSE_FRONT',
    );
    await attach(app(), driver.tokens, driver.licenseId, 'front', front);
    expect((await license(driver.licenseId)).reviewStatus).toBe('DRAFT');
    expect((await submit(app(), driver.tokens, driver.licenseId, 422)).body.errors).toEqual([
      { field: 'license', code: 'BACK_DOCUMENT_MISSING' },
    ]);
    const back = await uploadDocument(
      app(),
      driver.tokens,
      await licenseJpeg('back2'),
      'DRIVER_LICENSE_BACK',
    );
    await attach(app(), driver.tokens, driver.licenseId, 'back', back);
    await submit(app(), driver.tokens, driver.licenseId);
    expect(
      await prisma.notification.count({
        where: { recipientUserId: driver.userId, eventType: 'driver.rejected' },
      }),
    ).toBe(1);
  });

  it('two officers cannot hold the same case; an expired claim can be taken over', async () => {
    const driver = await preparedDriver(app(), { submit: true });
    const results = await Promise.all([
      http(app())
        .post(admin(`/${driver.licenseId}/claim`))
        .set(bearer(officer)),
      http(app())
        .post(admin(`/${driver.licenseId}/claim`))
        .set(bearer(otherOfficer)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(loser?.body.code).toBe('REVIEW_CLAIMED_BY_OTHER');
    const winner = results[0].status === 200 ? officer : otherOfficer;
    const other = winner === officer ? otherOfficer : officer;
    await http(app())
      .post(admin(`/${driver.licenseId}/approve`))
      .set(bearer(other))
      .send(APPROVE)
      .expect(409);
    await http(app())
      .post(admin(`/${driver.licenseId}/release`))
      .set(bearer(other))
      .expect(409);

    await prisma.driverLicense.update({
      where: { id: driver.licenseId },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });
    // The expired holder cannot decide any more.
    expect(
      (
        await http(app())
          .post(admin(`/${driver.licenseId}/approve`))
          .set(bearer(winner))
          .send(APPROVE)
          .expect(409)
      ).body.code,
    ).toBe('REVIEW_CLAIM_REQUIRED');
    const takeover = await http(app())
      .post(admin(`/${driver.licenseId}/claim`))
      .set(bearer(other))
      .expect(200);
    expect(takeover.body.data.claimedByMe).toBe(true);
    const actions = (
      await prisma.driverReviewEvent.findMany({ where: { driverLicenseId: driver.licenseId } })
    ).map((e) => e.action);
    expect(actions).toContain('claim_taken_over');
    await http(app())
      .post(admin(`/${driver.licenseId}/release`))
      .set(bearer(other))
      .expect(200);
    expect((await license(driver.licenseId)).reviewStatus).toBe('SUBMITTED');
  });

  it('concurrent decisions by the claim holder produce exactly one decision', async () => {
    const driver = await preparedDriver(app(), { submit: true });
    await http(app())
      .post(admin(`/${driver.licenseId}/claim`))
      .set(bearer(officer))
      .expect(200);
    const results = await Promise.all([
      http(app())
        .post(admin(`/${driver.licenseId}/approve`))
        .set(bearer(officer))
        .send(APPROVE),
      http(app())
        .post(admin(`/${driver.licenseId}/reject`))
        .set(bearer(officer))
        .send({ reasonCode: 'BLURRY' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const decisions = (
      await prisma.driverReviewEvent.findMany({ where: { driverLicenseId: driver.licenseId } })
    )
      .map((e) => e.action)
      .filter((a) => a === 'approved' || a === 'rejected');
    expect(decisions).toHaveLength(1);
  });

  it('approval re-checks the facts: an identity that is no longer verified blocks it', async () => {
    const driver = await preparedDriver(app(), { submit: true });
    await http(app())
      .post(admin(`/${driver.licenseId}/claim`))
      .set(bearer(officer))
      .expect(200);
    const attempt = await prisma.identityVerification.findFirstOrThrow({
      where: { userId: driver.userId, status: 'VERIFIED' },
    });
    await http(app())
      .post(`/api/v1/admin/identity-verifications/${attempt.id}/suspend`)
      .set(bearer(officer))
      .send({ reason: 'Identity under investigation' })
      .expect(200);
    const res = await http(app())
      .post(admin(`/${driver.licenseId}/approve`))
      .set(bearer(officer))
      .send(APPROVE)
      .expect(422);
    expect(res.body.errors).toContainEqual({ field: 'case', code: 'IDENTITY_NOT_VERIFIED' });
  });

  it('suspend makes the driver SUSPENDED; reinstate restores eligibility', async () => {
    const driver = await preparedDriver(app(), { submit: true });
    await claimAndApprove(driver);
    await http(app())
      .post(admin(`/${driver.licenseId}/suspend`))
      .set(bearer(officer))
      .send({ reasonCode: 'BLURRY', note: 'x'.repeat(12) })
      .expect(400);
    await http(app())
      .post(admin(`/${driver.licenseId}/suspend`))
      .set(bearer(officer))
      .send({ reasonCode: 'SAFETY_CONCERN', note: 'Owner reported unsafe driving' })
      .expect(200);
    const suspended = await me(driver.tokens);
    expect(suspended).toMatchObject({
      suspendedReason: 'SAFETY_CONCERN',
      eligibility: { status: 'SUSPENDED' },
    });
    // The internal suspension note is not shown to the driver.
    expect(JSON.stringify(suspended)).not.toContain('unsafe driving');
    await http(app()).get(`/api/v1/drivers/me/eligibility`).set(bearer(driver.tokens)).expect(200);
    await http(app())
      .post(admin(`/${driver.licenseId}/reinstate`))
      .set(bearer(officer))
      .send({ note: 'Investigation closed, no fault' })
      .expect(200);
    expect((await me(driver.tokens)).eligibility.status).toBe('ELIGIBLE');
    await http(app())
      .post(admin(`/${driver.licenseId}/reinstate`))
      .set(bearer(officer))
      .send({ note: 'Investigation closed again' })
      .expect(409);
  });

  it('an expired licence makes the driver ineligible (nightly job, simulated future date)', async () => {
    const driver = await preparedDriver(app(), { submit: true });
    await claimAndApprove(driver);
    expect((await me(driver.tokens)).eligibility.status).toBe('ELIGIBLE');
    const twoYears = new Date(Date.now() + 4 * 365 * 24 * 3600 * 1000);
    expect(await testApp.app.get(DriverEligibilityService).sweep(twoYears)).toBeGreaterThan(0);
    expect((await license(driver.licenseId)).reviewStatus).toBe('EXPIRED');
    const after = await me(driver.tokens);
    expect(after.eligibility).toMatchObject({
      status: 'INELIGIBLE',
      blockers: expect.arrayContaining(['LICENSE_NOT_APPROVED', 'DOCUMENTS_NOT_APPROVED']),
    });
    expect(after.license.editable).toBe(true);
    expect(
      await prisma.notification.count({
        where: { recipientUserId: driver.userId, eventType: 'driver.license_expired' },
      }),
    ).toBe(1);
  });

  it('invalid transitions are refused', async () => {
    const driver = await preparedDriver(app(), { submit: true });
    await http(app())
      .post(admin(`/${driver.licenseId}/approve`))
      .set(bearer(officer))
      .send(APPROVE)
      .expect(409);
    await http(app())
      .post(admin(`/${driver.licenseId}/suspend`))
      .set(bearer(officer))
      .send({ reasonCode: 'OTHER', note: 'Not approved yet' })
      .expect(409);
    await http(app())
      .post(admin(`/${driver.licenseId}/release`))
      .set(bearer(officer))
      .expect(409);
    const draft = await preparedDriver(app());
    await http(app())
      .post(admin(`/${draft.licenseId}/claim`))
      .set(bearer(officer))
      .expect(404);
    await http(app())
      .get(admin(`/${draft.licenseId}`))
      .set(bearer(officer))
      .expect(404);
    await http(app())
      .post(admin(`/${randomUUID()}/claim`))
      .set(bearer(officer))
      .expect(404);
  });

  it('queue filters, search and pagination', async () => {
    const counts = await http(app()).get(admin('/counts')).set(bearer(officer)).expect(200);
    expect(Object.keys(counts.body.data).sort()).toEqual([
      'APPROVED',
      'EXPIRED',
      'REJECTED',
      'SUBMITTED',
      'SUSPENDED',
      'UNDER_REVIEW',
    ]);
    const driver = await preparedDriver(app(), { submit: true });
    const byPhone = await http(app())
      .get(admin(''))
      .query({ q: driver.phone })
      .set(bearer(officer))
      .expect(200);
    expect((byPhone.body.data.items as { id: string }[]).map((c: { id: string }) => c.id)).toEqual([
      driver.licenseId,
    ]);
    const page = await http(app())
      .get(admin(''))
      .query({ limit: 1, page: 2 })
      .set(bearer(officer))
      .expect(200);
    expect(page.body.data).toMatchObject({ page: 2, limit: 1 });
    expect(page.body.data.items).toHaveLength(1);
    await http(app()).get(admin('')).query({ limit: 51 }).set(bearer(officer)).expect(400);
    await http(app()).get(admin('')).query({ status: 'NOPE' }).set(bearer(officer)).expect(400);
  });
});

describe('separation of duties', () => {
  it('only verification officers reach the queue; customers get 404; other staff 403', async () => {
    const driver = await preparedDriver(app(), { submit: true });
    for (const roles of [['SUPPORT'], ['FINANCE'], ['SUPER_ADMIN']] as const) {
      const staff = await staffLogin(app(), await seedStaff(app(), [...roles]));
      await http(app()).get(admin('')).set(bearer(staff)).expect(403);
      await http(app())
        .post(admin(`/${driver.licenseId}/claim`))
        .set(bearer(staff))
        .expect(403);
      await http(app())
        .get(admin(`/${driver.licenseId}/documents/${driver.frontId}/url`))
        .query(VIEW_REASON)
        .set(bearer(staff))
        .expect(403);
    }
    await http(app()).get(admin('')).set(bearer(driver.tokens)).expect(404);
    await http(app())
      .post(admin(`/${driver.licenseId}/approve`))
      .set(bearer(driver.tokens))
      .send(APPROVE)
      .expect(404);
    await http(app()).get(admin('')).expect(401);
  });

  it('the database refuses a driver (or a non-officer) as claimer or decider', async () => {
    const driver = await preparedDriver(app(), { submit: true });
    await expect(
      prisma.driverLicense.update({
        where: { id: driver.licenseId },
        data: {
          reviewStatus: 'UNDER_REVIEW',
          claimedById: driver.userId,
          claimExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.driverLicense.update({
        where: { id: driver.licenseId },
        data: { reviewStatus: 'APPROVED', decidedById: officerId, decidedAt: new Date() },
      }),
    ).rejects.toThrow();
  });
});
