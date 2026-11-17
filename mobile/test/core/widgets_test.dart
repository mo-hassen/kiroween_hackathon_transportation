import 'package:core_shared/core_shared.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobility/core/network/api_failure.dart';
import 'package:mobility/core/widgets/async_value_view.dart';
import 'package:mobility/core/widgets/money_text.dart';
import 'package:mobility/core/widgets/primary_button.dart';
import 'package:mobility/core/widgets/state_views.dart';

import '../helpers/pump_app.dart';

/// Loads a list once, then fails on every refresh with [refreshError].
final class _ScriptedList extends AsyncNotifier<List<String>> {
  _ScriptedList(this.refreshError);

  final Object refreshError;
  int _calls = 0;

  @override
  Future<List<String>> build() async {
    _calls++;
    if (_calls == 1) return ['Vitz 2014'];
    throw refreshError;
  }
}

AsyncNotifierProvider<_ScriptedList, List<String>> _listProvider(Object refreshError) =>
    AsyncNotifierProvider<_ScriptedList, List<String>>(() => _ScriptedList(refreshError));

class _ListScreen extends ConsumerWidget {
  const _ListScreen(this.provider);

  final AsyncNotifierProvider<_ScriptedList, List<String>> provider;

  @override
  Widget build(BuildContext context, WidgetRef ref) => Scaffold(
    body: AsyncValueView(
      value: ref.watch(provider),
      onRetry: () => ref.invalidate(provider),
      data: (items) => ListView(children: [for (final item in items) Text(item)]),
    ),
  );
}

void main() {
  group('AsyncValueView', () {
    Future<void> pumpValue(
      WidgetTester tester,
      AsyncValue<List<String>> value, {
      VoidCallback? onRetry,
    }) => pumpLocalized(
      tester,
      Scaffold(
        body: AsyncValueView<List<String>>(
          value: value,
          onRetry: onRetry,
          isEmpty: (items) => items.isEmpty,
          data: (items) => Column(children: [for (final item in items) Text(item)]),
        ),
      ),
    );

    testWidgets('loading', (tester) async {
      await pumpValue(tester, const AsyncLoading());
      expect(find.byType(LoadingView), findsOneWidget);
      expect(find.bySemanticsLabel('Loading'), findsOneWidget);
    });

    testWidgets('data', (tester) async {
      await pumpValue(tester, const AsyncData(['Corolla 2016']));
      expect(find.text('Corolla 2016'), findsOneWidget);
    });

    testWidgets('empty', (tester) async {
      await pumpValue(tester, const AsyncData([]));
      expect(find.byType(EmptyView), findsOneWidget);
      expect(find.text('Nothing here yet'), findsOneWidget);
    });

    testWidgets('error with retry and support reference', (tester) async {
      var retries = 0;
      await pumpValue(
        tester,
        const AsyncError(ServerFailure(requestId: 'abcdef12-3456'), StackTrace.empty),
        onRetry: () => retries++,
      );
      expect(
        find.text('Something went wrong on our side. Please try again later.'),
        findsOneWidget,
      );
      expect(find.text('Reference: abcdef12'), findsOneWidget);
      await tester.tap(find.text('Try again'));
      expect(retries, 1);
    });

    testWidgets('offline without cached data shows the connectivity error', (tester) async {
      await pumpValue(tester, const AsyncError(NetworkFailure(), StackTrace.empty));
      expect(
        find.text('No internet connection. Check your connection and try again.'),
        findsOneWidget,
      );
      expect(find.byType(OfflineBanner), findsNothing);
    });

    testWidgets('offline with cached data keeps the data under a banner', (tester) async {
      final provider = _listProvider(const NetworkFailure());
      await pumpLocalized(tester, _ListScreen(provider));
      await tester.pumpAndSettle();
      expect(find.text('Vitz 2014'), findsOneWidget);

      final container = ProviderScope.containerOf(tester.element(find.byType(_ListScreen)));
      container.invalidate(provider);
      await tester.pumpAndSettle();

      expect(find.byType(OfflineBanner), findsOneWidget);
      expect(find.text('You are offline. Showing saved information.'), findsOneWidget);
      expect(find.text('Vitz 2014'), findsOneWidget);
    });

    testWidgets('non-connectivity failure after data replaces the data with an error', (
      tester,
    ) async {
      final provider = _listProvider(const ForbiddenFailure());
      await pumpLocalized(tester, _ListScreen(provider));
      await tester.pumpAndSettle();
      ProviderScope.containerOf(tester.element(find.byType(_ListScreen))).invalidate(provider);
      await tester.pumpAndSettle();
      expect(find.text("You don't have access to this."), findsOneWidget);
      expect(find.text('Vitz 2014'), findsNothing);
    });

    testWidgets('error messages are localized in Amharic', (tester) async {
      await pumpLocalized(
        tester,
        const Scaffold(body: ErrorView(failure: NetworkFailure())),
        locale: const Locale('am'),
      );
      expect(find.text('የኢንተርኔት ግንኙነት የለም። ግንኙነትዎን ያረጋግጡና እንደገና ይሞክሩ።'), findsOneWidget);
    });
  });

  group('PrimaryButton', () {
    testWidgets('ignores taps and shows progress while loading', (tester) async {
      var taps = 0;
      await pumpLocalized(
        tester,
        Scaffold(
          body: PrimaryButton(label: 'Submit', onPressed: () => taps++, isLoading: true),
        ),
      );
      await tester.tap(find.byType(FilledButton));
      expect(taps, 0);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Submit'), findsNothing);
    });

    testWidgets('meets the 48 dp touch target', (tester) async {
      await pumpLocalized(
        tester,
        Scaffold(
          body: PrimaryButton(label: 'Submit', onPressed: () {}),
        ),
      );
      expect(tester.getSize(find.byType(FilledButton)).height, greaterThanOrEqualTo(48));
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    });
  });

  group('MoneyText', () {
    testWidgets('formats ETB in English', (tester) async {
      await pumpLocalized(tester, Scaffold(body: MoneyText(Money.etb(150050))));
      expect(find.text('ETB 1,500.50'), findsOneWidget);
    });

    testWidgets('formats ETB in Amharic', (tester) async {
      await pumpLocalized(
        tester,
        Scaffold(body: MoneyText(Money.etb(150050))),
        locale: const Locale('am'),
      );
      expect(find.text('ብር 1,500.50'), findsOneWidget);
    });
  });
}
