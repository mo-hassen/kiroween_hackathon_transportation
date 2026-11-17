import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobility/app/router.dart';
import 'package:mobility/app/routes.dart';
import 'package:mobility/core/auth/auth_interceptor.dart';
import 'package:mobility/core/auth/auth_tokens.dart';
import 'package:mobility/core/auth/session_controller.dart';
import 'package:mobility/core/auth/session_state.dart';
import 'package:mobility/core/auth/token_manager.dart';
import 'package:mobility/core/network/api_failure.dart';
import 'package:mobility/core/network/interceptors.dart';
import 'package:mobility/core/storage/token_store.dart';
import 'package:mobility/features/auth/data/auth_api.dart';

import '../../helpers/fake_http_adapter.dart';
import '../../helpers/fakes.dart';

void main() {
  group('TokenManager', () {
    test('rotates: persists the new refresh token before exposing the new access token', () async {
      final store = MemoryTokenStore('rt_old');
      String? accessDuringWrite;
      late TokenManager manager;
      final observing = _ObservingStore(
        store,
        onWrite: () => accessDuringWrite = manager.accessToken,
      );
      manager = TokenManager(store: observing, transport: (token) async => tokens('new'));
      expect(await manager.refresh(), RefreshOutcome.refreshed);
      expect(store.value, 'rt_refresh-new');
      expect(manager.accessToken, 'access-new');
      expect(accessDuringWrite, isNull);
    });

    test('is single-flight: concurrent callers share one refresh request', () async {
      final store = MemoryTokenStore('rt_old');
      final gate = Completer<AuthTokens>();
      var calls = 0;
      final manager = TokenManager(
        store: store,
        transport: (_) {
          calls++;
          return gate.future;
        },
      );
      final results = Future.wait([manager.refresh(), manager.refresh(), manager.refresh()]);
      gate.complete(tokens('new'));
      expect(await results, everyElement(RefreshOutcome.refreshed));
      expect(calls, 1);
    });

    test('a rejected refresh token signs out and wipes storage', () async {
      final store = MemoryTokenStore('rt_old');
      final manager = TokenManager(
        store: store,
        transport: (_) => throw const UnauthorizedFailure(),
      );
      expect(await manager.refresh(), RefreshOutcome.signedOut);
      expect(store.value, isNull);
      expect(manager.accessToken, isNull);
    });

    test('network trouble keeps the session (no sign-out on a bad connection)', () async {
      for (final failure in [
        const NetworkFailure(),
        const TimeoutFailure(),
        const ServerFailure(),
      ]) {
        final store = MemoryTokenStore('rt_old');
        final manager = TokenManager(store: store, transport: (_) => throw failure);
        expect(await manager.refresh(), RefreshOutcome.unreachable);
        expect(store.value, 'rt_old');
      }
    });

    test('without a stored token there is nothing to refresh', () async {
      var called = false;
      final manager = TokenManager(
        store: MemoryTokenStore(),
        transport: (_) async {
          called = true;
          return tokens('x');
        },
      );
      expect(await manager.refresh(), RefreshOutcome.signedOut);
      expect(called, isFalse);
    });
  });

  group('AuthTokens', () {
    test('parses the API response and never prints tokens', () {
      final parsed = AuthTokens.fromJson({
        'accessToken': 'a.b.c',
        'accessTokenExpiresAt': '2026-11-17T12:15:00.000Z',
        'refreshToken': 'rt_secret',
        'refreshTokenExpiresAt': '2026-12-17T12:00:00.000Z',
        'sessionId': 's-1',
      });
      expect(parsed.sessionId, 's-1');
      expect(parsed.toString(), isNot(contains('rt_secret')));
      expect(parsed.toString(), isNot(contains('a.b.c')));
      expect(() => AuthTokens.fromJson({'accessToken': 1}), throwsFormatException);
    });
  });

  group('AuthInterceptor', () {
    ({Dio dio, FakeHttpAdapter adapter, List<String> events}) build(
      List<FakeHandler> handlers,
      TokenManager tokens,
    ) {
      final adapter = FakeHttpAdapter(handlers);
      final events = <String>[];
      late final Dio dio;
      dio = Dio(BaseOptions(baseUrl: 'http://api.test/api/v1'))..httpClientAdapter = adapter;
      dio.interceptors.addAll([
        AuthInterceptor(
          retry: (options) => dio.fetch<Object?>(options),
          tokens: tokens,
          onSessionExpired: () => events.add('expired'),
        ),
        RetryInterceptor(dio: dio, sleep: (_) async {}),
      ]);
      return (dio: dio, adapter: adapter, events: events);
    }

    test('attaches the access token, but never to /auth/* endpoints', () async {
      final manager = TokenManager(store: MemoryTokenStore(), transport: (_) async => tokens('x'));
      await manager.adopt(tokens('current'));
      final (:dio, :adapter, events: _) = build([
        respond({'data': 1}, 200),
        respond({'data': 1}, 200),
      ], manager);
      await dio.get<Object?>('/me');
      await dio.post<Object?>('/auth/logout', data: {});
      expect(adapter.sentHeaders[0]['Authorization'], 'Bearer access-current');
      expect(adapter.sentHeaders[1].containsKey('Authorization'), isFalse);
    });

    test('on 401 refreshes once and retries with the new token', () async {
      final store = MemoryTokenStore();
      final manager = TokenManager(store: store, transport: (_) async => tokens('new'));
      await manager.adopt(tokens('old'));
      final (:dio, :adapter, :events) = build([
        respond(problem('UNAUTHENTICATED', 401), 401),
        respond({'data': 'ok'}, 200),
      ], manager);
      final response = await dio.get<Object?>('/me');
      expect(response.statusCode, 200);
      expect(adapter.sentHeaders.map((h) => h['Authorization']), [
        'Bearer access-old',
        'Bearer access-new',
      ]);
      expect(events, isEmpty);
    });

    test('shares one refresh between concurrent 401s', () async {
      var refreshes = 0;
      final manager = TokenManager(
        store: MemoryTokenStore(),
        transport: (_) async {
          refreshes++;
          await Future<void>.delayed(const Duration(milliseconds: 10));
          return tokens('new');
        },
      );
      await manager.adopt(tokens('old'));
      final (:dio, adapter: _, events: _) = build([
        respond(problem('UNAUTHENTICATED', 401), 401),
        respond(problem('UNAUTHENTICATED', 401), 401),
        respond({'data': 1}, 200),
        respond({'data': 2}, 200),
      ], manager);
      await Future.wait([dio.get<Object?>('/me'), dio.get<Object?>('/me/sessions')]);
      expect(refreshes, 1);
    });

    test('a rejected refresh ends the session and surfaces the 401', () async {
      final manager = TokenManager(
        store: MemoryTokenStore(),
        transport: (_) => throw const UnauthorizedFailure(),
      );
      await manager.adopt(tokens('old'));
      final (:dio, adapter: _, :events) = build([
        respond(problem('UNAUTHENTICATED', 401), 401),
      ], manager);
      await expectLater(dio.get<Object?>('/me'), throwsA(isA<DioException>()));
      expect(events, ['expired']);
    });

    test('a refresh that cannot reach the server does not end the session', () async {
      final store = MemoryTokenStore();
      final manager = TokenManager(store: store, transport: (_) => throw const NetworkFailure());
      await manager.adopt(tokens('old'));
      final (:dio, adapter: _, :events) = build([
        respond(problem('UNAUTHENTICATED', 401), 401),
      ], manager);
      await expectLater(dio.get<Object?>('/me'), throwsA(isA<DioException>()));
      expect(events, isEmpty);
      expect(store.value, 'rt_refresh-old');
    });

    test('never refreshes on a 401 from /auth/* (e.g. wrong password)', () async {
      var refreshes = 0;
      final manager = TokenManager(
        store: MemoryTokenStore(),
        transport: (_) async {
          refreshes++;
          return tokens('x');
        },
      );
      final (:dio, adapter: _, events: _) = build([
        respond(problem('INVALID_CREDENTIALS', 401), 401),
      ], manager);
      await expectLater(dio.post<Object?>('/auth/login', data: {}), throwsA(isA<DioException>()));
      expect(refreshes, 0);
    });

    test('identifies auth endpoints by path', () {
      expect(isAuthEndpoint('/auth/refresh'), isTrue);
      expect(isAuthEndpoint('/me'), isFalse);
      expect(isAuthEndpoint('/authors'), isFalse);
    });
  });

  group('SessionController', () {
    ProviderContainer containerWith(MemoryTokenStore store, FakeAuthApi api) {
      final container = ProviderContainer(
        retry: (_, _) => null,
        overrides: [
          tokenStoreProvider.overrideWithValue(store),
          authApiProvider.overrideWithValue(api),
        ],
      );
      addTearDown(container.dispose);
      return container;
    }

    Future<SessionState> settled(ProviderContainer container) async {
      container.read(sessionControllerProvider);
      for (
        var i = 0;
        i < 20 && container.read(sessionControllerProvider) is SessionRestoring;
        i++
      ) {
        await Future<void>.delayed(Duration.zero);
      }
      return container.read(sessionControllerProvider);
    }

    test('restores a stored session by refreshing it', () async {
      final container = containerWith(MemoryTokenStore('rt_stored'), FakeAuthApi());
      expect(await settled(container), isA<SignedIn>());
    });

    test('is signed out without a stored session', () async {
      final api = FakeAuthApi();
      expect(await settled(containerWith(MemoryTokenStore(), api)), isA<SignedOut>());
      expect(api.calls, isEmpty);
    });

    test('keeps the session when the server is unreachable and can retry', () async {
      final store = MemoryTokenStore('rt_stored');
      final api = FakeAuthApi()..onRefresh = (_) => throw const NetworkFailure();
      final container = containerWith(store, api);
      expect(await settled(container), isA<SessionUnreachable>());
      expect(store.value, 'rt_stored');
      api.onRefresh = (_) => tokens('back');
      await container.read(sessionControllerProvider.notifier).retryRestore();
      expect(container.read(sessionControllerProvider), isA<SignedIn>());
    });

    test('signing out clears storage first and tells the server on a best-effort basis', () async {
      final store = MemoryTokenStore('rt_stored');
      final api = FakeAuthApi();
      final container = containerWith(store, api);
      await settled(container);
      await container.read(sessionControllerProvider.notifier).signOut();
      await Future<void>.delayed(Duration.zero);
      expect(store.value, isNull);
      expect(container.read(sessionControllerProvider), isA<SignedOut>());
      expect(api.calls.last, startsWith('logout:'));
    });

    test('marks an expired session only while signed in', () async {
      final container = containerWith(MemoryTokenStore(), FakeAuthApi());
      await settled(container);
      container.read(sessionControllerProvider.notifier).sessionExpired();
      expect((container.read(sessionControllerProvider) as SignedOut).reason, SignOutReason.none);
      await container.read(sessionControllerProvider.notifier).signedIn(tokens('x'));
      container.read(sessionControllerProvider.notifier).sessionExpired();
      expect(
        (container.read(sessionControllerProvider) as SignedOut).reason,
        SignOutReason.sessionExpired,
      );
    });
  });

  group('redirectFor (route guard)', () {
    const restoring = SessionRestoring();
    const out = SignedOut();
    const expired = SignedOut(SignOutReason.sessionExpired);
    const signedIn = SignedIn('s');

    final cases = <(SessionState, String, String?)>[
      (restoring, AppRoutes.account, AppRoutes.splash),
      (restoring, AppRoutes.splash, null),
      (const SessionUnreachable(), AppRoutes.login, AppRoutes.splash),
      (out, AppRoutes.splash, AppRoutes.welcome),
      (out, AppRoutes.account, AppRoutes.welcome),
      (out, AppRoutes.accountSessions, AppRoutes.welcome),
      (out, AppRoutes.login, null),
      (out, AppRoutes.register, null),
      (out, AppRoutes.forgotPassword, null),
      (expired, AppRoutes.account, AppRoutes.login),
      (signedIn, AppRoutes.login, AppRoutes.account),
      (signedIn, AppRoutes.welcome, AppRoutes.account),
      (signedIn, AppRoutes.splash, AppRoutes.account),
      (signedIn, AppRoutes.accountSessions, null),
      (signedIn, '/admin/payouts', null),
      (out, '/admin/payouts', null),
    ];
    for (final (session, location, expected) in cases) {
      test('${session.runtimeType} at $location -> $expected', () {
        expect(redirectFor(session, location), expected);
      });
    }
  });
}

/// Delegating store that runs [onWrite] when the refresh token is written.
final class _ObservingStore implements TokenStore {
  _ObservingStore(this._inner, {required this.onWrite});

  final TokenStore _inner;
  final void Function() onWrite;

  @override
  Future<void> clear() => _inner.clear();

  @override
  Future<String?> readRefreshToken() => _inner.readRefreshToken();

  @override
  Future<void> writeRefreshToken(String token) {
    onWrite();
    return _inner.writeRefreshToken(token);
  }
}
