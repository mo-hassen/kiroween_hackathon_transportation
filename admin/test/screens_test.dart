import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kiroween_admin/core/api.dart';

import 'helpers/fakes.dart';

void main() {
  testWidgets('login with password + TOTP leads to the dashboard counts', (tester) async {
    final auth = FakeStaffAuthApi();
    await pumpAdmin(tester, auth: auth);
    expect(find.text('Staff sign-in'), findsOneWidget);

    await signIn(tester);
    expect(auth.calls.first, 'login:+251911000099:123456');
    expect(find.text('Dashboard'), findsWidgets);
    expect(find.text('Waiting for review'), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
  });

  testWidgets('a wrong code shows a safe message and clears the code field', (tester) async {
    final auth = FakeStaffAuthApi()
      ..loginFailure = const ApiFailure(FailureKind.unauthorized, code: 'INVALID_CREDENTIALS');
    await pumpAdmin(tester, auth: auth);
    await signIn(tester);
    expect(find.text('The phone number, password or code is incorrect.'), findsOneWidget);
    final totp = tester.widget<TextFormField>(find.byType(TextFormField).at(2));
    expect(totp.controller!.text, isEmpty);
  });

  testWidgets('staff without drivers.review see the no-permission screen', (tester) async {
    final auth = FakeStaffAuthApi(me: staffMe(permissions: const ['users.read']));
    final review = FakeDriverReviewApi();
    await pumpAdmin(tester, auth: auth, review: review);
    await signIn(tester);
    expect(find.text('No review permission'), findsOneWidget);
    expect(review.calls, isEmpty);

    await tester.tap(find.text('Sign out'));
    await tester.pumpAndSettle();
    expect(find.text('Staff sign-in'), findsOneWidget);
  });

  testWidgets('queue: claim opens the case; approve needs all three checks', (tester) async {
    final review = FakeDriverReviewApi();
    await pumpAdmin(tester, auth: FakeStaffAuthApi(), review: review);
    await signIn(tester);
    await tester.tap(find.text('Driver verification').first);
    await tester.pumpAndSettle();
    expect(review.calls, contains('list:SUBMITTED::1'));
    expect(find.text('Driver case-1'), findsOneWidget);

    await tester.tap(find.text('Claim'));
    await tester.pumpAndSettle();
    expect(review.calls, contains('claim:case-1'));
    expect(find.text('Driver case'), findsOneWidget);
    expect(find.text('AA123456'), findsOneWidget);

    await tester.tap(find.text('Approve'));
    await tester.pumpAndSettle();
    final confirm = find.widgetWithText(FilledButton, 'Confirm');
    expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
    for (final box in find.byType(CheckboxListTile).evaluate().toList()) {
      await tester.tap(find.byWidget(box.widget));
      await tester.pump();
    }
    expect(tester.widget<FilledButton>(confirm).onPressed, isNotNull);
    await tester.tap(confirm);
    await tester.pumpAndSettle();
    expect(review.calls, contains('approve:case-1:'));
    expect(find.text('Decision saved.'), findsOneWidget);
    expect(find.text('Suspend driver'), findsOneWidget);
  });

  testWidgets('reject requires a reason code', (tester) async {
    final review = FakeDriverReviewApi(cases: [summary(status: 'UNDER_REVIEW', claimedByMe: true)]);
    await pumpAdmin(tester, auth: FakeStaffAuthApi(), review: review);
    await signIn(tester);
    await tester.tap(find.text('Driver verification').first);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButton<String?>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Under review').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Reject'));
    await tester.pumpAndSettle();
    final confirm = find.widgetWithText(FilledButton, 'Confirm');
    expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
    await tester.tap(find.text('Reason'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Image unclear').last);
    await tester.pumpAndSettle();
    await tester.tap(confirm);
    await tester.pumpAndSettle();
    expect(review.calls, contains('reject:case-1:BLURRY:'));
  });

  testWidgets('documents open only after a reason and only for the claim holder', (tester) async {
    final review = FakeDriverReviewApi(
      cases: [summary(status: 'UNDER_REVIEW', claimedByOther: true)],
    );
    final viewer = FakeDocumentViewer();
    await pumpAdmin(tester, auth: FakeStaffAuthApi(), review: review, viewer: viewer);
    await signIn(tester);
    await tester.tap(find.text('Driver verification').first);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButton<String?>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Under review').last);
    await tester.pumpAndSettle();
    expect(find.text('Claim'), findsNothing);
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(find.text('View'), findsNothing);
    expect(find.text('Approve'), findsNothing);

    // Now the officer holds the claim.
    review.cases = [summary(status: 'UNDER_REVIEW', claimedByMe: true)];
    await tester.tap(find.text('Driver verification').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('View').first);
    await tester.pumpAndSettle();
    final confirm = find.widgetWithText(FilledButton, 'Confirm');
    await tester.enterText(find.byType(TextField).last, 'short');
    await tester.pump();
    expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
    await tester.enterText(find.byType(TextField).last, 'Checking the licence photo');
    await tester.pump();
    await tester.tap(confirm);
    await tester.pumpAndSettle();
    expect(review.calls, contains('url:case-1:doc-front:Checking the licence photo'));
    expect(viewer.shown, ['https://storage.test/doc-front?sig=1:false']);
  });

  testWidgets('a claim conflict is shown without leaving the queue', (tester) async {
    final review = FakeDriverReviewApi()
      ..actionFailure = const ApiFailure(FailureKind.conflict, code: 'REVIEW_CLAIMED_BY_OTHER');
    await pumpAdmin(tester, auth: FakeStaffAuthApi(), review: review);
    await signIn(tester);
    await tester.tap(find.text('Driver verification').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Claim'));
    await tester.pumpAndSettle();
    expect(find.text('Another officer is reviewing this case.'), findsOneWidget);
    expect(find.text('Driver case'), findsNothing);
  });

  testWidgets('suspension needs a reason and a 10-character internal note', (tester) async {
    final review = FakeDriverReviewApi(cases: [summary(status: 'APPROVED')]);
    await pumpAdmin(tester, auth: FakeStaffAuthApi(), review: review);
    await signIn(tester);
    await tester.tap(find.text('Driver verification').first);
    await tester.pumpAndSettle();
    await tester.tap(find.byType(DropdownButton<String?>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Approved').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Suspend driver'));
    await tester.pumpAndSettle();
    final confirm = find.widgetWithText(FilledButton, 'Confirm');
    await tester.tap(find.text('Reason'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Safety concern').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField).last, 'too short');
    await tester.pump();
    expect(tester.widget<FilledButton>(confirm).onPressed, isNull);
    await tester.enterText(find.byType(TextField).last, 'Customer complaint #42 confirmed');
    await tester.pump();
    await tester.tap(confirm);
    await tester.pumpAndSettle();
    expect(
      review.calls,
      contains('suspend:case-1:SAFETY_CONCERN:Customer complaint #42 confirmed'),
    );
    expect(find.text('Reinstate driver'), findsOneWidget);
  });
}
