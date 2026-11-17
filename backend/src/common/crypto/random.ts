import { randomBytes, randomInt } from 'node:crypto';

/** URL-safe random token with `bytes` of entropy (32 bytes = 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Uniformly distributed numeric code, e.g. a 6-digit SMS code. */
export function randomNumericCode(digits: number): string {
  return String(randomInt(0, 10 ** digits)).padStart(digits, '0');
}

// Crockford base32 without I, L, O, U: easy to read aloud and type.
const ACTIVATION_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Staff activation code: 12 symbols (60 bits), shown as XXXX-XXXX-XXXX. */
export function randomActivationCode(): string {
  let code = '';
  for (let i = 0; i < 12; i += 1) {
    code += ACTIVATION_ALPHABET[randomInt(0, ACTIVATION_ALPHABET.length)] ?? '0';
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

/** Canonical form for comparison: upper case, no separators, ambiguous letters mapped. */
export function normalizeActivationCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}
