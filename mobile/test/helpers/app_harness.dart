import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobility/app/app.dart';
import 'package:mobility/core/auth/device_identity.dart';
import 'package:mobility/core/config/app_config.dart';
import 'package:mobility/core/l10n/locale_controller.dart';
import 'package:mobility/core/storage/token_store.dart';
import 'package:mobility/features/account/data/account_api.dart';
import 'package:mobility/features/auth/data/auth_api.dart';
import 'package:mobility/features/system_status/data/system_status_api.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'fakes.dart';

final class _OnlineStatus implements SystemStatusApi {
  @override
  Future<ServiceStatus> fetchStatus() async => ServiceStatus.online;
}

final class AppHarness {
  AppHarness({String? storedRefreshToken}) : store = MemoryTokenStore(storedRefreshToken);

  final MemoryTokenStore store;
  final auth = FakeAuthApi();
  final account = FakeAccountApi();
  late ProviderContainer container;

  /// Boots the real app (router, session controller, guards) with fake APIs.
  Future<void> pump(WidgetTester tester, {Locale? locale}) async {
    SharedPreferences.setMockInitialValues({
      if (locale != null) LocaleController.storageKey: locale.languageCode,
    });
    final preferences = await SharedPreferences.getInstance();
    await tester.pumpWidget(
      ProviderScope(
        retry: (_, _) => null,
        overrides: [
          appConfigProvider.overrideWithValue(
            AppConfig.parse(environment: 'development', apiBaseUrl: 'http://10.0.2.2:3000'),
          ),
          sharedPreferencesProvider.overrideWithValue(preferences),
          tokenStoreProvider.overrideWithValue(store),
          installationIdStoreProvider.overrideWithValue(FixedInstallationId()),
          authApiProvider.overrideWithValue(auth),
          accountApiProvider.overrideWithValue(account),
          systemStatusApiProvider.overrideWithValue(_OnlineStatus()),
        ],
        child: const MobilityApp(),
      ),
    );
    container = ProviderScope.containerOf(tester.element(find.byType(MobilityApp)));
    await tester.pumpAndSettle();
  }
}

Future<void> enterText(WidgetTester tester, String label, String text) async {
  await tester.enterText(find.widgetWithText(TextFormField, label), text);
}

/// Taps the button (or list tile) labelled [text]. Titles with the same text are ignored;
/// with several matches the last one wins (e.g. the button in an open dialog).
Future<void> tapText(WidgetTester tester, String text) async {
  final finder = find
      .descendant(
        of: find.byWidgetPredicate((widget) => widget is ButtonStyleButton || widget is ListTile),
        matching: find.text(text),
      )
      .last;
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

/// Lets fire-and-forget futures (e.g. best-effort logout) complete.
Future<void> flushMicrotasks() => Future<void>.delayed(Duration.zero);
