import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobility/app/routes.dart';
import 'package:mobility/core/network/api_client.dart';
import 'package:mobility/core/network/api_failure.dart';
import 'package:mobility/features/driver/data/driver_api.dart';
import 'package:mobility/features/owner/data/owner_api.dart';

import '../../helpers/app_harness.dart';
import '../../helpers/driver_fakes.dart';
import '../../helpers/fake_http_adapter.dart';
import '../../helpers/owner_fakes.dart';

Map<String, Object?> _ownerJson() => {
  'id': 'o1',
  'ownerType': 'ORGANIZATION',
  'organizationName': 'Abebe Transport PLC',
  'tinMasked': '••••6789',
  'verificationStatus': 'REJECTED',
  'identityStatus': 'VERIFIED',
  'submittedAt': '2026-11-19T09:00:00.000Z',
  'decidedAt': '2026-11-19T10:00:00.000Z',
  'decisionReasonCode': 'INVALID_ORGANIZATION_DETAILS',
  'decisionNote': 'TIN differs',
  'editable': true,
  'typeChangeAllowed': true,
  'documents': [
    {'purpose': 'OWNER_TIN', 'document': null},
    {'purpose': 'OWNER_BUSINESS_LICENSE', 'document': null},
    {'purpose': 'OWNER_REPRESENTATIVE_LETTER', 'document': null},
  ],
  'submissionProblems': ['TIN_DOCUMENT_MISSING'],
  'eligibility': {
    'eligible': false,
    'blockers': ['OWNER_NOT_VERIFIED'],
  },
  'version': 4,
};

void main() {
  group('data', () {
    test('parses the owner response; the TIN is only ever masked', () {
      final owner = OwnerProfile.fromJson(_ownerJson());
      expect(owner.type, OwnerType.organization);
      expect(owner.status, OwnerStatus.rejected);
      expect(owner.tinMasked, '••••6789');
      expect(owner.documents.keys, OwnerDocumentSlot.values);
      expect(owner.readyToSubmit, isFalse);
      expect(OwnerStatus.parse('SOMETHING_NEW'), OwnerStatus.unknown);
    });

    test('TIN normalization matches the API', () {
      expect(normalizeTin(' 0012-345.678/9 '), '00123456789');
      expect(normalizeTin('12#4'), isNull);
      expect(normalizeTin('123'), isNull);
    });

    test(
      'HttpOwnerApi: 404 is null, PATCH sends If-Match, PUT per slot, submit sends a key',
      () async {
        final adapter = FakeHttpAdapter([
          respond(problem('NOT_FOUND', 404), 404),
          respond({'data': _ownerJson()}, 200),
          respond({'data': _ownerJson()}, 200),
          respond({'data': _ownerJson()}, 200),
        ]);
        final dio = Dio(BaseOptions(baseUrl: 'http://api.test/api/v1'))
          ..httpClientAdapter = adapter;
        final api = HttpOwnerApi(ApiClient(dio));
        expect(await api.profile(), isNull);
        await api.update(4, const OwnerInput(organizationName: 'New PLC'));
        await api.attach(OwnerDocumentSlot.representativeLetter, 'd1');
        await api.submit(idempotencyKey: 'key-1');
        expect(adapter.requests[1].method, 'PATCH');
        expect(adapter.sentHeaders[1]['If-Match'], '4');
        expect(adapter.requests[1].data, {'organizationName': 'New PLC'});
        expect(adapter.requests[2].method, 'PUT');
        expect(adapter.requests[2].path, '/owners/me/documents/representative-letter');
        expect(adapter.requests[3].path, '/owners/me/submit');
        expect(adapter.sentHeaders[3]['Idempotency-Key'], 'key-1');
      },
    );
  });

  testWidgets('individual onboarding: intro, type choice, submit with confirmation', (
    tester,
  ) async {
    final api = FakeOwnerApi();
    await pumpOwner(tester, api: api);
    expect(find.text('Become a verified vehicle owner'), findsOneWidget);
    await tapText(tester, 'Start');
    expect(find.text('Organization name'), findsNothing);
    await tapText(tester, 'Save');
    expect(api.calls, contains('create:{ownerType: INDIVIDUAL}'));
    expect(find.text('Not submitted yet'), findsOneWidget);
    expect(find.text('Organization documents'), findsNothing);

    await tapText(tester, 'Review and submit');
    expect(find.text('I own the vehicles I will register.'), findsOneWidget);
    final submit = find.widgetWithText(FilledButton, 'Submit for review');
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await tester.tap(find.byType(CheckboxListTile));
    await tester.pumpAndSettle();
    await tapText(tester, 'Submit for review');
    expect(api.calls.where((c) => c.startsWith('submit:')), hasLength(1));
    expect(
      find.text('Submitted. Verification officers are reviewing your request.'),
      findsOneWidget,
    );
    expect(find.text('Owner details'), findsNothing, reason: 'nothing is editable while pending');
  });

  testWidgets('organization form validates name and TIN before calling the API', (tester) async {
    final api = FakeOwnerApi();
    await pumpOwner(tester, api: api, initial: AppRoutes.ownerDetails);
    await tester.tap(find.text('An organization I represent'));
    await tester.pumpAndSettle();
    await enterText(tester, 'Organization name', 'A');
    await enterText(tester, 'TIN', '12#');
    await tapText(tester, 'Save');
    expect(find.text('Enter 2 to 200 characters'), findsOneWidget);
    expect(find.text('Use 4 to 20 letters and digits'), findsOneWidget);
    expect(api.calls, ['profile']);

    await enterText(tester, 'Organization name', 'Abebe Transport PLC');
    await enterText(tester, 'TIN', '0012 345 678');
    await tapText(tester, 'Save');
    expect(
      api.calls.last,
      'create:{ownerType: ORGANIZATION, organizationName: Abebe Transport PLC, tin: 0012345678}',
    );
  });

  testWidgets('a duplicate TIN is explained without details', (tester) async {
    final api = FakeOwnerApi()..failures['create'] = const ConflictFailure(code: 'TIN_IN_USE');
    await pumpOwner(tester, api: api, initial: AppRoutes.ownerDetails);
    await tester.tap(find.text('An organization I represent'));
    await tester.pumpAndSettle();
    await enterText(tester, 'Organization name', 'Abebe Transport PLC');
    await enterText(tester, 'TIN', '0012345678');
    await tapText(tester, 'Save');
    expect(find.textContaining('already registered to another account'), findsOneWidget);
  });

  testWidgets('editing an organization keeps the stored TIN unless a new one is typed', (
    tester,
  ) async {
    final api = FakeOwnerApi(current: ownerProfile(version: 3));
    await pumpOwner(tester, api: api, initial: AppRoutes.ownerDetails);
    expect(find.text('Leave empty to keep ••••6789'), findsOneWidget);
    expect(find.text('0012345678'), findsNothing);
    await tapText(tester, 'Save');
    expect(api.calls.last, 'update:3:{organizationName: Abebe Transport PLC}');
  });

  testWidgets('three document slots upload with progress; a scanner outage is retried', (
    tester,
  ) async {
    final uploads = FakeDriverApi(current: driverProfile())
      ..completeResults.add(const ServerFailure(code: 'DOCUMENT_SCAN_UNAVAILABLE'));
    final uploader = FakeObjectUploader();
    final api = FakeOwnerApi(current: ownerProfile());
    await pumpOwner(
      tester,
      api: api,
      uploads: uploads,
      uploader: uploader,
      initial: AppRoutes.ownerDocuments,
    );
    expect(find.text('TIN certificate'), findsOneWidget);
    expect(find.text('Business licence'), findsOneWidget);
    expect(find.text('Letter authorizing you to represent the organization'), findsOneWidget);
    expect(find.text('No photo yet'), findsNWidgets(3));

    await tapText(tester, 'Take photo');
    expect(find.textContaining('temporarily unavailable'), findsOneWidget);
    await tapText(tester, 'Retry');
    expect(uploader.puts, hasLength(1), reason: 'the bytes are not sent twice');
    expect(uploads.calls.first, startsWith('createUpload:OWNER_REPRESENTATIVE_LETTER:image/jpeg'));
    expect(api.calls, contains('attach:representative-letter:doc-1'));
    expect(find.text('Uploaded and checked'), findsOneWidget);
  });

  testWidgets('a refused document asks for a new photo (no retry)', (tester) async {
    final uploads = FakeDriverApi(current: driverProfile())
      ..completeResults.add(
        doc('doc-1', status: UploadStatus.infected, failureCode: 'MALWARE_DETECTED'),
      );
    final api = FakeOwnerApi(current: ownerProfile());
    await pumpOwner(tester, api: api, uploads: uploads, initial: AppRoutes.ownerDocuments);
    await tapText(tester, 'Choose from gallery');
    expect(find.textContaining('refused by the security check'), findsOneWidget);
    expect(find.text('Retry'), findsNothing);
    expect(api.calls.where((c) => c.startsWith('attach')), isEmpty);
  });

  testWidgets('organization submission lists server problems and reuses one key', (tester) async {
    final api = FakeOwnerApi(current: ownerProfile(documents: allDocuments()))
      ..failures['submit'] = const ValidationFailure(
        code: 'OWNER_SUBMISSION_INCOMPLETE',
        fieldErrors: [
          FieldError(field: 'owner', code: 'IDENTITY_NOT_VERIFIED'),
          FieldError(field: 'owner', code: 'BUSINESS_LICENSE_MISSING'),
        ],
      );
    await pumpOwner(tester, api: api, initial: AppRoutes.ownerReview);
    expect(find.text('••••6789'), findsOneWidget);
    await tester.tap(find.byType(CheckboxListTile));
    await tester.pumpAndSettle();
    await tapText(tester, 'Submit for review');
    expect(find.text('Verify your identity first\nAdd the business licence'), findsOneWidget);
    await tapText(tester, 'Submit for review');
    final keys = api.calls.where((c) => c.startsWith('submit:')).toList();
    expect(keys, hasLength(2));
    expect(keys.toSet(), hasLength(1));
  });

  testWidgets('rejected: reason and note as plain text, correction actions available', (
    tester,
  ) async {
    final api = FakeOwnerApi(
      current: ownerProfile(
        status: OwnerStatus.rejected,
        reason: 'REPRESENTATIVE_NOT_AUTHORIZED',
        note: '<b>new letter</b>',
      ),
    );
    await pumpOwner(tester, api: api);
    expect(find.text('Not approved'), findsOneWidget);
    expect(
      find.text('Reason: The letter does not authorize you to represent the organization'),
      findsOneWidget,
    );
    expect(find.text('Note from the officer: <b>new letter</b>'), findsOneWidget);
    expect(find.text('Add the TIN certificate'), findsOneWidget);
    expect(find.text('Organization documents'), findsOneWidget);
  });

  testWidgets('verified, suspended and expired states show their guidance', (tester) async {
    final api = FakeOwnerApi(current: ownerProfile(status: OwnerStatus.verified));
    await pumpOwner(tester, api: api);
    expect(find.text('Verified owner'), findsOneWidget);
    expect(find.textContaining('Vehicle registration will be added'), findsOneWidget);
    expect(find.text('Organization documents'), findsNothing);

    api.current = ownerProfile(status: OwnerStatus.suspended, reason: 'SAFETY_CONCERN');
    await tester.fling(find.byType(ListView), const Offset(0, 400), 1000);
    await tester.pumpAndSettle();
    expect(find.text('Owner account suspended'), findsOneWidget);
    expect(find.text('Reason: A safety concern was reported'), findsOneWidget);
    expect(find.textContaining('Contact support'), findsOneWidget);

    api.current = ownerProfile(status: OwnerStatus.expired, identity: 'EXPIRED');
    await tester.fling(find.byType(ListView), const Offset(0, 400), 1000);
    await tester.pumpAndSettle();
    expect(find.text('Verification expired'), findsOneWidget);
    await tapText(tester, 'Verify identity');
    expect(find.text('identity'), findsOneWidget);
  });

  testWidgets('Amharic strings render on the owner screens', (tester) async {
    await pumpOwner(tester, api: FakeOwnerApi(), locale: const Locale('am'));
    expect(find.text('የተረጋገጠ የተሽከርካሪ ባለቤት ይሁኑ'), findsOneWidget);
  });
}
