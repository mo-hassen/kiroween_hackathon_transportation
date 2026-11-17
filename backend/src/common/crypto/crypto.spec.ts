import { randomBytes } from 'node:crypto';
import { FieldEncryption } from './field-encryption.js';
import {
  normalizeActivationCode,
  randomActivationCode,
  randomNumericCode,
  randomToken,
} from './random.js';
import { SecretHasher, hexDigestsEqual, sha256Hex } from './secret-hasher.js';
import { uuidv7 } from './uuid.js';

describe('SecretHasher', () => {
  const hasher = new SecretHasher(randomBytes(32));

  it('is deterministic per purpose and separates purposes', () => {
    expect(hasher.hmacHex('otp', 'abc')).toBe(hasher.hmacHex('otp', 'abc'));
    expect(hasher.hmacHex('otp', 'abc')).not.toBe(hasher.hmacHex('subject', 'abc'));
    expect(hasher.hmacHex('otp', 'abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('depends on the pepper', () => {
    expect(new SecretHasher(randomBytes(32)).hmacHex('otp', 'abc')).not.toBe(
      hasher.hmacHex('otp', 'abc'),
    );
  });

  it('rejects short peppers', () => {
    expect(() => new SecretHasher(randomBytes(16))).toThrow();
  });

  it('compares digests in constant time and rejects malformed input', () => {
    const digest = sha256Hex('x');
    expect(hexDigestsEqual(digest, digest)).toBe(true);
    expect(hexDigestsEqual(digest, sha256Hex('y'))).toBe(false);
    expect(hexDigestsEqual(digest, '')).toBe(false);
    expect(hexDigestsEqual('', '')).toBe(false);
  });
});

describe('FieldEncryption', () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);

  it('round-trips with associated data', () => {
    const enc = new FieldEncryption(new Map([['k1', k1]]), 'k1');
    const ciphertext = enc.encrypt(Buffer.from('totp-secret'), 'users.mfa_secret_enc:u1');
    expect(ciphertext.includes(Buffer.from('totp-secret'))).toBe(false);
    expect(enc.decrypt(ciphertext, 'users.mfa_secret_enc:u1').toString()).toBe('totp-secret');
  });

  it('uses a fresh IV every time', () => {
    const enc = new FieldEncryption(new Map([['k1', k1]]), 'k1');
    expect(enc.encrypt(Buffer.from('x'), 'a').equals(enc.encrypt(Buffer.from('x'), 'a'))).toBe(
      false,
    );
  });

  it('rejects other associated data (value copied to another row)', () => {
    const enc = new FieldEncryption(new Map([['k1', k1]]), 'k1');
    const ciphertext = enc.encrypt(Buffer.from('x'), 'users.mfa_secret_enc:u1');
    expect(() => enc.decrypt(ciphertext, 'users.mfa_secret_enc:u2')).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const enc = new FieldEncryption(new Map([['k1', k1]]), 'k1');
    const ciphertext = enc.encrypt(Buffer.from('secret'), 'a');
    const last = ciphertext.length - 1;
    ciphertext[last] = (ciphertext[last] ?? 0) ^ 0xff;
    expect(() => enc.decrypt(ciphertext, 'a')).toThrow();
    expect(() => enc.decrypt(Buffer.from([9, 0]), 'a')).toThrow();
  });

  it('decrypts values written with a previous key after rotation', () => {
    const old = new FieldEncryption(new Map([['k1', k1]]), 'k1');
    const ciphertext = old.encrypt(Buffer.from('x'), 'a');
    const rotated = new FieldEncryption(
      new Map([
        ['k1', k1],
        ['k2', k2],
      ]),
      'k2',
    );
    expect(rotated.decrypt(ciphertext, 'a').toString()).toBe('x');
    const withoutOldKey = new FieldEncryption(new Map([['k2', k2]]), 'k2');
    expect(() => withoutOldKey.decrypt(ciphertext, 'a')).toThrow('Unknown field-encryption key id');
  });

  it('requires a 32-byte active key', () => {
    expect(() => new FieldEncryption(new Map([['k1', randomBytes(16)]]), 'k1')).toThrow();
    expect(() => new FieldEncryption(new Map(), 'k1')).toThrow();
  });
});

describe('random values', () => {
  it('generates 256-bit URL-safe tokens', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
  });

  it('generates fixed-length numeric codes', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(randomNumericCode(6)).toMatch(/^\d{6}$/);
    }
  });

  it('generates readable activation codes and normalizes typed input', () => {
    const code = randomActivationCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(normalizeActivationCode(code.toLowerCase())).toBe(code.replaceAll('-', ''));
    expect(normalizeActivationCode('abcd efgh-ilo1')).toBe('ABCDEFGH1101');
  });
});

describe('uuidv7', () => {
  it('produces RFC 9562 version-7 UUIDs that sort by creation time', () => {
    const first = uuidv7(1_700_000_000_000);
    const second = uuidv7(1_700_000_000_001);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second > first).toBe(true);
    expect(first.slice(0, 13).replace('-', '')).toBe(
      (1_700_000_000_000).toString(16).padStart(12, '0'),
    );
  });
});
