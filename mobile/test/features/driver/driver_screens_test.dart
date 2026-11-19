import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobility/app/routes.dart';
import 'package:mobility/core/network/api_failure.dart';
import 'package:mobility/features/driver/data/driver_api.dart';
import 'package:mobility/features/driver/data/license_upload.dart';

import '../../helpers/app_harness.dart';
import '../../helpers/driver_fakes.dart';

void main() {
  testWidgets('first visit: intro, create the profile, then add the licence', (tester) async {
    final api = FakeDriverApi();
    await pumpDriver(tester, api: api);
    expect(find.text('Drive with Kiroween'), findsOneWidget);

    await tapText(tester, 'Start');
    await enterText(tester, 'Years of driving experience', '4');
    await tapText(tester, 'Save');
    expect(api.calls, contains('createProfile:{yearsLicensed: 4, bio: }'));
    expect(find.text('Not yet eligible to drive'), findsOneWidget);
    expect(find.text('Add your driving licence'), findsOneWidget);

    await tapText(tester, 'Add licence details');
    await enterText(tester, 'Licence number', 'ab-12 3456');
    await enterText(tester, 'Categories as printed (e.g. B, C1)', 'b, c1');
    await enterText(tester, 'Issuing authority', 'Addis Ababa');
    await tapText(tester, 'Save');
    // Dates are required (chosen with the date picker).
    expect(find.text('Choose a date'), findsNWidgets(2));
    expect(api.calls.where((c) => c.startsWith('createLicense')), isEmpty);
  });

  testWidgets('licence form validates number and categories before calling the API', (
    tester,
  ) async {
    final api = FakeDriverApi(current: driverProfile());
    await pumpDriver(tester, api: api, initial: AppRoutes.driverLicense);
    await enterText(tester, 'Licence number', 'a1');
    await enterText(tester, 'Categories as printed (e.g. B, C1)', 'B, B');
    await tapText(tester, 'Save');
    expect(find.text('Use 4 to 20 letters and digits'), findsOneWidget);
    expect(find.text('Enter 1 to 10 different codes (letters, digits, hyphen)'), findsOneWidget);
    expect(api.calls, ['profile']);
  });

  testWidgets('editing re-sends the full details with If-Match; duplicates are explained', (
    tester,
  ) async {
    final api = FakeDriverApi(current: driverProfile(license: license(version: 7)))
      ..failures['updateLicense'] = const ConflictFailure(code: 'LICENSE_NUMBER_IN_USE');
    await pumpDriver(tester, api: api, initial: AppRoutes.driverLicense);
    expect(find.text('Addis Ababa Driver and Vehicle Licensing Authority'), findsOneWidget);
    await enterText(tester, 'Licence number', 'AA123456');
    await tapText(tester, 'Save');
    expect(api.calls.last, startsWith('updateLicense:lic-1:7:{licenseNumber: AA123456'));
    expect(find.textContaining('already registered to another account'), findsOneWidget);
  });

  testWidgets('rejected licence shows the reason and the officer note as plain text', (
    tester,
  ) async {
    final api = FakeDriverApi(
      current: driverProfile(
        license: license(
          status: ReviewStatus.rejected,
          reason: 'BLURRY',
          note: '<a href="x">retake</a>',
          front: doc('d1', review: ReviewStatus.rejected),
          back: doc('d2', review: ReviewStatus.rejected),
        ),
      ),
    );
    await pumpDriver(tester, api: api);
    expect(find.text('Not approved'), findsOneWidget);
    expect(find.text('Reason: The photo is not clear'), findsOneWidget);
    expect(find.text('Note from the officer: <a href="x">retake</a>'), findsOneWidget);
    expect(find.text('Edit licence details'), findsOneWidget);
    expect(find.text('Review and submit'), findsNothing, reason: 'old photos must be replaced');

    await tapText(tester, 'Licence photos');
    expect(find.text('Take a new photo'), findsNWidgets(2));
  });

  testWidgets('under review: no edit actions; unverified identity shows the banner', (
    tester,
  ) async {
    final api = FakeDriverApi(
      current: driverProfile(
        identity: 'PENDING',
        blockers: const ['IDENTITY_NOT_VERIFIED', 'LICENSE_NOT_APPROVED'],
        license: license(status: ReviewStatus.underReview),
      ),
    );
    await pumpDriver(tester, api: api);
    expect(find.text('A verification officer is reviewing your licence.'), findsOneWidget);
    expect(find.text('Edit licence details'), findsNothing);
    expect(find.text('Licence photos'), findsNothing);
    expect(find.textContaining('Verify your identity first'), findsOneWidget);
    await tapText(tester, 'Verify identity');
    expect(find.text('identity'), findsOneWidget);
  });

  testWidgets('suspended and eligible states', (tester) async {
    final api = FakeDriverApi(
      current: driverProfile(
        eligibility: Eligibility.suspended,
        blockers: const ['DRIVER_SUSPENDED'],
        suspendedReason: 'SAFETY_CONCERN',
        license: license(status: ReviewStatus.suspended),
      ),
    );
    await pumpDriver(tester, api: api);
    expect(find.text('Driving is suspended'), findsOneWidget);
    expect(find.text('Reason: A safety concern was reported'), findsOneWidget);

    api.current = driverProfile(
      eligibility: Eligibility.eligible,
      blockers: const [],
      license: license(status: ReviewStatus.approved),
    );
    await tester.fling(find.byType(ListView), const Offset(0, 400), 1000);
    await tester.pumpAndSettle();
    expect(find.text('You can drive'), findsOneWidget);
    expect(find.text('Approved'), findsOneWidget);
  });

  testWidgets('photos: upload with progress; a scanner outage can be retried', (tester) async {
    final api = FakeDriverApi(current: driverProfile(license: license()))
      ..completeResults.add(const ServerFailure(code: 'DOCUMENT_SCAN_UNAVAILABLE'));
    final uploader = FakeObjectUploader();
    final picker = FakePhotoPicker();
    await pumpDriver(
      tester,
      api: api,
      uploader: uploader,
      picker: picker,
      initial: AppRoutes.driverPhotos,
    );
    expect(find.text('No photo yet'), findsNWidgets(2));

    await tapText(tester, 'Take photo');
    expect(picker.sources, [PhotoSource.camera]);
    expect(find.textContaining('temporarily unavailable'), findsOneWidget);
    await tapText(tester, 'Retry');
    expect(uploader.puts, hasLength(1), reason: 'the bytes are not sent twice');
    expect(api.calls, contains('attach:back:doc-1'), reason: 'tapText uses the last card (back)');
    expect(find.text('Uploaded and checked'), findsOneWidget);
  });

  testWidgets('photos: a refused or unsupported file asks for a new photo (no retry)', (
    tester,
  ) async {
    final api = FakeDriverApi(current: driverProfile(license: license()))
      ..completeResults.add(
        doc('doc-1', status: UploadStatus.invalid, failureCode: 'TYPE_MISMATCH'),
      );
    final picker = FakePhotoPicker();
    await pumpDriver(tester, api: api, picker: picker, initial: AppRoutes.driverPhotos);
    await tapText(tester, 'Choose from gallery');
    expect(find.textContaining('not supported'), findsOneWidget);
    expect(find.text('Retry'), findsNothing);

    picker.next = const PhotoRejected('TOO_LARGE');
    await tapText(tester, 'Take photo');
    expect(find.text('The photo is too large. Take it again.'), findsOneWidget);
  });

  testWidgets('review: submit needs the confirmation and reuses one Idempotency-Key', (
    tester,
  ) async {
    final api = FakeDriverApi(
      current: driverProfile(
        license: license(front: doc('d1'), back: doc('d2')),
      ),
    )..failures['submit'] = const NetworkFailure();
    await pumpDriver(tester, api: api);
    await tapText(tester, 'Review and submit');

    final submit = find.widgetWithText(FilledButton, 'Submit for review');
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await tester.tap(find.byType(CheckboxListTile));
    await tester.pumpAndSettle();
    await tapText(tester, 'Submit for review');
    expect(
      find.text('No internet connection. Check your connection and try again.'),
      findsOneWidget,
    );

    await tapText(tester, 'Submit for review');
    final keys = api.calls.where((c) => c.startsWith('submit:')).toList();
    expect(keys, hasLength(2));
    expect(keys.toSet(), hasLength(1));
    expect(find.text('Submitted. Waiting for a verification officer.'), findsOneWidget);
  });

  testWidgets('submission problems from the server are listed', (tester) async {
    final api =
        FakeDriverApi(
            current: driverProfile(
              license: license(front: doc('d1'), back: doc('d2')),
            ),
          )
          ..failures['submit'] = const ValidationFailure(
            code: 'DRIVER_SUBMISSION_INCOMPLETE',
            fieldErrors: [
              FieldError(field: 'license', code: 'IDENTITY_NOT_VERIFIED'),
              FieldError(field: 'license', code: 'BACK_DOCUMENT_MISSING'),
            ],
          );
    await pumpDriver(tester, api: api, initial: AppRoutes.driverReview);
    await tester.tap(find.byType(CheckboxListTile));
    await tester.pumpAndSettle();
    await tapText(tester, 'Submit for review');
    expect(find.text('Verify your identity first\nAdd a photo of the back'), findsOneWidget);
  });
}
