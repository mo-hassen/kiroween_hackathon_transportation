import 'dart:convert';
import 'dart:io';

import 'package:core_shared/core_shared.dart';
import 'package:test/test.dart';

void main() {
  // Shared with the TypeScript implementation in the backend.
  final vectors = jsonDecode(
    File('../test_vectors/ethiopian_phone_numbers.json').readAsStringSync(),
  ) as Map<String, Object?>;
  final valid = (vectors['valid']! as List<Object?>)
      .cast<Map<String, Object?>>();
  final invalid = (vectors['invalid']! as List<Object?>).cast<String>();

  group('normalizeEthiopianMobile (shared vectors)', () {
    test('has vectors', () {
      expect(valid, isNotEmpty);
      expect(invalid, isNotEmpty);
    });

    for (final vector in valid) {
      final input = vector['input']! as String;
      test('normalizes ${jsonEncode(input)}', () {
        final e164 = normalizeEthiopianMobile(input);
        expect(e164, vector['e164']);
        expect(formatEthiopianMobile(e164!), vector['display']);
      });
    }

    for (final input in invalid) {
      test('rejects ${jsonEncode(input)}', () {
        expect(normalizeEthiopianMobile(input), isNull);
      });
    }
  });
}
