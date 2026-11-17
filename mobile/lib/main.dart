import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app/app.dart';
import 'core/config/app_config.dart';
import 'core/l10n/locale_controller.dart';

/// Run with `flutter run --dart-define-from-file=config/development.json`.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Fails fast on a misconfigured build instead of talking to the wrong server.
  final config = AppConfig.fromEnvironment();
  final preferences = await SharedPreferences.getInstance();

  runApp(
    ProviderScope(
      // Riverpod 3 retries failed providers automatically by default. Disabled:
      // retries are decided by the network layer, which never repeats unsafe calls.
      retry: (_, _) => null,
      overrides: [
        appConfigProvider.overrideWithValue(config),
        sharedPreferencesProvider.overrideWithValue(preferences),
      ],
      child: const MobilityApp(),
    ),
  );
}
