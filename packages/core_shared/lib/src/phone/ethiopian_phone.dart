/// Ethiopian mobile numbers. Mirrors backend/src/common/validation/ethiopian-phone.ts;
/// both are tested against packages/test_vectors/ethiopian_phone_numbers.json.
///
/// Accepted mobile prefixes: 9 (Ethio Telecom) and 7 (Safaricom Ethiopia) followed by
/// eight digits. [ASSUMPTION] Confirm against the current national numbering plan.
library;

final RegExp _separators = RegExp(r'[\s().-]');
final RegExp _nationalSignificant = RegExp(r'^[79][0-9]{8}$');

/// Returns `+2519XXXXXXXX` / `+2517XXXXXXXX`, or `null` if [input] is not an
/// Ethiopian mobile number. The server re-validates; this is for UX only.
String? normalizeEthiopianMobile(String input) {
  final compact = input.trim().replaceAll(_separators, '');
  final String national;
  if (compact.startsWith('+251')) {
    national = compact.substring(4);
  } else if (compact.startsWith('00251')) {
    national = compact.substring(5);
  } else if (compact.startsWith('251') && compact.length == 12) {
    national = compact.substring(3);
  } else if (compact.startsWith('0') && compact.length == 10) {
    national = compact.substring(1);
  } else {
    national = compact;
  }
  return _nationalSignificant.hasMatch(national) ? '+251$national' : null;
}

/// `+251911234567` -> `+251 91 123 4567`. [e164] must already be normalized.
String formatEthiopianMobile(String e164) {
  final national = e164.substring(4);
  return '+251 ${national.substring(0, 2)} ${national.substring(2, 5)} ${national.substring(5)}';
}
