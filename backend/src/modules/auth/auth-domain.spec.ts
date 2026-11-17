import { randomBytes } from 'node:crypto';
import { isLocked, lockedUntilAfter, lockoutDurationMs } from './login/lockout.js';
import { PasswordPolicy } from './password/password-policy.js';
import { PasswordService, UNUSABLE_PASSWORD_HASH } from './password/password.service.js';
import {
  base32Decode,
  base32Encode,
  hotp,
  otpauthUri,
  totpStep,
  verifyTotp,
} from './staff/totp.js';

describe('TOTP (RFC 6238 test vectors, SHA-1)', () => {
  const secret = Buffer.from('12345678901234567890');
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('T=%i -> %s', (seconds, code) => {
    expect(hotp(secret, totpStep(seconds * 1000))).toBe(code);
  });

  it('accepts the adjacent steps for clock drift and nothing further', () => {
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(secret, hotp(secret, step), now)).toBe(step);
    expect(verifyTotp(secret, hotp(secret, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(secret, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, hotp(secret, step - 2), now)).toBeNull();
    expect(verifyTotp(secret, hotp(secret, step + 2), now)).toBeNull();
  });

  it('rejects malformed codes', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '12 456']) {
      expect(verifyTotp(secret, code, Date.now())).toBeNull();
    }
  });

  it('round-trips base32 and matches the RFC 4648 example', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    const random = randomBytes(20);
    expect(base32Decode(base32Encode(random)).equals(random)).toBe(true);
    expect(() => base32Decode('not*base32')).toThrow();
  });

  it('builds an otpauth URI for authenticator apps', () => {
    const uri = otpauthUri({ secret, accountName: 'Abebe K.', issuer: 'Kiroween Mobility' });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Kiroween%20Mobility%3AAbebe%20K\.\?/);
    expect(new URL(uri).searchParams.get('secret')).toBe(base32Encode(secret));
    expect(new URL(uri).searchParams.get('digits')).toBe('6');
  });
});

describe('lockout backoff', () => {
  it.each([
    [0, 0],
    [4, 0],
    [5, 60_000],
    [6, 120_000],
    [7, 240_000],
    [15, 60_000 * 1024],
    [16, 24 * 60 * 60_000],
    [500, 24 * 60 * 60_000],
  ])('%i failures -> %i ms', (failures, ms) => {
    expect(lockoutDurationMs(failures)).toBe(ms);
  });

  it('computes the lock end and whether it is active', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    const until = lockedUntilAfter(5, now);
    expect(until?.toISOString()).toBe('2026-11-17T12:01:00.000Z');
    expect(lockedUntilAfter(4, now)).toBeNull();
    expect(isLocked(until, now)).toBe(true);
    expect(isLocked(until, new Date('2026-11-17T12:01:01Z'))).toBe(false);
    expect(isLocked(null, now)).toBe(false);
  });
});

describe('PasswordPolicy', () => {
  const policy = new PasswordPolicy(new Set(['basketball', 'password1234']));

  it.each([
    ['Basketball', 'PASSWORD_TOO_COMMON'],
    ['PASSWORD1234', 'PASSWORD_TOO_COMMON'],
    ['aaaaaaaaaaaa', 'PASSWORD_REPETITIVE'],
    ['abababababab', 'PASSWORD_REPETITIVE'],
    ['1234567890', 'PASSWORD_REPETITIVE'],
    ['qwertyuiopqwertyuiop', 'PASSWORD_REPETITIVE'],
    ['my number 911234567!', 'PASSWORD_CONTAINS_PHONE'],
    ['call me 0911234567', 'PASSWORD_CONTAINS_PHONE'],
  ])('rejects %j (%s)', (password, violation) => {
    expect(policy.check(password, { phoneE164: '+251911234567' })).toBe(violation);
  });

  it.each(['correct horse battery', 'Addis-Ababa-Bole-22', 'ቡና እና ሻይ በጠዋት'])(
    'accepts %j',
    (password) => {
      expect(policy.check(password, { phoneE164: '+251911234567' })).toBeNull();
    },
  );

  it('normalizes Unicode compatibility forms before comparing', () => {
    // Full-width "basketball" is the same password after NFKC.
    expect(policy.check('ｂａｓｋｅｔｂａｌｌ')).toBe('PASSWORD_TOO_COMMON');
  });

  it('loads the bundled list of common passwords', () => {
    expect(new PasswordService()['policy'].size).toBeGreaterThan(9000);
  });
});

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with argon2id and the OWASP parameters, never storing the password', async () => {
    const hashed = await service.hash('correct horse battery');
    expect(hashed).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hashed).not.toContain('correct horse battery');
    expect(await service.verify(hashed, 'correct horse battery')).toBe(true);
    expect(await service.verify(hashed, 'correct horse batterY')).toBe(false);
  });

  it('treats NFC and NFD forms of the same password as equal', async () => {
    const hashed = await service.hash('caf\u00e9 au lait 2026');
    expect(await service.verify(hashed, 'cafe\u0301 au lait 2026')).toBe(true);
  });

  it('never matches unusable or malformed hashes', async () => {
    expect(await service.verify(UNUSABLE_PASSWORD_HASH, 'anything at all')).toBe(false);
    expect(await service.verify('$argon2id$garbage', 'anything at all')).toBe(false);
  });

  it('reports policy violations as field errors', () => {
    expect(() => {
      service.assertAcceptable('1234567890', 'password');
    }).toThrow(
      expect.objectContaining({
        code: 'VALIDATION_FAILED',
        fieldErrors: [{ field: 'password', code: 'PASSWORD_TOO_COMMON' }],
      }),
    );
  });
});
