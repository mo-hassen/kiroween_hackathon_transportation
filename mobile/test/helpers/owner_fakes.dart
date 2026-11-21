import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mobility/app/l10n/l10n.dart';
import 'package:mobility/app/routes.dart';
import 'package:mobility/app/theme/app_theme.dart';
import 'package:mobility/core/l10n/locale_controller.dart';
import 'package:mobility/features/documents/document_upload.dart';
import 'package:mobility/features/driver/data/driver_api.dart';
import 'package:mobility/features/driver/data/license_upload.dart';
import 'package:mobility/features/owner/data/owner_api.dart';
import 'package:mobility/features/owner/presentation/owner_details_screen.dart';
import 'package:mobility/features/owner/presentation/owner_documents_screen.dart';
import 'package:mobility/features/owner/presentation/owner_review_screen.dart';
import 'package:mobility/features/owner/presentation/owner_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'driver_fakes.dart';

OwnerProfile ownerProfile({
  OwnerType type = OwnerType.organization,
  OwnerStatus status = OwnerStatus.unverified,
  String identity = 'VERIFIED',
  Map<OwnerDocumentSlot, DocumentInfo?>? documents,
  List<String>? problems,
  String? reason,
  String? note,
  int version = 1,
}) {
  final editable = const {
    OwnerStatus.unverified,
    OwnerStatus.rejected,
    OwnerStatus.expired,
    OwnerStatus.reverificationRequired,
  }.contains(status);
  final docs = type == OwnerType.organization
      ? (documents ?? {for (final s in OwnerDocumentSlot.values) s: null})
      : <OwnerDocumentSlot, DocumentInfo?>{};
  return OwnerProfile(
    type: type,
    organizationName: type == OwnerType.organization ? 'Abebe Transport PLC' : null,
    tinMasked: type == OwnerType.organization ? '••••6789' : null,
    status: status,
    identityStatus: identity,
    decisionReasonCode: reason,
    decisionNote: note,
    editable: editable,
    typeChangeAllowed: status == OwnerStatus.unverified || status == OwnerStatus.rejected,
    documents: docs,
    submissionProblems:
        problems ??
        [
          if (identity != 'VERIFIED') 'IDENTITY_NOT_VERIFIED',
          if (type == OwnerType.organization)
            for (final slot in OwnerDocumentSlot.values)
              if (!(docs[slot]?.usableForSubmission ?? false))
                switch (slot) {
                  OwnerDocumentSlot.tin => 'TIN_DOCUMENT_MISSING',
                  OwnerDocumentSlot.businessLicense => 'BUSINESS_LICENSE_MISSING',
                  OwnerDocumentSlot.representativeLetter => 'REPRESENTATIVE_LETTER_MISSING',
                },
        ],
    eligible: status == OwnerStatus.verified,
    version: version,
  );
}

Map<OwnerDocumentSlot, DocumentInfo?> allDocuments() => {
  for (final slot in OwnerDocumentSlot.values) slot: doc('doc-${slot.path}'),
};

/// Scripted owner API. Every call is recorded; failures are thrown once when set.
final class FakeOwnerApi implements OwnerApi {
  FakeOwnerApi({this.current});

  OwnerProfile? current;
  final calls = <String>[];
  final failures = <String, Object>{};

  Future<void> _call(String name) async {
    calls.add(name);
    final failure = failures.remove(name.split(':').first);
    if (failure != null) throw failure;
  }

  @override
  Future<OwnerProfile?> profile() async {
    await _call('profile');
    return current;
  }

  @override
  Future<OwnerProfile> create(OwnerInput input) async {
    await _call('create:${input.toJson()}');
    return current = ownerProfile(type: input.type ?? OwnerType.individual);
  }

  @override
  Future<OwnerProfile> update(int version, OwnerInput input) async {
    await _call('update:$version:${input.toJson()}');
    return current = ownerProfile(type: input.type ?? current!.type);
  }

  @override
  Future<OwnerProfile> attach(OwnerDocumentSlot slot, String documentId) async {
    await _call('attach:${slot.path}:$documentId');
    final documents = {...current!.documents, slot: doc(documentId)};
    return current = ownerProfile(type: current!.type, documents: documents);
  }

  @override
  Future<OwnerProfile> submit({required String idempotencyKey}) async {
    await _call('submit:$idempotencyKey');
    return current = ownerProfile(
      type: current!.type,
      status: OwnerStatus.pending,
      documents: current!.documents,
    );
  }
}

Future<void> pumpOwner(
  WidgetTester tester, {
  required FakeOwnerApi api,
  FakeDriverApi? uploads,
  FakeObjectUploader? uploader,
  FakePhotoPicker? picker,
  String initial = AppRoutes.owner,
  Locale locale = const Locale('en'),
}) async {
  SharedPreferences.setMockInitialValues({});
  final preferences = await SharedPreferences.getInstance();
  final router = GoRouter(
    initialLocation: initial,
    routes: [
      GoRoute(path: AppRoutes.owner, builder: (_, _) => const OwnerScreen()),
      GoRoute(path: AppRoutes.ownerDetails, builder: (_, _) => const OwnerDetailsScreen()),
      GoRoute(path: AppRoutes.ownerDocuments, builder: (_, _) => const OwnerDocumentsScreen()),
      GoRoute(path: AppRoutes.ownerReview, builder: (_, _) => const OwnerReviewScreen()),
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
        ownerApiProvider.overrideWithValue(api),
        documentUploadApiProvider.overrideWithValue(
          uploads ?? FakeDriverApi(current: driverProfile()),
        ),
        objectUploaderProvider.overrideWithValue(uploader ?? FakeObjectUploader()),
        licensePhotoPickerProvider.overrideWithValue(picker ?? FakePhotoPicker()),
      ],
      child: MaterialApp.router(
        theme: AppTheme.light(),
        locale: locale,
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        routerConfig: router,
      ),
    ),
  );
  await tester.pumpAndSettle();
}
