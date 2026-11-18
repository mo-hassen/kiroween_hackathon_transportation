import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobility/core/config/app_config.dart';
import 'package:mobility/core/network/api_client.dart';
import 'package:mobility/core/network/api_failure.dart';
import 'package:mobility/core/network/interceptors.dart';
import 'package:mobility/features/identity/application/identity_flow.dart';
import 'package:mobility/features/identity/data/identity_api.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../helpers/fake_http_adapter.dart';
import '../../helpers/identity_fakes.dart';

final _config = AppConfig.parse(environment: 'development', apiBaseUrl: 'http://10.0.2.2:3000');

({HttpIdentityApi api, FakeHttpAdapter adapter}) _apiWith(List<FakeHandler> handlers) {
  final adapter = FakeHttpAdapter(handlers);
  final dio = Dio(BaseOptions(baseUrl: _config.apiRoot))..httpClientAdapter = adapter;
  dio.interceptors.addAll([
    RequestIdInterceptor(),
    RetryInterceptor(dio: dio, sleep: (_) async {}),
  ]);
  return (api: HttpIdentityApi(ApiClient(dio)), adapter: adapter);
}

Map<String, Object?> _attemptJson(String status, {String? reason}) => {
  'id': 'v-1',
  'status': status,
  'reason': reason,
  'provider': 'DEV',
  'createdAt': '2026-11-17T10:00:00.000Z',
  'sessionExpiresAt': '2026-11-17T10:15:00.000Z',
  'completedAt': null,
  'verifiedAt': null,
  'validUntil': null,
};

void main() {
  group('HttpIdentityApi', () {
    test('reads the overview, including the server-decided canStart', () async {
      final (:api, :adapter) = _apiWith([
        respond({
          'data': {
            'identityStatus': 'VERIFIED',
            'canStart': false,
            'verifiedName': 'Abebe Bikila',
            'verifiedAt': '2026-11-17T10:05:00.000Z',
            'validUntil': '2028-11-17T10:05:00.000Z',
            'latest': {
              ..._attemptJson('VERIFIED'),
              'verifiedAt': '2026-11-17T10:05:00.000Z',
              'validUntil': '2028-11-17T10:05:00.000Z',
            },
          },
        }, 200),
      ]);
      final overview = await api.overview();
      expect(adapter.requests.single.path, '/identity/verifications/current');
      expect(overview.status, IdentityStatus.verified);
      expect(overview.canStart, isFalse);
      expect(overview.verifiedName, 'Abebe Bikila');
      expect(overview.validUntil, DateTime.utc(2028, 11, 17, 10, 5));
      expect(overview.latest?.status, AttemptStatus.verified);
    });

    test('maps statuses it does not know to unknown instead of failing', () async {
      final (:api, adapter: _) = _apiWith([
        respond({
          'data': {
            'identityStatus': 'SOMETHING_NEW',
            'canStart': false,
            'verifiedName': null,
            'verifiedAt': null,
            'validUntil': null,
            'latest': _attemptJson('ALSO_NEW'),
          },
        }, 200),
      ]);
      final overview = await api.overview();
      expect(overview.status, IdentityStatus.unknown);
      expect(overview.latest?.status, AttemptStatus.unknown);
    });

    test('starts with consent, the locale and an Idempotency-Key, and parses the URL', () async {
      final (:api, :adapter) = _apiWith([
        respond({
          'data': {
            'verification': _attemptJson('PENDING'),
            'authorizationUrl': 'https://id.example.et/authorize?state=x',
          },
        }, 201),
      ]);
      final started = await api.start(locale: 'am', idempotencyKey: 'key-123456');
      final request = adapter.requests.single;
      expect(request.method, 'POST');
      expect(request.path, '/identity/verifications');
      expect(request.data, {'consent': true, 'locale': 'am'});
      expect(adapter.sentHeaders.single[idempotencyKeyHeader], 'key-123456');
      expect(started.authorizationUrl, Uri.parse('https://id.example.et/authorize?state=x'));
      expect(started.attempt.status, AttemptStatus.pending);
    });

    test('a start without URL (attempt already ended) parses as null', () async {
      final (:api, adapter: _) = _apiWith([
        respond({
          'data': {'verification': _attemptJson('VERIFIED'), 'authorizationUrl': null},
        }, 201),
      ]);
      expect(
        (await api.start(locale: 'en', idempotencyKey: 'k-12345678')).authorizationUrl,
        isNull,
      );
    });

    test('retries a lost start with the same key (safe: the server replays it)', () async {
      final (:api, :adapter) = _apiWith([
        connectionError(),
        respond({
          'data': {'verification': _attemptJson('PENDING'), 'authorizationUrl': null},
        }, 201),
      ]);
      await api.start(locale: 'en', idempotencyKey: 'same-key-1');
      expect(adapter.sentHeaders.map((h) => h[idempotencyKeyHeader]), ['same-key-1', 'same-key-1']);
    });

    test('maps server errors to typed failures', () async {
      final (:api, adapter: _) = _apiWith([
        // 503 is transient: the client retries (same key) before giving up.
        for (var i = 0; i < 3; i++) respond(problem('IDENTITY_UNAVAILABLE', 503), 503),
        respond(problem('INVALID_STATE_TRANSITION', 409), 409),
      ]);
      await expectLater(
        api.start(locale: 'en', idempotencyKey: 'k-12345678'),
        throwsA(isA<ServerFailure>().having((f) => f.code, 'code', 'IDENTITY_UNAVAILABLE')),
      );
      await expectLater(
        api.cancel('v-1'),
        throwsA(isA<ConflictFailure>().having((f) => f.code, 'code', 'INVALID_STATE_TRANSITION')),
      );
    });

    test('confirms with the return-link token in the body (never in the URL)', () async {
      final (:api, :adapter) = _apiWith([
        respond({'data': _attemptJson('VERIFIED')}, 200),
      ]);
      final confirmed = await api.confirm('v-1', 't' * 43);
      final request = adapter.requests.single;
      expect(request.method, 'POST');
      expect(request.path, '/identity/verifications/v-1/confirm');
      expect(request.data, {'confirmation': 't' * 43});
      expect(request.uri.query, isEmpty);
      expect(confirmed.status, AttemptStatus.verified);
    });

    test('cancels by id', () async {
      final (:api, :adapter) = _apiWith([
        respond({'data': _attemptJson('CANCELLED', reason: 'CANCELLED')}, 200),
      ]);
      final cancelled = await api.cancel('v-1');
      expect(adapter.requests.single.path, '/identity/verifications/v-1/cancel');
      expect(cancelled.reason, 'CANCELLED');
    });
  });

  group('IdentityFlow', () {
    late FakeIdentityApi api;
    late FakeIdentityLauncher launcher;
    late ProviderContainer container;

    setUp(() {
      api = FakeIdentityApi();
      launcher = FakeIdentityLauncher();
      container = ProviderContainer(
        overrides: [
          identityApiProvider.overrideWithValue(api),
          identityLauncherProvider.overrideWithValue(launcher),
        ],
      );
      addTearDown(container.dispose);
    });

    IdentityFlow flow() => container.read(identityFlowProvider);

    test('opens the provider page and remembers it for resuming that attempt only', () async {
      expect(await flow().start(locale: 'en'), isA<StartOpened>());
      expect(launcher.opened, [api.authorizationUrl]);
      expect(flow().resumableUrl('v-new'), api.authorizationUrl);
      expect(flow().resumableUrl('another'), isNull);
      expect(await flow().resume('another'), isFalse);
      expect(await flow().resume('v-new'), isTrue);
      await flow().cancel('v-new');
      expect(flow().resumableUrl('v-new'), isNull);
      expect(api.calls, ['start:en', 'cancel:v-new']);
    });

    test('keeps the idempotency key only for a retry after a connectivity failure', () async {
      api.startFailure = const NetworkFailure();
      await expectLater(flow().start(locale: 'en'), throwsA(isA<NetworkFailure>()));
      api.startFailure = null;
      await flow().start(locale: 'en');
      expect(api.idempotencyKeys[0], api.idempotencyKeys[1]);

      api.startFailure = const ConflictFailure(code: 'IDENTITY_VERIFICATION_NOT_ALLOWED');
      await expectLater(flow().start(locale: 'en'), throwsA(isA<ConflictFailure>()));
      api.startFailure = null;
      await flow().start(locale: 'en');
      expect(api.idempotencyKeys.toSet(), hasLength(3));
    });

    test('reports a browser that cannot be opened, and an attempt without URL', () async {
      launcher.succeeds = false;
      expect(await flow().start(locale: 'en'), isA<StartLaunchFailed>());
      api.authorizationUrl = null;
      launcher.succeeds = true;
      expect(await flow().start(locale: 'en'), isA<StartLaunchFailed>());
      expect(launcher.opened, hasLength(1));
    });
  });

  group('SystemBrowserLauncher', () {
    test('refuses anything but https (http only in development builds)', () async {
      final production = SystemBrowserLauncher(
        AppConfig.parse(environment: 'production', apiBaseUrl: 'https://api.example.et'),
      );
      for (final url in [
        'http://id.example.et/authorize',
        'javascript:alert(1)',
        'file:///etc/passwd',
        'kiroweenmobility://app/identity/return',
      ]) {
        expect(await production.open(Uri.parse(url)), isFalse, reason: url);
      }
    });

    test('uses Custom Tabs when available, else the system browser, never a WebView', () async {
      final config = AppConfig.parse(
        environment: 'production',
        apiBaseUrl: 'https://api.example.et',
      );
      for (final customTabs in [true, false]) {
        final modes = <LaunchMode>[];
        final launcher = SystemBrowserLauncher(
          config,
          supportsMode: (mode) async => mode == LaunchMode.inAppBrowserView && customTabs,
          launch: (url, mode) async {
            modes.add(mode);
            return true;
          },
        );
        expect(await launcher.open(Uri.parse('https://id.example.et/authorize')), isTrue);
        expect(modes, [
          if (customTabs) LaunchMode.inAppBrowserView else LaunchMode.externalApplication,
        ]);
        expect(modes, isNot(contains(LaunchMode.inAppWebView)));
      }
    });

    test('a launch error is reported as not opened', () async {
      final launcher = SystemBrowserLauncher(
        AppConfig.parse(environment: 'production', apiBaseUrl: 'https://api.example.et'),
        supportsMode: (_) async => true,
        launch: (_, _) async => throw StateError('no activity'),
      );
      expect(await launcher.open(Uri.parse('https://id.example.et/authorize')), isFalse);
    });
  });
}
