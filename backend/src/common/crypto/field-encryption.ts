import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM encryption for sensitive columns (docs/architecture/03-database-schema.md).
 *
 * Layout: [version:1][kidLength:1][kid][iv:12][tag:16][ciphertext]. The key id lets old
 * ciphertexts be read after key rotation. Callers pass associated data that binds the
 * ciphertext to its row and column (e.g. `users.mfa_secret_enc:<userId>`), so a value
 * copied into another row fails to decrypt.
 */
export class FieldEncryption {
  constructor(
    private readonly keys: ReadonlyMap<string, Buffer>,
    private readonly activeKeyId: string,
  ) {
    const active = keys.get(activeKeyId);
    if (active?.length !== 32) {
      throw new Error('Active field-encryption key must exist and be 32 bytes');
    }
  }

  encrypt(plaintext: Buffer, associatedData: string): Buffer {
    const key = this.keys.get(this.activeKeyId);
    if (key === undefined) throw new Error('Active field-encryption key missing');
    const kid = Buffer.from(this.activeKeyId, 'utf8');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([
      Buffer.from([FORMAT_VERSION, kid.length]),
      kid,
      iv,
      cipher.getAuthTag(),
      ciphertext,
    ]);
  }

  /** Throws if the value was tampered with, uses an unknown key or other associated data. */
  decrypt(payload: Buffer, associatedData: string): Buffer {
    if (payload.length < 2 || payload[0] !== FORMAT_VERSION) {
      throw new Error('Unsupported ciphertext format');
    }
    const kidLength = payload[1] ?? 0;
    const kidEnd = 2 + kidLength;
    const kid = payload.subarray(2, kidEnd).toString('utf8');
    const key = this.keys.get(kid);
    if (key === undefined) throw new Error('Unknown field-encryption key id');
    const iv = payload.subarray(kidEnd, kidEnd + IV_BYTES);
    const tag = payload.subarray(kidEnd + IV_BYTES, kidEnd + IV_BYTES + TAG_BYTES);
    const ciphertext = payload.subarray(kidEnd + IV_BYTES + TAG_BYTES);
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('Truncated ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
}
