import 'package:core_shared/core_shared.dart';
import 'package:flutter/material.dart';

/// Displays [money] in the current UI language (`ETB 1,500.00` / `ብር 1,500.00`).
class MoneyText extends StatelessWidget {
  const MoneyText(this.money, {super.key, this.style});

  final Money money;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    final languageCode = Localizations.localeOf(context).languageCode;
    return Text(
      formatMoney(money, languageCode: languageCode),
      style: (style ?? const TextStyle()).copyWith(
        fontFeatures: const [FontFeature.tabularFigures()],
      ),
    );
  }
}
