import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobility/core/auth/session_controller.dart';
import 'package:mobility/core/auth/session_state.dart';
import 'package:mobility/core/network/api_failure.dart';
import 'package:mobility/features/account/presentation/account_screen.dart';
import 'package:mobility/features/auth/data/auth_api.dart';
import 'package:mobility/features/auth/presentation/login_screen.dart';
import 'package:mobility/features/auth/presentation/verify_device_screen.dart';
import 'package:mobility/features/splash/splash_screen.dart';
import 'package:mobility/features/welcome/welcome_screen.dart';

import '../helpers/app_harness.dart';
import '../helpers/fakes.dart';
import '../helpers/pump_app.dart';

void main() {
  group('session restoration', () {
    testWidgets('starts on welcome without a stored session', (tester) async {
      await AppHarness().pump(tester);
      expect(find.byType(WelcomeScreen), findsOneWidget);
    });

    testWidgets('goes straight to the account with a stored session', (tester) async {
      final harness = AppHarness(storedRefreshToken: 'rt_stored');
      await harness.pump(tester);
      expect(find.byType(AccountScreen), findsOneWidget);
      expect(harness.auth.calls, ['refresh:rt_stored']);
      expect(harness.store.value, 'rt_refresh-refreshed');
    });

    testWidgets('keeps the session and offers retry when the server is unreachable', (
      tester,
    ) async {
      final harness = AppHarness(storedRefreshToken: 'rt_stored');
      harness.auth.onRefresh = (_) => throw const NetworkFailure();
      await harness.pump(tester);
      expect(find.byType(SplashScreen), findsOneWidget);
      expect(find.text("Can't reach the service"), findsOneWidget);
      expect(harness.store.value, 'rt_stored');

      harness.auth.onRefresh = (_) => tokens('back');
      await tapText(tester, 'Try again');
      expect(find.byType(AccountScreen), findsOneWidget);
    });

    testWidgets('a rejected stored session lands on welcome and is wiped', (tester) async {
      final harness = AppHarness(storedRefreshToken: 'rt_revoked');
      harness.auth.onRefresh = (_) => throw const UnauthorizedFailure();
      await harness.pump(tester);
      expect(find.byType(WelcomeScreen), findsOneWidget);
      expect(harness.store.value, isNull);
    });
  });

  group('sign in', () {
    Future<AppHarness> openLogin(WidgetTester tester) async {
      final harness = AppHarness();
      await harness.pump(tester);
      await tapText(tester, 'Sign in');
      expect(find.byType(LoginScreen), findsOneWidget);
      return harness;
    }

    testWidgets('validates the phone and password before calling the server', (tester) async {
      final harness = await openLogin(tester);
      await enterText(tester, 'Phone number', '0811234567');
      await tapText(tester, 'Sign in');
      expect(find.text('Enter an Ethiopian mobile number (09… or 07…).'), findsOneWidget);
      expect(find.text('Enter your password.'), findsOneWidget);
      expect(harness.auth.calls, isEmpty);
    });

    testWidgets('signs in, normalizing the phone, and opens the account', (tester) async {
      final harness = await openLogin(tester);
      await enterText(tester, 'Phone number', '091 123 4567');
      await enterText(tester, 'Password', 'Bole-Road-Taxi-2026');
      await tapText(tester, 'Sign in');
      expect(harness.auth.calls, ['login:+251911234567:install-0000-test']);
      expect(find.byType(AccountScreen), findsOneWidget);
      expect(harness.store.value, 'rt_refresh-login');
    });

    testWidgets('shows a generic message for wrong credentials and stays', (tester) async {
      final harness = await openLogin(tester);
      harness.auth.failWith = const ValidationFailure(fieldErrors: [], code: 'INVALID_CREDENTIALS');
      await enterText(tester, 'Phone number', '0911234567');
      await enterText(tester, 'Password', 'wrong-password');
      await tapText(tester, 'Sign in');
      expect(find.textContaining('Incorrect phone number or password.'), findsOneWidget);
      expect(find.byType(LoginScreen), findsOneWidget);
    });

    testWidgets('explains rate limiting with the wait time', (tester) async {
      final harness = await openLogin(tester);
      harness.auth.failWith = const RateLimitedFailure(
        retryAfter: Duration(seconds: 600),
        code: 'RATE_LIMITED',
      );
      await enterText(tester, 'Phone number', '0911234567');
      await enterText(tester, 'Password', 'whatever-password');
      await tapText(tester, 'Sign in');
      expect(find.text('Too many attempts. Try again in 10 min.'), findsOneWidget);
    });

    testWidgets('asks for the SMS code on a new device, then signs in', (tester) async {
      final harness = await openLogin(tester);
      harness.auth.loginResult = LoginOtpRequired(
        loginTicket: 'ticket-abc',
        expiresAt: DateTime.utc(2030),
      );
      await enterText(tester, 'Phone number', '0911234567');
      await enterText(tester, 'Password', 'Bole-Road-Taxi-2026');
      await tapText(tester, 'Sign in');
      expect(find.byType(VerifyDeviceScreen), findsOneWidget);

      await enterText(tester, '6-digit code', '123456');
      await tapText(tester, 'Verify');
      expect(harness.auth.calls.last, 'verify:ticket-abc:123456');
      expect(find.byType(AccountScreen), findsOneWidget);
    });

    testWidgets('shows "session ended" on sign-in after an expired session', (tester) async {
      final harness = AppHarness(storedRefreshToken: 'rt_stored');
      await harness.pump(tester);
      harness.container.read(sessionControllerProvider.notifier).sessionExpired();
      await tester.pumpAndSettle();
      expect(find.byType(LoginScreen), findsOneWidget);
      expect(find.text('Your session has ended. Please sign in again.'), findsOneWidget);
    });
  });

  group('registration', () {
    Future<AppHarness> reachDetails(WidgetTester tester) async {
      final harness = AppHarness();
      await harness.pump(tester);
      await tapText(tester, 'Create account');
      await enterText(tester, 'Phone number', '0711234567');
      await tapText(tester, 'Send code');
      expect(harness.auth.calls, ['otp:+251711234567:en']);
      expect(find.text('We sent a code to +251 71 123 4567.'), findsOneWidget);
      return harness;
    }

    Future<void> fillDetails(WidgetTester tester, {String password = 'Bole-Road-Taxi-2026'}) async {
      await enterText(tester, '6-digit code', '654321');
      await enterText(tester, 'Your name', 'Almaz Tesfaye');
      await enterText(tester, 'Password', password);
    }

    testWidgets('registers and signs in', (tester) async {
      final harness = await reachDetails(tester);
      await fillDetails(tester);
      await tapText(tester, 'Create account');
      expect(harness.auth.calls, [
        'otp:+251711234567:en',
        'register:+251711234567:654321:Almaz Tesfaye',
        'login:+251711234567:install-0000-test',
      ]);
      expect(find.byType(AccountScreen), findsOneWidget);
    });

    testWidgets('requires 10 characters locally', (tester) async {
      final harness = await reachDetails(tester);
      await fillDetails(tester, password: 'short');
      await tapText(tester, 'Create account');
      expect(find.text('Use at least 10 characters.'), findsOneWidget);
      expect(harness.auth.calls.where((c) => c.startsWith('register')), isEmpty);
    });

    testWidgets('shows a server password-policy error under the field', (tester) async {
      final harness = await reachDetails(tester);
      harness.auth.failWith = const ValidationFailure(
        fieldErrors: [FieldError(field: 'password', code: 'PASSWORD_TOO_COMMON')],
        code: 'VALIDATION_FAILED',
      );
      await fillDetails(tester, password: 'basketball');
      await tapText(tester, 'Create account');
      expect(find.text('This password is too common. Choose another one.'), findsOneWidget);
    });

    testWidgets(
      'reuses the idempotency key when retrying the same details, and renews it after a change',
      (tester) async {
        final harness = await reachDetails(tester);
        harness.auth.failWith = const NetworkFailure();
        await fillDetails(tester);
        await tapText(tester, 'Create account');
        await tapText(tester, 'Create account');
        expect(harness.auth.idempotencyKeys, hasLength(2));
        expect(harness.auth.idempotencyKeys[0], harness.auth.idempotencyKeys[1]);
        expect(
          find.text('No internet connection. Check your connection and try again.'),
          findsOneWidget,
        );

        await enterText(tester, 'Your name', 'Almaz T.');
        await tapText(tester, 'Create account');
        expect(harness.auth.idempotencyKeys[2], isNot(harness.auth.idempotencyKeys[0]));
      },
    );
  });

  testWidgets('password reset by SMS code signs in with the new password', (tester) async {
    final harness = AppHarness();
    await harness.pump(tester);
    await tapText(tester, 'Sign in');
    await tapText(tester, 'Forgot password?');
    await enterText(tester, 'Phone number', '0911234567');
    await tapText(tester, 'Send code');
    await enterText(tester, '6-digit code', '111222');
    await enterText(tester, 'New password', 'Piassa-Cafe-Morning');
    await tapText(tester, 'Reset password');
    expect(harness.auth.calls, [
      'reset-request:+251911234567',
      'reset-confirm:+251911234567:111222',
      'login:+251911234567:install-0000-test',
    ]);
    expect(find.byType(AccountScreen), findsOneWidget);
  });

  group('accessibility and localization of auth screens', () {
    for (final locale in const [Locale('en'), Locale('am')]) {
      testWidgets(
        'sign-in has no overflow at 200% text on a small phone (${locale.languageCode})',
        (tester) async {
          useSmallPhone(tester);
          await pumpLocalized(tester, const LoginScreen(), locale: locale, textScale: 2);
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);
        },
      );
    }

    testWidgets('sign-in meets tap-target guidelines', (tester) async {
      await pumpLocalized(tester, const LoginScreen());
      await tester.pumpAndSettle();
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    });

    testWidgets('sign-in renders in Amharic', (tester) async {
      await pumpLocalized(tester, const LoginScreen(), locale: const Locale('am'));
      await tester.pumpAndSettle();
      expect(find.text('ስልክ ቁጥር'), findsOneWidget);
    });
  });

  test('SignedOut defaults to no reason', () {
    expect(const SignedOut().reason, SignOutReason.none);
  });
}
