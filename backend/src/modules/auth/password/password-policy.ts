import { readFileSync } from 'node:fs';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** Field error codes returned for a rejected password. */
export type PasswordViolation =
  'PASSWORD_TOO_COMMON' | 'PASSWORD_CONTAINS_PHONE' | 'PASSWORD_REPETITIVE';

/** NFKC so visually identical input (e.g. full-width digits) always hashes the same. */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

const SEQUENCES = [
  '0123456789',
  '9876543210',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
];

function isRepetitive(password: string): boolean {
  const lower = password.toLowerCase();
  if (new Set(lower).size <= 2) return true;
  for (let size = 1; size <= 4; size += 1) {
    const unit = lower.slice(0, size);
    if (unit.repeat(Math.ceil(lower.length / size)).slice(0, lower.length) === lower) return true;
  }
  return SEQUENCES.some(
    (sequence) =>
      sequence.includes(lower) || (lower.length >= 10 && sequence.repeat(3).includes(lower)),
  );
}

/**
 * NIST SP 800-63B style policy (docs/architecture/07-security-architecture.md §1): length
 * 10-128, no composition rules, reject known-common passwords, obvious patterns and the
 * user's own phone number. Length is enforced by the DTOs.
 */
export class PasswordPolicy {
  constructor(private readonly common: ReadonlySet<string>) {}

  static fromFile(path: URL): PasswordPolicy {
    const entries = readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return new PasswordPolicy(new Set(entries));
  }

  get size(): number {
    return this.common.size;
  }

  check(password: string, context: { readonly phoneE164?: string } = {}): PasswordViolation | null {
    const normalized = normalizePassword(password);
    if (this.common.has(normalized.toLowerCase())) return 'PASSWORD_TOO_COMMON';
    const national = context.phoneE164?.slice(4);
    if (
      national !== undefined &&
      national.length === 9 &&
      normalized.replace(/\D/g, '').includes(national)
    ) {
      return 'PASSWORD_CONTAINS_PHONE';
    }
    if (isRepetitive(normalized)) return 'PASSWORD_REPETITIVE';
    return null;
  }
}

/** Same depth below the package root from src/ and dist/: backend/assets/. */
export const COMMON_PASSWORDS_FILE = new URL(
  '../../../../assets/common-passwords.txt',
  import.meta.url,
);
