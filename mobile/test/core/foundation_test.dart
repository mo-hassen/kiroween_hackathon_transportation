import 'dart:convert';
import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobility/core/config/app_config.dart';
import 'package:mobility/core/l10n/locale_controller.dart';
import 'package:mobility/core/storage/token_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  group('AppConfig', () {
    test('accepts http only in development and strips a trailing slash', () {
      final config = AppConfig.parse(
        environment: 'development',
        apiBaseUrl: 'http://10.0.2.2:3000/',
      );
      expect(config.environment, AppEnvironment.development);
      expect(config.apiRoot, 'http://10.0.2.2:3000/api/v1');
    });

    test('accepts https in production', () {
      final config = AppConfig.parse(
        environment: 'production',
        apiBaseUrl: 'https://api.example.et',
      );
      expect(config.apiRoot, 'https://api.example.et/api/v1');
    });

    for (final (env, url) in [
      ('production', 'http://api.example.et'),
      ('staging', 'http://api.example.et'),
      ('development', ''),
      ('development', 'not a url'),
      ('development', 'ftp://host'),
      ('development', 'http://host?x=1'),
      ('prod', 'https://api.example.et'),
      ('', 'https://api.example.et'),
    ]) {
      test('rejects APP_ENV="$env" API_BASE_URL="$url"', () {
        expect(
          () => AppConfig.parse(environment: env, apiBaseUrl: url),
          throwsA(isA<AppConfigException>()),
        );
      });
    }
  });

  group('LocaleController', () {
    Future<ProviderContainer> containerWith(Map<String, Object> initial) async {
      SharedPreferences.setMockInitialValues(initial);
      final prefs = await SharedPreferences.getInstance();
      final container = ProviderContainer(
        overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      );
      addTearDown(container.dispose);
      return container;
    }

    test('follows the system language by default', () async {
      final container = await containerWith({});
      expect(container.read(localeControllerProvider), isNull);
    });

    test('restores a saved supported language', () async {
      final container = await containerWith({LocaleController.storageKey: 'am'});
      expect(container.read(localeControllerProvider), const Locale('am'));
    });

    test('ignores an unsupported saved value', () async {
      final container = await containerWith({LocaleController.storageKey: 'fr'});
      expect(container.read(localeControllerProvider), isNull);
    });

    test('persists the selection and can reset to system', () async {
      final container = await containerWith({});
      final controller = container.read(localeControllerProvider.notifier);
      await controller.select(const Locale('am'));
      expect(container.read(localeControllerProvider), const Locale('am'));
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getString(LocaleController.storageKey), 'am');
      await controller.select(null);
      expect(container.read(localeControllerProvider), isNull);
      expect(prefs.getString(LocaleController.storageKey), isNull);
    });

    test('rejects unsupported languages', () async {
      final container = await containerWith({});
      await expectLater(
        container.read(localeControllerProvider.notifier).select(const Locale('fr')),
        throwsArgumentError,
      );
    });
  });

  group('SecureTokenStore', () {
    setUp(() => FlutterSecureStorage.setMockInitialValues({}));

    test('writes, reads and clears the refresh token', () async {
      final store = SecureTokenStore();
      expect(await store.readRefreshToken(), isNull);
      await store.writeRefreshToken('opaque-refresh-token');
      expect(await store.readRefreshToken(), 'opaque-refresh-token');
      await store.clear();
      expect(await store.readRefreshToken(), isNull);
    });

    test('rejects empty tokens', () {
      expect(() => SecureTokenStore().writeRefreshToken(''), throwsArgumentError);
    });
  });

  group('localization resources', () {
    Map<String, Object?> load(String locale) =>
        jsonDecode(File('lib/app/l10n/arb/app_$locale.arb').readAsStringSync())
            as Map<String, Object?>;
    Set<String> messageKeys(Map<String, Object?> arb) =>
        arb.keys.where((key) => !key.startsWith('@')).toSet();

    test('Amharic defines every English message and nothing else', () {
      expect(messageKeys(load('am')), messageKeys(load('en')));
    });

    test('Amharic keeps every placeholder', () {
      final en = load('en');
      final am = load('am');
      final placeholder = RegExp(r'\{(\w+)\}');
      for (final key in messageKeys(en)) {
        final expected = placeholder.allMatches(en[key]! as String).map((m) => m[1]).toSet();
        final actual = placeholder.allMatches(am[key]! as String).map((m) => m[1]).toSet();
        expect(actual, expected, reason: key);
      }
    });

    test('no Amharic message is left empty', () {
      final am = load('am');
      for (final key in messageKeys(am)) {
        expect((am[key]! as String).trim(), isNotEmpty, reason: key);
      }
    });
  });

  group('no hard-coded user-facing strings', () {
    test('widgets under lib/ use localizations instead of string literals in Text()', () {
      final offenders = <String>[];
      final literalText = RegExp(r'''Text\(\s*['"]''');
      for (final file in Directory('lib').listSync(recursive: true).whereType<File>()) {
        if (!file.path.endsWith('.dart') || file.path.contains('generated')) continue;
        if (literalText.hasMatch(file.readAsStringSync())) offenders.add(file.path);
      }
      expect(offenders, isEmpty);
    });
  });
}
