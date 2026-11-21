import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireTestDatabaseUrl } from '../helpers/test-env.js';

/**
 * Phase 6 database guarantees (prisma/migrations/*_owner_verification), tested with raw SQL
 * so that a bug in the services could not bypass them: officers only, never the owner, two
 * different officers for an organization, frozen details, own documents, append-only history.
 */
let pool: pg.Pool;
const CHECK = '23514';
const RESTRICT = '23001';
const UNIQUE = '23505';
const STATUSES = [
  'UNVERIFIED',
  'PENDING',
  'VERIFIED',
  'REJECTED',
  'SUSPENDED',
  'EXPIRED',
  'REVERIFICATION_REQUIRED',
] as const;
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
    ...(accountType === 'STAFF' && status === 'ACTIVE'
      ? { mfa_enrolled_at: new Date(), mfa_secret_enc: Buffer.from('secret') }
      : {}),
  });
  return id;
}

/** An active staff account; with [role] VERIFICATION_OFFICER by default. */
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

async function ownerProfile(
  userId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await insert('owner_profiles', {
    id,
    user_id: userId,
    owner_type: 'ORGANIZATION',
    organization_name: 'Abebe Transport PLC',
    tin_enc: Buffer.from('enc'),
    tin_hmac: hex64(),
    tin_last4: '6789',
    updated_at: new Date(),
    ...overrides,
  });
  return id;
}

async function individual(userId: string): Promise<string> {
  return ownerProfile(userId, {
    owner_type: 'INDIVIDUAL',
    organization_name: null,
    tin_enc: null,
    tin_hmac: null,
    tin_last4: null,
  });
}

const update = (id: string, set: string, params: unknown[] = []) =>
  pool.query(`UPDATE owner_profiles SET ${set} WHERE id = $1`, [id, ...params]);
const submit = (id: string) => update(id, `verification_status = 'PENDING', submitted_at = now()`);

async function document(owner: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert('documents', {
    id,
    owner_user_id: owner,
    purpose: 'OWNER_TIN',
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

describe('owner_profiles', () => {
  it('belongs to customers only, one per user, and starts UNVERIFIED without review data', async () => {
    await expectViolation(individual(await staff()), CHECK);
    const customer = await user();
    await individual(customer);
    await expectViolation(individual(customer), UNIQUE);
    await expectViolation(ownerProfile(await user(), { verification_status: 'VERIFIED' }), CHECK);
    await expectViolation(ownerProfile(await user(), { claimed_by: await staff() }), CHECK);
  });

  it('keeps the type-dependent shape and formats', async () => {
    await expectViolation(
      ownerProfile(await user(), { organization_name: null }),
      CHECK,
      'owner_profiles_type_shape_chk',
    );
    await expectViolation(
      ownerProfile(await user(), { owner_type: 'INDIVIDUAL' }),
      CHECK,
      'owner_profiles_type_shape_chk',
    );
    await expectViolation(
      ownerProfile(await user(), { tin_hmac: 'not-hex' }),
      CHECK,
      'owner_profiles_tin_format_chk',
    );
    await expectViolation(
      ownerProfile(await user(), { organization_name: 'Bad\u0001Name' }),
      CHECK,
      'owner_profiles_org_name_chk',
    );
  });

  it('allows one organization per TIN (HMAC unique)', async () => {
    const hmac = hex64();
    await ownerProfile(await user(), { tin_hmac: hmac });
    await expectViolation(ownerProfile(await user(), { tin_hmac: hmac }), UNIQUE);
  });

  it('refuses every status transition outside the table', async () => {
    const allowed = new Set([
      'UNVERIFIED->PENDING',
      'PENDING->VERIFIED',
      'PENDING->REJECTED',
      'REJECTED->PENDING',
      'VERIFIED->SUSPENDED',
      'VERIFIED->EXPIRED',
      'VERIFIED->REVERIFICATION_REQUIRED',
      'SUSPENDED->VERIFIED',
      'SUSPENDED->REVERIFICATION_REQUIRED',
      'EXPIRED->PENDING',
      'REVERIFICATION_REQUIRED->PENDING',
    ]);
    const officer = await staff();
    // Puts a fresh individual profile into [status] through allowed steps.
    const reach = async (status: (typeof STATUSES)[number]): Promise<string> => {
      const id = await individual(await user());
      if (status === 'UNVERIFIED') return id;
      await submit(id);
      if (status === 'PENDING') return id;
      if (status === 'REJECTED') {
        await update(
          id,
          `verification_status = 'REJECTED', decided_by = $2, decided_at = now(), decision_reason_code = 'OTHER'`,
          [officer],
        );
        return id;
      }
      await update(
        id,
        `verification_status = 'VERIFIED', verified_by = $2, verified_at = now(), decided_by = $2, decided_at = now()`,
        [officer],
      );
      if (status === 'VERIFIED') return id;
      if (status === 'SUSPENDED') {
        await update(id, `verification_status = 'SUSPENDED', decision_reason_code = 'OTHER'`);
        return id;
      }
      await update(id, `verification_status = '${status}'`);
      return id;
    };
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (from === to || allowed.has(`${from}->${to}`)) continue;
        const id = await reach(from);
        await expectViolation(
          update(
            id,
            `verification_status = '${to}', submitted_at = now(), verified_by = $2, verified_at = now(),
             decided_by = $2, decided_at = now(), decision_reason_code = 'OTHER'`,
            [officer],
          ),
          CHECK,
        );
      }
    }
  });

  it('freezes details while PENDING or VERIFIED and the type after a first submission', async () => {
    const id = await ownerProfile(await user());
    await submit(id);
    await expectViolation(update(id, `organization_name = 'Renamed PLC'`), RESTRICT);
    await expectViolation(update(id, `tin_hmac = $2`, [hex64()]), RESTRICT);

    const officer = await staff();
    const expired = await individual(await user());
    await submit(expired);
    await update(
      expired,
      `verification_status = 'VERIFIED', verified_by = $2, verified_at = now(), decided_by = $2, decided_at = now()`,
      [officer],
    );
    await update(expired, `verification_status = 'EXPIRED'`);
    // EXPIRED allows corrections, but not a different owner type.
    await expectViolation(
      update(
        expired,
        `owner_type = 'ORGANIZATION', organization_name = 'X PLC', tin_enc = 'x', tin_hmac = $2, tin_last4 = '1'`,
        [hex64()],
      ),
      RESTRICT,
    );
  });

  it('refuses the owner, customers, staff without the role and inactive officers as reviewers', async () => {
    const ownerUser = await user();
    const id = await ownerProfile(ownerUser);
    await submit(id);
    const claim = (who: string) =>
      update(id, `claimed_by = $2, claim_expires_at = now() + interval '30 minutes'`, [who]);
    await expectViolation(claim(ownerUser), CHECK);
    await expectViolation(claim(await user()), CHECK);
    await expectViolation(claim(await staff('SUPPORT')), CHECK);
    await expectViolation(claim(await staff('SUPER_ADMIN')), CHECK);
    const locked = await staff();
    await pool.query(`UPDATE users SET status = 'LOCKED' WHERE id = $1`, [locked]);
    await expectViolation(claim(locked), CHECK);
    await claim(await staff());
    // A claim exists only while PENDING.
    await expectViolation(
      update(
        id,
        `verification_status = 'REJECTED', decided_by = $2, decided_at = now(), decision_reason_code = 'OTHER'`,
        [await staff()],
      ),
      CHECK,
      'owner_profiles_claim_shape_chk',
    );
  });

  it('never lets the owner approve themselves or decide their own case', async () => {
    const ownerUser = await user();
    const id = await individual(ownerUser);
    await submit(id);
    await expectViolation(
      update(
        id,
        `verification_status = 'VERIFIED', verified_by = $2, verified_at = now(), decided_by = $2, decided_at = now()`,
        [ownerUser],
      ),
      CHECK,
    );
    await expectViolation(
      update(
        id,
        `verification_status = 'REJECTED', decided_by = $2, decided_at = now(), decision_reason_code = 'OTHER'`,
        [ownerUser],
      ),
      CHECK,
    );
  });

  it('requires two different officers before an organization is VERIFIED (four-eyes)', async () => {
    const [first, second] = [await staff(), await staff()];
    const id = await ownerProfile(await user());
    await submit(id);
    const verifyBy = (who: string) =>
      update(
        id,
        `verification_status = 'VERIFIED', verified_by = $2, verified_at = now(), decided_by = $2, decided_at = now()`,
        [who],
      );
    // Without a first approval.
    await expectViolation(verifyBy(second), CHECK, 'owner_profiles_four_eyes_chk');
    await update(id, `first_approved_by = $2, first_approved_at = now()`, [first]);
    // The first approver as the second approver.
    await expectViolation(verifyBy(first), CHECK, 'owner_profiles_four_eyes_chk');
    await verifyBy(second);
    // The first approval can no longer be swapped to the verifier
    // (refused by the trigger: a first approval is only recorded while PENDING).
    await expectViolation(update(id, `first_approved_by = $2`, [second]), CHECK);
    // Individuals have no first approval.
    const person = await individual(await user());
    await submit(person);
    await expectViolation(
      update(person, `first_approved_by = $2, first_approved_at = now()`, [first]),
      CHECK,
      'owner_profiles_first_approval_chk',
    );
  });

  it('a rejection or suspension needs a decider and a reason', async () => {
    const id = await individual(await user());
    await submit(id);
    await expectViolation(
      update(id, `verification_status = 'REJECTED', decided_by = $2, decided_at = now()`, [
        await staff(),
      ]),
      CHECK,
      'owner_profiles_decision_chk',
    );
  });
});

describe('owner_documents', () => {
  it('links only own, matching-purpose documents of an organization, each to one profile', async () => {
    const ownerUser = await user();
    const id = await ownerProfile(ownerUser);
    const tinDoc = await document(ownerUser);
    const link = (doc: string, purpose = 'OWNER_TIN', profileId = id) =>
      insert('owner_documents', { owner_profile_id: profileId, document_id: doc, purpose });
    await expectViolation(link(await document(await user())), CHECK);
    await expectViolation(link(tinDoc, 'OWNER_BUSINESS_LICENSE'), CHECK);
    await expectViolation(
      link(await document(ownerUser, { purpose: 'DRIVER_LICENSE_FRONT' }), 'DRIVER_LICENSE_FRONT'),
      CHECK,
      'owner_documents_purpose_chk',
    );
    await link(tinDoc);
    const otherUser = await user();
    await expectViolation(link(tinDoc, 'OWNER_TIN', await ownerProfile(otherUser)), CHECK);
    // An individual owner has no organization documents.
    const personUser = await user();
    await expectViolation(
      link(await document(personUser), 'OWNER_TIN', await individual(personUser)),
      CHECK,
    );
  });

  it('cannot change while the case is pending', async () => {
    const ownerUser = await user();
    const id = await ownerProfile(ownerUser);
    await insert('owner_documents', {
      owner_profile_id: id,
      document_id: await document(ownerUser),
      purpose: 'OWNER_TIN',
    });
    await submit(id);
    await expectViolation(
      pool.query(`DELETE FROM owner_documents WHERE owner_profile_id = $1`, [id]),
      RESTRICT,
    );
    await expectViolation(
      insert('owner_documents', {
        owner_profile_id: id,
        document_id: await document(ownerUser, { purpose: 'OWNER_BUSINESS_LICENSE' }),
        purpose: 'OWNER_BUSINESS_LICENSE',
      }),
      RESTRICT,
    );
  });

  it('organization documents are images only', async () => {
    await expectViolation(
      document(await user(), { declared_mime_type: 'application/pdf' }),
      CHECK,
      'documents_owner_purpose_mime_chk',
    );
    // Driver licence documents keep their Phase 5 rules.
    await document(await user(), {
      purpose: 'DRIVER_LICENSE_FRONT',
      declared_mime_type: 'application/pdf',
    });
  });
});

describe('owner_review_events', () => {
  it('is append-only', async () => {
    const id = await individual(await user());
    const eventId = randomUUID();
    await insert('owner_review_events', {
      id: eventId,
      owner_profile_id: id,
      action: 'created',
      to_status: 'UNVERIFIED',
    });
    await expectViolation(
      pool.query(`UPDATE owner_review_events SET note = 'x' WHERE id = $1`, [eventId]),
      RESTRICT,
    );
    await expectViolation(
      pool.query(`DELETE FROM owner_review_events WHERE id = $1`, [eventId]),
      RESTRICT,
    );
  });
});
