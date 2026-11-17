import 'dart:io';

import 'package:test/test.dart';

/// Guards the rule "never use floating-point arithmetic for money"
/// (docs/architecture/09-ledger-payments-payouts.md §2).
void main() {
  test('money code never uses double or num', () {
    final forbidden = RegExp(
      r'\b(double|num)\b|toDouble\(|\.round\(|\.truncate\(',
    );
    final offenders = <String>[];
    for (final file in Directory(
      'lib/src/money',
    ).listSync(recursive: true).whereType<File>()) {
      final lines = file.readAsLinesSync();
      for (var i = 0; i < lines.length; i++) {
        final code = lines[i].split('//').first;
        if (forbidden.hasMatch(code)) {
          offenders.add('${file.path}:${i + 1}: ${lines[i].trim()}');
        }
      }
    }
    expect(offenders, isEmpty);
  });
}
