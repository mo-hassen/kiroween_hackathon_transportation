import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { Injectable } from '@nestjs/common';
import { validationError } from '../../../common/http/problem-details.js';
import { COMMON_PASSWORDS_FILE, normalizePassword, PasswordPolicy } from './password-policy.js';

/** OWASP Password Storage Cheat Sheet argon2id parameters (19 MiB, t=2, p=1). */
export const ARGON2_OPTIONS = Object.freeze({
  // Algorithm.Argon2id; the package exports a const enum, which isolatedModules cannot inline.
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

/** Stored for accounts that must not be able to log in (e.g. staff awaiting activation). */
export const UNUSABLE_PASSWORD_HASH = '!unusable';

@Injectable()
export class PasswordService {
  private readonly policy = PasswordPolicy.fromFile(COMMON_PASSWORDS_FILE);
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(normalizePassword(password), ARGON2_OPTIONS);
  }

  /** Never throws: malformed or unusable hashes simply do not match. */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    if (!passwordHash.startsWith('$argon2')) {
      // Still spend comparable time so unusable accounts are not distinguishable.
      await this.verifyDummy(password);
      return false;
    }
    try {
      return await verify(passwordHash, normalizePassword(password));
    } catch {
      return false;
    }
  }

  /**
   * Spends the same time as a real verification. Used for unknown phones and locked
   * accounts so response timing does not reveal whether an account exists.
   */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= hash(randomBytes(16).toString('hex'), ARGON2_OPTIONS);
    try {
      await verify(await this.dummyHash, normalizePassword(password));
    } catch {
      // Ignored: the result is never used.
    }
  }

  /** Throws 400 VALIDATION_FAILED with a field code if the password is not acceptable. */
  assertAcceptable(
    password: string,
    field: string,
    context: { readonly phoneE164?: string } = {},
  ): void {
    const violation = this.policy.check(password, context);
    if (violation !== null) {
      throw validationError(field, violation);
    }
  }
}
