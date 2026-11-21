/* eslint-disable @typescript-eslint/no-unsafe-call -- loose JSON bodies in tests */
import { randomUUID } from 'node:crypto';
import { FieldEncryption } from '../../src/common/crypto/field-encryption.js';
import { SecretHasher } from '../../src/common/crypto/secret-hasher.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { VehicleStatusService } from '../../src/modules/vehicles/vehicle-status.service.js';
import { engineNumberAad, vinAad } from '../../src/modules/vehicles/vehicles.service.js';
import {
  bearer,
  flushRateLimits,
  http,
  registerCustomer,
  seedStaff,
  staffLogin,
  type Tokens,
} from '../helpers/auth-helpers.js';
import { licenseJpeg, uploadDocument } from '../helpers/document-helpers.js';
import { preparedOwner } from '../helpers/owner-helpers.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import {
  adminVehicle,
  approveVehicle,
  attachEvidence,
  bodyOf,
  claimVehicle,
  createVehicle,
  dateIn,
  decideVehicle,
  preparedVehicle,
  submitVehicle,
  uniquePlate,
  uniqueVin,
  uploadEvidence,
  vehicleBody,
  VEHICLE_APPROVAL,
  VEHICLE_VIEW_REASON,
  verifiedOwner,
} from '../helpers/vehicle-helpers.js';

let testApp: TestApp;
let prisma: PrismaService;
let officerA: Tokens;
let officerAId: string;
let officerB: Tokens;

beforeAll(async () => {
  testApp = await createTestApp();
  prisma = testApp.app.get(PrismaService);
  await flushRateLimits();
  const a = await seedStaff(testApp.app, ['VERIFICATION_OFFICER']);
  const b = await seedStaff(testApp.app, ['VERIFICATION_OFFICER']);
  officerAId = a.userId;
  officerA = await staffLogin(testApp.app, a);
  officerB = await staffLogin(testApp.app, b);
});
afterAll(async () => {
  await testApp.close();
});
beforeEach(flushRateLimits);

const app = () => testApp.app;
const owned = (owner: { tokens: Tokens }) => bearer(owner.tokens);
const row = (id: string) => prisma.vehicle.findUniqueOrThrow({ where: { id } });
const json = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

/** Test-only: changes rows that triggers freeze (time passing, a scanner finding later). */
async function bypassTriggers(
  work: (tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0]) => Promise<unknown>,
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await work(tx);
  });
}
async function view(owner: { tokens: Tokens }, id: string, expect = 200) {
  return http(app()).get(`/api/v1/vehicles/${id}`).set(owned(owner)).expect(expect);
}
async function audits(targetId: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({ where: { targetId }, orderBy: { seq: 'asc' } });
  return rows.map((r) => r.action);
}
async function patch(
  owner: { tokens: Tokens },
  id: string,
  version: number,
  body: object,
  expect = 200,
) {
  return http(app())
    .patch(`/api/v1/vehicles/${id}`)
    .set(owned(owner))
    .set('If-Match', String(version))
    .send(body)
    .expect(expect);
}

describe('registration prerequisites', () => {
  it('needs an owner profile that is VERIFIED; staff accounts get 404', async () => {
    const customer = await registerCustomer(app());
    const none = await createVehicle(app(), customer.tokens, {}, 409);
    expect(none.body.code).toBe('OWNER_PROFILE_REQUIRED');
    // Reading without a profile is harmless.
    const list = await http(app()).get('/api/v1/vehicles').set(owned(customer)).expect(200);
    expect(list.body.data.items).toEqual([]);

    const unverified = await preparedOwner(app(), { type: 'INDIVIDUAL' });
    expect((await createVehicle(app(), unverified.tokens, {}, 409)).body.code).toBe(
      'OWNER_NOT_VERIFIED',
    );
    const pending = await preparedOwner(app(), { type: 'INDIVIDUAL', submit: true });
    expect((await createVehicle(app(), pending.tokens, {}, 409)).body.code).toBe(
      'OWNER_NOT_VERIFIED',
    );
    expect(await prisma.vehicle.count({ where: { ownerProfileId: pending.profileId } })).toBe(0);

    await http(app())
      .post('/api/v1/vehicles')
      .set(bearer(officerA))
      .send(vehicleBody())
      .expect(404);
    await http(app()).get('/api/v1/vehicles').set(bearer(officerA)).expect(404);
  });

  it('a verified owner registers a draft; owner status and vehicle status stay separate', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const res = await createVehicle(app(), owner.tokens);
    const body = bodyOf(res);
    expect(body).toMatchObject({
      status: 'DRAFT',
      vehicleType: 'SEDAN',
      editable: true,
      eligibility: { eligible: false, blockers: ['VEHICLE_NOT_APPROVED'] },
    });
    expect(body.submissionProblems).toContain('PHOTO_FRONT_MISSING');
    const stored = await row(body.id as string);
    expect(stored.ownerProfileId).toBe(owner.profileId);
    expect(stored.status).toBe('DRAFT');
    // Nothing about the vehicle makes the owner "available" or "listed".
    expect(Object.keys(body)).not.toEqual(expect.arrayContaining(['listed', 'available']));
    expect(await audits(stored.id)).toEqual(['vehicle.created']);
  });

  it('refuses uploads for vehicle purposes to owners who are not verified', async () => {
    const unverified = await preparedOwner(app(), { type: 'INDIVIDUAL' });
    const intent = await http(app())
      .post('/api/v1/documents')
      .set(owned(unverified))
      .send({
        purpose: 'VEHICLE_PHOTO',
        mimeType: 'image/jpeg',
        sizeBytes: 1000,
        sha256: 'a'.repeat(64),
      });
    expect([409, 404]).toContain(intent.status);
    if (intent.status === 409) expect(intent.body.code).toBe('OWNER_NOT_VERIFIED');
    const nobody = await registerCustomer(app());
    const other = await http(app())
      .post('/api/v1/documents')
      .set(bearer(nobody.tokens))
      .send({
        purpose: 'VEHICLE_PHOTO',
        mimeType: 'image/jpeg',
        sizeBytes: 1000,
        sha256: 'a'.repeat(64),
      });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('OWNER_PROFILE_REQUIRED');
  });
});

describe('vehicle details', () => {
  let owner: Awaited<ReturnType<typeof verifiedOwner>>;
  beforeAll(async () => {
    owner = await verifiedOwner(app(), officerA);
  });

  it('validates types, year, seats, text and plates on the server', async () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ vehicleType: 'SPACESHIP' }, 'type'],
      [{ vehicleType: 'sedan' }, 'type case'],
      [{ year: 1979 }, 'year too old'],
      [{ year: new Date().getUTCFullYear() + 2 }, 'year too new'],
      [{ year: 2018.5 }, 'year fraction'],
      [{ year: '2018' }, 'year string'],
      [{ seats: 0 }, 'seats'],
      [{ seats: 61 }, 'seats'],
      [{ transmission: 'CVT' }, 'transmission'],
      [{ make: 'T'.repeat(500) }, 'long make'],
      [{ make: 'Toy\u0000ota' }, 'NUL'],
      [{ make: 'Toy\u200Bota' }, 'zero-width'],
      [{ make: 'Toy\u202Eota' }, 'bidi'],
      [{ model: '<img src=x onerror=alert(1)>' }, 'markup'],
      [{ color: '\n' }, 'control'],
      [{ plateNumber: '' }, 'plate empty'],
      [{ plateNumber: 'X'.repeat(13) }, 'plate long'],
      [{ plateCode: "2'; DROP TABLE vehicles;--" }, 'plate sql'],
      [{ vin: 'abc' }, 'vin short'],
      [{ vin: 'ABC!DEF12345' }, 'vin chars'],
      [{ engineNumber: '!!' }, 'engine'],
    ];
    for (const [overrides, label] of bad) {
      const res = await http(app())
        .post('/api/v1/vehicles')
        .set(owned(owner))
        .send(vehicleBody(overrides));
      expect([label, res.status, res.body.code]).toEqual([label, 400, 'VALIDATION_FAILED']);
    }
    expect(await prisma.vehicle.count({ where: { ownerProfileId: owner.profileId } })).toBe(0);
  });

  it('accepts Amharic text and normalizes spacing', async () => {
    const res = await createVehicle(app(), owner.tokens, { make: '  ቶዮታ  ', model: ' Hi   Ace ' });
    expect(bodyOf(res)).toMatchObject({ make: 'ቶዮታ', model: 'Hi Ace' });
  });

  it('never takes the owner, status or review fields from the client (no ownership transfer)', async () => {
    const other = await verifiedOwner(app(), officerA);
    for (const field of [
      { ownerProfileId: other.profileId },
      { ownerUserId: other.userId },
      { userId: other.userId },
      { status: 'APPROVED' },
      { claimedById: officerAId },
      { decidedById: officerAId },
      { eligible: true },
    ]) {
      await createVehicle(app(), owner.tokens, field, 400);
    }
    const mine = bodyOf(await createVehicle(app(), owner.tokens));
    for (const field of [
      { ownerProfileId: other.profileId },
      { ownerUserId: other.userId },
      { status: 'APPROVED' },
      { version: 99 },
    ]) {
      await patch(owner, mine.id as string, mine.version as number, field, 400);
    }
    expect((await row(mine.id as string)).ownerProfileId).toBe(owner.profileId);
  });

  it('stores the VIN and engine number encrypted, masks them, and never logs or audits them', async () => {
    const vin = uniqueVin();
    const engine = 'ENG12345ABC';
    const res = await createVehicle(app(), owner.tokens, {
      vin: ` ${vin.toLowerCase()} `,
      engineNumber: engine,
    });
    const body = bodyOf(res);
    expect(body.vinMasked).toBe(`••••${vin.slice(-4)}`);
    expect(body.engineNumberOnFile).toBe(true);
    expect(json(res.body)).not.toContain(vin);
    expect(json(res.body)).not.toContain(engine);
    const stored = await row(body.id as string);
    expect(Buffer.from(stored.vinEnc!).toString('latin1')).not.toContain(vin);
    expect(stored.vinHmac).toBe(app().get(SecretHasher).hmacHex('vin', vin));
    expect(stored.vinKey).toBe(stored.vinHmac);
    const crypto = app().get(FieldEncryption);
    expect(crypto.decrypt(Buffer.from(stored.vinEnc!), vinAad(stored.id)).toString()).toBe(vin);
    expect(
      crypto.decrypt(Buffer.from(stored.engineNumberEnc!), engineNumberAad(stored.id)).toString(),
    ).toBe(engine);
    // Bound to the row: another row's associated data does not decrypt it.
    expect(() => crypto.decrypt(Buffer.from(stored.vinEnc!), vinAad(randomUUID()))).toThrow();
    const trail =
      json(await prisma.auditLog.findMany({ where: { targetId: stored.id } })) +
      json(await prisma.outboxEvent.findMany({ where: { aggregateId: stored.id } }));
    expect(trail).not.toContain(vin);
    expect(trail).not.toContain(engine);
    expect(testApp.logs()).not.toContain(vin);
    expect(testApp.logs()).not.toContain(engine);
  });

  it('repeats a create safely, and rejects another account’s plate and VIN without naming it', async () => {
    const other = await verifiedOwner(app(), officerA);
    const first = await createVehicle(app(), owner.tokens);
    const plate = {
      plateRegion: bodyOf(first).plate.region,
      plateCode: bodyOf(first).plate.code,
      plateNumber: bodyOf(first).plate.number,
    };
    // The same request again returns the owner's own draft.
    const again = await http(app())
      .post('/api/v1/vehicles')
      .set(owned(owner))
      .send(vehicleBody(plate))
      .expect(200);
    expect(bodyOf(again).id).toBe(bodyOf(first).id);

    // Another account, plate typed differently (case, separators).
    const clash = await createVehicle(
      app(),
      other.tokens,
      {
        plateRegion: plate.plateRegion.toLowerCase(),
        plateCode: ` ${plate.plateCode} `,
        plateNumber: plate.plateNumber.toLowerCase(),
      },
      409,
    );
    expect(clash.body.code).toBe('PLATE_IN_USE');
    expect(json(clash.body)).not.toContain(owner.userId);
    expect(json(clash.body)).not.toContain(bodyOf(first).id);
    expect(
      await prisma.auditLog.count({
        where: { action: 'vehicle.duplicate_plate_detected', actorUserId: other.userId },
      }),
    ).toBe(1);

    const vin = uniqueVin();
    await createVehicle(app(), owner.tokens, { vin });
    const vinClash = await createVehicle(app(), other.tokens, { vin: vin.toLowerCase() }, 409);
    expect(vinClash.body.code).toBe('VIN_IN_USE');
  });

  it('updates with If-Match; a stale version conflicts; a plate change is re-checked for duplicates', async () => {
    const vehicle = bodyOf(await createVehicle(app(), owner.tokens));
    const id = vehicle.id as string;
    await http(app())
      .patch(`/api/v1/vehicles/${id}`)
      .set(owned(owner))
      .send({ color: 'Red' })
      .expect(428);
    const updated = bodyOf(
      await patch(owner, id, vehicle.version as number, { color: 'Red', seats: 7 }),
    );
    expect(updated).toMatchObject({ color: 'Red', seats: 7 });
    expect(updated.version).toBeGreaterThan(vehicle.version as number);
    const stale = await patch(owner, id, vehicle.version as number, { color: 'Blue' }, 409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');

    const taken = bodyOf(await createVehicle(app(), owner.tokens));
    const clash = await patch(
      owner,
      id,
      updated.version as number,
      {
        plateRegion: taken.plate.region,
        plateCode: taken.plate.code,
        plateNumber: taken.plate.number,
      },
      409,
    );
    expect(clash.body.code).toBe('PLATE_IN_USE');
    const changed = bodyOf(
      await patch(owner, id, updated.version as number, { ...uniquePlate(), vin: uniqueVin() }),
    );
    expect(changed.plate.number).not.toBe(vehicle.plate.number);
    // An empty update is a read.
    await patch(owner, id, changed.version as number, {}, 200);
    // Only field names are audited.
    const updates = await prisma.auditLog.findMany({
      where: { targetId: id, action: 'vehicle.updated' },
    });
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(json(updates)).not.toContain('Red');
  });
});

describe('evidence and cross-owner access', () => {
  let alice: Awaited<ReturnType<typeof verifiedOwner>>;
  let bob: Awaited<ReturnType<typeof verifiedOwner>>;
  let aliceCar: string;
  beforeAll(async () => {
    alice = await verifiedOwner(app(), officerA);
    bob = await verifiedOwner(app(), officerA);
    aliceCar = bodyOf(await createVehicle(app(), alice.tokens)).id as string;
  });

  it('attaches by slot with the matching purpose; replaces; audits photos and documents apart', async () => {
    const photo = await uploadEvidence(app(), alice.tokens, 'PHOTO_FRONT');
    const res = await attachEvidence(app(), alice.tokens, aliceCar, 'PHOTO_FRONT', photo);
    const slot = bodyOf(res).evidence.find((e: { slot: string }) => e.slot === 'PHOTO_FRONT');
    expect(slot.document.id).toBe(photo);
    expect(slot.required).toBe(true);
    const registration = await uploadEvidence(app(), alice.tokens, 'REGISTRATION');
    await attachEvidence(app(), alice.tokens, aliceCar, 'REGISTRATION', registration);
    const replacement = await uploadEvidence(app(), alice.tokens, 'PHOTO_FRONT');
    await attachEvidence(app(), alice.tokens, aliceCar, 'PHOTO_FRONT', replacement);
    const actions = await audits(aliceCar);
    expect(actions).toEqual(
      expect.arrayContaining(['vehicle.photo_attached', 'vehicle.document_attached']),
    );
    const attached = await prisma.auditLog.findMany({
      where: { targetId: aliceCar, action: 'vehicle.photo_attached' },
      orderBy: { seq: 'asc' },
    });
    expect((attached[1]?.changes as { replaced: boolean }).replaced).toBe(true);
  });

  it('refuses unknown slots, wrong purposes and bad expiry dates', async () => {
    const photo = await uploadEvidence(app(), alice.tokens, 'PHOTO_LEFT');
    await http(app())
      .put(`/api/v1/vehicles/${aliceCar}/evidence/ROOF`)
      .set(owned(alice))
      .send({ documentId: photo })
      .expect(400);
    // A photo in a document slot, and a document in a photo slot.
    expect(
      (await attachEvidence(app(), alice.tokens, aliceCar, 'REGISTRATION', photo, 409)).body.code,
    ).toBe('DOCUMENT_NOT_AVAILABLE');
    const insurance = await uploadEvidence(app(), alice.tokens, 'INSURANCE');
    expect(
      (await attachEvidence(app(), alice.tokens, aliceCar, 'PHOTO_LEFT', insurance, 409)).body.code,
    ).toBe('DOCUMENT_NOT_AVAILABLE');
    // A driving licence image is not vehicle evidence.
    await http(app()).post('/api/v1/drivers/me').set(owned(alice)).send({}).expect(201);
    const licence = await uploadDocument(app(), alice.tokens, await licenseJpeg('x'));
    await attachEvidence(app(), alice.tokens, aliceCar, 'PHOTO_LEFT', licence, 409);
    // Insurance needs an end date that is not in the past; photos take none.
    await http(app())
      .put(`/api/v1/vehicles/${aliceCar}/evidence/INSURANCE`)
      .set(owned(alice))
      .send({ documentId: insurance })
      .expect(400);
    await attachEvidence(app(), alice.tokens, aliceCar, 'INSURANCE', insurance, 400, dateIn(-1));
    await attachEvidence(app(), alice.tokens, aliceCar, 'INSURANCE', insurance, 400, '2027-02-30');
    await attachEvidence(
      app(),
      alice.tokens,
      aliceCar,
      'INSURANCE',
      insurance,
      400,
      dateIn(365 * 30),
    );
    await attachEvidence(app(), alice.tokens, aliceCar, 'PHOTO_LEFT', photo, 400, dateIn(10));
    // Insurance ending today is still valid.
    await attachEvidence(app(), alice.tokens, aliceCar, 'INSURANCE', insurance, 200, dateIn(0));
  });

  it('accepts images only for vehicle evidence', async () => {
    for (const purpose of ['VEHICLE_REGISTRATION', 'VEHICLE_PHOTO']) {
      const res = await http(app())
        .post('/api/v1/documents')
        .set(owned(alice))
        .send({ purpose, mimeType: 'application/pdf', sizeBytes: 1000, sha256: 'b'.repeat(64) });
      expect(res.status).toBe(400);
    }
  });

  it('keeps the photo of vehicle A out of vehicle B, whoever owns B', async () => {
    const photo = await uploadEvidence(app(), alice.tokens, 'PHOTO_BACK');
    await attachEvidence(app(), alice.tokens, aliceCar, 'PHOTO_BACK', photo);

    // The same owner's second vehicle.
    const second = bodyOf(await createVehicle(app(), alice.tokens)).id as string;
    const reuse = await attachEvidence(app(), alice.tokens, second, 'PHOTO_BACK', photo, 409);
    expect(reuse.body.code).toBe('DOCUMENT_NOT_AVAILABLE');
    // The same vehicle, a different slot.
    expect(
      (await attachEvidence(app(), alice.tokens, aliceCar, 'PHOTO_RIGHT', photo, 409)).body.code,
    ).toBe('DOCUMENT_NOT_AVAILABLE');
    // Another owner's vehicle: the document is simply not theirs.
    const bobCar = bodyOf(await createVehicle(app(), bob.tokens)).id as string;
    await attachEvidence(app(), bob.tokens, bobCar, 'PHOTO_BACK', photo, 404);
    expect(
      (await prisma.vehicleDocument.findMany({ where: { documentId: photo } })).map(
        (l) => l.vehicleId,
      ),
    ).toEqual([aliceCar]);
  });

  it('answers 404 for every access to another owner’s vehicle, and to staff on owner routes', async () => {
    const photo = await uploadEvidence(app(), bob.tokens, 'PHOTO_FRONT');
    const version = bodyOf(await view(alice, aliceCar)).version as number;
    await view(bob, aliceCar, 404);
    await http(app()).get(`/api/v1/vehicles/${aliceCar}/status`).set(owned(bob)).expect(404);
    await patch(bob, aliceCar, version, { color: 'Black' }, 404);
    await attachEvidence(app(), bob.tokens, aliceCar, 'PHOTO_FRONT', photo, 404);
    await submitVehicle(app(), bob.tokens, aliceCar, 404);
    await http(app()).post(`/api/v1/vehicles/${aliceCar}/archive`).set(owned(bob)).expect(404);
    const listed = await http(app()).get('/api/v1/vehicles').set(owned(bob)).expect(200);
    expect(json(listed.body)).not.toContain(aliceCar);
    await http(app()).get(`/api/v1/vehicles/${aliceCar}`).set(bearer(officerA)).expect(404);
    // It looks exactly like a vehicle that does not exist.
    const missing = await view(bob, randomUUID(), 404);
    const foreign = await view(bob, aliceCar, 404);
    expect({ ...foreign.body, requestId: undefined, instance: undefined }).toEqual({
      ...missing.body,
      requestId: undefined,
      instance: undefined,
    });
    await view(alice, 'not-a-uuid', 400);
    expect((await row(aliceCar)).color).toBe('White');
  });

  it('another owner cannot download or complete the documents of a vehicle', async () => {
    const photo = await uploadEvidence(app(), alice.tokens, 'PHOTO_PLATE');
    await attachEvidence(app(), alice.tokens, aliceCar, 'PHOTO_PLATE', photo);
    await http(app()).get(`/api/v1/documents/${photo}`).set(owned(bob)).expect(404);
    await http(app()).get(`/api/v1/documents/${photo}/download`).set(owned(bob)).expect(404);
  });
});

describe('submission', () => {
  it('lists blockers from the server and submits once a vehicle is complete (idempotent)', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens, {
      skip: ['PHOTO_PLATE', 'INSPECTION'],
    });
    const status = await http(app())
      .get(`/api/v1/vehicles/${vehicle.id}/status`)
      .set(owned(owner))
      .expect(200);
    expect(bodyOf(status)).toMatchObject({
      status: 'DRAFT',
      submissionProblems: ['INSPECTION_MISSING', 'PHOTO_PLATE_MISSING'],
    });
    const refused = await submitVehicle(app(), owner.tokens, vehicle.id, 422);
    expect(refused.body.code).toBe('VEHICLE_SUBMISSION_INCOMPLETE');
    expect(json(refused.body)).toContain('PHOTO_PLATE_MISSING');
    expect((await row(vehicle.id)).status).toBe('DRAFT');

    await attachEvidence(
      app(),
      owner.tokens,
      vehicle.id,
      'PHOTO_PLATE',
      await uploadEvidence(app(), owner.tokens, 'PHOTO_PLATE'),
    );
    await attachEvidence(
      app(),
      owner.tokens,
      vehicle.id,
      'INSPECTION',
      await uploadEvidence(app(), owner.tokens, 'INSPECTION'),
    );
    const key = randomUUID();
    const first = await submitVehicle(app(), owner.tokens, vehicle.id, 200, key);
    expect(bodyOf(first)).toMatchObject({
      status: 'SUBMITTED',
      editable: false,
      submissionProblems: [],
    });
    const replay = await submitVehicle(app(), owner.tokens, vehicle.id, 200, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(
      await prisma.vehicleReviewEvent.count({
        where: { vehicleId: vehicle.id, action: 'submitted' },
      }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: vehicle.id, eventType: 'vehicle.submitted' },
      }),
    ).toBe(1);
    // A different key now finds a vehicle that is no longer submittable.
    expect((await submitVehicle(app(), owner.tokens, vehicle.id, 409)).body.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    // The submitted case is frozen for the owner.
    const version = (await row(vehicle.id)).version;
    await patch(owner, vehicle.id, version, { color: 'Black' }, 409);
    await attachEvidence(
      app(),
      owner.tokens,
      vehicle.id,
      'PHOTO_FRONT',
      await uploadEvidence(app(), owner.tokens, 'PHOTO_FRONT'),
      409,
    );
    await http(app()).post(`/api/v1/vehicles/${vehicle.id}/archive`).set(owned(owner)).expect(409);
    const submittedDocs = await prisma.document.findMany({
      where: { vehicleLink: { vehicleId: vehicle.id } },
    });
    expect(submittedDocs.every((d) => d.reviewStatus === 'SUBMITTED')).toBe(true);
    expect(await audits(vehicle.id)).toContain('vehicle.submitted');
  });

  it('re-checks the owner inside the submission transaction', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens);
    await prisma.ownerProfile.update({
      where: { id: owner.profileId },
      data: {
        verificationStatus: 'SUSPENDED',
        verifiedById: officerAId,
        verifiedAt: new Date(),
        decidedById: officerAId,
        decidedAt: new Date(),
        decisionReasonCode: 'OTHER',
      },
    });
    const refused = await submitVehicle(app(), owner.tokens, vehicle.id, 409);
    expect(refused.body.code).toBe('OWNER_NOT_VERIFIED');
    expect((await row(vehicle.id)).status).toBe('DRAFT');
    // Reading is still allowed, and the vehicle is not eligible.
    const seen = bodyOf(await view(owner, vehicle.id));
    expect(seen.eligibility.eligible).toBe(false);
    await createVehicle(app(), owner.tokens, {}, 409);
  });

  it('treats a document an officer rejected earlier as missing', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens);
    await bypassTriggers((tx) =>
      tx.document.update({
        where: { id: vehicle.documents.PHOTO_LEFT! },
        data: { reviewStatus: 'REJECTED', reviewedById: officerAId, reviewedAt: new Date() },
      }),
    );
    const refused = await submitVehicle(app(), owner.tokens, vehicle.id, 422);
    expect(json(refused.body)).toContain('PHOTO_LEFT_MISSING');
  });

  it('does not let two concurrent submissions with different keys both succeed', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens);
    const results = await Promise.all([
      http(app())
        .post(`/api/v1/vehicles/${vehicle.id}/submit`)
        .set(owned(owner))
        .set('Idempotency-Key', randomUUID()),
      http(app())
        .post(`/api/v1/vehicles/${vehicle.id}/submit`)
        .set(owned(owner))
        .set('Idempotency-Key', randomUUID()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await prisma.vehicleReviewEvent.count({
        where: { vehicleId: vehicle.id, action: 'submitted' },
      }),
    ).toBe(1);
  });
});

describe('officer review', () => {
  it('claim, audited detail, evidence URLs, approve: eligible but not listed', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vin = uniqueVin();
    const vehicle = await preparedVehicle(app(), owner.tokens, {
      submit: true,
      overrides: { vin },
    });

    // Nothing is shown to an officer who has not claimed the case: VIN masked, evidence closed.
    const before = await http(app())
      .get(adminVehicle(`/${vehicle.id}`))
      .set(bearer(officerB))
      .expect(200);
    expect(bodyOf(before).vin).toBeNull();
    expect(bodyOf(before).vinMasked).toBe(`••••${vin.slice(-4)}`);
    expect(bodyOf(before).status).toBe('SUBMITTED');
    const closed = await http(app())
      .get(adminVehicle(`/${vehicle.id}/documents/${vehicle.documents.REGISTRATION}/url`))
      .query(VEHICLE_VIEW_REASON)
      .set(bearer(officerB));
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('REVIEW_CLAIM_REQUIRED');
    // Deciding without the claim is refused.
    expect(
      (await decideVehicle(app(), officerB, vehicle.id, 'approve', VEHICLE_APPROVAL, 409)).body
        .code,
    ).toBe('INVALID_STATE_TRANSITION');

    const claimed = await claimVehicle(app(), officerA, vehicle.id);
    expect(bodyOf(claimed)).toMatchObject({ status: 'UNDER_REVIEW', claimedByMe: true });
    expect((await claimVehicle(app(), officerB, vehicle.id, 409)).body.code).toBe(
      'REVIEW_CLAIMED_BY_OTHER',
    );
    // Idempotent for the holder.
    await claimVehicle(app(), officerA, vehicle.id);

    const detail = bodyOf(
      await http(app())
        .get(adminVehicle(`/${vehicle.id}`))
        .set(bearer(officerA))
        .expect(200),
    );
    expect(detail.vin).toBe(vin);
    expect(detail.approvalBlockers).toEqual([]);
    expect(detail.evidence).toHaveLength(10);
    const actions = await audits(vehicle.id);
    expect(actions).toEqual(
      expect.arrayContaining(['vehicle.case_viewed', 'vehicle.identifiers_viewed']),
    );
    const shown = await prisma.auditLog.findFirstOrThrow({
      where: { targetId: vehicle.id, action: 'vehicle.identifiers_viewed' },
    });
    expect(json(shown)).not.toContain(vin);

    // The other officer still cannot open the evidence.
    await http(app())
      .get(adminVehicle(`/${vehicle.id}/documents/${vehicle.documents.PHOTO_FRONT}/url`))
      .query(VEHICLE_VIEW_REASON)
      .set(bearer(officerB))
      .expect(409);
    const url = await http(app())
      .get(adminVehicle(`/${vehicle.id}/documents/${vehicle.documents.PHOTO_FRONT}/url`))
      .query(VEHICLE_VIEW_REASON)
      .set(bearer(officerA))
      .expect(200);
    expect(bodyOf(url).method).toBe('GET');
    expect(Date.parse(bodyOf(url).expiresAt as string) - Date.now()).toBeLessThanOrEqual(61_000);
    await http(app())
      .get(adminVehicle(`/${vehicle.id}/documents/${vehicle.documents.REGISTRATION}/url`))
      .query(VEHICLE_VIEW_REASON)
      .set(bearer(officerA))
      .expect(200);
    // A reason is required, and the document must belong to this vehicle.
    await http(app())
      .get(adminVehicle(`/${vehicle.id}/documents/${vehicle.documents.PHOTO_FRONT}/url`))
      .set(bearer(officerA))
      .expect(400);
    const otherDoc = await uploadEvidence(app(), owner.tokens, 'PHOTO_FRONT');
    await http(app())
      .get(adminVehicle(`/${vehicle.id}/documents/${otherDoc}/url`))
      .query(VEHICLE_VIEW_REASON)
      .set(bearer(officerA))
      .expect(404);
    const trail = await audits(vehicle.id);
    expect(trail).toEqual(
      expect.arrayContaining(['vehicle.photo_viewed', 'vehicle.document_viewed']),
    );
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'document.viewed_by_staff',
          actorUserId: officerAId,
          changes: { path: ['caseId'], equals: vehicle.id },
        },
      }),
    ).toBeGreaterThanOrEqual(2);

    // Every check must be confirmed.
    for (const missing of Object.keys(VEHICLE_APPROVAL)) {
      await decideVehicle(
        app(),
        officerA,
        vehicle.id,
        'approve',
        { ...VEHICLE_APPROVAL, [missing]: false },
        400,
      );
    }
    const key = randomUUID();
    const approved = await decideVehicle(
      app(),
      officerA,
      vehicle.id,
      'approve',
      VEHICLE_APPROVAL,
      200,
      key,
    );
    expect(bodyOf(approved)).toMatchObject({ status: 'APPROVED', claimedById: null });
    const replay = await decideVehicle(
      app(),
      officerA,
      vehicle.id,
      'approve',
      VEHICLE_APPROVAL,
      200,
      key,
    );
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(
      (await decideVehicle(app(), officerA, vehicle.id, 'approve', VEHICLE_APPROVAL, 409)).body
        .code,
    ).toBe('INVALID_STATE_TRANSITION');

    const stored = await row(vehicle.id);
    expect(stored).toMatchObject({
      status: 'APPROVED',
      decidedById: officerAId,
      claimedById: null,
    });
    const docs = await prisma.document.findMany({
      where: { vehicleLink: { vehicleId: vehicle.id } },
    });
    expect(docs.every((d) => d.reviewStatus === 'APPROVED' && d.reviewedById === officerAId)).toBe(
      true,
    );
    // The owner sees an approved, eligible vehicle: eligibility, not marketplace availability.
    const seen = bodyOf(await view(owner, vehicle.id));
    expect(seen).toMatchObject({
      status: 'APPROVED',
      eligibility: { eligible: true, blockers: [] },
    });
    expect(seen).not.toHaveProperty('listed');
    expect(seen).not.toHaveProperty('available');
    const history = await prisma.vehicleReviewEvent.findMany({
      where: { vehicleId: vehicle.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((e) => e.action)).toEqual(['created', 'submitted', 'claimed', 'approved']);
    expect(await audits(vehicle.id)).toContain('vehicle.approved');
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: vehicle.id, eventType: 'vehicle.approved' },
      }),
    ).toBe(1);
    const note = await prisma.notification.findFirstOrThrow({
      where: { recipientUserId: owner.userId, eventType: 'vehicle.approved' },
    });
    expect(note).toMatchObject({ titleKey: 'notif.vehicle.approved.title', deepLink: '/vehicles' });
    // Officers' queue and counts include it; the list never carries the VIN.
    const queue = await http(app())
      .get(adminVehicle(''))
      .query({ status: 'APPROVED', q: vehicle.id.slice(0, 4) })
      .set(bearer(officerA))
      .expect(200);
    expect(json(queue.body)).not.toContain(vin);
  });

  it('rejects with a reason the owner sees; the owner corrects and resubmits', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens, { submit: true });
    await claimVehicle(app(), officerA, vehicle.id);
    for (const reasonCode of ['SAFETY_CONCERN', 'MISMATCH_NAME', 'NOPE']) {
      await decideVehicle(app(), officerA, vehicle.id, 'reject', { reasonCode }, 400);
    }
    await decideVehicle(app(), officerA, vehicle.id, 'reject', {}, 400);
    await decideVehicle(app(), officerB, vehicle.id, 'reject', { reasonCode: 'BLURRY' }, 409);
    await decideVehicle(app(), officerA, vehicle.id, 'reject', {
      reasonCode: 'BLURRY',
      note: 'The rear photo is out of focus',
    });
    const rejected = bodyOf(await view(owner, vehicle.id));
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      decisionReasonCode: 'BLURRY',
      decisionNote: 'The rear photo is out of focus',
      editable: true,
      eligibility: { eligible: false },
    });
    // Replace the photo; the vehicle returns to DRAFT and is resubmitted.
    const photo = await uploadEvidence(app(), owner.tokens, 'PHOTO_BACK');
    const edited = await attachEvidence(app(), owner.tokens, vehicle.id, 'PHOTO_BACK', photo);
    expect(bodyOf(edited)).toMatchObject({ status: 'DRAFT', decisionReasonCode: null });
    await submitVehicle(app(), owner.tokens, vehicle.id);
    const again = await row(vehicle.id);
    expect(again).toMatchObject({
      status: 'SUBMITTED',
      decidedById: null,
      decisionReasonCode: null,
    });
    await approveVehicle(app(), officerB, vehicle.id);
    expect((await row(vehicle.id)).status).toBe('APPROVED');
    const history = await prisma.vehicleReviewEvent.findMany({
      where: { vehicleId: vehicle.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((e) => e.action)).toEqual([
      'created',
      'submitted',
      'claimed',
      'rejected',
      'edited',
      'submitted',
      'claimed',
      'approved',
    ]);
  });

  it('re-checks owner, account and evidence in the approval transaction', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens, { submit: true });
    await claimVehicle(app(), officerA, vehicle.id);
    await bypassTriggers((tx) =>
      tx.document.update({
        where: { id: vehicle.documents.PHOTO_PLATE! },
        data: { reviewStatus: 'REJECTED', reviewedById: officerAId, reviewedAt: new Date() },
      }),
    );
    const refused = await decideVehicle(
      app(),
      officerA,
      vehicle.id,
      'approve',
      VEHICLE_APPROVAL,
      422,
    );
    expect(refused.body.code).toBe('VEHICLE_SUBMISSION_INCOMPLETE');
    expect(json(refused.body)).toContain('PHOTO_PLATE_MISSING');
    await bypassTriggers((tx) =>
      tx.document.update({
        where: { id: vehicle.documents.PHOTO_PLATE! },
        data: { reviewStatus: 'SUBMITTED' },
      }),
    );
    await prisma.user.update({ where: { id: owner.userId }, data: { status: 'SUSPENDED' } });
    const suspended = await decideVehicle(
      app(),
      officerA,
      vehicle.id,
      'approve',
      VEHICLE_APPROVAL,
      422,
    );
    expect(json(suspended.body)).toContain('ACCOUNT_NOT_ACTIVE');
    await prisma.user.update({ where: { id: owner.userId }, data: { status: 'ACTIVE' } });
    await prisma.user.update({ where: { id: owner.userId }, data: { identityStatus: 'EXPIRED' } });
    const identity = await decideVehicle(
      app(),
      officerA,
      vehicle.id,
      'approve',
      VEHICLE_APPROVAL,
      422,
    );
    expect(json(identity.body)).toContain('IDENTITY_NOT_VERIFIED');
    expect((await row(vehicle.id)).status).toBe('UNDER_REVIEW');
  });

  it('exactly one of two concurrent claims or decisions wins', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens, { submit: true });
    const claims = await Promise.all([
      http(app())
        .post(adminVehicle(`/${vehicle.id}/claim`))
        .set(bearer(officerA)),
      http(app())
        .post(adminVehicle(`/${vehicle.id}/claim`))
        .set(bearer(officerB)),
    ]);
    expect(claims.map((r) => r.status).sort()).toEqual([200, 409]);
    const holder = claims[0].status === 200 ? officerA : officerB;
    const decisions = await Promise.all([
      http(app())
        .post(adminVehicle(`/${vehicle.id}/approve`))
        .set(bearer(holder))
        .set('Idempotency-Key', randomUUID())
        .send(VEHICLE_APPROVAL),
      http(app())
        .post(adminVehicle(`/${vehicle.id}/reject`))
        .set(bearer(holder))
        .set('Idempotency-Key', randomUUID())
        .send({ reasonCode: 'OTHER' }),
      http(app())
        .post(adminVehicle(`/${vehicle.id}/approve`))
        .set(bearer(holder))
        .set('Idempotency-Key', randomUUID())
        .send(VEHICLE_APPROVAL),
    ]);
    expect(decisions.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(
      await prisma.vehicleReviewEvent.count({
        where: { vehicleId: vehicle.id, action: { in: ['approved', 'rejected'] } },
      }),
    ).toBe(1);
  });

  it('another officer takes over an expired claim; the former holder can no longer decide; release re-queues', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens, { submit: true });
    await claimVehicle(app(), officerA, vehicle.id);
    await prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { claimExpiresAt: new Date(Date.now() - 1000) },
    });
    const taken = await claimVehicle(app(), officerB, vehicle.id);
    expect(bodyOf(taken).claimedByMe).toBe(true);
    expect(
      (await decideVehicle(app(), officerA, vehicle.id, 'approve', VEHICLE_APPROVAL, 409)).body
        .code,
    ).toBe('REVIEW_CLAIM_REQUIRED');
    await http(app())
      .post(adminVehicle(`/${vehicle.id}/release`))
      .set(bearer(officerA))
      .expect(409);
    const released = await http(app())
      .post(adminVehicle(`/${vehicle.id}/release`))
      .set(bearer(officerB))
      .expect(200);
    expect(bodyOf(released)).toMatchObject({ status: 'SUBMITTED', claimedById: null });
    expect(
      (await prisma.vehicleReviewEvent.findMany({ where: { vehicleId: vehicle.id } })).map(
        (e) => e.action,
      ),
    ).toEqual(expect.arrayContaining(['claim_taken_over', 'released']));
  });

  it('suspension needs a reason and note, is internal, ends eligibility; a fraud suspension needs a different officer to lift', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens, { submit: true });
    await approveVehicle(app(), officerA, vehicle.id);
    await decideVehicle(
      app(),
      officerA,
      vehicle.id,
      'suspend',
      { reasonCode: 'BLURRY', note: 'Not a valid reason code' },
      400,
    );
    await decideVehicle(
      app(),
      officerA,
      vehicle.id,
      'suspend',
      { reasonCode: 'OTHER', note: 'short' },
      400,
    );
    await decideVehicle(
      app(),
      officerA,
      vehicle.id,
      'suspend',
      { reasonCode: 'SUSPECTED_FRAUD' },
      400,
    );
    await decideVehicle(app(), officerA, vehicle.id, 'suspend', {
      reasonCode: 'SUSPECTED_FRAUD',
      note: 'Registration looks altered',
    });
    const seen = bodyOf(await view(owner, vehicle.id));
    expect(seen).toMatchObject({
      status: 'SUSPENDED',
      decisionReasonCode: 'SUSPECTED_FRAUD',
      decisionNote: null,
      editable: false,
    });
    expect(seen.eligibility.eligible).toBe(false);
    // The owner cannot edit, archive or resubmit a suspended vehicle.
    await patch(owner, vehicle.id, seen.version as number, { color: 'Red' }, 409);
    await http(app()).post(`/api/v1/vehicles/${vehicle.id}/archive`).set(owned(owner)).expect(409);
    await submitVehicle(app(), owner.tokens, vehicle.id, 409);
    // Suspension and reinstatement only apply to the right statuses.
    await decideVehicle(
      app(),
      officerA,
      vehicle.id,
      'suspend',
      { reasonCode: 'OTHER', note: 'Already suspended' },
      409,
    );
    expect(
      (
        await decideVehicle(
          app(),
          officerA,
          vehicle.id,
          'reinstate',
          { note: 'Checked again myself' },
          409,
        )
      ).body.code,
    ).toBe('SECOND_APPROVER_REQUIRED');
    await decideVehicle(app(), officerB, vehicle.id, 'reinstate', {
      note: 'Registration verified in person',
    });
    expect(bodyOf(await view(owner, vehicle.id)).eligibility.eligible).toBe(true);

    // A suspension for another reason is lifted by the same officer.
    await decideVehicle(app(), officerA, vehicle.id, 'suspend', {
      reasonCode: 'SAFETY_CONCERN',
      note: 'Brakes reported faulty',
    });
    await decideVehicle(app(), officerA, vehicle.id, 'reinstate', {
      note: 'Repairs confirmed by inspection',
    });
    expect((await row(vehicle.id)).status).toBe('APPROVED');
    await decideVehicle(
      app(),
      officerA,
      vehicle.id,
      'reinstate',
      { note: 'Not suspended any more' },
      409,
    );
    const actions = await audits(vehicle.id);
    expect(actions).toEqual(expect.arrayContaining(['vehicle.suspended', 'vehicle.reinstated']));
  });

  it('refuses reinstatement while the evidence has lapsed', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens, { submit: true });
    await approveVehicle(app(), officerA, vehicle.id);
    await decideVehicle(app(), officerA, vehicle.id, 'suspend', {
      reasonCode: 'OTHER',
      note: 'Routine investigation',
    });
    await bypassTriggers((tx) =>
      tx.vehicleDocument.update({
        where: { vehicleId_slot: { vehicleId: vehicle.id, slot: 'INSURANCE' } },
        data: { expiresOn: new Date(`${dateIn(-3)}T00:00:00Z`) },
      }),
    );
    const refused = await decideVehicle(
      app(),
      officerA,
      vehicle.id,
      'reinstate',
      { note: 'Looks fine to me' },
      422,
    );
    expect(json(refused.body)).toContain('INSURANCE_EXPIRED');
  });

  it('queue: filters, search, pagination and counts; no drafts, no VIN', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const tag = `Zq${Math.floor(Math.random() * 1e6)}`;
    await createVehicle(app(), owner.tokens, { make: tag }); // draft: never visible to officers
    const submitted = await preparedVehicle(app(), owner.tokens, {
      submit: true,
      overrides: { make: tag, vehicleType: 'SUV' },
    });
    const second = await preparedVehicle(app(), owner.tokens, {
      submit: true,
      overrides: { make: tag },
    });
    await approveVehicle(app(), officerA, second.id);
    const list = async (query: Record<string, string>) =>
      bodyOf(
        await http(app()).get(adminVehicle('')).query(query).set(bearer(officerA)).expect(200),
      );
    const all = await list({ q: tag });
    expect(all.total).toBe(2);
    expect(json(all)).not.toContain('"vin"');
    expect(
      (await list({ q: tag, status: 'APPROVED' })).items.map((i: { id: string }) => i.id),
    ).toEqual([second.id]);
    expect(
      (await list({ q: tag, vehicleType: 'SUV' })).items.map((i: { id: string }) => i.id),
    ).toEqual([submitted.id]);
    expect((await list({ q: tag, status: 'DRAFT' })).total).toBe(0);
    expect((await list({ q: tag, limit: '1', page: '2' })).items).toHaveLength(1);
    await http(app())
      .get(adminVehicle(''))
      .query({ status: 'NOPE' })
      .set(bearer(officerA))
      .expect(400);
    await http(app())
      .get(adminVehicle(''))
      .query({ limit: '500' })
      .set(bearer(officerA))
      .expect(400);
    const counts = bodyOf(
      await http(app()).get(adminVehicle('/counts')).set(bearer(officerA)).expect(200),
    );
    expect(counts.SUBMITTED).toBeGreaterThanOrEqual(1);
    expect(counts.APPROVED).toBeGreaterThanOrEqual(1);
    expect(Object.keys(counts).sort()).toEqual([
      'APPROVED',
      'EXPIRED',
      'REJECTED',
      'SUBMITTED',
      'SUSPENDED',
      'UNDER_REVIEW',
    ]);
    // Drafts are not reachable by id either.
    const draft = await prisma.vehicle.findFirstOrThrow({
      where: { ownerProfileId: owner.profileId, status: 'DRAFT' },
    });
    await http(app())
      .get(adminVehicle(`/${draft.id}`))
      .set(bearer(officerA))
      .expect(404);
    await claimVehicle(app(), officerA, draft.id, 404);
  });

  it('is limited to verification officers (403 for other staff, 404 for customers)', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens, { submit: true });
    const support = await staffLogin(app(), await seedStaff(app(), ['SUPPORT']));
    const admin = await staffLogin(app(), await seedStaff(app(), ['SUPER_ADMIN']));
    for (const tokens of [support, admin]) {
      await http(app()).get(adminVehicle('')).set(bearer(tokens)).expect(403);
      await http(app())
        .get(adminVehicle(`/${vehicle.id}`))
        .set(bearer(tokens))
        .expect(403);
      await http(app())
        .post(adminVehicle(`/${vehicle.id}/claim`))
        .set(bearer(tokens))
        .expect(403);
    }
    await http(app()).get(adminVehicle('')).set(owned(owner)).expect(404);
    await http(app())
      .post(adminVehicle(`/${vehicle.id}/claim`))
      .set(owned(owner))
      .expect(404);
    await http(app()).get(adminVehicle('')).expect(401);
    expect((await row(vehicle.id)).status).toBe('SUBMITTED');
  });
});

describe('changes after approval', () => {
  async function approved() {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens, { submit: true });
    await approveVehicle(app(), officerA, vehicle.id);
    return { owner, vehicle };
  }

  it('a non-material change keeps the approval; a material change forces re-verification', async () => {
    const { owner, vehicle } = await approved();
    const version = (await row(vehicle.id)).version;
    const colour = bodyOf(await patch(owner, vehicle.id, version, { color: 'Silver', seats: 4 }));
    expect(colour.status).toBe('APPROVED');
    expect(colour.eligibility.eligible).toBe(true);
    const material = bodyOf(
      await patch(owner, vehicle.id, colour.version as number, { make: 'Honda' }),
    );
    expect(material).toMatchObject({ status: 'SUBMITTED', eligibility: { eligible: false } });
    expect(
      await prisma.vehicleReviewEvent.count({
        where: { vehicleId: vehicle.id, action: 'resubmitted' },
      }),
    ).toBe(1);
    // Approving again works as for a new vehicle.
    await approveVehicle(app(), officerB, vehicle.id);
    expect((await row(vehicle.id)).make).toBe('Honda');
    // Changing the plate to one that is free also forces re-verification; a taken plate is refused.
    const other = bodyOf(await createVehicle(app(), owner.tokens));
    await patch(
      owner,
      vehicle.id,
      (await row(vehicle.id)).version,
      {
        plateRegion: other.plate.region,
        plateCode: other.plate.code,
        plateNumber: other.plate.number,
      },
      409,
    );
    expect((await row(vehicle.id)).status).toBe('APPROVED');
    const plated = bodyOf(
      await patch(owner, vehicle.id, (await row(vehicle.id)).version, uniquePlate()),
    );
    expect(plated.status).toBe('SUBMITTED');
  });

  it('new evidence on an approved vehicle is re-verified; incomplete evidence is refused', async () => {
    const { owner, vehicle } = await approved();
    const photo = await uploadEvidence(app(), owner.tokens, 'PHOTO_FRONT');
    const res = await attachEvidence(app(), owner.tokens, vehicle.id, 'PHOTO_FRONT', photo);
    expect(bodyOf(res).status).toBe('SUBMITTED');
    const queue = await http(app())
      .get(adminVehicle(''))
      .query({ status: 'SUBMITTED' })
      .set(bearer(officerA))
      .expect(200);
    expect(json(queue.body)).toContain(vehicle.id);
  });
});

describe('expiry', () => {
  it('moves an approved vehicle to EXPIRED when insurance ends, on read and in the sweep; renewal resubmits', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens, { submit: true });
    await approveVehicle(app(), officerA, vehicle.id);
    // Insurance that ends today is still valid.
    await bypassTriggers((tx) =>
      tx.vehicleDocument.update({
        where: { vehicleId_slot: { vehicleId: vehicle.id, slot: 'INSURANCE' } },
        data: { expiresOn: new Date(`${dateIn(0)}T00:00:00Z`) },
      }),
    );
    expect(bodyOf(await view(owner, vehicle.id)).status).toBe('APPROVED');
    await bypassTriggers((tx) =>
      tx.vehicleDocument.update({
        where: { vehicleId_slot: { vehicleId: vehicle.id, slot: 'INSURANCE' } },
        data: { expiresOn: new Date(`${dateIn(-1)}T00:00:00Z`) },
      }),
    );
    const seen = bodyOf(await view(owner, vehicle.id));
    expect(seen).toMatchObject({
      status: 'EXPIRED',
      editable: true,
      eligibility: { eligible: false },
    });
    expect(seen.submissionProblems).toEqual(['INSURANCE_EXPIRED']);
    expect(await audits(vehicle.id)).toContain('vehicle.expired');
    expect(
      await prisma.notification.count({
        where: { recipientUserId: owner.userId, eventType: 'vehicle.expired' },
      }),
    ).toBe(1);
    // Looking again does not repeat it.
    await view(owner, vehicle.id);
    expect(
      await prisma.vehicleReviewEvent.count({
        where: { vehicleId: vehicle.id, action: 'evidence_expired' },
      }),
    ).toBe(1);
    // Renew the insurance and submit again.
    const renewed = await uploadEvidence(app(), owner.tokens, 'INSURANCE');
    expect(
      bodyOf(await attachEvidence(app(), owner.tokens, vehicle.id, 'INSURANCE', renewed)).status,
    ).toBe('DRAFT');
    await submitVehicle(app(), owner.tokens, vehicle.id);
    await approveVehicle(app(), officerB, vehicle.id);
    expect((await row(vehicle.id)).status).toBe('APPROVED');
  });

  it('the sweep (npm run vehicles:refresh) expires vehicles nobody reads, and an officer cannot approve around it', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens, { submit: true });
    await approveVehicle(app(), officerA, vehicle.id);
    await bypassTriggers((tx) =>
      tx.vehicleDocument.update({
        where: { vehicleId_slot: { vehicleId: vehicle.id, slot: 'INSPECTION' } },
        data: { expiresOn: new Date(`${dateIn(-2)}T00:00:00Z`) },
      }),
    );
    expect((await row(vehicle.id)).status).toBe('APPROVED');
    const changed = await app().get(VehicleStatusService).sweep();
    expect(changed).toBeGreaterThanOrEqual(1);
    expect((await row(vehicle.id)).status).toBe('EXPIRED');
    expect(await app().get(VehicleStatusService).sweep()).toBe(0);
    // A suspension of an expired vehicle is refused (nothing to suspend).
    await decideVehicle(
      app(),
      officerA,
      vehicle.id,
      'suspend',
      { reasonCode: 'OTHER', note: 'Too late to suspend' },
      409,
    );
  });

  it('an approval of a vehicle whose evidence lapsed during review is refused', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens, { submit: true });
    await claimVehicle(app(), officerA, vehicle.id);
    await bypassTriggers((tx) =>
      tx.vehicleDocument.update({
        where: { vehicleId_slot: { vehicleId: vehicle.id, slot: 'INSURANCE' } },
        data: { expiresOn: new Date(`${dateIn(-1)}T00:00:00Z`) },
      }),
    );
    const refused = await decideVehicle(
      app(),
      officerA,
      vehicle.id,
      'approve',
      VEHICLE_APPROVAL,
      422,
    );
    expect(json(refused.body)).toContain('INSURANCE_EXPIRED');
  });
});

describe('archiving', () => {
  it('removes the vehicle from the list, frees its plate and VIN, and is harmless to repeat', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vin = uniqueVin();
    const plate = uniquePlate();
    const vehicle = bodyOf(await createVehicle(app(), owner.tokens, { ...plate, vin }));
    const archived = await http(app())
      .post(`/api/v1/vehicles/${vehicle.id}/archive`)
      .set(owned(owner))
      .expect(200);
    expect(bodyOf(archived).status).toBe('ARCHIVED');
    await http(app()).post(`/api/v1/vehicles/${vehicle.id}/archive`).set(owned(owner)).expect(200);
    const stored = await row(vehicle.id as string);
    expect(stored).toMatchObject({ plateKey: null, vinKey: null });
    expect(stored.archivedAt).not.toBeNull();
    const list = await http(app()).get('/api/v1/vehicles').set(owned(owner)).expect(200);
    expect(json(list.body)).not.toContain(vehicle.id);
    // An archived vehicle cannot be edited, and the plate and VIN can be registered again.
    await patch(owner, vehicle.id as string, stored.version, { color: 'Red' }, 409);
    await createVehicle(app(), owner.tokens, { ...plate, vin });
    expect(
      await prisma.vehicleReviewEvent.count({
        where: { vehicleId: vehicle.id as string, action: 'archived' },
      }),
    ).toBe(1);
  });

  it('an approved vehicle can be archived; officers no longer see it', async () => {
    const owner = await verifiedOwner(app(), officerA);
    const vehicle = await preparedVehicle(app(), owner.tokens, { submit: true });
    await approveVehicle(app(), officerA, vehicle.id);
    await http(app()).post(`/api/v1/vehicles/${vehicle.id}/archive`).set(owned(owner)).expect(200);
    await http(app())
      .get(adminVehicle(`/${vehicle.id}`))
      .set(bearer(officerA))
      .expect(404);
    expect(bodyOf(await view(owner, vehicle.id)).eligibility.eligible).toBe(false);
  });
});

describe('owner and driver together', () => {
  it('a driver who becomes a verified owner keeps the driver profile; vehicle routes do not touch it', async () => {
    const customer = await registerCustomer(app());
    await http(app()).post('/api/v1/drivers/me').set(bearer(customer.tokens)).send({}).expect(201);
    const driverBefore = await prisma.driverProfile.findUniqueOrThrow({
      where: { userId: customer.userId },
    });
    const owner = await verifiedOwner(app(), officerA, customer);
    await preparedVehicle(app(), owner.tokens, { submit: true });
    expect(
      await prisma.driverProfile.findUniqueOrThrow({ where: { userId: customer.userId } }),
    ).toEqual(driverBefore);
  });
});
