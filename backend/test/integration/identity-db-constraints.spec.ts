import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireTestDatabaseUrl } from '../helpers/test-env.js';

/** Phase 4 database guarantees (prisma/migrations/*_identity), tested with raw SQL. */
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

async function user(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert('users', {
    id,
    phone_e164: phone(),
    password_hash: '!unusable',
    account_type: 'CUSTOMER',
    status: 'ACTIVE',
    updated_at: new Date(),
    ...overrides,
  });
  return id;
}

async function attempt(userId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await insert('identity_verifications', {
    id,
    user_id: userId,
    provider: 'DEV',
    previous_identity_status: 'UNVERIFIED',
    consented_at: new Date(),
    state_hash: hex64(),
    request_secrets_enc: Buffer.from('encrypted'),
    session_expires_at: new Date(Date.now() + 900_000),
    updated_at: new Date(),
    ...overrides,
  });
  return id;
}

/** Drives an attempt to VERIFIED the way the service does (attempt first, then account). */
async function verify(userId: string, attemptId: string, subject = hex64()): Promise<string> {
  await pool.query(`UPDATE users SET identity_status = 'PENDING' WHERE id = $1`, [userId]);
  await pool.query(
    `UPDATE identity_verifications SET status = 'VERIFIED', completed_at = now(), verified_at = now(),
       valid_until = now() + interval '24 months', subject_hmac = $2, verified_claims_enc = 'x',
       request_secrets_enc = NULL WHERE id = $1`,
    [attemptId, subject],
  );
  await pool.query(
    `UPDATE users SET identity_status = 'VERIFIED', identity_subject_hmac = $2 WHERE id = $1`,
    [userId, subject],
  );
  return subject;
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

describe('users (identity columns)', () => {
  it('cannot become VERIFIED without a verified attempt for the bound subject', async () => {
    const id = await user();
    await pool.query(`UPDATE users SET identity_status = 'PENDING' WHERE id = $1`, [id]);
    await expectViolation(
      pool.query(
        `UPDATE users SET identity_status = 'VERIFIED', identity_subject_hmac = $2 WHERE id = $1`,
        [id, hex64()],
      ),
      CHECK,
    );
  });

  it('only allows the documented account transitions (e.g. never UNVERIFIED -> VERIFIED)', async () => {
    const id = await user();
    await expectViolation(
      pool.query(`UPDATE users SET identity_status = 'VERIFIED' WHERE id = $1`, [id]),
      CHECK,
    );
    await expectViolation(
      pool.query(`UPDATE users SET identity_status = 'SUSPENDED' WHERE id = $1`, [id]),
      CHECK,
    );
  });

  it('binds the identity subject once', async () => {
    const id = await user();
    const subject = await verify(id, await attempt(id));
    expect(subject).toMatch(/^[0-9a-f]{64}$/);
    await expectViolation(
      pool.query(`UPDATE users SET identity_subject_hmac = $2 WHERE id = $1`, [id, hex64()]),
      RESTRICT,
    );
    await expectViolation(
      pool.query(`UPDATE users SET identity_subject_hmac = NULL WHERE id = $1`, [id]),
      RESTRICT,
    );
  });

  it('links one identity to one account (BR-ID-2)', async () => {
    const subject = hex64();
    const first = await user();
    await verify(first, await attempt(first), subject);
    const second = await user();
    await expectViolation(
      pool.query(`UPDATE users SET identity_subject_hmac = $2 WHERE id = $1`, [second, subject]),
      UNIQUE,
      'users_identity_subject_hmac_key',
    );
  });

  it('gives staff accounts no customer identity', async () => {
    await expectViolation(
      user({ account_type: 'STAFF', status: 'PENDING_ACTIVATION', identity_status: 'PENDING' }),
      CHECK,
      'users_staff_has_no_identity_chk',
    );
    const staff = await user({ account_type: 'STAFF', status: 'PENDING_ACTIVATION' });
    await expectViolation(attempt(staff), CHECK);
  });

  it('stores the subject as a hex HMAC only', async () => {
    await expectViolation(
      user({ identity_subject_hmac: 'raw-fayda-number-123456789012' }),
      CHECK,
      'users_identity_subject_format_chk',
    );
  });
});

describe('identity_verifications', () => {
  it('starts PENDING', async () => {
    await expectViolation(attempt(await user(), { status: 'VERIFIED' }), CHECK);
  });

  it('only allows the documented attempt transitions', async () => {
    const id = await user();
    const rejected = await attempt(id);
    await pool.query(
      `UPDATE identity_verifications SET status = 'REJECTED', completed_at = now(), outcome_code = 'IDENTITY_MISMATCH', request_secrets_enc = NULL WHERE id = $1`,
      [rejected],
    );
    await expectViolation(
      pool.query(`UPDATE identity_verifications SET status = 'PENDING' WHERE id = $1`, [rejected]),
      CHECK,
    );
    await expectViolation(
      pool.query(
        `UPDATE identity_verifications SET status = 'VERIFIED', verified_at = now(), valid_until = now() + interval '1 day', subject_hmac = $2, verified_claims_enc = 'x' WHERE id = $1`,
        [rejected, hex64()],
      ),
      CHECK,
    );
  });

  it('keeps identifying columns immutable and the callback marker single-use', async () => {
    const id = await attempt(await user());
    for (const column of [
      'user_id',
      'state_hash',
      'session_expires_at',
      'previous_identity_status',
    ]) {
      const value =
        column === 'user_id'
          ? await user()
          : column === 'state_hash'
            ? hex64()
            : column === 'previous_identity_status'
              ? 'REJECTED'
              : new Date(Date.now() + 1_000_000);
      await expectViolation(
        pool.query(`UPDATE identity_verifications SET "${column}" = $2 WHERE id = $1`, [id, value]),
        RESTRICT,
      );
    }
    await pool.query(
      `UPDATE identity_verifications SET callback_received_at = now() WHERE id = $1`,
      [id],
    );
    await expectViolation(
      pool.query(
        `UPDATE identity_verifications SET callback_received_at = now() + interval '1 second' WHERE id = $1`,
        [id],
      ),
      RESTRICT,
    );
  });

  it('erases session secrets when the attempt ends and requires an outcome code', async () => {
    const id = await attempt(await user());
    await expectViolation(
      pool.query(
        `UPDATE identity_verifications SET status = 'FAILED', completed_at = now(), outcome_code = 'PROVIDER_ERROR' WHERE id = $1`,
        [id],
      ),
      CHECK,
      'identity_secrets_only_while_pending_chk',
    );
    await expectViolation(
      pool.query(
        `UPDATE identity_verifications SET status = 'FAILED', completed_at = now(), request_secrets_enc = NULL WHERE id = $1`,
        [id],
      ),
      CHECK,
      'identity_outcome_required_chk',
    );
  });

  it('requires a verified attempt to carry its encrypted result', async () => {
    const id = await attempt(await user());
    await expectViolation(
      pool.query(
        `UPDATE identity_verifications SET status = 'VERIFIED', completed_at = now(), verified_at = now(), valid_until = now() + interval '1 day', request_secrets_enc = NULL WHERE id = $1`,
        [id],
      ),
      CHECK,
      'identity_verified_shape_chk',
    );
  });

  it('allows one open attempt and one current identity per user, and a subject on one verified attempt', async () => {
    const id = await user();
    await attempt(id);
    await expectViolation(attempt(id), UNIQUE, 'identity_verifications_one_pending_per_user');

    const subject = hex64();
    const holder = await user();
    await verify(holder, await attempt(holder), subject);
    const other = await user();
    const otherAttempt = await attempt(other);
    await expectViolation(
      pool.query(
        `UPDATE identity_verifications SET status = 'VERIFIED', completed_at = now(), verified_at = now(),
           valid_until = now() + interval '1 day', subject_hmac = $2, verified_claims_enc = 'x',
           request_secrets_enc = NULL WHERE id = $1`,
        [otherAttempt, subject],
      ),
      UNIQUE,
      'identity_verifications_verified_subject_key',
    );
  });

  it('keeps a held provider result only while PENDING, complete and after the callback', async () => {
    const id = await attempt(await user());
    const held = (extra = '') =>
      pool.query(
        `UPDATE identity_verifications SET pending_result_enc = 'x', confirmation_hash = $2,
           confirmation_expires_at = now() + interval '10 minutes'${extra} WHERE id = $1`,
        [id, hex64()],
      );
    await expectViolation(held(), CHECK, 'identity_result_after_callback_chk');
    await pool.query(
      `UPDATE identity_verifications SET callback_received_at = now() WHERE id = $1`,
      [id],
    );
    await expectViolation(
      pool.query(`UPDATE identity_verifications SET confirmation_hash = $2 WHERE id = $1`, [
        id,
        hex64(),
      ]),
      CHECK,
      'identity_result_shape_chk',
    );
    await expectViolation(
      pool.query(
        `UPDATE identity_verifications SET pending_result_enc = 'x', confirmation_hash = 'raw-token',
           confirmation_expires_at = now() WHERE id = $1`,
        [id],
      ),
      CHECK,
      'identity_confirmation_hash_format_chk',
    );
    await held();
    await expectViolation(
      pool.query(
        `UPDATE identity_verifications SET status = 'FAILED', completed_at = now(), outcome_code = 'PROVIDER_ERROR', request_secrets_enc = NULL WHERE id = $1`,
        [id],
      ),
      CHECK,
      'identity_result_only_while_pending_chk',
    );
  });

  it('never changes the session an attempt is bound to', async () => {
    const id = await attempt(await user());
    await expectViolation(
      pool.query(`UPDATE identity_verifications SET initiated_session_id = $2 WHERE id = $1`, [
        id,
        randomUUID(),
      ]),
      RESTRICT,
    );
  });

  it('stores the state as a SHA-256 hex digest only', async () => {
    await expectViolation(
      attempt(await user(), { state_hash: 'raw-state-value' }),
      CHECK,
      'identity_state_hash_format_chk',
    );
  });
});
