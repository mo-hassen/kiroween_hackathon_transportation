import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { requireTestDatabaseUrl } from '../helpers/test-env.js';

/**
 * Database-level guarantees from docs/architecture/03-database-schema.md, tested with raw
 * SQL so they hold no matter which code path writes to the database.
 */
let pool: pg.Pool;

const randomPhone = (): string =>
  `+2519${String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, '0')}`;

async function insertUser(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = {
    id: randomUUID(),
    phone_e164: randomPhone(),
    password_hash: 'argon2id$placeholder-hash',
    account_type: 'CUSTOMER',
    updated_at: new Date(),
    ...overrides,
  };
  const columns = Object.keys(row);
  const values = Object.values(row);
  await pool.query(
    `INSERT INTO users (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    values,
  );
  return row.id;
}

/** Asserts the statement fails with the given SQLSTATE and (optionally) constraint name. */
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
  if (constraint !== undefined) {
    expect(error?.constraint).toBe(constraint);
  }
}

const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const RESTRICT = '23001';

beforeAll(() => {
  pool = new pg.Pool({ connectionString: requireTestDatabaseUrl(), max: 2 });
});
afterAll(async () => {
  await pool.end();
});

describe('users', () => {
  it('rejects duplicate phone numbers', async () => {
    const phone = randomPhone();
    await insertUser({ phone_e164: phone });
    await expectViolation(insertUser({ phone_e164: phone }), UNIQUE, 'users_phone_e164_key');
  });

  it.each(['0911234567', '+251111234567', '+25191123456', '+254711234567'])(
    'rejects non-normalized or non-mobile phone %s',
    async (phone) => {
      await expectViolation(
        insertUser({ phone_e164: phone }),
        CHECK,
        'users_phone_e164_format_chk',
      );
    },
  );

  it('rejects non-lowercase or malformed email', async () => {
    await expectViolation(
      insertUser({ email: 'Abebe@Example.com' }),
      CHECK,
      'users_email_normalized_chk',
    );
    await expectViolation(
      insertUser({ email: 'not-an-email' }),
      CHECK,
      'users_email_normalized_chk',
    );
  });

  it('rejects duplicate email', async () => {
    const email = `u${randomBytes(4).toString('hex')}@example.com`;
    await insertUser({ email });
    await expectViolation(insertUser({ email }), UNIQUE, 'users_email_key');
  });

  it('requires closed_at exactly when status is CLOSED', async () => {
    await expectViolation(insertUser({ status: 'CLOSED' }), CHECK, 'users_closed_consistency_chk');
    await expectViolation(
      insertUser({ closed_at: new Date() }),
      CHECK,
      'users_closed_consistency_chk',
    );
    await expect(insertUser({ status: 'CLOSED', closed_at: new Date() })).resolves.toBeDefined();
  });

  it('rejects negative counters and unknown enum values', async () => {
    await expectViolation(
      insertUser({ failed_login_count: -1 }),
      CHECK,
      'users_failed_login_count_chk',
    );
    await expectViolation(insertUser({ account_type: 'ROOT' }), '22P02');
  });

  it('defaults new users to PENDING_PHONE and UNVERIFIED identity', async () => {
    const id = await insertUser();
    const { rows } = await pool.query<{ status: string; identity_status: string }>(
      'SELECT status, identity_status FROM users WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ status: 'PENDING_PHONE', identity_status: 'UNVERIFIED' });
  });
});

describe('devices and sessions', () => {
  async function insertSession(
    userId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    const row = {
      id: randomUUID(),
      user_id: userId,
      refresh_token_family: randomUUID(),
      current_token_hash: randomBytes(32).toString('hex'),
      expires_at: new Date(Date.now() + 86_400_000),
      updated_at: new Date(),
      ...overrides,
    };
    const columns = Object.keys(row);
    await pool.query(
      `INSERT INTO sessions (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }

  it('rejects a device registered twice for the same user', async () => {
    const userId = await insertUser();
    const insert = () =>
      pool.query(
        `INSERT INTO devices (id, user_id, installation_id, platform, updated_at) VALUES ($1, $2, 'install-0001', 'ANDROID', now())`,
        [randomUUID(), userId],
      );
    await insert();
    await expectViolation(insert(), UNIQUE, 'devices_user_id_installation_id_key');
  });

  it('rejects sessions for unknown users', async () => {
    await expectViolation(insertSession(randomUUID()), FOREIGN_KEY);
  });

  it('rejects duplicate refresh-token hashes', async () => {
    const userId = await insertUser();
    const hash = randomBytes(32).toString('hex');
    await insertSession(userId, { current_token_hash: hash });
    await expectViolation(
      insertSession(userId, { current_token_hash: hash }),
      UNIQUE,
      'sessions_current_token_hash_key',
    );
  });

  it('rejects sessions that expire before they are created', async () => {
    const userId = await insertUser();
    await expectViolation(
      insertSession(userId, { expires_at: new Date(Date.now() - 1000) }),
      CHECK,
      'sessions_expiry_after_creation_chk',
    );
  });

  it('requires a reason whenever a session is revoked', async () => {
    const userId = await insertUser();
    await expectViolation(
      insertSession(userId, { revoked_at: new Date() }),
      CHECK,
      'sessions_revocation_reason_chk',
    );
  });

  it('rejects a rotation that reuses the current token hash', async () => {
    const userId = await insertUser();
    const hash = randomBytes(32).toString('hex');
    await expectViolation(
      insertSession(userId, { current_token_hash: hash, previous_token_hash: hash }),
      CHECK,
      'sessions_token_rotation_chk',
    );
  });

  it('refuses to delete a user that still has sessions', async () => {
    const userId = await insertUser();
    await insertSession(userId);
    await expectViolation(pool.query('DELETE FROM users WHERE id = $1', [userId]), FOREIGN_KEY);
  });
});

describe('audit_logs (append-only)', () => {
  async function insertAudit(action = 'test.created'): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO audit_logs (id, actor_type, action, target_type, target_id) VALUES ($1, 'SYSTEM', $2, 'test', 't-1')`,
      [id, action],
    );
    return id;
  }

  it('accepts inserts', async () => {
    await expect(insertAudit()).resolves.toBeDefined();
  });

  it('rejects badly formed action names', async () => {
    await expectViolation(insertAudit('Vehicle Approved'), CHECK, 'audit_action_format_chk');
  });

  it('rejects UPDATE of business columns', async () => {
    const id = await insertAudit();
    await expectViolation(
      pool.query(`UPDATE audit_logs SET action = 'test.tampered' WHERE id = $1`, [id]),
      RESTRICT,
    );
  });

  it('rejects DELETE and TRUNCATE', async () => {
    const id = await insertAudit();
    await expectViolation(pool.query('DELETE FROM audit_logs WHERE id = $1', [id]), RESTRICT);
    await expectViolation(pool.query('TRUNCATE audit_logs'), RESTRICT);
  });

  it('allows sealing the hash chain exactly once, without other changes', async () => {
    const id = await insertAudit();
    await expectViolation(
      pool.query(`UPDATE audit_logs SET hash = 'h1', reason = 'sneaky' WHERE id = $1`, [id]),
      RESTRICT,
    );
    await pool.query(`UPDATE audit_logs SET prev_hash = 'h0', hash = 'h1' WHERE id = $1`, [id]);
    await expectViolation(
      pool.query(`UPDATE audit_logs SET hash = 'h2' WHERE id = $1`, [id]),
      RESTRICT,
    );
  });
});

describe('idempotency_records and outbox_events', () => {
  async function insertIdempotency(overrides: Record<string, unknown> = {}): Promise<void> {
    const row = {
      id: randomUUID(),
      scope: 'applications.create',
      principal: 'user-1',
      key: randomUUID(),
      request_hash: 'h',
      locked_until: new Date(),
      expires_at: new Date(Date.now() + 86_400_000),
      updated_at: new Date(),
      ...overrides,
    };
    const columns = Object.keys(row);
    await pool.query(
      `INSERT INTO idempotency_records (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  }

  it('rejects the same key twice for one scope and principal', async () => {
    const key = randomUUID();
    await insertIdempotency({ key });
    await expectViolation(
      insertIdempotency({ key }),
      UNIQUE,
      'idempotency_records_scope_principal_key_key',
    );
    await expect(insertIdempotency({ key, principal: 'user-2' })).resolves.toBeUndefined();
  });

  it('validates key format and completed responses', async () => {
    await expectViolation(insertIdempotency({ key: 'short' }), CHECK, 'idempotency_key_format_chk');
    await expectViolation(
      insertIdempotency({ status: 'COMPLETED' }),
      CHECK,
      'idempotency_completed_has_response_chk',
    );
  });

  it('validates outbox event types and attempts', async () => {
    const insert = (eventType: string, attempts = 0) =>
      pool.query(
        `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload, attempts) VALUES ($1, 'user', 'u', $2, '{}', $3)`,
        [randomUUID(), eventType, attempts],
      );
    await expect(insert('user.registered')).resolves.toBeDefined();
    await expectViolation(insert('UserRegistered'), CHECK, 'outbox_event_type_format_chk');
    await expectViolation(insert('user.registered', -1), CHECK, 'outbox_attempts_chk');
  });
});

describe('schema objects', () => {
  it('creates the partial indexes with their WHERE clauses', async () => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('sessions_active_user_idx', 'outbox_events_pending_idx')`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName['sessions_active_user_idx']).toMatch(/WHERE \(revoked_at IS NULL\)/);
    expect(byName['outbox_events_pending_idx']).toMatch(/WHERE \(processed_at IS NULL\)/);
  });

  it('generates time-ordered UUIDv7 ids through the Prisma client', async () => {
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: requireTestDatabaseUrl(), max: 1 }),
    });
    try {
      const first = await prisma.user.create({
        data: { phoneE164: randomPhone(), passwordHash: 'h', accountType: 'CUSTOMER' },
      });
      const second = await prisma.user.create({
        data: { phoneE164: randomPhone(), passwordHash: 'h', accountType: 'CUSTOMER' },
      });
      expect(first.id[14]).toBe('7');
      expect(second.id > first.id).toBe(true);
    } finally {
      await prisma.$disconnect();
    }
  });
});
