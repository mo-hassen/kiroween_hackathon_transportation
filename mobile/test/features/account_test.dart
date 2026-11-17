import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobility/core/config/app_info.dart';
import 'package:mobility/core/network/api_failure.dart';
import 'package:mobility/features/account/data/account_api.dart';
import 'package:mobility/features/account/presentation/account_screen.dart';
import 'package:mobility/features/account/presentation/change_password_screen.dart';
import 'package:mobility/features/account/presentation/sessions_screen.dart';
import 'package:mobility/features/welcome/welcome_screen.dart';

import '../helpers/app_harness.dart';

void main() {
  Future<AppHarness> signedIn(WidgetTester tester) async {
    final harness = AppHarness(storedRefreshToken: 'rt_stored');
    await harness.pump(tester);
    expect(find.byType(AccountScreen), findsOneWidget);
    return harness;
  }

  testWidgets('shows the profile with a formatted phone number', (tester) async {
    await signedIn(tester);
    expect(find.text('Abebe Kebede'), findsOneWidget);
    expect(find.text('+251 91 123 4567'), findsOneWidget);
  });

  testWidgets('edits the name with the version it read (If-Match)', (tester) async {
    final harness = await signedIn(tester);
    await tester.tap(find.byTooltip('Edit name'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'Abebe K.');
    await tapText(tester, 'Save');
    expect(harness.account.calls, ['update:3:Abebe K.']);
    expect(find.text('Name saved.'), findsOneWidget);
  });

  testWidgets('a suspended account is read-only in the UI as on the server', (tester) async {
    final harness = AppHarness(storedRefreshToken: 'rt_stored');
    harness.account.profile = const AccountProfile(
      id: 'u',
      phone: '+251911234567',
      displayName: 'Abebe',
      preferredLocale: 'en',
      status: 'SUSPENDED',
      version: 1,
    );
    await harness.pump(tester);
    expect(find.textContaining('Your account is suspended.'), findsOneWidget);
    expect(find.byTooltip('Edit name'), findsNothing);
    expect(find.text('Change password'), findsNothing);
    expect(find.text('Devices and sessions'), findsOneWidget);
  });

  testWidgets('lists devices, marks this one, and signs out another after confirmation', (
    tester,
  ) async {
    final harness = await signedIn(tester);
    await tapText(tester, 'Devices and sessions');
    expect(find.byType(SessionsScreen), findsOneWidget);
    expect(find.text('This device'), findsOneWidget);
    expect(find.text('Android phone'), findsOneWidget);
    expect(find.text('iPhone'), findsOneWidget);

    await tester.tap(find.byTooltip('Sign out this device'));
    await tester.pumpAndSettle();
    expect(find.textContaining('will need a text-message code'), findsOneWidget);
    await tapText(tester, 'Sign out this device');
    expect(harness.account.revoked, ['s-tablet']);
    expect(find.text('iPhone'), findsNothing);
  });

  testWidgets('change password: shows a wrong current password under its field', (tester) async {
    final harness = await signedIn(tester);
    await tapText(tester, 'Change password');
    expect(find.byType(ChangePasswordScreen), findsOneWidget);
    harness.account.changePasswordFailure = const ValidationFailure(
      fieldErrors: [FieldError(field: 'currentPassword', code: 'INCORRECT')],
      code: 'VALIDATION_FAILED',
    );
    await enterText(tester, 'Current password', 'not-it');
    await enterText(tester, 'New password', 'Merkato-Market-2030');
    await tapText(tester, 'Save');
    expect(find.text('The current password is incorrect.'), findsOneWidget);

    harness.account.changePasswordFailure = null;
    await tapText(tester, 'Save');
    expect(find.text('Password changed. Other devices were signed out.'), findsOneWidget);
    expect(find.byType(AccountScreen), findsOneWidget);
  });

  testWidgets('sign-out asks for confirmation, clears the session and tells the server', (
    tester,
  ) async {
    final harness = await signedIn(tester);
    await tapText(tester, 'Sign out');
    expect(find.text('Sign out of this device?'), findsOneWidget);
    await tapText(tester, 'Sign out');
    expect(find.byType(WelcomeScreen), findsOneWidget);
    expect(harness.store.value, isNull);
    await tester.runAsync(flushMicrotasks);
    expect(harness.auth.calls.last, 'logout:rt_refresh-refreshed');
  });

  testWidgets('a guarded route cannot be opened while signed out', (tester) async {
    final harness = AppHarness();
    await harness.pump(tester);
    expect(find.byType(WelcomeScreen), findsOneWidget);
    expect(find.byType(AccountScreen), findsNothing);
  });

  test('reports the same app version as pubspec.yaml', () {
    final version = RegExp(
      r'^version:\s*([0-9.]+)',
      multiLine: true,
    ).firstMatch(File('pubspec.yaml').readAsStringSync())?[1];
    expect(appVersion, version);
  });
}
