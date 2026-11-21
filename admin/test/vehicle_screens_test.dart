import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kiroween_admin/app/router.dart';
import 'package:kiroween_admin/core/api.dart';
import 'package:kiroween_admin/core/session.dart';
import 'package:kiroween_admin/features/vehicles/vehicle_review_api.dart';

import 'helpers/fake_http_adapter.dart';
import 'helpers/fakes.dart';
import 'helpers/vehicle_fakes.dart';

const verifier = ['vehicles.verify'];

Future<void> openVehicles(WidgetTester tester) async {
  await tester.tap(find.text('Vehicles').first);
  await tester.pumpAndSettle();
}

Future<void> confirmChecks(WidgetTester tester) async {
  final count = find.byType(Checkbox).evaluate().length;
  for (var i = 0; i < count; i++) {
    final box = find.byType(Checkbox).at(i);
    if (tester.widget<Checkbox>(box).value ?? false) continue;
    await tester.ensureVisible(box);
    await tester.tap(box);
    await tester.pump();
  }
}

FilledButton confirmButton(WidgetTester tester) =>
    tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Confirm'));

void main() {
  group('routing by permission', () {
    SignedIn signedIn(List<String> permissions) =>
        SignedIn(StaffProfile.fromJson(staffMe(permissions: permissions)));

    test('vehicles.verify alone reaches /vehicles but not /drivers or /owners', () {
      final officer = signedIn(verifier);
      expect(staffRedirect(officer, Uri.parse('/vehicles/x')), isNull);
      expect(staffRedirect(officer, Uri.parse('/drivers')), '/');
      expect(staffRedirect(officer, Uri.parse('/owners')), '/');
      expect(staffRedirect(officer, Uri.parse('/no-permission')), '/');
    });

    test('other review permissions cannot open vehicle cases; no permission is refused', () {
      expect(
        staffRedirect(signedIn(const ['drivers.review', 'owners.review']), Uri.parse('/vehicles')),
        '/',
      );
      expect(
        staffRedirect(signedIn(const ['users.read']), Uri.parse('/vehicles')),
        '/no-permission',
      );
    });
  });

  testWidgets('dashboard and navigation show vehicles only with vehicles.verify', (tester) async {
    final vehicles = FakeVehicleReviewApi();
    await pumpAdmin(
      tester,
      auth: FakeStaffAuthApi(me: staffMe(permissions: verifier)),
      vehicles: vehicles,
    );
    await signIn(tester);
    expect(find.text('Vehicle verification'), findsOneWidget);
    expect(find.text('Vehicles'), findsOneWidget);
    expect(find.text('7'), findsOneWidget);
  });

  testWidgets('without vehicles.verify there is no vehicle navigation, counts or call', (
    tester,
  ) async {
    final vehicles = FakeVehicleReviewApi();
    await pumpAdmin(tester, auth: FakeStaffAuthApi(), vehicles: vehicles);
    await signIn(tester);
    expect(find.text('Vehicles'), findsNothing);
    expect(find.text('Vehicle verification'), findsNothing);
    expect(vehicles.calls, isEmpty);
  });

  testWidgets('claim, inspect with a reason, approve needs all four checks', (tester) async {
    final vehicles = FakeVehicleReviewApi();
    final viewer = FakeDocumentViewer();
    await pumpAdmin(
      tester,
      auth: FakeStaffAuthApi(me: staffMe(permissions: verifier)),
      vehicles: vehicles,
      viewer: viewer,
    );
    await signIn(tester);
    await openVehicles(tester);
    expect(vehicles.calls, contains('list:SUBMITTED::'));
    expect(find.text('Toyota Vitz (2018)'), findsOneWidget);
    await tester.tap(find.text('Claim'));
    await tester.pumpAndSettle();
    expect(find.text('Vehicle case'), findsOneWidget);
    // The full VIN appears only after the claim, with the audit hint.
    expect(find.text(fakeVin), findsOneWidget);
    expect(
      find.textContaining('The full VIN and engine number are shown because you hold the claim'),
      findsOneWidget,
    );
    expect(find.text('Photo: front'), findsOneWidget);
    expect(find.text('Photo: interior (optional)'), findsOneWidget);
    expect(find.textContaining('Valid until 2027-06-01'), findsNWidgets(2));

    // A document opens only after a reason.
    await tester.tap(find.text('View').first);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'Checking the registration');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
    await tester.pumpAndSettle();
    expect(vehicles.calls, contains('url:veh-1:doc-REGISTRATION:Checking the registration'));
    expect(viewer.shown, ['https://storage.test/doc-REGISTRATION?sig=1:false']);

    await tester.tap(find.text('Approve vehicle'));
    await tester.pumpAndSettle();
    expect(find.textContaining('does not list it'), findsOneWidget);
    expect(find.byType(CheckboxListTile), findsNWidgets(4));
    expect(confirmButton(tester).onPressed, isNull);
    await tester.tap(find.byType(CheckboxListTile).first);
    await tester.pump();
    expect(confirmButton(tester).onPressed, isNull);
    await confirmChecks(tester);
    expect(confirmButton(tester).onPressed, isNotNull);
    await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
    await tester.pumpAndSettle();
    expect(vehicles.calls, contains('approve:veh-1'));
    expect(find.text('Decision saved.'), findsOneWidget);
    expect(find.text('Suspend vehicle'), findsOneWidget);
    expect(find.text('Approve vehicle'), findsNothing);
  });

  testWidgets('evidence stays closed while another officer holds the case', (tester) async {
    final vehicles = FakeVehicleReviewApi(
      cases: [vehicleSummary(status: 'UNDER_REVIEW', claimedByOther: true)],
    );
    await pumpAdmin(
      tester,
      auth: FakeStaffAuthApi(me: staffMe(permissions: verifier)),
      vehicles: vehicles,
    );
    await signIn(tester);
    await openVehicles(tester);
    await tester.tap(find.byKey(const ValueKey('vehicle-status')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Under review').last);
    await tester.pumpAndSettle();
    expect(find.text('Claim'), findsNothing);
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(find.text('View'), findsNothing);
    expect(find.text(fakeVin), findsNothing);
    expect(find.text('••••3456'), findsOneWidget);
    expect(find.textContaining('Claim the case to see the full VIN'), findsOneWidget);
    expect(find.text('Approve vehicle'), findsNothing);
  });

  testWidgets('reject needs a reason; the allowed codes are the vehicle ones', (tester) async {
    final vehicles = FakeVehicleReviewApi(
      cases: [vehicleSummary(status: 'UNDER_REVIEW', claimedByMe: true)],
    );
    await pumpAdmin(
      tester,
      auth: FakeStaffAuthApi(me: staffMe(permissions: verifier)),
      vehicles: vehicles,
    );
    await signIn(tester);
    await openVehicles(tester);
    await tester.tap(find.byKey(const ValueKey('vehicle-status')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Under review').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reject'));
    await tester.pumpAndSettle();
    expect(confirmButton(tester).onPressed, isNull);
    await tester.tap(find.text('Reason'));
    await tester.pumpAndSettle();
    expect(find.text('Vehicle details do not match'), findsOneWidget);
    expect(find.text('A document is invalid'), findsOneWidget);
    expect(find.text('Safety concern'), findsNothing);
    await tester.tap(find.text('Vehicle details do not match').last);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
    await tester.pumpAndSettle();
    expect(vehicles.calls, contains('reject:veh-1:VEHICLE_DETAILS_MISMATCH'));
  });

  testWidgets('suspend needs a reason and a note; reinstate needs a note', (tester) async {
    final vehicles = FakeVehicleReviewApi(cases: [vehicleSummary(status: 'APPROVED')]);
    await pumpAdmin(
      tester,
      auth: FakeStaffAuthApi(me: staffMe(permissions: verifier)),
      vehicles: vehicles,
    );
    await signIn(tester);
    await openVehicles(tester);
    await tester.tap(find.byKey(const ValueKey('vehicle-status')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Approved').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Suspend vehicle'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reason'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Suspected fraud').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'short');
    await tester.pump();
    expect(confirmButton(tester).onPressed, isNull);
    await tester.enterText(find.byType(TextField).last, 'Registration looks altered');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
    await tester.pumpAndSettle();
    expect(vehicles.calls, contains('suspend:veh-1:SUSPECTED_FRAUD:Registration looks altered'));
    expect(find.text('Reinstate vehicle'), findsOneWidget);
  });

  testWidgets('a server refusal is explained with a localized message, not its text', (
    tester,
  ) async {
    final vehicles = FakeVehicleReviewApi()
      ..actionFailure = const ApiFailure(FailureKind.conflict, code: 'REVIEW_CLAIMED_BY_OTHER');
    await pumpAdmin(
      tester,
      auth: FakeStaffAuthApi(me: staffMe(permissions: verifier)),
      vehicles: vehicles,
    );
    await signIn(tester);
    await openVehicles(tester);
    await tester.tap(find.text('Claim'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Another officer'), findsWidgets);
  });

  test(
    'HttpVehicleReviewApi sends the four checks, a fresh Idempotency-Key and no VIN query',
    () async {
      final adapter = FakeHttpAdapter([
        respond({'data': null}, 200),
        respond({'data': null}, 200),
        respond({
          'data': {'items': <Object?>[], 'total': 0, 'page': 1, 'limit': 20},
        }, 200),
      ]);
      final dio = Dio(BaseOptions(baseUrl: 'http://api.test/api/v1'))..httpClientAdapter = adapter;
      final api = HttpVehicleReviewApi(ApiClient(dio));
      await api.approve('v1');
      await api.reject('v1', reasonCode: 'BLURRY', note: 'Rear photo');
      await api.list(status: 'SUBMITTED', vehicleType: 'SUV', query: 'AA');

      expect(adapter.requests[0].path, '/admin/vehicle-verifications/v1/approve');
      expect(adapter.requests[0].data, {
        'detailsMatch': true,
        'ownerMatchesRegistration': true,
        'documentsLegible': true,
        'photosMatch': true,
      });
      expect(adapter.requests[1].data, {'reasonCode': 'BLURRY', 'note': 'Rear photo'});
      final keys = [
        adapter.sentHeaders[0]['Idempotency-Key'],
        adapter.sentHeaders[1]['Idempotency-Key'],
      ];
      expect(keys.every((k) => k is String && k.length == 36), isTrue);
      expect(keys.toSet(), hasLength(2));
      expect(adapter.requests[2].queryParameters, {
        'status': 'SUBMITTED',
        'vehicleType': 'SUV',
        'q': 'AA',
        'page': '1',
        'limit': '20',
      });
    },
  );
}
