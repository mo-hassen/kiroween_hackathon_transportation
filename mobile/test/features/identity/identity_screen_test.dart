import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobility/app/router.dart';
import 'package:mobility/app/routes.dart';
import 'package:mobility/core/auth/auth_tokens.dart';
import 'package:mobility/core/auth/session_state.dart';
import 'package:mobility/core/network/api_failure.dart';
import 'package:mobility/features/account/data/account_api.dart';
import 'package:mobility/features/account/presentation/account_screen.dart';
import 'package:mobility/features/identity/data/identity_api.dart';
import 'package:mobility/features/identity/presentation/identity_screen.dart';
import 'package:mobility/features/splash/splash_screen.dart';
import 'package:mobility/features/welcome/welcome_screen.dart';

import '../../helpers/app_harness.dart';
import '../../helpers/fakes.dart';
import '../../helpers/identity_fakes.dart';

const _verificationId = '0193a1b2-0000-7000-8000-000000000000';
const _confirmation = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
const _returnLink = '/identity/return?verification=$_verificationId&confirmation=$_confirmation';

void main() {
  /// Signed in, then on the identity screen through the account menu.
  Future<AppHarness> openIdentity(
    WidgetTester tester, {
    IdentityOverview? state,
    Locale? locale,
  }) async {
    final harness = AppHarness(storedRefreshToken: 'rt_stored');
    if (state != null) harness.identity.current = state;
    await harness.pump(tester, locale: locale);
    expect(find.byType(AccountScreen), findsOneWidget);
    unawaited(harness.container.read(routerProvider).push(AppRoutes.identity));
    await tester.pumpAndSettle();
    expect(find.byType(IdentityScreen), findsOneWidget);
    return harness;
  }

  Finder button(String label) => find.widgetWithText(FilledButton, label);
  bool enabled(WidgetTester tester, String label) =>
      tester.widget<FilledButton>(button(label)).onPressed != null;

  group('starting verification', () {
    testWidgets('requires consent, then opens the provider and shows the pending state', (
      tester,
    ) async {
      final harness = await openIdentity(tester);
      expect(find.text('Not verified yet'), findsOneWidget);
      expect(find.textContaining('never store your photo'), findsOneWidget);
      expect(enabled(tester, 'Verify my identity'), isFalse);

      await tester.ensureVisible(find.byType(CheckboxListTile));
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pumpAndSettle();
      expect(enabled(tester, 'Verify my identity'), isTrue);
      await tapText(tester, 'Verify my identity');

      expect(harness.identity.calls, ['start:en']);
      expect(harness.launcher.opened, [harness.identity.authorizationUrl]);
      expect(find.text('Verification in progress'), findsOneWidget);
      expect(find.text('Continue in browser'), findsOneWidget);
      expect(find.text('Check status'), findsOneWidget);
      expect(find.text('Verify my identity'), findsNothing);
    });

    testWidgets('a browser that cannot be opened is reported', (tester) async {
      final harness = await openIdentity(tester);
      harness.launcher.succeeds = false;
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pumpAndSettle();
      await tapText(tester, 'Verify my identity');
      expect(find.text('Could not open the browser. Please try again.'), findsOneWidget);
    });

    testWidgets('server errors are explained without server text', (tester) async {
      final harness = await openIdentity(tester);
      harness.identity.startFailure = const ServerFailure(code: 'IDENTITY_UNAVAILABLE');
      harness.identity.afterStart = null;
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pumpAndSettle();
      await tapText(tester, 'Verify my identity');
      expect(find.text('Identity verification is temporarily unavailable.'), findsOneWidget);
      expect(harness.launcher.opened, isEmpty);
    });

    testWidgets('no provider on the server: no start button, an explanation instead', (
      tester,
    ) async {
      await openIdentity(tester, state: identityState(IdentityStatus.unverified, canStart: false));
      expect(find.text('Identity verification is temporarily unavailable.'), findsOneWidget);
      expect(find.byType(CheckboxListTile), findsNothing);
    });
  });

  group('pending verification', () {
    testWidgets('cancel asks first, then shows the cancelled outcome and a retry', (tester) async {
      final harness = await openIdentity(
        tester,
        state: identityState(
          IdentityStatus.pending,
          latest: attempt('v-open', AttemptStatus.pending),
        ),
      );
      // Started on another run of the app: nothing to resume, but status and cancel work.
      expect(find.text('Continue in browser'), findsNothing);
      await tapText(tester, 'Cancel verification');
      expect(find.textContaining('Cancel this verification?'), findsOneWidget);
      await tapText(tester, 'Keep it');
      expect(harness.identity.calls, isEmpty);

      await tapText(tester, 'Cancel verification');
      await tapText(tester, 'Cancel verification');
      expect(harness.identity.calls, ['cancel:v-open']);
      expect(find.text('The last verification was cancelled.'), findsOneWidget);
      expect(find.text('Verify again'), findsOneWidget);
    });

    testWidgets('refreshes when the app returns from the browser', (tester) async {
      final harness = await openIdentity(
        tester,
        state: identityState(
          IdentityStatus.pending,
          latest: attempt('v-open', AttemptStatus.pending),
        ),
      );
      final calls = harness.identity.overviewCalls;
      harness.identity.current = identityState(
        IdentityStatus.verified,
        verifiedName: 'Abebe Bikila',
        validUntil: DateTime.utc(2028, 11, 17),
        latest: attempt('v-open', AttemptStatus.verified),
      );
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pumpAndSettle();
      expect(harness.identity.overviewCalls, greaterThan(calls));
      expect(find.text('Identity verified'), findsOneWidget);
    });

    testWidgets('check status asks the server again', (tester) async {
      final harness = await openIdentity(
        tester,
        state: identityState(
          IdentityStatus.pending,
          latest: attempt('v-open', AttemptStatus.pending),
        ),
      );
      final calls = harness.identity.overviewCalls;
      await tester.tap(find.text('Check status'));
      await tester.pumpAndSettle();
      expect(harness.identity.overviewCalls, calls + 1);
    });
  });

  group('status rendering', () {
    testWidgets('verified: name and validity, no actions', (tester) async {
      await openIdentity(
        tester,
        state: identityState(
          IdentityStatus.verified,
          verifiedName: 'Abebe Bikila',
          validUntil: DateTime.utc(2028, 11, 17, 12),
          latest: attempt('v-1', AttemptStatus.verified),
        ),
      );
      expect(find.text('Identity verified'), findsOneWidget);
      expect(find.text('Verified as Abebe Bikila'), findsOneWidget);
      expect(find.text('Valid until Nov 17, 2028'), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
    });

    testWidgets('rejected: generic explanation, retry possible', (tester) async {
      await openIdentity(
        tester,
        state: identityState(
          IdentityStatus.rejected,
          latest: attempt('v-1', AttemptStatus.rejected, reason: 'VERIFICATION_REJECTED'),
        ),
      );
      expect(find.text('Verification not accepted'), findsOneWidget);
      expect(find.textContaining('contact support'), findsOneWidget);
      expect(find.text('Verify again'), findsOneWidget);
    });

    testWidgets('failed: provider outage explained, retry possible', (tester) async {
      await openIdentity(
        tester,
        state: identityState(
          IdentityStatus.unverified,
          latest: attempt('v-1', AttemptStatus.failed, reason: 'PROVIDER_UNAVAILABLE'),
        ),
      );
      expect(
        find.text('The national ID service did not respond. Please try again later.'),
        findsOneWidget,
      );
      expect(find.text('Verify again'), findsOneWidget);
    });

    testWidgets('failed: other failures get the generic text', (tester) async {
      await openIdentity(
        tester,
        state: identityState(
          IdentityStatus.unverified,
          latest: attempt('v-1', AttemptStatus.failed, reason: 'VERIFICATION_FAILED'),
        ),
      );
      expect(
        find.text('The last verification could not be completed. Please try again.'),
        findsOneWidget,
      );
    });

    testWidgets('declined at the provider and timed-out sessions are explained', (tester) async {
      await openIdentity(
        tester,
        state: identityState(
          IdentityStatus.unverified,
          latest: attempt('v-1', AttemptStatus.cancelled, reason: 'DECLINED_AT_PROVIDER'),
        ),
      );
      expect(find.textContaining('You chose not to share your details.'), findsOneWidget);
    });

    testWidgets('session expired', (tester) async {
      await openIdentity(
        tester,
        state: identityState(
          IdentityStatus.unverified,
          latest: attempt('v-1', AttemptStatus.expired, reason: 'SESSION_EXPIRED'),
        ),
      );
      expect(find.text('The last verification was not finished in time.'), findsOneWidget);
      expect(find.text('Verify again'), findsOneWidget);
    });

    testWidgets('verified identity expired: verify again', (tester) async {
      await openIdentity(
        tester,
        state: identityState(
          IdentityStatus.expired,
          latest: attempt('v-1', AttemptStatus.expired, reason: 'VALIDITY_ENDED'),
        ),
      );
      expect(find.text('Verification expired'), findsOneWidget);
      expect(find.textContaining('has expired'), findsOneWidget);
      expect(find.text('Verify again'), findsOneWidget);
    });

    testWidgets('re-verification required', (tester) async {
      await openIdentity(
        tester,
        state: identityState(
          IdentityStatus.reverificationRequired,
          latest: attempt('v-1', AttemptStatus.reverificationRequired),
        ),
      );
      expect(find.text('Please verify again'), findsOneWidget);
      expect(find.byType(CheckboxListTile), findsOneWidget);
    });

    testWidgets('suspended: no actions, contact support', (tester) async {
      await openIdentity(
        tester,
        state: identityState(
          IdentityStatus.suspended,
          latest: attempt('v-1', AttemptStatus.suspended),
        ),
      );
      expect(find.text('Identity verification on hold'), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
      expect(find.byType(CheckboxListTile), findsNothing);
    });

    testWidgets('a status this version does not know', (tester) async {
      await openIdentity(tester, state: identityState(IdentityStatus.unknown));
      expect(find.text('Status unavailable. Update the app or try again later.'), findsOneWidget);
      expect(find.byType(FilledButton), findsNothing);
    });

    testWidgets('loading errors offer a retry', (tester) async {
      final harness = AppHarness(storedRefreshToken: 'rt_stored');
      harness.identity.overviewFailure = const NetworkFailure();
      await harness.pump(tester);
      unawaited(harness.container.read(routerProvider).push(AppRoutes.identity));
      await tester.pumpAndSettle();
      expect(find.text('Try again'), findsOneWidget);
      harness.identity.overviewFailure = null;
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.text('Not verified yet'), findsOneWidget);
    });

    testWidgets('renders in Amharic', (tester) async {
      await openIdentity(tester, locale: const Locale('am'));
      expect(find.text('የማንነት ማረጋገጫ'), findsOneWidget);
      expect(find.text('ማንነቴን አረጋግጥ'), findsOneWidget);
    });
  });

  group('navigation', () {
    testWidgets('the account menu shows the identity status and opens the screen', (tester) async {
      final harness = AppHarness(storedRefreshToken: 'rt_stored');
      harness.account.profile = const AccountProfile(
        id: 'u',
        phone: '+251911234567',
        displayName: 'Abebe',
        preferredLocale: 'en',
        status: 'ACTIVE',
        version: 1,
        identityStatus: IdentityStatus.verified,
      );
      await harness.pump(tester);
      expect(find.text('Identity verified'), findsOneWidget);
      await tapText(tester, 'Identity verification');
      expect(find.byType(IdentityScreen), findsOneWidget);
    });

    testWidgets('a return link without a token only opens the status screen', (tester) async {
      final harness = AppHarness(storedRefreshToken: 'rt_stored');
      await harness.pump(tester);
      harness.container
          .read(routerProvider)
          .go('${AppRoutes.identityReturn}?verification=$_verificationId');
      await tester.pumpAndSettle();
      expect(find.byType(IdentityScreen), findsOneWidget);
      expect(harness.identity.calls, isEmpty);
      expect(find.text('Not verified yet'), findsOneWidget);
    });

    testWidgets('the return link confirms from this session, then shows the server status', (
      tester,
    ) async {
      final harness = AppHarness(storedRefreshToken: 'rt_stored');
      await harness.pump(tester);
      harness.container.read(routerProvider).go(_returnLink);
      await tester.pumpAndSettle();
      expect(harness.identity.calls, ['confirm:$_verificationId:$_confirmation']);
      expect(find.byType(IdentityScreen), findsOneWidget);
      expect(find.text('Identity verified'), findsOneWidget);
    });

    testWidgets('a rejected confirmation is explained and nothing is shown as verified', (
      tester,
    ) async {
      final harness = AppHarness(storedRefreshToken: 'rt_stored');
      harness.identity
        ..confirmFailure = const ValidationFailure(
          fieldErrors: [],
          code: 'IDENTITY_CONFIRMATION_INVALID',
        )
        ..current = identityState(
          IdentityStatus.pending,
          latest: attempt(_verificationId, AttemptStatus.pending),
        );
      await harness.pump(tester);
      harness.container.read(routerProvider).go(_returnLink);
      await tester.pumpAndSettle();
      expect(find.textContaining('could not be completed here'), findsOneWidget);
      expect(find.text('Verification in progress'), findsOneWidget);
      expect(find.text('Identity verified'), findsNothing);
    });

    testWidgets('malformed return links are not sent to the server', (tester) async {
      final harness = AppHarness(storedRefreshToken: 'rt_stored');
      await harness.pump(tester);
      for (final link in [
        '${AppRoutes.identityReturn}?verification=not-a-uuid&confirmation=$_confirmation',
        '${AppRoutes.identityReturn}?verification=$_verificationId&confirmation=short',
        AppRoutes.identityReturn,
      ]) {
        harness.container.read(routerProvider).go(link);
        await tester.pumpAndSettle();
        expect(find.byType(IdentityScreen), findsOneWidget);
      }
      expect(harness.identity.calls, isEmpty);
    });

    testWidgets('a return link that cold-starts the app is resumed after the session restore', (
      tester,
    ) async {
      final harness = AppHarness(storedRefreshToken: 'rt_stored');
      final refresh = Completer<AuthTokens>();
      harness.auth.onRefresh = (_) => refresh.future;
      await harness.pump(tester, settle: false);
      harness.container.read(routerProvider).go(_returnLink);
      await tester.pump();
      expect(find.byType(SplashScreen), findsOneWidget);
      refresh.complete(tokens('restored'));
      await tester.pumpAndSettle();
      expect(harness.identity.calls, ['confirm:$_verificationId:$_confirmation']);
      expect(find.byType(IdentityScreen), findsOneWidget);
    });

    test('splash only resumes the identity return route (no open redirect)', () {
      const signedIn = SignedIn('s');
      Uri splash(String next) => Uri(path: AppRoutes.splash, queryParameters: {'next': next});
      expect(redirectFor(signedIn, AppRoutes.splash, uri: splash(_returnLink)), _returnLink);
      for (final next in [
        'https://evil.example/identity/return',
        '/account/password',
        '//evil.example/identity/return',
      ]) {
        expect(redirectFor(signedIn, AppRoutes.splash, uri: splash(next)), AppRoutes.account);
      }
      expect(
        redirectFor(
          const SessionRestoring(),
          AppRoutes.identityReturn,
          uri: Uri.parse('$_returnLink&extra=dropped'),
        ),
        splash(_returnLink).toString(),
      );
    });

    testWidgets('the return link needs a session (guard is UX only)', (tester) async {
      final harness = AppHarness();
      await harness.pump(tester);
      harness.container.read(routerProvider).go('${AppRoutes.identityReturn}?verification=x');
      await tester.pumpAndSettle();
      expect(find.byType(IdentityScreen), findsNothing);
      expect(find.byType(WelcomeScreen), findsOneWidget);
    });

    test('identity routes are guarded like the account routes', () {
      for (final route in [AppRoutes.identity, AppRoutes.identityReturn]) {
        expect(redirectFor(const SignedOut(), route), AppRoutes.welcome);
        expect(redirectFor(const SignedIn('s'), route), isNull);
      }
    });
  });
}
