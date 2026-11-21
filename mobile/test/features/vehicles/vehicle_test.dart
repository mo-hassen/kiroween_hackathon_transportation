import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobility/app/router.dart';
import 'package:mobility/app/routes.dart';
import 'package:mobility/core/auth/session_state.dart';
import 'package:mobility/core/network/api_client.dart';
import 'package:mobility/core/network/api_failure.dart';
import 'package:mobility/features/driver/data/license_upload.dart';
import 'package:mobility/features/owner/data/owner_api.dart';
import 'package:mobility/features/vehicles/data/vehicle_api.dart';

import '../../helpers/driver_fakes.dart';
import '../../helpers/fake_http_adapter.dart';
import '../../helpers/owner_fakes.dart';
import '../../helpers/vehicle_fakes.dart';

Map<String, Object?> _json() => {
  'id': vehicleId,
  'vehicleType': 'PICKUP',
  'make': 'Isuzu',
  'model': 'D-Max',
  'year': 2020,
  'color': null,
  'seats': 5,
  'transmission': 'MANUAL',
  'fuelType': 'DIESEL',
  'plate': {'region': 'OR', 'code': '3', 'number': '98765'},
  'vinMasked': '••••3456',
  'engineNumberOnFile': false,
  'status': 'REJECTED',
  'decisionReasonCode': 'BLURRY',
  'decisionNote': 'The rear photo is out of focus',
  'editable': true,
  'evidence': [
    {
      'slot': 'INSURANCE',
      'required': true,
      'expiresOn': '2027-03-31',
      'document': {
        'id': 'd1',
        'uploadStatus': 'AVAILABLE',
        'reviewStatus': 'SUBMITTED',
        'mimeType': 'image/jpeg',
        'failureCode': null,
      },
    },
    {'slot': 'SOMETHING_NEW', 'required': false, 'expiresOn': null, 'document': null},
  ],
  'submissionProblems': ['PHOTO_FRONT_MISSING'],
  'eligibility': {
    'eligible': false,
    'blockers': ['VEHICLE_NOT_APPROVED'],
  },
  'version': 7,
};

Finder slotButton(EvidenceSlot slot, String label) => find.ancestor(
  of: find.descendant(of: find.byKey(ValueKey(slot)), matching: find.text(label)),
  matching: find.bySubtype<ButtonStyleButton>(),
);

Future<void> scrollTo(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
}

void main() {
  group('data', () {
    test('parses the vehicle response; the VIN is only ever masked; unknown slots are ignored', () {
      final v = Vehicle.fromJson(_json());
      expect(v.status, VehicleStatus.rejected);
      expect(v.plate, 'OR 3 98765');
      expect(v.vinMasked, '••••3456');
      expect(v.evidence.map((e) => e.slot), [EvidenceSlot.insurance]);
      expect(v.evidenceFor(EvidenceSlot.insurance)?.expiresOn, '2027-03-31');
      expect(v.requiredReady, 1);
      expect(v.requiredTotal, 9);
      expect(v.readyToSubmit, isFalse);
      expect(v.eligible, isFalse);
      expect(VehicleStatus.parse('SOMETHING_NEW'), VehicleStatus.unknown);
    });

    test('counts only required slots that are ready', () {
      expect(vehicle(ready: {EvidenceSlot.photoInterior}).requiredReady, 0);
      expect(vehicle(ready: allRequired).requiredReady, 9);
      expect(vehicle(ready: allRequired).readyToSubmit, isTrue);
      // The server's blockers decide, not the count.
      expect(vehicle(ready: allRequired, problems: ['INSURANCE_EXPIRED']).readyToSubmit, isFalse);
    });

    test('input checks match the API', () {
      expect(normalizeVin(' jtdkb20u 777-123456 '), 'JTDKB20U777123456');
      expect(normalizeVin('abc'), isNull);
      expect(normalizeVin('ABC!DEF12345'), isNull);
      expect(normalizeEngineNumber('2nz-fe 123'), '2NZFE123');
      expect(validPlatePart('AA'), isTrue);
      expect(validPlatePart('ኢት 12'), isTrue);
      expect(validPlatePart(''), isFalse);
      expect(validPlatePart('1' * 13), isFalse);
      expect(validPlatePart("2';--"), isFalse);
      expect(validDisplayText('Land Rover (110)', max: 60), isTrue);
      expect(validDisplayText('<script>', max: 60), isFalse);
      expect(validDisplayText('', max: 60), isFalse);
    });

    test(
      'HttpVehicleApi sends no ownership data, If-Match, the expiry date and an idempotency key',
      () async {
        final adapter = FakeHttpAdapter([
          respond({
            'data': {
              'items': [_json()],
            },
          }, 200),
          respond({'data': _json()}, 201),
          respond({'data': _json()}, 200),
          respond({'data': _json()}, 200),
          respond({'data': _json()}, 200),
        ]);
        final dio = Dio(BaseOptions(baseUrl: 'http://api.test/api/v1'))
          ..httpClientAdapter = adapter;
        final api = HttpVehicleApi(ApiClient(dio));
        const input = VehicleInput(
          type: 'PICKUP',
          make: 'Isuzu',
          model: 'D-Max',
          year: 2020,
          seats: 5,
          transmission: 'MANUAL',
          fuel: 'DIESEL',
          plateRegion: 'OR',
          plateCode: '3',
          plateNumber: '98765',
        );
        expect((await api.list()).single.make, 'Isuzu');
        await api.create(input);
        await api.update(vehicleId, 7, input);
        await api.attach(vehicleId, EvidenceSlot.insurance, 'd9', expiresOn: '2027-04-01');
        await api.submit(vehicleId, idempotencyKey: 'key-1');
        final body = adapter.requests[1].data! as Map;
        expect(body.keys, isNot(contains('ownerProfileId')));
        expect(body.keys, isNot(contains('status')));
        expect(body.keys, isNot(contains('vin')));
        expect(adapter.requests[2].method, 'PATCH');
        expect(adapter.sentHeaders[2]['If-Match'], '7');
        expect(adapter.requests[3].method, 'PUT');
        expect(adapter.requests[3].path, '/vehicles/$vehicleId/evidence/INSURANCE');
        expect(adapter.requests[3].data, {'documentId': 'd9', 'expiresOn': '2027-04-01'});
        expect(adapter.requests[4].path, '/vehicles/$vehicleId/submit');
        expect(adapter.sentHeaders[4]['Idempotency-Key'], 'key-1');
      },
    );
  });

  group('routes', () {
    test('vehicle id routes are guarded; other paths are left to not-found', () {
      expect(AppRoutes.isKnown(AppRoutes.vehicle(vehicleId)), isTrue);
      expect(AppRoutes.isKnown(AppRoutes.vehicleEdit(vehicleId)), isTrue);
      expect(AppRoutes.isKnown(AppRoutes.vehicleReview(vehicleId)), isTrue);
      expect(AppRoutes.isKnown('/vehicles/not-a-uuid'), isFalse);
      expect(AppRoutes.isKnown('/vehicles/$vehicleId/other'), isFalse);
      expect(redirectFor(const SignedOut(), AppRoutes.vehicle(vehicleId)), AppRoutes.welcome);
      expect(redirectFor(const SignedOut(), AppRoutes.vehicles), AppRoutes.welcome);
      expect(redirectFor(const SignedOut(), '/vehicles/not-a-uuid'), isNull);
    });
  });

  group('list', () {
    testWidgets('an owner who is not verified is sent to owner verification first', (tester) async {
      await pumpVehicles(
        tester,
        api: FakeVehicleApi(),
        owner: FakeOwnerApi(
          current: ownerProfile(type: OwnerType.individual, status: OwnerStatus.pending),
        ),
      );
      expect(find.text('Verify your owner profile first'), findsOneWidget);
      expect(find.text('Add a vehicle'), findsNothing);
      await tester.tap(find.text('Go to owner verification'));
      await tester.pumpAndSettle();
      expect(find.text('owner hub'), findsOneWidget);
    });

    testWidgets('a verified owner sees an empty state with the add button', (tester) async {
      await pumpVehicles(tester, api: FakeVehicleApi());
      expect(find.text('No vehicles yet'), findsOneWidget);
      expect(find.text('Add a vehicle'), findsOneWidget);
    });

    testWidgets('lists vehicles with their status; a suspended owner can still read them', (
      tester,
    ) async {
      await pumpVehicles(
        tester,
        api: FakeVehicleApi(
          vehicles: [
            vehicle(status: VehicleStatus.approved, ready: allRequired),
            vehicle(id: '0192a000-0000-7000-8000-000000000002', status: VehicleStatus.rejected),
          ],
        ),
        owner: FakeOwnerApi(
          current: ownerProfile(type: OwnerType.individual, status: OwnerStatus.suspended),
        ),
      );
      expect(find.textContaining('Toyota Vitz (2018)'), findsNWidgets(2));
      expect(find.textContaining('Approved'), findsOneWidget);
      expect(find.textContaining('Needs changes'), findsOneWidget);
      expect(find.text('Add a vehicle'), findsNothing);
    });

    testWidgets('Amharic labels', (tester) async {
      await pumpVehicles(
        tester,
        api: FakeVehicleApi(
          vehicles: [vehicle(status: VehicleStatus.approved, ready: allRequired)],
        ),
        locale: const Locale('am'),
      );
      expect(find.text('የእኔ ተሽከርካሪዎች'), findsOneWidget);
      expect(find.textContaining('ጸድቋል'), findsOneWidget);
    });
  });

  group('form', () {
    testWidgets('needs the required fields, then creates the vehicle and opens it', (tester) async {
      final api = FakeVehicleApi();
      await pumpVehicles(tester, api: api);
      await tester.tap(find.text('Add a vehicle'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(api.calls.where((c) => c.startsWith('create')), isEmpty);
      expect(find.text('Required'), findsWidgets);

      Future<void> type(String label, String text) async {
        final field = find.widgetWithText(TextFormField, label);
        await tester.ensureVisible(field);
        await tester.enterText(field, text);
      }

      await type('Make (for example Toyota)', 'Toyota');
      await type('Model (for example Vitz)', 'Vitz');
      await type('Year', '1975');
      await type('Region (for example AA)', 'AA');
      await type('Code (for example 2)', '2');
      await type('Number', '12345');
      await type('VIN or chassis number (optional)', 'abc');
      await tester.ensureVisible(find.text('Save'));
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(find.text('Enter a year from 1980 to next year'), findsOneWidget);
      expect(find.text('Use 5 to 25 letters and digits'), findsOneWidget);
      expect(api.calls.where((c) => c.startsWith('create')), isEmpty);

      await type('Year', '2018');
      await type('VIN or chassis number (optional)', 'jtd kb20u-777123456');
      await tester.ensureVisible(find.text('Save'));
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      final create = api.calls.singleWhere((c) => c.startsWith('create'));
      expect(create, contains('vin: JTDKB20U777123456'));
      expect(create, contains('plateNumber: 12345'));
      expect(create, isNot(contains('owner')));
      // The new vehicle opens on its own screen.
      expect(find.text('Documents and photos'), findsOneWidget);
    });

    testWidgets('the server refusing a duplicate plate is explained', (tester) async {
      final api = FakeVehicleApi()
        ..failures['create'] = const ConflictFailure(code: 'PLATE_IN_USE');
      await pumpVehicles(tester, api: api, initial: AppRoutes.vehicleNew);
      for (final (label, text) in [
        ('Make (for example Toyota)', 'Toyota'),
        ('Model (for example Vitz)', 'Vitz'),
        ('Year', '2018'),
        ('Region (for example AA)', 'AA'),
        ('Code (for example 2)', '2'),
        ('Number', '12345'),
      ]) {
        final field = find.widgetWithText(TextFormField, label);
        await tester.ensureVisible(field);
        await tester.enterText(field, text);
      }
      await tester.ensureVisible(find.text('Save'));
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(find.text('This plate number is already registered.'), findsOneWidget);
    });
  });

  group('vehicle screen', () {
    testWidgets('shows progress, the missing items and the officer note of a rejection', (
      tester,
    ) async {
      final api = FakeVehicleApi(
        vehicles: [
          vehicle(
            status: VehicleStatus.rejected,
            ready: {EvidenceSlot.registration, EvidenceSlot.insurance},
            reason: 'VEHICLE_DETAILS_MISMATCH',
            note: 'Year differs from the registration',
          ),
        ],
      );
      await pumpVehicles(tester, api: api, initial: AppRoutes.vehicle(vehicleId));
      expect(find.text('Needs changes'), findsOneWidget);
      expect(find.text('Reason: The details do not match the registration'), findsOneWidget);
      expect(
        find.text('Note from the officer: Year differs from the registration'),
        findsOneWidget,
      );
      expect(find.text('2 of 9 items ready'), findsOneWidget);
      expect(find.text('Add the front photo'), findsOneWidget);
      expect(find.text('Review and submit'), findsNothing);
      expect(find.bySemanticsLabel('Progress: 2 of 9 required items ready'), findsOneWidget);
    });

    testWidgets('uploads a photo with the right purpose and attaches it to the slot', (
      tester,
    ) async {
      final api = FakeVehicleApi(vehicles: [vehicle()]);
      final uploads = FakeDriverApi(current: driverProfile());
      final picker = FakePhotoPicker();
      await pumpVehicles(
        tester,
        api: api,
        uploads: uploads,
        picker: picker,
        initial: AppRoutes.vehicle(vehicleId),
      );
      final take = slotButton(EvidenceSlot.photoFront, 'Take photo');
      await scrollTo(tester, take);
      await tester.tap(take);
      await tester.pumpAndSettle();
      expect(picker.sources, [PhotoSource.camera]);
      expect(uploads.calls.first, startsWith('createUpload:VEHICLE_PHOTO:image/jpeg'));
      expect(api.calls, contains('attach:PHOTO_FRONT:doc-1:'));
      expect(find.text('1 of 9 items ready'), findsOneWidget);
    });

    testWidgets('insurance asks for its end date and sends it with the document', (tester) async {
      final api = FakeVehicleApi(vehicles: [vehicle()]);
      final uploads = FakeDriverApi(current: driverProfile());
      await pumpVehicles(tester, api: api, uploads: uploads, initial: AppRoutes.vehicle(vehicleId));
      final gallery = slotButton(EvidenceSlot.insurance, 'Choose from gallery');
      await scrollTo(tester, gallery);
      await tester.tap(gallery);
      await tester.pumpAndSettle();
      expect(find.text('When does this certificate end?'), findsOneWidget);
      await tester.tap(find.text('OK'));
      await tester.pumpAndSettle();
      expect(uploads.calls.first, startsWith('createUpload:VEHICLE_INSURANCE'));
      final attach = api.calls.singleWhere((c) => c.startsWith('attach:INSURANCE'));
      expect(attach, matches(RegExp(r'^attach:INSURANCE:doc-1:\d{4}-\d{2}-\d{2}$')));
    });

    testWidgets('cancelling the date picks nothing and uploads nothing', (tester) async {
      final api = FakeVehicleApi(vehicles: [vehicle()]);
      final uploads = FakeDriverApi(current: driverProfile());
      await pumpVehicles(tester, api: api, uploads: uploads, initial: AppRoutes.vehicle(vehicleId));
      final take = slotButton(EvidenceSlot.inspection, 'Take photo');
      await scrollTo(tester, take);
      await tester.tap(take);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(uploads.calls, isEmpty);
      expect(api.calls.where((c) => c.startsWith('attach')), isEmpty);
    });

    testWidgets('a failed check is retried without picking the photo again', (tester) async {
      final api = FakeVehicleApi(vehicles: [vehicle()]);
      final uploads = FakeDriverApi(current: driverProfile())
        ..completeResults.add(const ServerFailure(code: 'DOCUMENT_SCAN_UNAVAILABLE'));
      final picker = FakePhotoPicker();
      await pumpVehicles(
        tester,
        api: api,
        uploads: uploads,
        picker: picker,
        initial: AppRoutes.vehicle(vehicleId),
      );
      final take = slotButton(EvidenceSlot.photoLeft, 'Take photo');
      await scrollTo(tester, take);
      await tester.tap(take);
      await tester.pumpAndSettle();
      expect(
        find.text('The photo check is temporarily unavailable. Retry in a few minutes.'),
        findsOneWidget,
      );
      expect(api.calls.where((c) => c.startsWith('attach')), isEmpty);
      final retry = slotButton(EvidenceSlot.photoLeft, 'Retry');
      await tester.tap(retry);
      await tester.pumpAndSettle();
      expect(picker.sources, hasLength(1));
      expect(uploads.calls.where((c) => c.startsWith('createUpload')), hasLength(1));
      expect(api.calls, contains('attach:PHOTO_LEFT:doc-1:'));
    });

    testWidgets('a refused file needs a new photo; nothing is attached', (tester) async {
      final api = FakeVehicleApi(vehicles: [vehicle()]);
      final picker = FakePhotoPicker()..next = const PhotoRejected('UNSUPPORTED_TYPE');
      await pumpVehicles(tester, api: api, picker: picker, initial: AppRoutes.vehicle(vehicleId));
      final take = slotButton(EvidenceSlot.photoBack, 'Take photo');
      await scrollTo(tester, take);
      await tester.tap(take);
      await tester.pumpAndSettle();
      expect(find.textContaining('JPEG'), findsWidgets);
      expect(slotButton(EvidenceSlot.photoBack, 'Retry'), findsNothing);
      expect(api.calls.where((c) => c.startsWith('attach')), isEmpty);
    });

    testWidgets('a submitted vehicle cannot be changed; an approved one warns before re-review', (
      tester,
    ) async {
      final api = FakeVehicleApi(
        vehicles: [vehicle(status: VehicleStatus.submitted, ready: allRequired)],
      );
      await pumpVehicles(tester, api: api, initial: AppRoutes.vehicle(vehicleId));
      expect(find.text('Waiting for review'), findsOneWidget);
      expect(find.text('Review and submit'), findsNothing);
      expect(find.text('Remove this vehicle'), findsNothing);
      await scrollTo(tester, slotButton(EvidenceSlot.registration, 'Take photo'));
      final take = tester.widget<ButtonStyleButton>(
        slotButton(EvidenceSlot.registration, 'Take photo'),
      );
      expect(take.onPressed, isNull);
    });

    testWidgets('an approved vehicle warns that changes send it back for review', (tester) async {
      final api = FakeVehicleApi(
        vehicles: [vehicle(status: VehicleStatus.approved, ready: allRequired)],
      );
      await pumpVehicles(tester, api: api, initial: AppRoutes.vehicle(vehicleId));
      expect(find.text('Approved'), findsOneWidget);
      expect(find.textContaining('sends this vehicle back for review'), findsOneWidget);
      expect(find.textContaining('does not list it for rent'), findsOneWidget);
    });

    testWidgets('removing a vehicle asks first', (tester) async {
      final api = FakeVehicleApi(vehicles: [vehicle()]);
      await pumpVehicles(tester, api: api, initial: AppRoutes.vehicles);
      await tester.tap(find.textContaining('Toyota Vitz (2018)'));
      await tester.pumpAndSettle();
      final remove = find.text('Remove this vehicle');
      await scrollTo(tester, remove);
      await tester.tap(remove);
      await tester.pumpAndSettle();
      expect(find.text('Remove this vehicle?'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(api.calls.where((c) => c.startsWith('archive')), isEmpty);
      await tester.tap(remove);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
      await tester.pumpAndSettle();
      expect(api.calls, contains('archive:$vehicleId'));
      expect(find.text('No vehicles yet'), findsOneWidget);
    });
  });

  group('review and submit', () {
    testWidgets('needs the confirmation, then submits once with an idempotency key', (
      tester,
    ) async {
      final api = FakeVehicleApi(vehicles: [vehicle(ready: allRequired)]);
      await pumpVehicles(tester, api: api, initial: AppRoutes.vehicle(vehicleId));
      final review = find.text('Review and submit');
      await scrollTo(tester, review);
      await tester.tap(review);
      await tester.pumpAndSettle();
      expect(find.text('AA 2 12345'), findsOneWidget);
      expect(find.text('••••3456'), findsOneWidget);
      final submit = find.widgetWithText(FilledButton, 'Submit for review');
      expect(tester.widget<FilledButton>(submit).onPressed, isNull);
      await tester.tap(find.byType(Checkbox));
      await tester.pump();
      await tester.ensureVisible(submit);
      await tester.tap(submit);
      await tester.pumpAndSettle();
      final calls = api.calls.where((c) => c.startsWith('submit')).toList();
      expect(calls, hasLength(1));
      expect(calls.single, matches(RegExp(r'^submit:[0-9a-f-]{36}:[0-9a-f-]{36}$')));
      expect(find.text('Waiting for review'), findsOneWidget);
    });

    testWidgets('the server\'s blockers are shown in words', (tester) async {
      final api = FakeVehicleApi(vehicles: [vehicle(ready: allRequired)])
        ..failures['submit'] = const ValidationFailure(
          code: 'VEHICLE_SUBMISSION_INCOMPLETE',
          fieldErrors: [
            FieldError(field: 'vehicle', code: 'INSURANCE_EXPIRED'),
            FieldError(field: 'vehicle', code: 'PHOTO_PLATE_MISSING'),
          ],
        );
      await pumpVehicles(tester, api: api, initial: AppRoutes.vehicleReview(vehicleId));
      await tester.tap(find.byType(Checkbox));
      await tester.pump();
      final submit = find.widgetWithText(FilledButton, 'Submit for review');
      await tester.ensureVisible(submit);
      await tester.tap(submit);
      await tester.pumpAndSettle();
      expect(find.textContaining('The insurance has expired'), findsOneWidget);
      expect(find.textContaining('Add the number plate photo'), findsOneWidget);
    });
  });
}
