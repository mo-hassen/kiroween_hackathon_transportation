import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireTestDatabaseUrl } from '../helpers/test-env.js';

/** Phase 3 database guarantees (prisma/migrations/*_auth), tested with raw SQL. */
let pool: pg.Pool;

const CHECK = '23514';
const RESTRICT = '23001';
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

const challenge = (overrides: Record<string, unknown>) => ({
  id: randomUUID(),
  purpose: 'REGISTER',
  phone_e164: phone(),
  code_hash: hex64(),
  max_attempts: 5,
  expires_at: new Date(Date.now() + 300_000),
  ...overrides,
});

beforeAll(() => {
  pool = new pg.Pool({ connectionString: requireTestDatabaseUrl(), max: 2 });
});
afterAll(async () => {
  await pool.end();
});

describe('users (auth columns)', () => {
  it('keeps MFA data off customer accounts', async () => {
    await expectViolation(
      user({ mfa_secret_enc: Buffer.from('x') }),
      CHECK,
      'users_customer_has_no_mfa_chk',
    );
  });

  it('requires an enrolled authenticator for ACTIVE staff', async () => {
    await expectViolation(
      user({ account_type: 'STAFF', status: 'ACTIVE' }),
      CHECK,
      'users_active_staff_has_mfa_chk',
    );
    await expect(
      user({ account_type: 'STAFF', status: 'PENDING_ACTIVATION' }),
    ).resolves.toBeDefined();
    await expect(
      user({
        account_type: 'STAFF',
        status: 'ACTIVE',
        mfa_secret_enc: Buffer.from('x'),
        mfa_enrolled_at: new Date(),
      }),
    ).resolves.toBeDefined();
  });

  it('never lets an account switch between customer and staff (BR-ACC-2)', async () => {
    const id = await user();
    await expectViolation(
      pool.query(`UPDATE users SET account_type = 'STAFF' WHERE id = $1`, [id]),
      RESTRICT,
    );
  });
});

describe('staff_role_assignments', () => {
  it('only lets staff hold roles', async () => {
    const customer = await user();
    await expectViolation(
      insert('staff_role_assignments', {
        id: randomUUID(),
        user_id: customer,
        role: 'SUPPORT',
        updated_at: new Date(),
      }),
      CHECK,
    );
  });

  it('only lets staff grant roles, and never to themselves', async () => {
    const staff = await user({ account_type: 'STAFF', status: 'PENDING_ACTIVATION' });
    const customer = await user();
    await expectViolation(
      insert('staff_role_assignments', {
        id: randomUUID(),
        user_id: staff,
        role: 'SUPPORT',
        granted_by: customer,
        updated_at: new Date(),
      }),
      CHECK,
    );
    await expectViolation(
      insert('staff_role_assignments', {
        id: randomUUID(),
        user_id: staff,
        role: 'SUPPORT',
        granted_by: staff,
        updated_at: new Date(),
      }),
      CHECK,
      'staff_roles_no_self_grant_chk',
    );
  });

  it('holds one row per user and role', async () => {
    const staff = await user({ account_type: 'STAFF', status: 'PENDING_ACTIVATION' });
    await insert('staff_role_assignments', {
      id: randomUUID(),
      user_id: staff,
      role: 'FINANCE',
      updated_at: new Date(),
    });
    await expectViolation(
      insert('staff_role_assignments', {
        id: randomUUID(),
        user_id: staff,
        role: 'FINANCE',
        updated_at: new Date(),
      }),
      '23505',
      'staff_role_assignments_user_id_role_key',
    );
  });
});

describe('otp_challenges', () => {
  it('accepts well-formed challenges for every purpose', async () => {
    const owner = await user();
    const staff = await user({ account_type: 'STAFF', status: 'PENDING_ACTIVATION' });
    await insert('otp_challenges', challenge({}));
    await insert('otp_challenges', challenge({ purpose: 'PASSWORD_RESET', user_id: owner }));
    await insert(
      'otp_challenges',
      challenge({
        purpose: 'LOGIN_STEP_UP',
        user_id: owner,
        installation_id: 'install-1',
        ticket_hash: hex64(),
      }),
    );
    await insert('otp_challenges', challenge({ purpose: 'STAFF_ACTIVATION', user_id: staff }));
    await insert(
      'otp_challenges',
      challenge({
        purpose: 'STAFF_MFA_ENROLLMENT',
        user_id: staff,
        code_hash: null,
        ticket_hash: hex64(),
      }),
    );
  });

  it.each([
    ['registration bound to a user', { user_id: 'OWNER' }],
    [
      'step-up without a ticket',
      { purpose: 'LOGIN_STEP_UP', user_id: 'OWNER', installation_id: 'i-1' },
    ],
    [
      'step-up without an installation',
      { purpose: 'LOGIN_STEP_UP', user_id: 'OWNER', ticket_hash: 'HEX' },
    ],
    ['reset without a user', { purpose: 'PASSWORD_RESET' }],
    [
      'enrollment with a code',
      { purpose: 'STAFF_MFA_ENROLLMENT', user_id: 'OWNER', ticket_hash: 'HEX' },
    ],
  ])('rejects %s', async (_label, overrides) => {
    const owner = await user({ account_type: 'STAFF', status: 'PENDING_ACTIVATION' });
    const resolved = Object.fromEntries(
      Object.entries(overrides).map(([k, v]) => [
        k,
        v === 'OWNER' ? owner : v === 'HEX' ? hex64() : v,
      ]),
    );
    await expectViolation(
      insert('otp_challenges', challenge(resolved)),
      CHECK,
      'otp_purpose_shape_chk',
    );
  });

  it('stores digests only and bounds attempts', async () => {
    await expectViolation(
      insert('otp_challenges', challenge({ code_hash: '123456' })),
      CHECK,
      'otp_code_hash_format_chk',
    );
    await expectViolation(
      insert('otp_challenges', challenge({ attempts: 6 })),
      CHECK,
      'otp_attempts_chk',
    );
    await expectViolation(
      insert('otp_challenges', challenge({ max_attempts: 50 })),
      CHECK,
      'otp_max_attempts_chk',
    );
    await expectViolation(
      insert('otp_challenges', challenge({ phone_e164: '0911234567' })),
      CHECK,
      'otp_phone_format_chk',
    );
    await expectViolation(
      insert('otp_challenges', challenge({ expires_at: new Date(Date.now() - 1000) })),
      CHECK,
      'otp_expiry_chk',
    );
  });
});

describe('sessions and retired tokens', () => {
  it('stores only SHA-256 digests of refresh tokens', async () => {
    const owner = await user();
    const session = (hash: string) =>
      insert('sessions', {
        id: randomUUID(),
        user_id: owner,
        refresh_token_family: randomUUID(),
        current_token_hash: hash,
        expires_at: new Date(Date.now() + 86_400_000),
        updated_at: new Date(),
      });
    await expectViolation(
      session('rt_plaintext-refresh-token'),
      CHECK,
      'sessions_token_hash_format_chk',
    );
    const id = randomUUID();
    await insert('sessions', {
      id,
      user_id: owner,
      refresh_token_family: randomUUID(),
      current_token_hash: hex64(),
      expires_at: new Date(Date.now() + 86_400_000),
      updated_at: new Date(),
    });
    await expectViolation(
      insert('retired_refresh_tokens', { token_hash: 'plain', session_id: id }),
      CHECK,
      'retired_refresh_tokens_hash_format_chk',
    );
    await expect(
      insert('retired_refresh_tokens', { token_hash: hex64(), session_id: id }),
    ).resolves.toBeUndefined();
  });
});
