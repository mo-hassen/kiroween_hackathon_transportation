import 'package:flutter/material.dart';

/// Material 3 theme. Sized for low-end Android phones used outdoors:
/// 48 dp minimum touch targets and AA contrast from the generated scheme.
abstract final class AppTheme {
  static const Color _seed = Color(0xFF1B6B3A);
  static const Size minimumTouchTarget = Size(48, 48);

  static ThemeData light() => _build(Brightness.light);
  static ThemeData dark() => _build(Brightness.dark);

  static ThemeData _build(Brightness brightness) {
    final scheme = ColorScheme.fromSeed(seedColor: _seed, brightness: brightness);
    final buttonShape = RoundedRectangleBorder(borderRadius: BorderRadius.circular(12));
    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      materialTapTargetSize: MaterialTapTargetSize.padded,
      visualDensity: VisualDensity.standard,
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(minimumSize: const Size(64, 52), shape: buttonShape),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(minimumSize: const Size(64, 52), shape: buttonShape),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(minimumSize: minimumTouchTarget),
      ),
      cardTheme: const CardThemeData(margin: EdgeInsets.zero),
    );
  }
}
