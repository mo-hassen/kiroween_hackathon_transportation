/**
 * Ethiopian mobile numbers. Shared rule, mirrored in packages/core_shared (Dart) and
 * checked against the same vectors in packages/test_vectors/ethiopian_phone_numbers.json.
 *
 * Accepted mobile prefixes: 9 (Ethio Telecom) and 7 (Safaricom Ethiopia), followed by
 * eight digits. [ASSUMPTION] Validate against the current national numbering plan
 * before launch (docs/architecture/12-ethiopia-assumptions-risks.md).
 */
const SEPARATORS = /[\s().-]/g;
const NATIONAL_SIGNIFICANT = /^[79]\d{8}$/;

/** Returns `+2519XXXXXXXX` / `+2517XXXXXXXX`, or `null` when the input is not an Ethiopian mobile number. */
export function normalizeEthiopianMobile(input: string): string | null {
  const compact = input.trim().replace(SEPARATORS, '');
  let national: string;
  if (compact.startsWith('+251')) {
    national = compact.slice(4);
  } else if (compact.startsWith('00251')) {
    national = compact.slice(5);
  } else if (compact.startsWith('251') && compact.length === 12) {
    national = compact.slice(3);
  } else if (compact.startsWith('0') && compact.length === 10) {
    national = compact.slice(1);
  } else {
    national = compact;
  }
  return NATIONAL_SIGNIFICANT.test(national) ? `+251${national}` : null;
}

/** `+251911234567` -> `+251 91 123 4567`. Input must already be normalized. */
export function formatEthiopianMobile(e164: string): string {
  const national = e164.slice(4);
  return `+251 ${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`;
}
