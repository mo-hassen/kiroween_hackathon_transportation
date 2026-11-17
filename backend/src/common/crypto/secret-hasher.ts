import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/** Separate HMAC keys per purpose, derived from one server pepper with HKDF. */
export type HashPurpose = 'otp' | 'ticket' | 'idempotency' | 'subject';

/**
 * Keyed hashing for low-entropy or identifying values (OTP codes, phone numbers in
 * rate-limit keys and audit targets) so a database or Redis leak alone does not reveal
 * them. High-entropy random tokens use plain SHA-256 (`sha256Hex`).
 */
export class SecretHasher {
  private readonly keys = new Map<HashPurpose, Buffer>();

  constructor(private readonly pepper: Buffer) {
    if (pepper.length < 32) {
      throw new Error('Hashing pepper must be at least 32 bytes');
    }
  }

  hmacHex(purpose: HashPurpose, value: string): string {
    return createHmac('sha256', this.keyFor(purpose)).update(value, 'utf8').digest('hex');
  }

  private keyFor(purpose: HashPurpose): Buffer {
    let key = this.keys.get(purpose);
    if (key === undefined) {
      key = Buffer.from(
        hkdfSync('sha256', this.pepper, 'kiroween-mobility', `hmac:${purpose}`, 32),
      );
      this.keys.set(purpose, key);
    }
    return key;
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests of equal length. */
export function hexDigestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
