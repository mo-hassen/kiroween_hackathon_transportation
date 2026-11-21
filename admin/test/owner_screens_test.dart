import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kiroween_admin/app/router.dart';
import 'package:kiroween_admin/core/api.dart';
import 'package:kiroween_admin/core/session.dart';
import 'package:kiroween_admin/features/owners/owner_review_api.dart';

import 'helpers/fake_http_adapter.dart';
import 'helpers/fakes.dart';
import 'helpers/owner_fakes.dart';

const both = ['drivers.review', 'owners.review'];

Future<void> openOwners(WidgetTester tester) async {
  await tester.tap(find.text('Owner verification').first);
  await tester.pumpAndSettle();
}

Future<void> confirmChecks(WidgetTester tester) async {
  for (final box in find.byType(CheckboxListTile).evaluate().toList()) {
    await tester.tap(find.byWidget(box.widget));
    await tester.pump();
  }
}

/// Opens the TIN check dialog, types [tin] and a reason, confirms.
Future<void> checkTinInUi(WidgetTester tester, String tin) async {
  await tester.tap(find.text('Check full TIN'));
  await tester.pumpAndSettle();
  await tester.enterText(find.byKey(const ValueKey('tin-input')), tin);
  await tester.enterText(
    find.byKey(const ValueKey('tin-reason')),
    'Comparing with the certificate',
  );
  await tester.pump();
  await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
  await tester.pumpAndSettle();
}

bool enabled(WidgetTester tester, String label) =>
    tester.widget<FilledButton>(find.widgetWithText(FilledButton, label)).onPressed != null;

FilledButton confirmButton(WidgetTester tester) =>
    tester.widget<FilledButton>(find.widgetWithText(FilledButton, 'Confirm'));

void main() {
  group('routing by permission', () {
    SignedIn signedIn(List<String> permissions) =>
        SignedIn(StaffProfile.fromJson(staffMe(permissions: permissions)));

    test('owners.review alone reaches /owners but not /drivers', () {
      final owners = signedIn(const ['owners.review']);
      expect(staffRedirect(owners, Uri.parse('/owners/x')), isNull);
      expect(staffRedirect(owners, Uri.parse('/drivers')), '/');
      expect(staffRedirect(owners, Uri.parse('/no-permission')), '/');
    });

    test('drivers.review alone cannot open owner cases; neither permission is refused', () {
      expect(staffRedirect(signedIn(const ['drivers.review']), Uri.parse('/owners/x')), '/');
      expect(staffRedirect(signedIn(const ['users.read']), Uri.parse('/owners')), '/no-permission');
    });
  });

  testWidgets('dashboard shows owner counts only with owners.review', (tester) async {
    await pumpAdmin(
      tester,
      auth: FakeStaffAuthApi(me: staffMe(permissions: both)),
    );
    await signIn(tester);
    expect(find.text('Owner verification'), findsWidgets);
    expect(find.text('Awaiting second approval'), findsOneWidget);
    expect(find.text('4'), findsOneWidget);
  });

  testWidgets('without owners.review there is no owner navigation or counts', (tester) async {
    final owners = FakeOwnerReviewApi();
    await pumpAdmin(tester, auth: FakeStaffAuthApi(), owners: owners);
    await signIn(tester);
    expect(find.text('Owner verification'), findsNothing);
    expect(owners.calls, isEmpty);
  });

  testWidgets(
    'organization: first approval needs all four checks; then a second officer is required',
    (tester) async {
      final owners = FakeOwnerReviewApi();
      await pumpAdmin(
        tester,
        auth: FakeStaffAuthApi(me: staffMe(permissions: both)),
        owners: owners,
      );
      await signIn(tester);
      await openOwners(tester);
      expect(owners.calls, contains('list:PENDING:::'));
      expect(find.text('Org own-1 PLC'), findsOneWidget);

      await tester.tap(find.text('Claim'));
      await tester.pumpAndSettle();
      expect(find.text('Owner case'), findsOneWidget);
      expect(find.text('••••5678'), findsOneWidget);
      expect(find.text('Approve owner'), findsNothing);
      expect(find.text('Give second approval'), findsNothing);

      // Approval stays disabled until this officer confirmed the full TIN.
      expect(enabled(tester, 'Record first approval'), isFalse);
      expect(
        find.text('Check the full TIN against the certificate before approving.'),
        findsOneWidget,
      );
      await checkTinInUi(tester, '0012-345-678');
      expect(find.text('The TIN on the certificate matches the stored TIN.'), findsOneWidget);
      expect(
        find.text('0012-345-678'),
        findsNothing,
        reason: 'the typed TIN is not kept on screen',
      );
      expect(enabled(tester, 'Record first approval'), isTrue);
      await tester.tap(find.text('Record first approval'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('A different officer must give the second approval'),
        findsOneWidget,
      );
      expect(find.byType(CheckboxListTile), findsNWidgets(4));
      expect(confirmButton(tester).onPressed, isNull);
      await confirmChecks(tester);
      expect(confirmButton(tester).onPressed, isNotNull);
      await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
      await tester.pumpAndSettle();
      expect(owners.calls, contains('first:own-1'));
      // The first approver sees the state but has no second-approval or claim action.
      expect(find.textContaining('You gave the first approval'), findsWidgets);
      expect(find.text('Give second approval'), findsNothing);
      expect(find.text('Claim'), findsNothing);
    },
  );

  testWidgets('a different officer gives the second approval', (tester) async {
    final owners = FakeOwnerReviewApi(cases: [ownerSummary(awaitingSecond: true)]);
    await pumpAdmin(
      tester,
      auth: FakeStaffAuthApi(me: staffMe(permissions: both)),
      owners: owners,
    );
    await signIn(tester);
    await openOwners(tester);
    expect(find.textContaining("Needs a second officer's approval"), findsOneWidget);
    await tester.tap(find.text('Claim'));
    await tester.pumpAndSettle();
    expect(find.text('Record first approval'), findsNothing);
    expect(enabled(tester, 'Give second approval'), isFalse);
    await checkTinInUi(tester, '0012345678');
    await tester.tap(find.text('Give second approval'));
    await tester.pumpAndSettle();
    expect(find.textContaining('You are the second officer'), findsOneWidget);
    await confirmChecks(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
    await tester.pumpAndSettle();
    expect(owners.calls, contains('second:own-1'));
    expect(find.text('Decision saved.'), findsOneWidget);
    expect(find.text('Suspend owner'), findsOneWidget);
  });

  testWidgets('the server refusing a same-officer second approval is explained', (tester) async {
    final owners = FakeOwnerReviewApi(cases: [ownerSummary(awaitingSecond: true)])
      ..actionFailure = const ApiFailure(FailureKind.conflict, code: 'SECOND_APPROVER_REQUIRED');
    await pumpAdmin(
      tester,
      auth: FakeStaffAuthApi(me: staffMe(permissions: both)),
      owners: owners,
    );
    await signIn(tester);
    await openOwners(tester);
    await tester.tap(find.text('Claim'));
    await tester.pumpAndSettle();
    expect(find.text('A different officer must give the second approval.'), findsOneWidget);
  });

  testWidgets('individual: single approval; documents need a reason; reject needs a reason code', (
    tester,
  ) async {
    final owners = FakeOwnerReviewApi(cases: [ownerSummary(type: 'INDIVIDUAL', claimedByMe: true)]);
    final viewer = FakeDocumentViewer();
    await pumpAdmin(
      tester,
      auth: FakeStaffAuthApi(me: staffMe(permissions: both)),
      owners: owners,
      viewer: viewer,
    );
    await signIn(tester);
    await openOwners(tester);
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(find.text('No owner documents are required for individuals.'), findsOneWidget);
    expect(find.text('Record first approval'), findsNothing);

    await tester.tap(find.text('Reject'));
    await tester.pumpAndSettle();
    expect(confirmButton(tester).onPressed, isNull);
    await tester.tap(find.text('Reason'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Organization details do not match').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Approve owner'));
    await tester.pumpAndSettle();
    expect(find.byType(CheckboxListTile), findsOneWidget);
    await confirmChecks(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
    await tester.pumpAndSettle();
    expect(owners.calls, contains('approve:own-1'));
  });

  testWidgets('organization documents open only for the claim holder, after a reason', (
    tester,
  ) async {
    final owners = FakeOwnerReviewApi(cases: [ownerSummary(claimedByOther: true)]);
    final viewer = FakeDocumentViewer();
    await pumpAdmin(
      tester,
      auth: FakeStaffAuthApi(me: staffMe(permissions: both)),
      owners: owners,
      viewer: viewer,
    );
    await signIn(tester);
    await openOwners(tester);
    expect(find.text('Claim'), findsNothing);
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(find.text('View'), findsNothing);

    owners.cases = [ownerSummary(claimedByMe: true)];
    await openOwners(tester);
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(find.text('TIN certificate'), findsOneWidget);
    expect(find.text('Authorized-representative letter'), findsOneWidget);
    await tester.tap(find.text('View').first);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'Checking the TIN certificate');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
    await tester.pumpAndSettle();
    expect(owners.calls, contains('url:own-1:doc-tin:Checking the TIN certificate'));
    expect(viewer.shown, ['https://storage.test/doc-tin?sig=1:false']);
  });

  testWidgets('suspend needs a reason and a 10-character note; reinstate needs a note', (
    tester,
  ) async {
    final owners = FakeOwnerReviewApi(cases: [ownerSummary(status: 'VERIFIED')]);
    await pumpAdmin(
      tester,
      auth: FakeStaffAuthApi(me: staffMe(permissions: both)),
      owners: owners,
    );
    await signIn(tester);
    await openOwners(tester);
    await tester.tap(find.byKey(const ValueKey('owner-status')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Verified').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Suspend owner'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Reason'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Suspected fraud').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'short');
    await tester.pump();
    expect(confirmButton(tester).onPressed, isNull);
    await tester.enterText(find.byType(TextField).last, 'Two complaints confirmed by support');
    await tester.pump();
    await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
    await tester.pumpAndSettle();
    expect(
      owners.calls,
      contains('suspend:own-1:SUSPECTED_FRAUD:Two complaints confirmed by support'),
    );
    expect(find.text('Reinstate owner'), findsOneWidget);
  });

  testWidgets('a wrong TIN shows "does not match"; results disappear after 60 s and on leaving', (
    tester,
  ) async {
    final owners = FakeOwnerReviewApi(cases: [ownerSummary(claimedByMe: true)]);
    await pumpAdmin(
      tester,
      auth: FakeStaffAuthApi(me: staffMe(permissions: both)),
      owners: owners,
    );
    await signIn(tester);
    await openOwners(tester);
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();

    // The dialog needs a valid TIN format and a 10-character reason.
    await tester.tap(find.text('Check full TIN'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('tin-input')), '12#');
    await tester.enterText(find.byKey(const ValueKey('tin-reason')), 'too short');
    await tester.pump();
    expect(find.text('Use 4 to 20 letters and digits'), findsOneWidget);
    expect(confirmButton(tester).onPressed, isNull);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    await checkTinInUi(tester, '9999999999');
    expect(find.text('The TIN on the certificate does NOT match the stored TIN.'), findsOneWidget);
    expect(owners.calls, contains('tin:own-1:Comparing with the certificate'));
    expect(enabled(tester, 'Record first approval'), isFalse);
    await tester.pump(const Duration(seconds: 61));
    expect(find.byKey(const ValueKey('tin-result')), findsNothing);

    await checkTinInUi(tester, '0012345678');
    expect(find.text('You confirmed the full TIN for this submission'), findsOneWidget);
    expect(find.byKey(const ValueKey('tin-result')), findsOneWidget);
    // Leaving the case hides the result.
    await openOwners(tester);
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tin-result')), findsNothing);
  });

  testWidgets('no TIN check action without the claim', (tester) async {
    final owners = FakeOwnerReviewApi(cases: [ownerSummary(claimedByOther: true)]);
    await pumpAdmin(
      tester,
      auth: FakeStaffAuthApi(me: staffMe(permissions: both)),
      owners: owners,
    );
    await signIn(tester);
    await openOwners(tester);
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(find.text('Check full TIN'), findsNothing);
  });

  test('HttpOwnerReviewApi.checkTin posts the typed TIN once and reads only the result', () async {
    final adapter = FakeHttpAdapter([
      respond({
        'data': {'matches': true, 'checkedAt': '2026-11-21T09:00:00Z'},
      }, 200),
    ]);
    final dio = Dio(BaseOptions(baseUrl: 'http://api.test/api/v1'))..httpClientAdapter = adapter;
    final matches = await HttpOwnerReviewApi(ApiClient(dio))
        .checkTin('o1', tin: '0012345678', reason: 'r' * 12);
    expect(matches, isTrue);
    expect(adapter.requests.single.path, '/admin/owner-verifications/o1/tin-check');
    expect(adapter.requests.single.data, {'tin': '0012345678', 'reason': 'r' * 12});
  });

  test(
    'HttpOwnerReviewApi sends the four checks and a fresh Idempotency-Key per decision',
    () async {
      final adapter = FakeHttpAdapter([
        respond({'data': null}, 200),
        respond({'data': null}, 200),
        respond({
          'data': {'items': <Object?>[], 'total': 0, 'page': 1, 'limit': 20},
        }, 200),
      ]);
      final dio = Dio(BaseOptions(baseUrl: 'http://api.test/api/v1'))..httpClientAdapter = adapter;
      final api = HttpOwnerReviewApi(ApiClient(dio));
      await api.firstApproval('o1');
      await api.secondApproval('o1', note: 'ok');
      await api.list(ownerType: 'ORGANIZATION', awaitingSecondApproval: true, status: 'PENDING');

      expect(adapter.requests[0].path, '/admin/owner-verifications/o1/first-approval');
      expect(adapter.requests[0].data, {
        'identityConfirmed': true,
        'documentsLegible': true,
        'organizationDetailsMatch': true,
        'representativeAuthorized': true,
      });
      expect(adapter.requests[1].path, '/admin/owner-verifications/o1/second-approval');
      final keys = [
        adapter.sentHeaders[0]['Idempotency-Key'],
        adapter.sentHeaders[1]['Idempotency-Key'],
      ];
      expect(keys.every((k) => k is String && k.length == 36), isTrue);
      expect(keys.toSet(), hasLength(2));
      expect(adapter.requests[2].queryParameters, {
        'status': 'PENDING',
        'ownerType': 'ORGANIZATION',
        'awaitingSecondApproval': 'true',
        'page': '1',
        'limit': '20',
      });
    },
  );
}
