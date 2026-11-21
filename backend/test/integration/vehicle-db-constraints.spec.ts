import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { VEHICLE_STATUSES, VEHICLE_TRANSITIONS } from '../../src/modules/vehicles/vehicle-rules.js';
import { requireTestDatabaseUrl } from '../helpers/test-env.js';

/**
 * Phase 7 database guarantees (prisma/migrations/*_vehicle_verification), tested with raw SQL
 * so that a bug in the services could not bypass them: a verified owner only, the owner never
 * changes, officers only, the status table, frozen details, one active vehicle per plate and
 * VIN, evidence that is the owner's own and fits its slot, append-only history.
 */
let pool: pg.Pool;
const CHECK = '23514';
const RESTRICT = '23001';
const UNIQUE = '23505';

const hex64 = (): string => randomBytes(32).toString('hex');
const phone = (): string =>
  `+2519${String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, '0')}`;
const plate = (): string => `AA-2-${randomBytes(4).toString('hex').toUpperCase()}`;

async function insert(table: string, row: Record<string, unknown>): Promise<void> {
  const columns = Object.keys(row);
  await pool.query(
    `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(row),
  );
}
async function user(accountType = 'CUSTOMER', status = 'ACTIVE'): Promise<string> {
  const id = randomUUID();
  await insert('users', {
    id,
    phone_e164: phone(),
    password_hash: '!unusable',
    account_type: accountType,
    status,
    updated_at: new Date(),
    ...(accountType === 'STAFF' && status === 'ACTIVE'
      ? { mfa_enrolled_at: new Date(), mfa_secret_enc: Buffer.from('secret') }
      : {}),
  });
  return id;
}
async function staff(role: string | null = 'VERIFICATION_OFFICER'): Promise<string> {
  const id = await user('STAFF', 'ACTIVE');
  if (role !== null) {
    await insert('staff_role_assignments', {
      id: randomUUID(),
      user_id: id,
      role,
      updated_at: new Date(),
    });
  }
  return id;
}

/** A customer with an individual owner profile, optionally VERIFIED. */
async function owner(verified = true): Promise<{ userId: string; profileId: string }> {
  const userId = await user();
  const profileId = randomUUID();
  await insert('owner_profiles', {
    id: profileId,
    user_id: userId,
    owner_type: 'INDIVIDUAL',
    updated_at: new Date(),
  });
  if (verified) {
    const officer = await staff();
    await pool.query(
      `UPDATE owner_profiles SET verification_status = 'PENDING', submitted_at = now() WHERE id = $1`,
      [profileId],
    );
    await pool.query(
      `UPDATE owner_profiles SET verification_status = 'VERIFIED', verified_by = $2, verified_at = now(),
         decided_by = $2, decided_at = now() WHERE id = $1`,
      [profileId, officer],
    );
  }
  return { userId, profileId };
}

async function vehicle(
  profileId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  const normalized = plate();
  await insert('vehicles', {
    id,
    owner_profile_id: profileId,
    vehicle_type: 'SEDAN',
    make: 'Toyota',
    model: 'Vitz',
    year: 2018,
    seats: 5,
    transmission: 'AUTOMATIC',
    fuel_type: 'PETROL',
    plate_region: 'AA',
    plate_code: '2',
    plate_number: normalized.split('-')[2],
    plate_normalized: normalized,
    plate_key: normalized,
    updated_at: new Date(),
    ...overrides,
  });
  return id;
}
const update = (id: string, set: string, params: unknown[] = []) =>
  pool.query(`UPDATE vehicles SET ${set} WHERE id = $1`, [id, ...params]);

async function document(
  ownerUserId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await insert('documents', {
    id,
    owner_user_id: ownerUserId,
    purpose: 'VEHICLE_PHOTO',
    upload_key: `incoming/${id}`,
    declared_mime_type: 'image/jpeg',
    declared_size_bytes: 1000,
    sha256: hex64(),
    upload_expires_at: new Date(Date.now() + 300_000),
    updated_at: new Date(),
    ...overrides,
  });
  return id;
}

async function expectViolation(
  promise: Promise<unknown>,
  sqlState: string,
  constraint?: string,
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e as { code?: string; constraint?: string },
  );
  expect(error, 'statement unexpectedly succeeded').toBeDefined();
  expect(error?.code).toBe(sqlState);
  if (constraint !== undefined) expect(error?.constraint).toBe(constraint);
}

beforeAll(() => {
  pool = new pg.Pool({ connectionString: requireTestDatabaseUrl(), max: 2 });
});
afterAll(async () => {
  await pool.end();
});

describe('vehicles: creation', () => {
  it('needs a VERIFIED owner on an ACTIVE account, and starts as an unreviewed DRAFT', async () => {
    const unverified = await owner(false);
    await expectViolation(vehicle(unverified.profileId), CHECK);
    const verified = await owner();
    await vehicle(verified.profileId);
    await pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [verified.userId]);
    await expectViolation(vehicle(verified.profileId), CHECK);

    const fresh = await owner();
    await expectViolation(vehicle(fresh.profileId, { status: 'APPROVED' }), CHECK);
    await expectViolation(vehicle(fresh.profileId, { claimed_by: await staff() }), CHECK);
    await expectViolation(vehicle(fresh.profileId, { submitted_at: new Date() }), CHECK);
  });

  it('keeps ranges, text and plate formats', async () => {
    const { profileId } = await owner();
    await expectViolation(vehicle(profileId, { year: 1979 }), CHECK, 'vehicles_range_chk');
    await expectViolation(vehicle(profileId, { year: 2101 }), CHECK, 'vehicles_range_chk');
    await expectViolation(vehicle(profileId, { seats: 0 }), CHECK, 'vehicles_range_chk');
    await expectViolation(vehicle(profileId, { seats: 61 }), CHECK, 'vehicles_range_chk');
    await expectViolation(vehicle(profileId, { make: 'To\u0001yota' }), CHECK, 'vehicles_text_chk');
    await expectViolation(vehicle(profileId, { make: '' }), CHECK, 'vehicles_text_chk');
    await expectViolation(
      vehicle(profileId, { model: 'x'.repeat(61) }),
      CHECK,
      'vehicles_text_chk',
    );
    await expectViolation(
      vehicle(profileId, { plate_number: '12\u0007' }),
      CHECK,
      'vehicles_plate_chk',
    );
    await expectViolation(
      vehicle(profileId, { plate_normalized: 'AA 2 1', plate_key: 'AA 2 1' }),
      CHECK,
      'vehicles_plate_chk',
    );
  });

  it('rejects unknown vehicle types at the type level', async () => {
    const { profileId } = await owner();
    await expectViolation(vehicle(profileId, { vehicle_type: 'SPACESHIP' }), '22P02');
  });

  it('keeps VIN columns consistent and formatted', async () => {
    const { profileId } = await owner();
    await expectViolation(
      vehicle(profileId, { vin_enc: Buffer.from('x') }),
      CHECK,
      'vehicles_vin_shape_chk',
    );
    const hmac = hex64();
    await expectViolation(
      vehicle(profileId, {
        vin_enc: Buffer.from('x'),
        vin_hmac: 'zz',
        vin_last4: '1234',
        vin_key: 'zz',
      }),
      CHECK,
      'vehicles_vin_shape_chk',
    );
    await expectViolation(
      vehicle(profileId, { vin_enc: Buffer.from('x'), vin_hmac: hmac, vin_last4: '1234' }),
      CHECK,
      'vehicles_vin_key_chk',
    );
    await vehicle(profileId, {
      vin_enc: Buffer.from('x'),
      vin_hmac: hmac,
      vin_last4: '1234',
      vin_key: hmac,
    });
  });
});

describe('vehicles: one active vehicle per plate and VIN', () => {
  it('rejects a second active vehicle with the same plate or VIN, in any account', async () => {
    const a = await owner();
    const b = await owner();
    const normalized = plate();
    await vehicle(a.profileId, { plate_normalized: normalized, plate_key: normalized });
    await expectViolation(
      vehicle(b.profileId, { plate_normalized: normalized, plate_key: normalized }),
      UNIQUE,
    );
    const hmac = hex64();
    const vin = { vin_enc: Buffer.from('x'), vin_hmac: hmac, vin_last4: '1234', vin_key: hmac };
    await vehicle(a.profileId, vin);
    await expectViolation(vehicle(b.profileId, vin), UNIQUE);
  });

  it('frees the plate and VIN once the vehicle is archived, and only then', async () => {
    const a = await owner();
    const normalized = plate();
    const hmac = hex64();
    const id = await vehicle(a.profileId, {
      plate_normalized: normalized,
      plate_key: normalized,
      vin_enc: Buffer.from('x'),
      vin_hmac: hmac,
      vin_last4: '1234',
      vin_key: hmac,
    });
    // Archived but still holding the key: refused.
    await expectViolation(
      update(id, `status = 'ARCHIVED', archived_at = now()`),
      CHECK,
      'vehicles_plate_key_chk',
    );
    await update(id, `status = 'ARCHIVED', archived_at = now(), plate_key = NULL, vin_key = NULL`);
    const b = await owner();
    await vehicle(b.profileId, {
      plate_normalized: normalized,
      plate_key: normalized,
      vin_enc: Buffer.from('x'),
      vin_hmac: hmac,
      vin_last4: '1234',
      vin_key: hmac,
    });
    // A key without archiving is also refused, and so is "archived" without the status.
    await expectViolation(update(id, `archived_at = NULL`), CHECK);
  });
});

describe('vehicles: status transitions', () => {
  const officerPromise = (): Promise<string> => staff();

  /** Brings a fresh vehicle to [status] through allowed steps only. */
  async function reach(
    status: (typeof VEHICLE_STATUSES)[number],
    officer: string,
  ): Promise<string> {
    const { profileId } = await owner();
    const id = await vehicle(profileId);
    if (status === 'DRAFT') return id;
    if (status === 'ARCHIVED') {
      await update(
        id,
        `status = 'ARCHIVED', archived_at = now(), plate_key = NULL, vin_key = NULL`,
      );
      return id;
    }
    await update(id, `status = 'SUBMITTED', submitted_at = now()`);
    if (status === 'SUBMITTED') return id;
    await update(
      id,
      `status = 'UNDER_REVIEW', claimed_by = $2, claim_expires_at = now() + interval '30 minutes'`,
      [officer],
    );
    if (status === 'UNDER_REVIEW') return id;
    if (status === 'REJECTED') {
      await update(
        id,
        `status = 'REJECTED', claimed_by = NULL, claim_expires_at = NULL, decided_by = $2,
           decided_at = now(), decision_reason_code = 'OTHER'`,
        [officer],
      );
      return id;
    }
    await update(
      id,
      `status = 'APPROVED', claimed_by = NULL, claim_expires_at = NULL, decided_by = $2, decided_at = now()`,
      [officer],
    );
    if (status === 'APPROVED') return id;
    if (status === 'SUSPENDED') {
      await update(id, `status = 'SUSPENDED', decision_reason_code = 'OTHER'`);
      return id;
    }
    await update(id, `status = 'EXPIRED'`);
    return id;
  }

  const target = (to: string): string => {
    switch (to) {
      case 'SUBMITTED':
        return `status = 'SUBMITTED', submitted_at = COALESCE(submitted_at, now()), claimed_by = NULL, claim_expires_at = NULL`;
      case 'UNDER_REVIEW':
        return `status = 'UNDER_REVIEW', claimed_by = $2, claim_expires_at = now() + interval '30 minutes'`;
      case 'APPROVED':
        return `status = 'APPROVED', claimed_by = NULL, claim_expires_at = NULL, decided_by = $2, decided_at = now()`;
      case 'REJECTED':
      case 'SUSPENDED':
        return `status = '${to}', claimed_by = NULL, claim_expires_at = NULL, decided_by = $2, decided_at = now(), decision_reason_code = 'OTHER'`;
      case 'ARCHIVED':
        return `status = 'ARCHIVED', archived_at = now(), plate_key = NULL, vin_key = NULL, claimed_by = NULL, claim_expires_at = NULL`;
      default:
        return `status = '${to}', claimed_by = NULL, claim_expires_at = NULL`;
    }
  };

  it('allows exactly the transitions of VEHICLE_TRANSITIONS and refuses every other', async () => {
    const officer = await officerPromise();
    for (const from of VEHICLE_STATUSES) {
      for (const to of VEHICLE_STATUSES) {
        if (from === to) continue;
        const id = await reach(from, officer);
        const attempt = update(
          id,
          target(to),
          to === 'UNDER_REVIEW' || to === 'APPROVED' || to === 'REJECTED' || to === 'SUSPENDED'
            ? [officer]
            : [],
        );
        if (VEHICLE_TRANSITIONS[from].includes(to)) {
          await attempt;
        } else {
          const error = await attempt.then(
            () => undefined,
            (e: unknown) => e as { code?: string; message?: string },
          );
          expect(error, `${from} -> ${to} unexpectedly succeeded`).toBeDefined();
          expect(error?.code, `${from} -> ${to}`).toBe(CHECK);
          expect(error?.message, `${from} -> ${to}`).toMatch(/transition/);
        }
      }
    }
  }, 120_000);

  it('freezes material details outside DRAFT, REJECTED and EXPIRED, but not colour or seats', async () => {
    const officer = await officerPromise();
    for (const status of ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SUSPENDED'] as const) {
      const id = await reach(status, officer);
      await expectViolation(update(id, `make = 'Honda'`), RESTRICT);
      await expectViolation(update(id, `year = 2019`), RESTRICT);
      await expectViolation(update(id, `vehicle_type = 'SUV'`), RESTRICT);
      await expectViolation(update(id, `engine_number_enc = '\\x00'::bytea`), RESTRICT);
    }
    const approved = await reach('APPROVED', officer);
    await update(approved, `color = 'Red', seats = 4`);
    for (const status of ['DRAFT', 'REJECTED', 'EXPIRED'] as const) {
      const id = await reach(status, officer);
      await update(id, `make = 'Honda'`);
    }
  });

  it('lets an approved vehicle change material details only on its way back to SUBMITTED', async () => {
    const officer = await officerPromise();
    const id = await reach('APPROVED', officer);
    await update(
      id,
      `make = 'Honda', status = 'SUBMITTED', submitted_at = now(), decided_by = NULL, decided_at = NULL`,
    );
  });

  it('never changes the owner of a vehicle', async () => {
    const a = await owner();
    const b = await owner();
    const id = await vehicle(a.profileId);
    await expectViolation(update(id, `owner_profile_id = $2`, [b.profileId]), RESTRICT);
  });

  it('allows only active verification officers (never the owner) to claim and decide', async () => {
    const officer = await officerPromise();
    const support = await staff('SUPPORT');
    const customer = await user();
    const id = await reach('SUBMITTED', officer);
    for (const who of [support, customer]) {
      await expectViolation(
        update(
          id,
          `status = 'UNDER_REVIEW', claimed_by = $2, claim_expires_at = now() + interval '1 hour'`,
          [who],
        ),
        CHECK,
      );
    }
    await update(
      id,
      `status = 'UNDER_REVIEW', claimed_by = $2, claim_expires_at = now() + interval '1 hour'`,
      [officer],
    );
    await expectViolation(
      update(
        id,
        `status = 'APPROVED', claimed_by = NULL, claim_expires_at = NULL, decided_by = $2, decided_at = now()`,
        [support],
      ),
      CHECK,
    );
  });

  it('needs a decision record, a reason and a consistent claim', async () => {
    const officer = await officerPromise();
    const id = await reach('UNDER_REVIEW', officer);
    await expectViolation(
      update(id, `status = 'APPROVED', claimed_by = NULL, claim_expires_at = NULL`),
      CHECK,
      'vehicles_decision_chk',
    );
    await expectViolation(
      update(
        id,
        `status = 'REJECTED', claimed_by = NULL, claim_expires_at = NULL, decided_by = $2, decided_at = now()`,
        [officer],
      ),
      CHECK,
      'vehicles_decision_chk',
    );
    await expectViolation(update(id, `claim_expires_at = NULL`), CHECK, 'vehicles_claim_shape_chk');
    const draft = await reach('DRAFT', officer);
    await expectViolation(
      update(draft, `claimed_by = $2, claim_expires_at = now()`, [officer]),
      CHECK,
      'vehicles_claim_shape_chk',
    );
    await expectViolation(
      update(id, `decision_note = $2`, ['x'.repeat(1001)]),
      CHECK,
      'vehicles_note_chk',
    );
  });

  it('lets a different officer, but not the same one, lift a fraud suspension', async () => {
    const first = await officerPromise();
    const second = await officerPromise();
    const id = await reach('APPROVED', first);
    await update(
      id,
      `status = 'SUSPENDED', decided_by = $2, decision_reason_code = 'SUSPECTED_FRAUD'`,
      [first],
    );
    await expectViolation(
      update(id, `status = 'APPROVED', decided_by = $2, decision_reason_code = NULL`, [first]),
      CHECK,
    );
    await update(id, `status = 'APPROVED', decided_by = $2, decision_reason_code = NULL`, [second]);

    // Other reasons: the same officer may reinstate.
    const other = await reach('SUSPENDED', first);
    await update(other, `status = 'APPROVED', decided_by = $2, decision_reason_code = NULL`, [
      first,
    ]);
  });
});

describe('vehicle_documents', () => {
  async function link(
    vehicleId: string,
    slot: string,
    documentId: string,
    purpose: string,
    expiresOn: string | null = null,
  ): Promise<void> {
    await insert('vehicle_documents', {
      vehicle_id: vehicleId,
      slot,
      document_id: documentId,
      purpose,
      expires_on: expiresOn,
    });
  }

  it('links only the owner’s own document with the matching purpose, each to one vehicle slot', async () => {
    const a = await owner();
    const b = await owner();
    const vehicleA = await vehicle(a.profileId);
    const vehicleB = await vehicle(b.profileId);
    const photo = await document(a.userId);
    await link(vehicleA, 'PHOTO_FRONT', photo, 'VEHICLE_PHOTO');
    // The same photo cannot be evidence for a second slot or vehicle.
    await expectViolation(link(vehicleA, 'PHOTO_BACK', photo, 'VEHICLE_PHOTO'), UNIQUE);
    // Another owner's vehicle: refused because the photo is not that owner's.
    await expectViolation(link(vehicleB, 'PHOTO_FRONT', photo, 'VEHICLE_PHOTO'), CHECK);
    // The same owner's second vehicle: a photo of vehicle A is never evidence for vehicle B.
    const sibling = await vehicle(a.profileId);
    await expectViolation(link(sibling, 'PHOTO_FRONT', photo, 'VEHICLE_PHOTO'), UNIQUE);
    // Someone else's document, or one with the wrong purpose.
    await expectViolation(
      link(vehicleB, 'PHOTO_BACK', await document(a.userId), 'VEHICLE_PHOTO'),
      CHECK,
    );
    await expectViolation(
      link(
        vehicleA,
        'PHOTO_LEFT',
        await document(a.userId, { purpose: 'OWNER_TIN' }),
        'VEHICLE_PHOTO',
      ),
      CHECK,
    );
  });

  it('keeps slot and purpose together, and expiry dates on insurance and inspection only', async () => {
    const a = await owner();
    const id = await vehicle(a.profileId);
    await expectViolation(
      link(id, 'REGISTRATION', await document(a.userId), 'VEHICLE_PHOTO'),
      CHECK,
      'vehicle_documents_slot_purpose_chk',
    );
    await expectViolation(
      link(
        id,
        'INSURANCE',
        await document(a.userId, { purpose: 'VEHICLE_INSURANCE' }),
        'VEHICLE_INSURANCE',
      ),
      CHECK,
      'vehicle_documents_expiry_chk',
    );
    await expectViolation(
      link(id, 'PHOTO_FRONT', await document(a.userId), 'VEHICLE_PHOTO', '2027-01-01'),
      CHECK,
      'vehicle_documents_expiry_chk',
    );
    await link(
      id,
      'INSURANCE',
      await document(a.userId, { purpose: 'VEHICLE_INSURANCE' }),
      'VEHICLE_INSURANCE',
      '2027-01-01',
    );
  });

  it('changes only while the vehicle is editable (or approved, which the service re-submits)', async () => {
    const officer = await staff();
    const a = await owner();
    const id = await vehicle(a.profileId);
    const doc = await document(a.userId);
    await link(id, 'PHOTO_FRONT', doc, 'VEHICLE_PHOTO');
    await update(id, `status = 'SUBMITTED', submitted_at = now()`);
    await expectViolation(
      pool.query(`DELETE FROM vehicle_documents WHERE vehicle_id = $1`, [id]),
      RESTRICT,
    );
    await expectViolation(
      link(id, 'PHOTO_BACK', await document(a.userId), 'VEHICLE_PHOTO'),
      RESTRICT,
    );
    await update(
      id,
      `status = 'UNDER_REVIEW', claimed_by = $2, claim_expires_at = now() + interval '1 hour'`,
      [officer],
    );
    await expectViolation(
      pool.query(`UPDATE vehicle_documents SET document_id = $2 WHERE vehicle_id = $1`, [
        id,
        await document(a.userId),
      ]),
      RESTRICT,
    );
  });

  it('stores vehicle evidence as images only', async () => {
    const a = await owner();
    for (const purpose of [
      'VEHICLE_REGISTRATION',
      'VEHICLE_OWNERSHIP',
      'VEHICLE_INSURANCE',
      'VEHICLE_INSPECTION',
      'VEHICLE_PHOTO',
    ]) {
      await expectViolation(
        document(a.userId, { purpose, declared_mime_type: 'application/pdf' }),
        CHECK,
        'documents_vehicle_purpose_mime_chk',
      );
      await document(a.userId, { purpose });
    }
  });
});

describe('vehicle_review_events', () => {
  it('is append-only with a well-formed action', async () => {
    const a = await owner();
    const id = await vehicle(a.profileId);
    const eventId = randomUUID();
    await insert('vehicle_review_events', {
      id: eventId,
      vehicle_id: id,
      action: 'created',
      to_status: 'DRAFT',
    });
    await expectViolation(
      pool.query(`UPDATE vehicle_review_events SET action = 'edited' WHERE id = $1`, [eventId]),
      RESTRICT,
    );
    await expectViolation(
      pool.query(`DELETE FROM vehicle_review_events WHERE id = $1`, [eventId]),
      RESTRICT,
    );
    await expectViolation(
      insert('vehicle_review_events', {
        id: randomUUID(),
        vehicle_id: id,
        action: 'Bad Action',
        to_status: 'DRAFT',
      }),
      CHECK,
      'vehicle_review_events_action_chk',
    );
  });
});
