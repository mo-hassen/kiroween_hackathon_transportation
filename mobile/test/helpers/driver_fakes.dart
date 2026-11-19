import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mobility/app/l10n/l10n.dart';
import 'package:mobility/app/routes.dart';
import 'package:mobility/app/theme/app_theme.dart';
import 'package:mobility/core/l10n/locale_controller.dart';
import 'package:mobility/features/driver/data/driver_api.dart';
import 'package:mobility/features/driver/data/license_upload.dart';
import 'package:mobility/features/driver/presentation/driver_profile_screen.dart';
import 'package:mobility/features/driver/presentation/driver_screen.dart';
import 'package:mobility/features/driver/presentation/license_form_screen.dart';
import 'package:mobility/features/driver/presentation/license_photos_screen.dart';
import 'package:mobility/features/driver/presentation/license_review_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// A tiny valid-looking JPEG header (the fake API does not inspect it).
final jpegBytes = Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4, 5, 6]);

DocumentInfo doc(
  String id, {
  UploadStatus status = UploadStatus.available,
  ReviewStatus review = ReviewStatus.draft,
  String? failureCode,
}) => DocumentInfo(
  id: id,
  status: status,
  reviewStatus: review,
  mimeType: 'image/jpeg',
  failureCode: failureCode,
);

DriverLicense license({
  ReviewStatus status = ReviewStatus.draft,
  DocumentInfo? front,
  DocumentInfo? back,
  String? reason,
  String? note,
  bool? editable,
  int version = 1,
}) => DriverLicense(
  id: 'lic-1',
  numberMasked: '••••3456',
  categories: const ['B'],
  issuedOn: '2022-03-01',
  expiresOn: '2030-03-01',
  issuingAuthority: 'Addis Ababa Driver and Vehicle Licensing Authority',
  status: status,
  submittedAt: null,
  decisionReasonCode: reason,
  decisionNote: note,
  front: front,
  back: back,
  editable:
      editable ??
      const {ReviewStatus.draft, ReviewStatus.rejected, ReviewStatus.expired}.contains(status),
  version: version,
);

DriverProfile driverProfile({
  DriverLicense? license,
  String identity = 'VERIFIED',
  Eligibility eligibility = Eligibility.ineligible,
  List<String> blockers = const ['LICENSE_NOT_APPROVED'],
  String? suspendedReason,
}) => DriverProfile(
  yearsLicensed: 4,
  bio: null,
  homeSubCity: 'BOLE',
  identityStatus: identity,
  eligibility: eligibility,
  blockers: blockers,
  suspendedReason: suspendedReason,
  license: license,
  version: 2,
);

/// Scripted driver API. Every call is recorded; failures are thrown once when set.
final class FakeDriverApi implements DriverApi {
  FakeDriverApi({this.current});

  DriverProfile? current;
  final calls = <String>[];
  final failures = <String, Object>{};

  /// Results of successive `completeUpload` calls (default: AVAILABLE).
  final completeResults = <Object>[];
  int _documents = 0;

  Future<void> _call(String name) async {
    calls.add(name);
    final failure = failures.remove(name.split(':').first);
    if (failure != null) throw failure;
  }

  void _setLicense(DriverLicense? next) => current = DriverProfile(
    yearsLicensed: current!.yearsLicensed,
    bio: current!.bio,
    homeSubCity: current!.homeSubCity,
    identityStatus: current!.identityStatus,
    eligibility: current!.eligibility,
    blockers: current!.blockers,
    suspendedReason: current!.suspendedReason,
    license: next,
    version: current!.version,
  );

  @override
  Future<DriverProfile?> profile() async {
    await _call('profile');
    return current;
  }

  @override
  Future<DriverProfile> createProfile(ProfileInput input) async {
    await _call('createProfile:${input.toJson()}');
    return current = driverProfile(blockers: const ['LICENSE_MISSING']);
  }

  @override
  Future<DriverProfile> updateProfile(int version, ProfileInput input) async {
    await _call('updateProfile:$version:${input.toJson()}');
    return current!;
  }

  @override
  Future<DriverLicense> createLicense(LicenseInput input) async {
    await _call('createLicense:${input.toJson()}');
    final created = license();
    _setLicense(created);
    return created;
  }

  @override
  Future<DriverLicense> updateLicense(String id, int version, LicenseInput input) async {
    await _call('updateLicense:$id:$version:${input.toJson()}');
    return current!.license!;
  }

  @override
  Future<DriverLicense> attach(String licenseId, LicenseSide side, String documentId) async {
    await _call('attach:${side.path}:$documentId');
    final old = current!.license!;
    final next = license(
      status: ReviewStatus.draft,
      front: side == LicenseSide.front ? doc(documentId) : old.front,
      back: side == LicenseSide.back ? doc(documentId) : old.back,
    );
    _setLicense(next);
    return next;
  }

  @override
  Future<DriverLicense> submit(String licenseId, {required String idempotencyKey}) async {
    await _call('submit:$idempotencyKey');
    final old = current!.license!;
    final next = license(status: ReviewStatus.submitted, front: old.front, back: old.back);
    _setLicense(next);
    return next;
  }

  @override
  Future<UploadIntent> createUpload({
    required String purpose,
    required String mimeType,
    required int sizeBytes,
    required String sha256,
  }) async {
    await _call('createUpload:$purpose:$mimeType:$sizeBytes:$sha256');
    _documents++;
    return UploadIntent(
      document: doc('doc-$_documents', status: UploadStatus.pendingUpload),
      url: Uri.parse('https://storage.test/incoming/doc-$_documents?sig=1'),
      headers: const {'Content-Type': 'image/jpeg'},
    );
  }

  @override
  Future<DocumentInfo> completeUpload(String documentId) async {
    await _call('complete:$documentId');
    if (completeResults.isNotEmpty) {
      final next = completeResults.removeAt(0);
      if (next is DocumentInfo) return next;
      throw next;
    }
    return doc(documentId);
  }
}

final class FakeObjectUploader implements ObjectUploader {
  final puts = <String>[];
  Object? failNext;

  @override
  Future<void> put(
    Uri url,
    Map<String, String> headers,
    Uint8List bytes, {
    void Function(double progress)? onProgress,
  }) async {
    puts.add('$url:${headers['Content-Type']}:${bytes.length}');
    final failure = failNext;
    failNext = null;
    if (failure != null) throw failure;
    onProgress?.call(0.5);
    onProgress?.call(1);
  }
}

final class FakePhotoPicker implements LicensePhotoPicker {
  Object? next = PickedPhoto(bytes: jpegBytes, mimeType: 'image/jpeg');
  final sources = <PhotoSource>[];

  @override
  Future<PickedPhoto?> pick(PhotoSource source) async {
    sources.add(source);
    final value = next;
    if (value is PickedPhoto?) return value;
    throw value;
  }
}

/// Pumps the driver routes (hub, forms, photos, review) with fakes, starting at [initial].
Future<void> pumpDriver(
  WidgetTester tester, {
  required FakeDriverApi api,
  FakeObjectUploader? uploader,
  FakePhotoPicker? picker,
  String initial = AppRoutes.driver,
}) async {
  SharedPreferences.setMockInitialValues({});
  final preferences = await SharedPreferences.getInstance();
  final router = GoRouter(
    initialLocation: initial,
    routes: [
      GoRoute(path: AppRoutes.driver, builder: (_, _) => const DriverScreen()),
      GoRoute(path: AppRoutes.driverProfile, builder: (_, _) => const DriverProfileScreen()),
      GoRoute(path: AppRoutes.driverLicense, builder: (_, _) => const LicenseFormScreen()),
      GoRoute(path: AppRoutes.driverPhotos, builder: (_, _) => const LicensePhotosScreen()),
      GoRoute(path: AppRoutes.driverReview, builder: (_, _) => const LicenseReviewScreen()),
      GoRoute(
        path: AppRoutes.identity,
        builder: (_, _) => const Scaffold(body: Text('identity')),
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    ProviderScope(
      retry: (_, _) => null,
      overrides: [
        sharedPreferencesProvider.overrideWithValue(preferences),
        driverApiProvider.overrideWithValue(api),
        objectUploaderProvider.overrideWithValue(uploader ?? FakeObjectUploader()),
        licensePhotoPickerProvider.overrideWithValue(picker ?? FakePhotoPicker()),
      ],
      child: MaterialApp.router(
        theme: AppTheme.light(),
        locale: const Locale('en'),
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        routerConfig: router,
      ),
    ),
  );
  await tester.pumpAndSettle();
}
