import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kiroween_admin/app/router.dart';
import 'package:kiroween_admin/core/api.dart';
import 'package:kiroween_admin/core/config.dart';
import 'package:kiroween_admin/core/session.dart';

import 'helpers/fakes.dart';

void main() {
  group('AdminConfig', () {
    test('accepts http only in development and strips the trailing slash', () {
      final config = AdminConfig.parse(
        environment: 'development',
        apiBaseUrl: 'http://localhost:3000/',
      );
      expect(config.apiRoot, 'http://localhost:3000/api/v1');
      expect(
        () => AdminConfig.parse(environment: 'production', apiBaseUrl: 'http://api.example.com'),
        throwsA(isA<AdminConfigException>()),
      );
      expect(
        AdminConfig.parse(environment: 'staging', apiBaseUrl: 'https://api.example.com').apiRoot,
        'https://api.example.com/api/v1',
      );
    });

    test('rejects unknown environments, relative URLs and queries', () {
      for (final (env, url) in [
        ('prod', 'https://a.example'),
        ('development', '/api'),
        ('development', 'http://a.example?x=1'),
        ('development', ''),
      ]) {
        expect(
          () => AdminConfig.parse(environment: env, apiBaseUrl: url),
          throwsA(isA<AdminConfigException>()),
        );
      }
    });
  });

  group('staffRedirect', () {
    final reviewer = SignedIn(StaffProfile.fromJson(staffMe()));
    final noPermission = SignedIn(
      StaffProfile.fromJson(staffMe(permissions: const ['users.read'])),
    );

    test('signed-out users only reach /login', () {
      expect(staffRedirect(const SignedOut(), Uri.parse('/drivers/x')), '/login');
      expect(staffRedirect(const SignedOut(), Uri.parse('/login')), isNull);
    });

    test('staff without drivers.review only reach /no-permission', () {
      expect(staffRedirect(noPermission, Uri.parse('/')), '/no-permission');
      expect(staffRedirect(noPermission, Uri.parse('/drivers')), '/no-permission');
      expect(staffRedirect(noPermission, Uri.parse('/no-permission')), isNull);
    });

    test('reviewers are sent from /login and /no-permission to the dashboard', () {
      expect(staffRedirect(reviewer, Uri.parse('/login')), '/');
      expect(staffRedirect(reviewer, Uri.parse('/no-permission')), '/');
      expect(staffRedirect(reviewer, Uri.parse('/drivers/abc')), isNull);
    });
  });

  group('StaffSessionController', () {
    ProviderContainer containerWith(FakeStaffAuthApi auth) {
      final container = ProviderContainer(
        overrides: [
          adminConfigProvider.overrideWithValue(testConfig),
          staffAuthApiProvider.overrideWithValue(auth),
        ],
      );
      addTearDown(container.dispose);
      return container;
    }

    test('keeps tokens in memory after sign-in and clears them on sign-out', () async {
      final auth = FakeStaffAuthApi();
      final container = containerWith(auth);
      await container
          .read(staffSessionProvider.notifier)
          .signIn(phone: 'p', password: 'pw', totpCode: '123456');
      expect(container.read(staffSessionProvider), isA<SignedIn>());
      expect(container.read(tokenHolderProvider).accessToken, 'access-1');

      await container.read(staffSessionProvider.notifier).signOut();
      expect(container.read(staffSessionProvider), isA<SignedOut>());
      expect(container.read(tokenHolderProvider).accessToken, isNull);
      expect(container.read(tokenHolderProvider).refreshToken, isNull);
      expect(auth.calls, contains('logout:refresh-1'));
    });

    test('refuses customer accounts and revokes their session', () async {
      final auth = FakeStaffAuthApi(me: staffMe(type: 'CUSTOMER'));
      final container = containerWith(auth);
      await expectLater(
        container
            .read(staffSessionProvider.notifier)
            .signIn(phone: 'p', password: 'pw', totpCode: '123456'),
        throwsA(isA<ApiFailure>().having((f) => f.code, 'code', 'NOT_STAFF')),
      );
      await Future<void>.delayed(Duration.zero);
      expect(container.read(staffSessionProvider), isA<SignedOut>());
      expect(container.read(tokenHolderProvider).accessToken, isNull);
      expect(auth.calls, contains('logout:refresh-1'));
    });

    test('concurrent refreshes share one call; a rejected refresh ends the session', () async {
      final auth = FakeStaffAuthApi();
      final container = containerWith(auth);
      final session = container.read(staffSessionProvider.notifier);
      await session.signIn(phone: 'p', password: 'pw', totpCode: '123456');

      final results = await Future.wait([session.refresh(), session.refresh()]);
      expect(results, [true, true]);
      expect(auth.calls.where((c) => c.startsWith('refresh:')), ['refresh:refresh-1']);

      auth.refreshFailure = const ApiFailure(FailureKind.unauthorized);
      expect(await session.refresh(), isFalse);
      final state = container.read(staffSessionProvider);
      expect(state, isA<SignedOut>().having((s) => s.expired, 'expired', isTrue));
      expect(container.read(tokenHolderProvider).refreshToken, isNull);
    });

    test('a network error during refresh keeps the session', () async {
      final auth = FakeStaffAuthApi();
      final container = containerWith(auth);
      final session = container.read(staffSessionProvider.notifier);
      await session.signIn(phone: 'p', password: 'pw', totpCode: '123456');
      auth.refreshFailure = const ApiFailure(FailureKind.network);
      expect(await session.refresh(), isFalse);
      expect(container.read(staffSessionProvider), isA<SignedIn>());
    });
  });
}
