import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobility/app/l10n/l10n.dart';
import 'package:mobility/app/router.dart';
import 'package:mobility/app/theme/app_theme.dart';
import 'package:mobility/core/auth/session_state.dart';
import 'package:mobility/core/l10n/locale_controller.dart';
import 'package:mobility/core/network/api_failure.dart';
import 'package:mobility/core/widgets/state_views.dart';
import 'package:mobility/features/not_found/not_found_screen.dart';
import 'package:mobility/features/system_status/data/system_status_api.dart';
import 'package:mobility/features/welcome/welcome_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../helpers/pump_app.dart';

/// Returns the scripted results in order, one per call.
final class _FakeStatusApi implements SystemStatusApi {
  _FakeStatusApi(this._results);

  final List<FutureOr<ServiceStatus> Function()> _results;
  int calls = 0;

  @override
  Future<ServiceStatus> fetchStatus() async => _results[calls++]();
}

void main() {
  group('WelcomeScreen', () {
    Future<_FakeStatusApi> pumpWelcome(
      WidgetTester tester,
      List<FutureOr<ServiceStatus> Function()> results, {
      Locale locale = const Locale('en'),
      double textScale = 1.0,
    }) async {
      final api = _FakeStatusApi(results);
      await pumpLocalized(
        tester,
        const WelcomeScreen(),
        overrides: [systemStatusApiProvider.overrideWithValue(api)],
        locale: locale,
        textScale: textScale,
      );
      return api;
    }

    testWidgets('shows the checking state, then online', (tester) async {
      final completer = Completer<ServiceStatus>();
      await pumpWelcome(tester, [() => completer.future]);
      await tester.pump();
      // The Card merges child semantics, so the label is read together with the title.
      expect(
        find.byWidgetPredicate((w) => w is LoadingView && w.label == 'Checking connection…'),
        findsOneWidget,
      );
      expect(find.bySemanticsLabel(RegExp('Checking connection…')), findsOneWidget);

      completer.complete(ServiceStatus.online);
      await tester.pumpAndSettle();
      expect(find.text('Connected to the service'), findsOneWidget);
    });

    testWidgets('shows a localized error and recovers on retry', (tester) async {
      final api = await pumpWelcome(tester, [
        () => throw const NetworkFailure(),
        () => ServiceStatus.online,
      ]);
      await tester.pumpAndSettle();
      expect(
        find.text('No internet connection. Check your connection and try again.'),
        findsOneWidget,
      );

      // Phase 3 put the sign-in buttons above the status card: scroll it into view.
      await tester.ensureVisible(find.text('Try again'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Try again'));
      await tester.pumpAndSettle();
      expect(find.text('Connected to the service'), findsOneWidget);
      expect(api.calls, 2);
    });

    testWidgets('renders in Amharic', (tester) async {
      await pumpWelcome(tester, [() => ServiceStatus.online], locale: const Locale('am'));
      await tester.pumpAndSettle();
      expect(find.text('የአገልግሎት ሁኔታ'), findsOneWidget);
      expect(find.text('ከአገልግሎቱ ጋር ተገናኝቷል'), findsOneWidget);
    });

    for (final locale in const [Locale('en'), Locale('am')]) {
      testWidgets('has no overflow at 200% text size on a small phone (${locale.languageCode})', (
        tester,
      ) async {
        useSmallPhone(tester);
        await pumpWelcome(
          tester,
          [() => throw const ServerFailure(requestId: 'abcdef1234')],
          locale: locale,
          textScale: 2,
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      });
    }

    testWidgets('meets Android tap-target and contrast guidelines', (tester) async {
      await pumpWelcome(tester, [() => ServiceStatus.online]);
      await tester.pumpAndSettle();
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(textContrastGuideline));
    });
  });

  group('language switching', () {
    testWidgets('switches the whole app to Amharic and persists it', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      await tester.pumpWidget(
        ProviderScope(
          retry: (_, _) => null,
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
            systemStatusApiProvider.overrideWithValue(_FakeStatusApi([() => ServiceStatus.online])),
          ],
          child: Consumer(
            builder: (context, ref, _) => MaterialApp(
              theme: AppTheme.light(),
              locale: ref.watch(localeControllerProvider) ?? const Locale('en'),
              supportedLocales: AppLocalizations.supportedLocales,
              localizationsDelegates: AppLocalizations.localizationsDelegates,
              home: const WelcomeScreen(),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Service status'), findsOneWidget);

      await tester.tap(find.byTooltip('Language'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('አማርኛ').last);
      await tester.pumpAndSettle();

      expect(find.text('የአገልግሎት ሁኔታ'), findsOneWidget);
      expect(prefs.getString(LocaleController.storageKey), 'am');
    });
  });

  group('router', () {
    Future<void> pumpRouter(WidgetTester tester, String location) async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final session = ValueNotifier<SessionState>(const SignedOut());
      addTearDown(session.dispose);
      final router = buildRouter(session: session, initialLocation: location);
      addTearDown(router.dispose);
      await tester.pumpWidget(
        ProviderScope(
          retry: (_, _) => null,
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
            systemStatusApiProvider.overrideWithValue(
              _FakeStatusApi([() => ServiceStatus.online, () => ServiceStatus.online]),
            ),
          ],
          child: MaterialApp.router(
            routerConfig: router,
            supportedLocales: AppLocalizations.supportedLocales,
            localizationsDelegates: AppLocalizations.localizationsDelegates,
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('redirects / to the welcome screen', (tester) async {
      await pumpRouter(tester, '/');
      expect(find.byType(WelcomeScreen), findsOneWidget);
    });

    testWidgets('sends unknown deep links to the not-found screen, which can go home', (
      tester,
    ) async {
      await pumpRouter(tester, '/admin/payouts?token=abc');
      expect(find.byType(NotFoundScreen), findsOneWidget);
      expect(find.text('Page not found'), findsWidgets);

      await tester.tap(find.text('Go to start'));
      await tester.pumpAndSettle();
      expect(find.byType(WelcomeScreen), findsOneWidget);
    });
  });
}
