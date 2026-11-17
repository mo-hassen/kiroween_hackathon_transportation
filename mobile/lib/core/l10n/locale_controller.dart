import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../app/l10n/generated/app_localizations.dart';

/// Overridden in `main()` with the loaded instance.
final sharedPreferencesProvider = Provider<SharedPreferences>(
  (ref) => throw UnimplementedError('sharedPreferencesProvider must be overridden'),
);

/// The user's chosen UI language, or `null` to follow the phone setting.
final class LocaleController extends Notifier<Locale?> {
  static const storageKey = 'ui.locale';

  @override
  Locale? build() {
    final saved = ref.watch(sharedPreferencesProvider).getString(storageKey);
    return _supported(saved);
  }

  Future<void> select(Locale? locale) async {
    final prefs = ref.read(sharedPreferencesProvider);
    if (locale == null) {
      await prefs.remove(storageKey);
      state = null;
      return;
    }
    final supported = _supported(locale.languageCode);
    if (supported == null) {
      throw ArgumentError.value(locale, 'locale', 'Unsupported locale');
    }
    await prefs.setString(storageKey, supported.languageCode);
    state = supported;
  }

  static Locale? _supported(String? languageCode) => AppLocalizations.supportedLocales
      .where((locale) => locale.languageCode == languageCode)
      .firstOrNull;
}

final localeControllerProvider = NotifierProvider<LocaleController, Locale?>(LocaleController.new);
