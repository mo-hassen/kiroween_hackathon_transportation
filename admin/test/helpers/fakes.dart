import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kiroween_admin/app/app.dart';
import 'package:kiroween_admin/core/api.dart';
import 'package:kiroween_admin/core/config.dart';
import 'package:kiroween_admin/core/session.dart';
import 'package:kiroween_admin/features/drivers/case_detail_screen.dart';
import 'package:kiroween_admin/features/drivers/driver_review_api.dart';
import 'package:kiroween_admin/features/owners/owner_review_api.dart';
import 'package:kiroween_admin/features/vehicles/vehicle_review_api.dart';

import 'owner_fakes.dart';
import 'vehicle_fakes.dart';

final testConfig = AdminConfig.parse(
  environment: 'development',
  apiBaseUrl: 'http://localhost:3000',
);

Map<String, Object?> staffMe({
  List<String> permissions = const ['drivers.review'],
  String type = 'STAFF',
}) => {
  'accountType': type,
  'displayName': 'Officer Abebe',
  'roles': ['VERIFICATION_OFFICER'],
  'permissions': permissions,
};

final class FakeStaffAuthApi implements StaffAuthApi {
  FakeStaffAuthApi({Map<String, Object?>? me}) : meResponse = me ?? staffMe();

  Map<String, Object?> meResponse;
  ApiFailure? loginFailure;
  ApiFailure? refreshFailure;
  final calls = <String>[];
  int _n = 0;

  ({String accessToken, String refreshToken}) _pair() {
    _n++;
    return (accessToken: 'access-$_n', refreshToken: 'refresh-$_n');
  }

  @override
  Future<({String accessToken, String refreshToken})> login({
    required String phone,
    required String password,
    required String totpCode,
    required String installationId,
  }) async {
    calls.add('login:$phone:$totpCode');
    if (loginFailure != null) throw loginFailure!;
    return _pair();
  }

  @override
  Future<({String accessToken, String refreshToken})> refresh(String refreshToken) async {
    calls.add('refresh:$refreshToken');
    await Future<void>.delayed(Duration.zero);
    if (refreshFailure != null) throw refreshFailure!;
    return _pair();
  }

  @override
  Future<void> logout(String refreshToken) async => calls.add('logout:$refreshToken');

  @override
  Future<Map<String, Object?>> me(String accessToken) async => meResponse;
}

CaseSummary summary({
  String id = 'case-1',
  String status = 'SUBMITTED',
  bool claimedByMe = false,
  bool claimedByOther = false,
}) => CaseSummary(
  id: id,
  status: status,
  driverName: 'Driver $id',
  submittedAt: DateTime.utc(2026, 11, 18, 9),
  claimedByMe: claimedByMe,
  claimedByOther: claimedByOther,
  expiresOn: '2030-01-01',
);

CaseDetail caseDetail(CaseSummary s, {CaseDocument? front, CaseDocument? back}) => CaseDetail(
  summary: s,
  driverPhone: '+251911000001',
  licenseNumber: 'AA123456',
  categories: const ['B'],
  issuedOn: '2020-01-01',
  issuingAuthority: 'Addis Ababa',
  identityStatus: 'VERIFIED',
  identityVerifiedName: 'Abebe Kebede',
  yearsLicensed: 5,
  homeSubCity: 'BOLE',
  decisionReasonCode: null,
  decisionNote: null,
  front:
      front ??
      const CaseDocument(id: 'doc-front', mimeType: 'image/jpeg', uploadStatus: 'AVAILABLE'),
  back:
      back ??
      const CaseDocument(id: 'doc-back', mimeType: 'application/pdf', uploadStatus: 'AVAILABLE'),
  history: [
    CaseEvent(
      action: 'submitted',
      toStatus: 'SUBMITTED',
      reasonCode: null,
      note: null,
      at: DateTime.utc(2026, 11, 18, 9),
    ),
  ],
);

final class FakeDriverReviewApi implements DriverReviewApi {
  FakeDriverReviewApi({List<CaseSummary>? cases}) : cases = cases ?? [summary()];

  List<CaseSummary> cases;
  final calls = <String>[];
  ApiFailure? actionFailure;
  CaseCounts countsResponse = const {'SUBMITTED': 3, 'UNDER_REVIEW': 1};

  CaseSummary _find(String id) => cases.firstWhere((c) => c.id == id);

  void _replace(String id, CaseSummary next) =>
      cases = [for (final c in cases) c.id == id ? next : c];

  Future<void> _action(String call) async {
    calls.add(call);
    if (actionFailure != null) throw actionFailure!;
  }

  @override
  Future<CaseCounts> counts() async => countsResponse;

  @override
  Future<CasePage> list({String? status, String? query, int page = 1, int limit = 20}) async {
    calls.add('list:$status:${query ?? ''}:$page');
    final items = cases.where((c) => status == null || c.status == status).toList();
    return CasePage(items: items, total: items.length, page: page, limit: limit);
  }

  @override
  Future<CaseDetail> detail(String id) async => detailFor(_find(id));

  CaseDetail Function(CaseSummary) detailFor = caseDetail;

  @override
  Future<void> claim(String id) async {
    await _action('claim:$id');
    _replace(id, summary(id: id, status: 'UNDER_REVIEW', claimedByMe: true));
  }

  @override
  Future<void> release(String id) async {
    await _action('release:$id');
    _replace(id, summary(id: id));
  }

  @override
  Future<void> approve(String id, {String? note}) async {
    await _action('approve:$id:${note ?? ''}');
    _replace(id, summary(id: id, status: 'APPROVED'));
  }

  @override
  Future<void> reject(String id, {required String reasonCode, String? note}) async {
    await _action('reject:$id:$reasonCode:${note ?? ''}');
    _replace(id, summary(id: id, status: 'REJECTED'));
  }

  @override
  Future<void> suspend(String id, {required String reasonCode, required String note}) async {
    await _action('suspend:$id:$reasonCode:$note');
    _replace(id, summary(id: id, status: 'SUSPENDED'));
  }

  @override
  Future<void> reinstate(String id, {required String note}) async {
    await _action('reinstate:$id:$note');
    _replace(id, summary(id: id, status: 'APPROVED'));
  }

  @override
  Future<Uri> documentUrl(String caseId, String documentId, {required String reason}) async {
    calls.add('url:$caseId:$documentId:$reason');
    return Uri.parse('https://storage.test/$documentId?sig=1');
  }
}

final class FakeDocumentViewer implements DocumentViewer {
  final shown = <String>[];

  @override
  Future<void> show(BuildContext context, Uri url, {required bool isPdf}) async =>
      shown.add('$url:$isPdf');
}

/// Boots the whole app with fakes and returns the container (for session state).
Future<ProviderContainer> pumpAdmin(
  WidgetTester tester, {
  required FakeStaffAuthApi auth,
  FakeDriverReviewApi? review,
  FakeOwnerReviewApi? owners,
  FakeVehicleReviewApi? vehicles,
  FakeDocumentViewer? viewer,
}) async {
  tester.view.physicalSize = const Size(1400, 1000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final container = ProviderContainer(
    overrides: [
      adminConfigProvider.overrideWithValue(testConfig),
      staffAuthApiProvider.overrideWithValue(auth),
      driverReviewApiProvider.overrideWithValue(review ?? FakeDriverReviewApi()),
      ownerReviewApiProvider.overrideWithValue(owners ?? FakeOwnerReviewApi()),
      vehicleReviewApiProvider.overrideWithValue(vehicles ?? FakeVehicleReviewApi()),
      documentViewerProvider.overrideWithValue(viewer ?? FakeDocumentViewer()),
    ],
  );
  addTearDown(container.dispose);
  await tester.pumpWidget(UncontrolledProviderScope(container: container, child: const AdminApp()));
  await tester.pumpAndSettle();
  return container;
}

Future<void> signIn(WidgetTester tester) async {
  await tester.enterText(find.byType(TextFormField).at(0), '+251911000099');
  await tester.enterText(find.byType(TextFormField).at(1), 'correct horse battery');
  await tester.enterText(find.byType(TextFormField).at(2), '123456');
  await tester.tap(find.text('Sign in'));
  await tester.pumpAndSettle();
}
