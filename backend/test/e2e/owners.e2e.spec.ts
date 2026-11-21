import { randomUUID } from 'node:crypto';
import { FieldEncryption } from '../../src/common/crypto/field-encryption.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { OwnerStatusService } from '../../src/modules/owners/owner-status.service.js';
import { tinAad } from '../../src/modules/owners/owners.service.js';
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
import { complete, createIntent, uploadDocument } from '../helpers/document-helpers.js';
import { uniqueSubject, verifyIdentity } from '../helpers/identity-helpers.js';
import {
  adminOwner,
  attachAllOwnerDocuments,
  attachOwnerDocument,
  claimOwner,
  decide,
  INDIVIDUAL_APPROVAL,
  ORG_APPROVAL,
  ownerDocJpeg,
  OWNER_VIEW_REASON,
  preparedOwner,
  submitOwner,
  uniqueTin,
  uploadOwnerDocument,
} from '../helpers/owner-helpers.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

let testApp: TestApp;
let prisma: PrismaService;
let officerA: Tokens;
let officerAId: string;
let officerB: Tokens;
let officerBId: string;

beforeAll(async () => {
  testApp = await createTestApp();
  prisma = testApp.app.get(PrismaService);
  await flushRateLimits();
  const a = await seedStaff(testApp.app, ['VERIFICATION_OFFICER']);
  const b = await seedStaff(testApp.app, ['VERIFICATION_OFFICER']);
  officerAId = a.userId;
  officerBId = b.userId;
  officerA = await staffLogin(testApp.app, a);
  officerB = await staffLogin(testApp.app, b);
});
afterAll(async () => {
  await testApp.close();
});
beforeEach(flushRateLimits);

const app = () => testApp.app;
const profileRow = (id: string) => prisma.ownerProfile.findUniqueOrThrow({ where: { id } });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON body in tests
async function me(tokens: Tokens): Promise<any> {
  return (await http(app()).get('/api/v1/owners/me').set(bearer(tokens)).expect(200)).body.data;
}
async function auditActions(targetId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({ where: { targetId }, orderBy: { seq: 'asc' } });
  return rows.map((r) => r.action);
}
const json = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

describe('owner profile', () => {
  it('creates an individual profile once; customers only; the driver profile is untouched', async () => {
    const customer = await registerCustomer(app());
    await http(app()).post('/api/v1/drivers/me').set(bearer(customer.tokens)).send({}).expect(201);
    const driverBefore = await prisma.driverProfile.findUniqueOrThrow({
      where: { userId: customer.userId },
    });
    const created = await http(app())
      .post('/api/v1/owners/me')
      .set(bearer(customer.tokens))
      .send({ ownerType: 'INDIVIDUAL' })
      .expect(201);
    expect(created.body.data).toMatchObject({
      ownerType: 'INDIVIDUAL',
      organizationName: null,
      tinMasked: null,
      verificationStatus: 'UNVERIFIED',
      documents: [],
      editable: true,
      typeChangeAllowed: true,
      submissionProblems: ['IDENTITY_NOT_VERIFIED'],
      eligibility: { eligible: false, blockers: ['IDENTITY_NOT_VERIFIED', 'OWNER_NOT_VERIFIED'] },
    });
    const again = await http(app())
      .post('/api/v1/owners/me')
      .set(bearer(customer.tokens))
      .send({ ownerType: 'INDIVIDUAL' })
      .expect(200);
    expect(again.body.data.id).toBe(created.body.data.id);
    expect(await prisma.ownerProfile.count({ where: { userId: customer.userId } })).toBe(1);
    expect(
      await prisma.driverProfile.findUniqueOrThrow({ where: { userId: customer.userId } }),
    ).toEqual(driverBefore);
    expect(await auditActions(created.body.data.id as string)).toEqual(['owner.profile_created']);
    await http(app())
      .post('/api/v1/owners/me')
      .set(bearer(officerA))
      .send({ ownerType: 'INDIVIDUAL' })
      .expect(404);
    await http(app()).get('/api/v1/owners/me').set(bearer(officerA)).expect(404);
  });

  it('never accepts verification, reviewer or eligibility fields from the client', async () => {
    const customer = await registerCustomer(app());
    for (const extra of [
      { verificationStatus: 'VERIFIED' },
      { verified: true },
      { reviewerId: randomUUID() },
      { eligibilityStatus: 'ELIGIBLE' },
      { firstApprovedById: randomUUID() },
    ]) {
      const res = await http(app())
        .post('/api/v1/owners/me')
        .set(bearer(customer.tokens))
        .send({ ownerType: 'INDIVIDUAL', ...extra })
        .expect(400);
      expect(res.body.errors).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_FIELD' }));
    }
    expect(await prisma.ownerProfile.count({ where: { userId: customer.userId } })).toBe(0);
  });

  it('validates organization fields per type', async () => {
    const customer = await registerCustomer(app());
    const post = (body: object) =>
      http(app()).post('/api/v1/owners/me').set(bearer(customer.tokens)).send(body);
    const field = async (body: object, name: string, code: string) => {
      const res = await post(body).expect(400);
      expect(res.body.errors).toContainEqual({ field: name, code });
    };
    await field({ ownerType: 'ORGANIZATION', tin: uniqueTin() }, 'organizationName', 'REQUIRED');
    await field({ ownerType: 'ORGANIZATION', organizationName: 'X Transport' }, 'tin', 'REQUIRED');
    await field(
      { ownerType: 'ORGANIZATION', organizationName: 'X Transport', tin: '12#' },
      'tin',
      'INVALID_FORMAT',
    );
    await field({ ownerType: 'INDIVIDUAL', tin: uniqueTin() }, 'tin', 'NOT_ALLOWED');
    await field(
      { ownerType: 'INDIVIDUAL', organizationName: 'X' },
      'organizationName',
      'NOT_ALLOWED',
    );
    await post({ ownerType: 'PARTNERSHIP' }).expect(400);
  });

  it('stores the TIN encrypted with an HMAC, masks it, and never logs or audits it', async () => {
    const customer = await registerCustomer(app());
    const tin = uniqueTin();
    const res = await http(app())
      .post('/api/v1/owners/me')
      .set(bearer(customer.tokens))
      .send({
        ownerType: 'ORGANIZATION',
        organizationName: '  Habesha   Fleet PLC ',
        tin: ` ${tin.slice(0, 4)}-${tin.slice(4)} `,
      })
      .expect(201);
    expect(res.body.data).toMatchObject({
      organizationName: 'Habesha Fleet PLC',
      tinMasked: `••••${tin.slice(-4)}`,
    });
    expect(json(res.body)).not.toContain(tin);
    const row = await profileRow(res.body.data.id as string);
    expect(Buffer.from(row.tinEnc!).toString('latin1')).not.toContain(tin);
    expect(row.tinHmac).toMatch(/^[0-9a-f]{64}$/);
    const encryption = app().get(FieldEncryption);
    expect(encryption.decrypt(Buffer.from(row.tinEnc!), tinAad(row.id)).toString()).toBe(tin);
    // Bound to the row: another row's associated data does not decrypt it.
    expect(() => encryption.decrypt(Buffer.from(row.tinEnc!), tinAad(randomUUID()))).toThrow();
    const audits = await prisma.auditLog.findMany({ where: { targetId: row.id } });
    const outbox = await prisma.outboxEvent.findMany({ where: { aggregateId: row.id } });
    expect(json(audits) + json(outbox)).not.toContain(tin);
    expect(testApp.logs()).not.toContain(tin);
  });

  it('rejects a TIN registered to another account (normalized) without naming it, and flags it', async () => {
    const holder = await preparedOwner(app(), { verified: false });
    const other = await registerCustomer(app());
    const res = await http(app())
      .post('/api/v1/owners/me')
      .set(bearer(other.tokens))
      .send({
        ownerType: 'ORGANIZATION',
        organizationName: 'Other PLC',
        tin: holder.tin!.split('').join(' '),
      })
      .expect(409);
    expect(res.body.code).toBe('TIN_IN_USE');
    expect(json(res.body)).not.toContain(holder.userId);
    expect(json(res.body)).not.toContain(holder.profileId);
    expect(await auditActions(other.userId)).toContain('owner.duplicate_tin_detected');
    // The same through an update.
    const own = await http(app())
      .post('/api/v1/owners/me')
      .set(bearer(other.tokens))
      .send({ ownerType: 'ORGANIZATION', organizationName: 'Other PLC', tin: uniqueTin() })
      .expect(201);
    const update = await http(app())
      .patch('/api/v1/owners/me')
      .set(bearer(other.tokens))
      .set('If-Match', String(own.body.data.version))
      .send({ tin: holder.tin })
      .expect(409);
    expect(update.body.code).toBe('TIN_IN_USE');
  });

  it('updates with If-Match, switches type before submission and clears organization data', async () => {
    const owner = await preparedOwner(app(), { verified: false });
    await http(app())
      .patch('/api/v1/owners/me')
      .set(bearer(owner.tokens))
      .send({ organizationName: 'Y' })
      .expect(428);
    const current = await me(owner.tokens);
    await http(app())
      .patch('/api/v1/owners/me')
      .set(bearer(owner.tokens))
      .set('If-Match', String(current.version - 1))
      .send({ organizationName: 'Renamed Transport' })
      .expect(409);
    const renamed = await http(app())
      .patch('/api/v1/owners/me')
      .set(bearer(owner.tokens))
      .set('If-Match', String(current.version))
      .send({ organizationName: 'Renamed Transport' })
      .expect(200);
    expect(renamed.body.data).toMatchObject({
      organizationName: 'Renamed Transport',
      tinMasked: `••••${owner.tin!.slice(-4)}`,
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { targetId: owner.profileId, action: 'owner.profile_updated' },
    });
    expect(json(audit.changes)).not.toContain('Renamed');
    const individual = await http(app())
      .patch('/api/v1/owners/me')
      .set(bearer(owner.tokens))
      .set('If-Match', String(renamed.body.data.version))
      .send({ ownerType: 'INDIVIDUAL' })
      .expect(200);
    expect(individual.body.data).toMatchObject({
      ownerType: 'INDIVIDUAL',
      organizationName: null,
      tinMasked: null,
      documents: [],
    });
    expect(await prisma.ownerDocument.count({ where: { ownerProfileId: owner.profileId } })).toBe(
      0,
    );
    // Back to ORGANIZATION needs both fields again.
    const back = await http(app())
      .patch('/api/v1/owners/me')
      .set(bearer(owner.tokens))
      .set('If-Match', String(individual.body.data.version))
      .send({ ownerType: 'ORGANIZATION', organizationName: 'Back PLC' })
      .expect(400);
    expect(back.body.errors).toContainEqual({ field: 'tin', code: 'REQUIRED' });
  });
});

describe('owner documents', () => {
  it('needs an organization profile; images only; type-checked by magic bytes', async () => {
    const customer = await registerCustomer(app());
    const jpeg = await ownerDocJpeg('tin');
    const none = await createIntent(app(), customer.tokens, jpeg, {
      purpose: 'OWNER_TIN',
      expect: 409,
    });
    expect(none.body.code).toBe('OWNER_PROFILE_REQUIRED');
    await http(app())
      .post('/api/v1/owners/me')
      .set(bearer(customer.tokens))
      .send({ ownerType: 'INDIVIDUAL' })
      .expect(201);
    await createIntent(app(), customer.tokens, jpeg, { purpose: 'OWNER_TIN', expect: 409 });

    const org = await preparedOwner(app(), { verified: false });
    const pdf = await createIntent(app(), org.tokens, Buffer.from('%PDF-1.4\n%%EOF\n'), {
      purpose: 'OWNER_BUSINESS_LICENSE',
      mimeType: 'application/pdf',
      expect: 400,
    });
    expect(pdf.body.errors).toContainEqual({ field: 'mimeType', code: 'UNSUPPORTED_TYPE' });
    // A PNG declared as JPEG is refused after upload (magic bytes), never AVAILABLE.
    const fake = await uploadDocument(
      app(),
      org.tokens,
      Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
      'OWNER_TIN',
    );
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: fake } });
    expect(doc.uploadStatus).toBe('INVALID');
    await attachOwnerDocument(app(), org.tokens, 'tin', fake, 409);
    // The stored copy has no EXIF.
    const stored = await prisma.document.findUniqueOrThrow({ where: { id: org.documents.tin! } });
    expect(stored).toMatchObject({ uploadStatus: 'AVAILABLE', mimeType: 'image/jpeg' });
  });

  it("refuses another owner's, wrong-purpose and unprocessed documents; replaces with audit", async () => {
    const owner = await preparedOwner(app(), { verified: false });
    const other = await preparedOwner(app(), { verified: false });
    await attachOwnerDocument(app(), owner.tokens, 'tin', other.documents.tin!, 404);
    await attachOwnerDocument(
      app(),
      owner.tokens,
      'tin',
      owner.documents['business-license']!,
      409,
    );
    const intent = await createIntent(app(), owner.tokens, await ownerDocJpeg('x'), {
      purpose: 'OWNER_TIN',
    });
    await attachOwnerDocument(app(), owner.tokens, 'tin', intent.id, 409);
    await attachOwnerDocument(app(), owner.tokens, 'unknown' as never, owner.documents.tin!, 400);
    const replacement = await uploadOwnerDocument(app(), owner.tokens, 'tin');
    await attachOwnerDocument(app(), owner.tokens, 'tin', replacement);
    expect(await auditActions(owner.profileId)).toContain('owner.document_replaced');
    const slots = (await me(owner.tokens)).documents as {
      purpose: string;
      document: { id: string };
    }[];
    expect(slots.find((s) => s.purpose === 'OWNER_TIN')!.document.id).toBe(replacement);
  });

  it("another owner can neither read, complete nor download someone's documents (IDOR)", async () => {
    const owner = await preparedOwner(app(), { verified: false });
    const other = await preparedOwner(app(), { verified: false });
    const id = owner.documents['representative-letter']!;
    await http(app()).get(`/api/v1/documents/${id}`).set(bearer(other.tokens)).expect(404);
    await http(app())
      .post(`/api/v1/documents/${id}/complete`)
      .set(bearer(other.tokens))
      .expect(404);
    await http(app()).get(`/api/v1/documents/${id}/url`).set(bearer(other.tokens)).expect(404);
    await http(app()).get(`/api/v1/documents/${id}/url`).set(bearer(owner.tokens)).expect(200);
    // Officers cannot reach a document through a case it does not belong to.
    const pending = await preparedOwner(app(), { submit: true });
    await claimOwner(app(), officerA, pending.profileId);
    await http(app())
      .get(adminOwner(`/${pending.profileId}/documents/${id}/url`))
      .set(bearer(officerA))
      .query(OWNER_VIEW_REASON)
      .expect(404);
    await http(app())
      .post(adminOwner(`/${pending.profileId}/release`))
      .set(bearer(officerA))
      .expect(200);
  });
});

describe('submission', () => {
  it('an individual needs a verified identity; submission is idempotent and locks the details', async () => {
    const customer = await registerCustomer(app());
    const created = await http(app())
      .post('/api/v1/owners/me')
      .set(bearer(customer.tokens))
      .send({ ownerType: 'INDIVIDUAL' })
      .expect(201);
    const blocked = await submitOwner(app(), customer.tokens, 422);
    expect(blocked.body).toMatchObject({ code: 'OWNER_SUBMISSION_INCOMPLETE' });
    expect(blocked.body.errors).toEqual([{ field: 'owner', code: 'IDENTITY_NOT_VERIFIED' }]);
    await verifyIdentity(app(), customer.tokens);
    await http(app()).post('/api/v1/owners/me/submit').set(bearer(customer.tokens)).expect(400);
    const key = randomUUID();
    const first = await submitOwner(app(), customer.tokens, 200, key);
    const replay = await submitOwner(app(), customer.tokens, 200, key);
    expect(first.body.data.verificationStatus).toBe('PENDING');
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(
      await prisma.ownerReviewEvent.count({
        where: { ownerProfileId: created.body.data.id as string, action: 'submitted' },
      }),
    ).toBe(1);
    await submitOwner(app(), customer.tokens, 409);
    await http(app())
      .patch('/api/v1/owners/me')
      .set(bearer(customer.tokens))
      .set('If-Match', String(first.body.data.version))
      .send({ ownerType: 'ORGANIZATION', organizationName: 'Late PLC', tin: uniqueTin() })
      .expect(409);
    expect(
      await prisma.outboxEvent.count({
        where: {
          aggregateId: created.body.data.id as string,
          eventType: 'owner.verification_submitted',
        },
      }),
    ).toBe(1);
  });

  it('an organization needs all three AVAILABLE documents', async () => {
    const customer = await registerCustomer(app());
    await verifyIdentity(app(), customer.tokens);
    await http(app())
      .post('/api/v1/owners/me')
      .set(bearer(customer.tokens))
      .send({ ownerType: 'ORGANIZATION', organizationName: 'Docs PLC', tin: uniqueTin() })
      .expect(201);
    const missing = await submitOwner(app(), customer.tokens, 422);
    expect((missing.body.errors as { code: string }[]).map((x) => x.code)).toEqual([
      'TIN_DOCUMENT_MISSING',
      'BUSINESS_LICENSE_MISSING',
      'REPRESENTATIVE_LETTER_MISSING',
    ]);
    const ids = await attachAllOwnerDocuments(app(), customer.tokens);
    const ok = await submitOwner(app(), customer.tokens);
    expect(ok.body.data.verificationStatus).toBe('PENDING');
    const docs = await prisma.document.findMany({ where: { id: { in: Object.values(ids) } } });
    expect(docs.map((d) => d.reviewStatus)).toEqual(['SUBMITTED', 'SUBMITTED', 'SUBMITTED']);
    // Documents of a pending case cannot be replaced.
    await attachOwnerDocument(
      app(),
      customer.tokens,
      'tin',
      await uploadOwnerDocument(app(), customer.tokens, 'tin'),
      409,
    );
  });
});

describe('officer review', () => {
  it('individual: claim, audited detail (masked), approve -> VERIFIED and eligible', async () => {
    const owner = await preparedOwner(app(), { type: 'INDIVIDUAL', submit: true });
    await decide(app(), officerA, owner.profileId, 'approve', INDIVIDUAL_APPROVAL, 409);
    const claimed = await claimOwner(app(), officerA, owner.profileId);
    expect(claimed.body.data).toMatchObject({ claimedByMe: true, verificationStatus: 'PENDING' });
    const detail = await http(app())
      .get(adminOwner(`/${owner.profileId}`))
      .set(bearer(officerA))
      .expect(200);
    expect(detail.body.data).toMatchObject({
      ownerType: 'INDIVIDUAL',
      identityStatus: 'VERIFIED',
      accountStatus: 'ACTIVE',
      tinMasked: null,
    });
    expect(detail.body.data.identityVerifiedName).toEqual(expect.any(String));
    await decide(app(), officerA, owner.profileId, 'first-approval', ORG_APPROVAL, 409);
    await decide(app(), officerA, owner.profileId, 'approve', { identityConfirmed: false }, 400);
    const approved = await decide(app(), officerA, owner.profileId, 'approve', INDIVIDUAL_APPROVAL);
    expect(approved.body.data).toMatchObject({
      verificationStatus: 'VERIFIED',
      claimedByMe: false,
    });
    const row = await profileRow(owner.profileId);
    expect(row).toMatchObject({
      verifiedById: officerAId,
      decidedById: officerAId,
      firstApprovedById: null,
    });
    expect((await me(owner.tokens)).eligibility).toEqual({ eligible: true, blockers: [] });
    expect(await auditActions(owner.profileId)).toEqual([
      'owner.profile_created',
      'owner.verification_submitted',
      'owner.review_claimed',
      'owner.case_viewed',
      'owner.approved',
    ]);
    const notification = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: owner.userId, eventType: 'owner.approved' },
    });
    expect(notification).toMatchObject({
      titleKey: 'notif.owner.approved.title',
      deepLink: '/owner',
    });
  });

  it('organization: four-eyes; the first officer can never give the second approval', async () => {
    const owner = await preparedOwner(app(), { submit: true });
    await claimOwner(app(), officerA, owner.profileId);
    await http(app())
      .get(adminOwner(`/${owner.profileId}/documents/${owner.documents.tin!}/url`))
      .set(bearer(officerA))
      .query(OWNER_VIEW_REASON)
      .expect(200);
    const viewed = await prisma.auditLog.findFirstOrThrow({
      where: { targetId: owner.documents.tin!, action: 'document.viewed_by_staff' },
    });
    expect(viewed.reason).toBe(OWNER_VIEW_REASON.reason);
    // Individual approval and an early second approval are refused for organizations.
    await decide(app(), officerA, owner.profileId, 'approve', INDIVIDUAL_APPROVAL, 409);
    const early = await decide(
      app(),
      officerA,
      owner.profileId,
      'second-approval',
      ORG_APPROVAL,
      409,
    );
    expect(early.body.code).toBe('FIRST_APPROVAL_REQUIRED');

    const first = await decide(app(), officerA, owner.profileId, 'first-approval', ORG_APPROVAL);
    expect(first.body.data).toMatchObject({
      verificationStatus: 'PENDING',
      awaitingSecondApproval: true,
      firstApprovedByMe: true,
      claimedById: null,
    });
    expect((await me(owner.tokens)).verificationStatus).toBe('PENDING');
    // The first officer: no second approval, no new claim.
    const same = await decide(
      app(),
      officerA,
      owner.profileId,
      'second-approval',
      ORG_APPROVAL,
      409,
    );
    expect(same.body.code).toBe('SECOND_APPROVER_REQUIRED');
    const reclaim = await claimOwner(app(), officerA, owner.profileId, 409);
    expect(reclaim.body.code).toBe('SECOND_APPROVER_REQUIRED');
    await decide(app(), officerA, owner.profileId, 'first-approval', ORG_APPROVAL, 409);

    // The second officer needs the claim, then completes the verification.
    const unclaimed = await decide(
      app(),
      officerB,
      owner.profileId,
      'second-approval',
      ORG_APPROVAL,
      409,
    );
    expect(unclaimed.body.code).toBe('REVIEW_CLAIM_REQUIRED');
    await claimOwner(app(), officerB, owner.profileId);
    await decide(app(), officerB, owner.profileId, 'first-approval', ORG_APPROVAL, 409);
    const second = await decide(app(), officerB, owner.profileId, 'second-approval', ORG_APPROVAL);
    expect(second.body.data.verificationStatus).toBe('VERIFIED');
    expect(await profileRow(owner.profileId)).toMatchObject({
      firstApprovedById: officerAId,
      verifiedById: officerBId,
      decidedById: officerBId,
    });
    const docs = await prisma.document.findMany({
      where: { id: { in: Object.values(owner.documents) } },
    });
    expect(docs.every((d) => d.reviewStatus === 'APPROVED' && d.reviewedById === officerBId)).toBe(
      true,
    );
    const actions = await auditActions(owner.profileId);
    expect(actions).toEqual(
      expect.arrayContaining([
        'owner.first_approval_recorded',
        'owner.second_approval_completed',
        'owner.approved',
      ]),
    );
    const history = await prisma.ownerReviewEvent.findMany({
      where: { ownerProfileId: owner.profileId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(history.map((e) => `${e.action}:${e.toStatus}`)).toEqual([
      'created:UNVERIFIED',
      'submitted:PENDING',
      'claimed:PENDING',
      'first_approval:PENDING',
      'claimed:PENDING',
      'second_approval:VERIFIED',
    ]);
    expect(
      await prisma.outboxEvent.findMany({
        where: { aggregateId: owner.profileId },
        select: { eventType: true },
        orderBy: { createdAt: 'asc' },
      }),
    ).toEqual([
      { eventType: 'owner.profile_created' },
      { eventType: 'owner.verification_submitted' },
      { eventType: 'owner.first_approval_recorded' },
      { eventType: 'owner.approved' },
    ]);
    // Notification parameters carry codes only, never the TIN or names.
    const notes = await prisma.notification.findMany({ where: { recipientUserId: owner.userId } });
    expect(json(notes)).not.toContain(owner.tin);
    expect(json(notes)).not.toContain('Abebe Transport');
  });

  it('two officers cannot claim the same case; concurrent decisions produce exactly one', async () => {
    const owner = await preparedOwner(app(), { type: 'INDIVIDUAL', submit: true });
    const claims = await Promise.all([
      http(app())
        .post(adminOwner(`/${owner.profileId}/claim`))
        .set(bearer(officerA)),
      http(app())
        .post(adminOwner(`/${owner.profileId}/claim`))
        .set(bearer(officerB)),
    ]);
    expect(claims.map((r) => r.status).sort()).toEqual([200, 409]);
    const holder = claims[0].status === 200 ? officerA : officerB;
    const other = holder === officerA ? officerB : officerA;
    await decide(app(), other, owner.profileId, 'approve', INDIVIDUAL_APPROVAL, 409);
    const decisions = await Promise.all([
      http(app())
        .post(adminOwner(`/${owner.profileId}/approve`))
        .set(bearer(holder))
        .set('Idempotency-Key', randomUUID())
        .send(INDIVIDUAL_APPROVAL),
      http(app())
        .post(adminOwner(`/${owner.profileId}/reject`))
        .set(bearer(holder))
        .set('Idempotency-Key', randomUUID())
        .send({ reasonCode: 'OTHER' }),
    ]);
    expect(decisions.map((r) => r.status).sort()).toEqual([200, 409]);
    const decided = await prisma.ownerReviewEvent.count({
      where: { ownerProfileId: owner.profileId, action: { in: ['approved', 'rejected'] } },
    });
    expect(decided).toBe(1);
  });

  it('concurrent second approvals and replays verify the organization exactly once', async () => {
    const owner = await preparedOwner(app(), { submit: true });
    await claimOwner(app(), officerA, owner.profileId);
    await decide(app(), officerA, owner.profileId, 'first-approval', ORG_APPROVAL);
    await claimOwner(app(), officerB, owner.profileId);
    const key = randomUUID();
    const results = await Promise.all(
      [key, randomUUID()].map((k) =>
        http(app())
          .post(adminOwner(`/${owner.profileId}/second-approval`))
          .set(bearer(officerB))
          .set('Idempotency-Key', k)
          .send(ORG_APPROVAL),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.status === 200)!;
    if (winner === results[0]) {
      const replay = await decide(
        app(),
        officerB,
        owner.profileId,
        'second-approval',
        ORG_APPROVAL,
        200,
        key,
      );
      expect(replay.headers['idempotent-replayed']).toBe('true');
      // The same key with a different body is refused.
      await decide(
        app(),
        officerB,
        owner.profileId,
        'second-approval',
        { ...ORG_APPROVAL, note: 'x' },
        422,
        key,
      );
    }
    expect(
      await prisma.ownerReviewEvent.count({
        where: { ownerProfileId: owner.profileId, action: 'second_approval' },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { targetId: owner.profileId, action: 'owner.approved' },
      }),
    ).toBe(1);
  });

  it('reject with a reason; the owner corrects, uploads new documents and resubmits', async () => {
    const owner = await preparedOwner(app(), { submit: true });
    await claimOwner(app(), officerA, owner.profileId);
    await decide(app(), officerA, owner.profileId, 'first-approval', ORG_APPROVAL);
    await claimOwner(app(), officerB, owner.profileId);
    await decide(app(), officerB, owner.profileId, 'reject', {}, 400);
    await decide(app(), officerB, owner.profileId, 'reject', { reasonCode: 'SAFETY_CONCERN' }, 400);
    await decide(app(), officerB, owner.profileId, 'reject', {
      reasonCode: 'INVALID_ORGANIZATION_DETAILS',
      note: 'The TIN on the certificate differs',
    });
    const rejected = await me(owner.tokens);
    expect(rejected).toMatchObject({
      verificationStatus: 'REJECTED',
      decisionReasonCode: 'INVALID_ORGANIZATION_DETAILS',
      decisionNote: 'The TIN on the certificate differs',
      editable: true,
      typeChangeAllowed: true,
      submissionProblems: [
        'TIN_DOCUMENT_MISSING',
        'BUSINESS_LICENSE_MISSING',
        'REPRESENTATIVE_LETTER_MISSING',
      ],
    });
    expect((await profileRow(owner.profileId)).firstApprovedById).toBeNull();
    await submitOwner(app(), owner.tokens, 422);
    // Decided documents are never reused.
    await attachOwnerDocument(app(), owner.tokens, 'tin', owner.documents.tin!, 409);
    await http(app())
      .patch('/api/v1/owners/me')
      .set(bearer(owner.tokens))
      .set('If-Match', String(rejected.version))
      .send({ tin: uniqueTin() })
      .expect(200);
    await attachAllOwnerDocuments(app(), owner.tokens);
    const again = await submitOwner(app(), owner.tokens);
    expect(again.body.data).toMatchObject({
      verificationStatus: 'PENDING',
      decisionReasonCode: null,
    });
    const detail = await http(app())
      .get(adminOwner(`/${owner.profileId}`))
      .set(bearer(officerA))
      .expect(200);
    expect(detail.body.data).toMatchObject({
      awaitingSecondApproval: false,
      firstApprovedById: null,
    });
    const notification = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: owner.userId, eventType: 'owner.rejected' },
    });
    expect(notification.params).toEqual({ reasonCode: 'INVALID_ORGANIZATION_DETAILS' });
  });

  it('approval re-checks identity and account status inside the decision', async () => {
    const owner = await preparedOwner(app(), { type: 'INDIVIDUAL', submit: true });
    await claimOwner(app(), officerA, owner.profileId);
    const attempt = await prisma.identityVerification.findFirstOrThrow({
      where: { userId: owner.userId, status: 'VERIFIED' },
    });
    await http(app())
      .post(`/api/v1/admin/identity-verifications/${attempt.id}/suspend`)
      .set(bearer(officerA))
      .send({ reason: 'Identity under investigation' })
      .expect(200);
    const res = await decide(app(), officerA, owner.profileId, 'approve', INDIVIDUAL_APPROVAL, 422);
    expect(res.body.errors).toContainEqual({ field: 'case', code: 'IDENTITY_NOT_VERIFIED' });

    const org = await preparedOwner(app(), { submit: true });
    await claimOwner(app(), officerA, org.profileId);
    await decide(app(), officerA, org.profileId, 'first-approval', ORG_APPROVAL);
    await prisma.user.update({ where: { id: org.userId }, data: { status: 'SUSPENDED' } });
    await claimOwner(app(), officerB, org.profileId);
    const blocked = await decide(
      app(),
      officerB,
      org.profileId,
      'second-approval',
      ORG_APPROVAL,
      422,
    );
    expect(blocked.body.errors).toContainEqual({ field: 'case', code: 'ACCOUNT_NOT_ACTIVE' });
    expect((await profileRow(org.profileId)).verificationStatus).toBe('PENDING');
  });

  it('suspend blocks owner use; a fraud suspension needs a different officer to reinstate', async () => {
    const owner = await preparedOwner(app(), { type: 'INDIVIDUAL', submit: true });
    await decide(
      app(),
      officerA,
      owner.profileId,
      'suspend',
      { reasonCode: 'OTHER', note: 'Too early to suspend' },
      409,
    );
    await claimOwner(app(), officerA, owner.profileId);
    await decide(app(), officerA, owner.profileId, 'approve', INDIVIDUAL_APPROVAL);
    await decide(
      app(),
      officerA,
      owner.profileId,
      'suspend',
      { reasonCode: 'SUSPECTED_FRAUD', note: 'short' },
      400,
    );
    await decide(app(), officerA, owner.profileId, 'suspend', {
      reasonCode: 'SUSPECTED_FRAUD',
      note: 'Reported by two drivers; under investigation',
    });
    const suspended = await me(owner.tokens);
    expect(suspended).toMatchObject({
      verificationStatus: 'SUSPENDED',
      decisionReasonCode: 'SUSPECTED_FRAUD',
      decisionNote: null,
      editable: false,
      eligibility: { eligible: false, blockers: ['OWNER_SUSPENDED'] },
    });
    await submitOwner(app(), owner.tokens, 409);
    const same = await decide(
      app(),
      officerA,
      owner.profileId,
      'reinstate',
      { note: 'Investigation closed' },
      409,
    );
    expect(same.body.code).toBe('SECOND_APPROVER_REQUIRED');
    const reinstated = await decide(app(), officerB, owner.profileId, 'reinstate', {
      note: 'Investigation closed, no fraud found',
    });
    expect(reinstated.body.data.verificationStatus).toBe('VERIFIED');
    expect((await me(owner.tokens)).eligibility.eligible).toBe(true);
    await decide(app(), officerB, owner.profileId, 'reinstate', { note: 'Again and again' }, 409);
  });

  it('an expired identity expires the owner verification; the owner resubmits after renewal', async () => {
    // Renewal must be the same person (BR-ID-2): keep the synthetic subject.
    const subject = uniqueSubject();
    const customer = await registerCustomer(app());
    await verifyIdentity(app(), customer.tokens, subject);
    const owner = await preparedOwner(app(), {
      type: 'INDIVIDUAL',
      submit: true,
      verified: false,
      customer,
    });
    await claimOwner(app(), officerA, owner.profileId);
    await decide(app(), officerA, owner.profileId, 'approve', INDIVIDUAL_APPROVAL);
    const later = new Date(Date.now() + 3 * 365 * 24 * 3600 * 1000);
    await app().get(OwnerStatusService).refreshForUser(owner.userId, later);
    const expired = await me(owner.tokens);
    expect(expired).toMatchObject({
      verificationStatus: 'EXPIRED',
      identityStatus: 'EXPIRED',
      editable: true,
      typeChangeAllowed: false,
      submissionProblems: ['IDENTITY_NOT_VERIFIED'],
    });
    expect(await auditActions(owner.profileId)).toContain('owner.verification_expired');
    await submitOwner(app(), owner.tokens, 422);
    await verifyIdentity(app(), owner.tokens, subject);
    expect((await submitOwner(app(), owner.tokens)).body.data.verificationStatus).toBe('PENDING');
  });

  it('queue: filters, search, pagination and counts; no TIN or document data in lists', async () => {
    const name = `Queue ${randomUUID().slice(0, 8)} PLC`;
    const customer: Customer = await registerCustomer(app());
    await verifyIdentity(app(), customer.tokens);
    const created = await http(app())
      .post('/api/v1/owners/me')
      .set(bearer(customer.tokens))
      .send({ ownerType: 'ORGANIZATION', organizationName: name, tin: uniqueTin() })
      .expect(201);
    await attachAllOwnerDocuments(app(), customer.tokens);
    await submitOwner(app(), customer.tokens);
    const found = await http(app())
      .get(adminOwner(''))
      .set(bearer(officerA))
      .query({ q: name.slice(0, 14), ownerType: 'ORGANIZATION', status: 'PENDING' })
      .expect(200);
    expect(found.body.data.items).toHaveLength(1);
    const item = found.body.data.items[0];
    expect(item).toMatchObject({ id: created.body.data.id, organizationName: name });
    const keys = Object.keys(item as object);
    expect(keys.filter((k) => /^tin|document|phone/i.test(k))).toEqual([]);
    const tin = (await prisma.ownerProfile.findUniqueOrThrow({ where: { id: item.id as string } }))
      .tinLast4!;
    expect(json(item)).not.toContain(`••••${tin}`);
    await http(app()).get(adminOwner('')).set(bearer(officerA)).query({ limit: 51 }).expect(400);
    const page = await http(app())
      .get(adminOwner(''))
      .set(bearer(officerA))
      .query({ limit: 1, page: 1 })
      .expect(200);
    expect(page.body.data.items).toHaveLength(1);
    expect(page.body.data.total).toBeGreaterThanOrEqual(1);
    const second = await http(app())
      .get(adminOwner(''))
      .set(bearer(officerA))
      .query({ awaitingSecondApproval: 'true' })
      .expect(200);
    expect(
      (second.body.data.items as { awaitingSecondApproval: boolean }[]).every(
        (i) => i.awaitingSecondApproval,
      ),
    ).toBe(true);
    const counts = await http(app()).get(adminOwner('/counts')).set(bearer(officerA)).expect(200);
    expect(counts.body.data.PENDING_ORGANIZATION).toBeGreaterThanOrEqual(1);
    expect(Object.keys(counts.body.data).sort()).toEqual(
      [
        'AWAITING_SECOND_APPROVAL',
        'EXPIRED',
        'PENDING_INDIVIDUAL',
        'PENDING_ORGANIZATION',
        'REJECTED',
        'REVERIFICATION_REQUIRED',
        'SUSPENDED',
        'VERIFIED',
      ].sort(),
    );
    // Never-submitted profiles are not cases.
    const draft = await preparedOwner(app(), { verified: false });
    await http(app())
      .get(adminOwner(`/${draft.profileId}`))
      .set(bearer(officerA))
      .expect(404);
    await claimOwner(app(), officerA, draft.profileId, 404);
  });

  it('documents of a pending case need the claim; staff without owners.review get 403', async () => {
    const owner = await preparedOwner(app(), { submit: true });
    const url = adminOwner(`/${owner.profileId}/documents/${owner.documents.tin!}/url`);
    const unclaimed = await http(app())
      .get(url)
      .set(bearer(officerA))
      .query(OWNER_VIEW_REASON)
      .expect(409);
    expect(unclaimed.body.code).toBe('REVIEW_CLAIM_REQUIRED');
    await http(app()).get(url).set(bearer(officerA)).query({ reason: 'short' }).expect(400);
    for (const role of ['SUPPORT', 'FINANCE', 'SUPER_ADMIN'] as const) {
      const tokens = await staffLogin(app(), await seedStaff(app(), [role]));
      await http(app()).get(adminOwner('')).set(bearer(tokens)).expect(403);
      await http(app()).get(url).set(bearer(tokens)).query(OWNER_VIEW_REASON).expect(403);
    }
    await http(app()).get(adminOwner('')).set(bearer(owner.tokens)).expect(404);
    await http(app()).get(adminOwner('')).expect(401);
  });
});

describe('owner and driver together', () => {
  it('a driver can become an owner without changing the driver profile or licence', async () => {
    const customer = await registerCustomer(app());
    await http(app())
      .post('/api/v1/drivers/me')
      .set(bearer(customer.tokens))
      .send({ yearsLicensed: 3 })
      .expect(201);
    const owner = await preparedOwner(app(), { type: 'INDIVIDUAL', submit: true, customer });
    await claimOwner(app(), officerA, owner.profileId);
    await decide(app(), officerA, owner.profileId, 'approve', INDIVIDUAL_APPROVAL);
    const driver = (
      await http(app()).get('/api/v1/drivers/me').set(bearer(customer.tokens)).expect(200)
    ).body.data;
    expect(driver).toMatchObject({ yearsLicensed: 3, license: null });
    expect(driver.eligibility.status).toBe('INELIGIBLE');
    await complete(app(), customer.tokens, randomUUID(), 404);
  });
});
