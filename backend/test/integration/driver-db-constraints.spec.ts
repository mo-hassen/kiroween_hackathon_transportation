import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireTestDatabaseUrl } from '../helpers/test-env.js';

/** Phase 5 database guarantees (prisma/migrations/*_documents_drivers), tested with raw SQL. */
let pool: pg.Pool;
const CHECK = '23514';
const RESTRICT = '23001';
const UNIQUE = '23505';
const hex64 = (): string => randomBytes(32).toString('hex');
const phone = (): string =>
  `+2519${String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, '0')}`;

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
  });
  return id;
}

async function document(owner: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert('documents', {
    id,
    owner_user_id: owner,
    purpose: 'DRIVER_LICENSE_FRONT',
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

async function makeAvailable(id: string): Promise<void> {
  await pool.query(
    `UPDATE documents SET upload_status = 'AVAILABLE', storage_key = $2, mime_type = 'image/jpeg',
       size_bytes = 900, stored_sha256 = $3, processed_at = now(), scan_engine = 'test' WHERE id = $1`,
    [id, `documents/2026/11/${id}`, hex64()],
  );
}

async function profile(userId: string): Promise<string> {
  const id = randomUUID();
  await insert('driver_profiles', { id, user_id: userId, updated_at: new Date() });
  return id;
}

async function license(
  profileId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await insert('driver_licenses', {
    id,
    driver_profile_id: profileId,
    license_number_enc: Buffer.from('enc'),
    license_number_hmac: hex64(),
    license_number_last4: '1234',
    categories: ['B'],
    issued_on: '2022-01-01',
    expires_on: '2030-01-01',
    issuing_authority: 'Authority',
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

describe('documents', () => {
  it('accepts only server-format keys, allowed types and sizes up to 10 MB', async () => {
    const owner = await user();
    await expectViolation(
      document(owner, { upload_key: '../../etc/passwd' }),
      CHECK,
      'documents_upload_key_format_chk',
    );
    await expectViolation(
      document(owner, { declared_mime_type: 'text/html' }),
      CHECK,
      'documents_mime_chk',
    );
    await expectViolation(
      document(owner, { declared_size_bytes: 10_485_761 }),
      CHECK,
      'documents_size_chk',
    );
    await expectViolation(document(owner, { sha256: 'abc' }), CHECK, 'documents_sha256_format_chk');
  });

  it('belongs to customers and starts PENDING_UPLOAD/DRAFT', async () => {
    await expectViolation(document(await user('STAFF', 'PENDING_ACTIVATION')), CHECK);
    await expectViolation(document(await user(), { upload_status: 'AVAILABLE' }), CHECK);
  });

  it('cannot become AVAILABLE without the processed copy and scan record', async () => {
    const id = await document(await user());
    await expectViolation(
      pool.query(`UPDATE documents SET upload_status = 'AVAILABLE' WHERE id = $1`, [id]),
      CHECK,
      'documents_available_shape_chk',
    );
  });

  it('keeps owner, purpose, keys and declared facts immutable; terminal statuses stay terminal', async () => {
    const owner = await user();
    const id = await document(owner);
    for (const [column, value] of [
      ['owner_user_id', await user()],
      ['purpose', 'DRIVER_LICENSE_BACK'],
      ['sha256', hex64()],
      ['upload_key', `incoming/${randomUUID()}`],
    ] as const) {
      await expectViolation(
        pool.query(`UPDATE documents SET "${column}" = $2 WHERE id = $1`, [id, value]),
        RESTRICT,
      );
    }
    await pool.query(
      `UPDATE documents SET upload_status = 'INFECTED', failure_code = 'MALWARE_DETECTED' WHERE id = $1`,
      [id],
    );
    await expectViolation(
      pool.query(`UPDATE documents SET upload_status = 'UPLOADED' WHERE id = $1`, [id]),
      CHECK,
    );
    const available = await document(owner);
    await makeAvailable(available);
    await expectViolation(
      pool.query(`UPDATE documents SET upload_status = 'PROCESSING' WHERE id = $1`, [available]),
      CHECK,
    );
  });

  it('cannot be reviewed before it is available', async () => {
    const id = await document(await user());
    await expectViolation(
      pool.query(`UPDATE documents SET review_status = 'APPROVED' WHERE id = $1`, [id]),
      CHECK,
      'documents_review_needs_available_chk',
    );
  });
});

describe('driver profiles and licences', () => {
  it('one profile per customer; staff cannot have one', async () => {
    const id = await user();
    await profile(id);
    await expectViolation(profile(id), UNIQUE);
    await expectViolation(profile(await user('STAFF', 'PENDING_ACTIVATION')), CHECK);
  });

  it('a suspended profile is SUSPENDED and has a reason (and vice versa)', async () => {
    const id = await profile(await user());
    await expectViolation(
      pool.query(`UPDATE driver_profiles SET eligibility_status = 'SUSPENDED' WHERE id = $1`, [id]),
      CHECK,
      'driver_profiles_suspension_chk',
    );
    await expectViolation(
      pool.query(
        `UPDATE driver_profiles SET eligibility_status = 'ELIGIBLE', suspended_at = now(), suspended_reason = 'OTHER' WHERE id = $1`,
        [id],
      ),
      CHECK,
    );
  });

  it('enforces dates, unique licence numbers and category format', async () => {
    const p1 = await profile(await user());
    await expectViolation(
      license(p1, { expires_on: '2021-01-01' }),
      CHECK,
      'driver_licenses_dates_chk',
    );
    await expectViolation(license(p1, { categories: [] }), CHECK, 'driver_licenses_categories_chk');
    await expectViolation(
      license(p1, { categories: ['b; drop'] }),
      CHECK,
      'driver_licenses_categories_chk',
    );
    const hmac = hex64();
    await license(p1, { license_number_hmac: hmac });
    await expectViolation(
      license(await profile(await user()), { license_number_hmac: hmac }),
      UNIQUE,
    );
  });

  it('starts DRAFT and follows only the review transition table', async () => {
    const p = await profile(await user());
    await expectViolation(license(p, { review_status: 'APPROVED' }), CHECK);
    const id = await license(p);
    await expectViolation(
      pool.query(`UPDATE driver_licenses SET review_status = 'UNDER_REVIEW' WHERE id = $1`, [id]),
      CHECK,
    );
    await pool.query(
      `UPDATE driver_licenses SET review_status = 'SUBMITTED', submitted_at = now() WHERE id = $1`,
      [id],
    );
    await expectViolation(
      pool.query(
        `UPDATE driver_licenses SET review_status = 'APPROVED', decided_by = $2, decided_at = now() WHERE id = $1`,
        [id, await user()],
      ),
      CHECK,
    );
  });

  it('freezes licence details outside DRAFT', async () => {
    const id = await license(await profile(await user()));
    await pool.query(
      `UPDATE driver_licenses SET review_status = 'SUBMITTED', submitted_at = now() WHERE id = $1`,
      [id],
    );
    await expectViolation(
      pool.query(`UPDATE driver_licenses SET expires_on = '2035-01-01' WHERE id = $1`, [id]),
      RESTRICT,
    );
  });

  it('refuses the driver and non-officers as claimer', async () => {
    const driverUser = await user();
    const id = await license(await profile(driverUser));
    await pool.query(
      `UPDATE driver_licenses SET review_status = 'SUBMITTED', submitted_at = now() WHERE id = $1`,
      [id],
    );
    const claim = (who: string) =>
      pool.query(
        `UPDATE driver_licenses SET review_status = 'UNDER_REVIEW', claimed_by = $2, claim_expires_at = now() + interval '30 minutes' WHERE id = $1`,
        [id, who],
      );
    await expectViolation(claim(driverUser), CHECK);
    await expectViolation(claim(await user('STAFF', 'PENDING_ACTIVATION')), CHECK);
  });

  it('links only own documents with the matching purpose, each to one licence', async () => {
    const owner = await user();
    const id = await license(await profile(owner));
    const front = await document(owner);
    const foreign = await document(await user());
    const link = (doc: string, purpose = 'DRIVER_LICENSE_FRONT', licenseId = id) =>
      insert('driver_license_documents', {
        driver_license_id: licenseId,
        document_id: doc,
        purpose,
      });
    await expectViolation(link(foreign), CHECK);
    await expectViolation(link(front, 'DRIVER_LICENSE_BACK'), CHECK);
    await link(front);
    // Reuse on another account's licence: refused by the ownership trigger (the unique key
    // on document_id is the second line of defence).
    const otherLicense = await license(await profile(await user()));
    await expectViolation(link(front, 'DRIVER_LICENSE_FRONT', otherLicense), CHECK);
  });

  it('keeps the review history append-only', async () => {
    const id = await license(await profile(await user()));
    const eventId = randomUUID();
    await insert('driver_review_events', {
      id: eventId,
      driver_license_id: id,
      action: 'created',
      to_status: 'DRAFT',
    });
    await expectViolation(
      pool.query(`UPDATE driver_review_events SET note = 'x' WHERE id = $1`, [eventId]),
      RESTRICT,
    );
    await expectViolation(
      pool.query(`DELETE FROM driver_review_events WHERE id = $1`, [eventId]),
      RESTRICT,
    );
  });
});

describe('notifications', () => {
  it('stores template keys only and deduplicates per recipient', async () => {
    const recipient = await user();
    const row = {
      recipient_user_id: recipient,
      event_type: 'driver.approved',
      dedupe_key: 'k1',
      title_key: 'notif.driver.approved.title',
      body_key: 'notif.driver.approved.body',
    };
    await insert('notifications', { id: randomUUID(), ...row });
    await expectViolation(insert('notifications', { id: randomUUID(), ...row }), UNIQUE);
    await expectViolation(
      insert('notifications', {
        id: randomUUID(),
        ...row,
        dedupe_key: 'k2',
        title_key: '<b>Hi</b>',
      }),
      CHECK,
    );
  });
});
