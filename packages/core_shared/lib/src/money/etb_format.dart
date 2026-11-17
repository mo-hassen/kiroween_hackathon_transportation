import 'money.dart';

/// Currency labels per UI language. Amharic uses "ብር" (birr).
const Map<String, String> _etbSymbols = {'en': 'ETB', 'am': 'ብር'};

/// Formats [money] as e.g. `ETB 1,500.00` (en) or `ብር 1,500.00` (am).
///
/// Uses integer arithmetic only, so no rounding can occur.
String formatMoney(Money money, {required String languageCode}) {
  final symbol = money.currency == Money.etbCode
      ? (_etbSymbols[languageCode] ?? _etbSymbols['en']!)
      : money.currency;
  final absolute = money.amountMinor.abs();
  final major = _groupThousands((absolute ~/ 100).toString());
  final minor = (absolute % 100).toString().padLeft(2, '0');
  final sign = money.isNegative ? '-' : '';
  return '$sign$symbol $major.$minor';
}

String _groupThousands(String digits) {
  final buffer = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) buffer.write(',');
    buffer.write(digits[i]);
  }
  return buffer.toString();
}

final RegExp _amountInput = RegExp(r'^(\d{1,3}(,\d{3})+|\d+)(\.(\d{1,2}))?$');
final RegExp _symbolPrefix = RegExp(r'^(ETB|ብር)\s*', caseSensitive: false);

/// Parses user input such as `1,500`, `1500.5` or `ETB 1,500.50` into santim.
///
/// Returns `null` for negative values, more than two decimals, malformed grouping,
/// or amounts outside the safe range. Never goes through `double`.
int? parseEtbInput(String input) {
  final text = input.trim().replaceFirst(_symbolPrefix, '');
  final match = _amountInput.firstMatch(text);
  if (match == null) return null;
  final majorDigits = match.group(1)!.replaceAll(',', '');
  final minorDigits = (match.group(4) ?? '').padRight(2, '0');
  if (majorDigits.length > 14) return null;
  final minor = int.parse(majorDigits) * 100 + int.parse(minorDigits);
  return minor > Money.maxSafeMinor ? null : minor;
}
