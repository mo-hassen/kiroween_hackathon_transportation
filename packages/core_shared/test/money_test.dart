import 'package:core_shared/core_shared.dart';
import 'package:test/test.dart';

void main() {
  group('formatMoney', () {
    final cases = <int, String>{
      0: '0.00',
      5: '0.05',
      100: '1.00',
      150000: '1,500.00',
      150050: '1,500.50',
      123456789: '1,234,567.89',
      100000000: '1,000,000.00',
    };
    cases.forEach((minor, expected) {
      test('$minor santim -> ETB $expected', () {
        expect(
          formatMoney(Money.etb(minor), languageCode: 'en'),
          'ETB $expected',
        );
      });
    });

    test('uses the Amharic currency label', () {
      expect(formatMoney(Money.etb(150000), languageCode: 'am'), 'ብር 1,500.00');
    });

    test('falls back to the English label for other languages', () {
      expect(formatMoney(Money.etb(100), languageCode: 'om'), 'ETB 1.00');
    });

    test('formats negative amounts (refunds, reversals)', () {
      expect(
        formatMoney(Money.etb(-150050), languageCode: 'en'),
        '-ETB 1,500.50',
      );
    });

    test('formats the largest safe amount exactly', () {
      expect(
        formatMoney(Money.etb(Money.maxSafeMinor), languageCode: 'en'),
        'ETB 90,071,992,547,409.91',
      );
    });
  });

  group('parseEtbInput', () {
    final valid = <String, int>{
      '0': 0,
      '1500': 150000,
      '1,500': 150000,
      '1500.5': 150050,
      '1500.05': 150005,
      '1,234,567.89': 123456789,
      ' ETB 1,500.50 ': 150050,
      'ብር 20': 2000,
      'etb 3': 300,
    };
    valid.forEach((input, minor) {
      test(
        'parses "$input" as $minor',
        () => expect(parseEtbInput(input), minor),
      );
    });

    for (final input in [
      '',
      '-5',
      '1.234',
      '1,50',
      '15,00.00',
      '1.',
      '.5',
      'abc',
      '1e3',
      '1 500',
      '999999999999999',
    ]) {
      test('rejects "$input"', () => expect(parseEtbInput(input), isNull));
    }
  });

  group('Money', () {
    test('round-trips the API JSON shape', () {
      final money = Money.fromJson({'amountMinor': 150000, 'currency': 'ETB'});
      expect(money, Money.etb(150000));
      expect(money.toJson(), {'amountMinor': 150000, 'currency': 'ETB'});
    });

    test('rejects floating-point amounts from JSON', () {
      expect(
        () => Money.fromJson({'amountMinor': 1500.5, 'currency': 'ETB'}),
        throwsFormatException,
      );
    });

    test('rejects unsupported currencies', () {
      expect(() => Money(100, 'USD'), throwsArgumentError);
    });

    test('rejects amounts outside the safe range', () {
      expect(() => Money.etb(Money.maxSafeMinor + 1), throwsArgumentError);
    });

    test('adds and subtracts exactly', () {
      expect(Money.etb(10) + Money.etb(20), Money.etb(30));
      expect(Money.etb(10) - Money.etb(20), Money.etb(-10));
    });
  });
}
