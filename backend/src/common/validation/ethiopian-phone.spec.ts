import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { formatEthiopianMobile, normalizeEthiopianMobile } from './ethiopian-phone.js';

interface PhoneVectors {
  valid: { input: string; e164: string; display: string }[];
  invalid: string[];
}

// Shared with the Dart implementation in packages/core_shared.
const vectors = JSON.parse(
  readFileSync(
    resolve(process.cwd(), '../packages/test_vectors/ethiopian_phone_numbers.json'),
    'utf8',
  ),
) as PhoneVectors;

describe('normalizeEthiopianMobile (shared vectors)', () => {
  it.each(vectors.valid.map((v) => [v.input, v.e164, v.display]))(
    'normalizes %j to %s',
    (input, e164, display) => {
      expect(normalizeEthiopianMobile(input)).toBe(e164);
      expect(formatEthiopianMobile(e164)).toBe(display);
    },
  );

  it.each(vectors.invalid.map((input) => [input]))('rejects %j', (input) => {
    expect(normalizeEthiopianMobile(input)).toBeNull();
  });
});
