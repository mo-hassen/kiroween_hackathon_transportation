import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mobility/app/l10n/l10n.dart';
import 'package:mobility/app/routes.dart';
import 'package:mobility/app/theme/app_theme.dart';
import 'package:mobility/core/l10n/locale_controller.dart';
import 'package:mobility/features/documents/document_upload.dart';
import 'package:mobility/features/driver/data/license_upload.dart';
import 'package:mobility/features/owner/data/owner_api.dart';
import 'package:mobility/features/vehicles/data/vehicle_api.dart';
import 'package:mobility/features/vehicles/presentation/vehicle_form_screen.dart';
import 'package:mobility/features/vehicles/presentation/vehicle_review_screen.dart';
import 'package:mobility/features/vehicles/presentation/vehicle_screen.dart';
import 'package:mobility/features/vehicles/presentation/vehicles_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'driver_fakes.dart';
import 'owner_fakes.dart';

const vehicleId = '0192a000-0000-7000-8000-000000000001';

const _statusNames = {
  VehicleStatus.draft: 'DRAFT',
  VehicleStatus.submitted: 'SUBMITTED',
  VehicleStatus.underReview: 'UNDER_REVIEW',
  VehicleStatus.approved: 'APPROVED',
  VehicleStatus.rejected: 'REJECTED',
  VehicleStatus.expired: 'EXPIRED',
  VehicleStatus.suspended: 'SUSPENDED',
  VehicleStatus.archived: 'ARCHIVED',
};

/// A vehicle as the API returns it. [ready] slots carry an AVAILABLE document.
Vehicle vehicle({
  String id = vehicleId,
  VehicleStatus status = VehicleStatus.draft,
  Set<EvidenceSlot>? ready,
  List<String>? problems,
  String? reason,
  String? note,
  int version = 1,
  bool? eligible,
}) {
  final editable = const {
    VehicleStatus.draft,
    VehicleStatus.rejected,
    VehicleStatus.expired,
  }.contains(status);
  final have = ready ?? <EvidenceSlot>{};
  return Vehicle.fromJson({
    'id': id,
    'vehicleType': 'SEDAN',
    'make': 'Toyota',
    'model': 'Vitz',
    'year': 2018,
    'color': 'White',
    'seats': 5,
    'transmission': 'AUTOMATIC',
    'fuelType': 'PETROL',
    'plate': {'region': 'AA', 'code': '2', 'number': '12345'},
    'vinMasked': '••••3456',
    'engineNumberOnFile': true,
    'status': _statusNames[status],
    'decisionReasonCode': reason,
    'decisionNote': note,
    'editable': editable,
    'evidence': [
      for (final slot in EvidenceSlot.values)
        {
          'slot': slot.wire,
          'required': slot.required,
          'expiresOn': have.contains(slot) && slot.expires ? '2027-06-01' : null,
          'document': have.contains(slot)
              ? {
                  'id': 'doc-${slot.wire}',
                  'uploadStatus': 'AVAILABLE',
                  'reviewStatus': 'DRAFT',
                  'mimeType': 'image/jpeg',
                  'failureCode': null,
                }
              : null,
        },
    ],
    'submissionProblems':
        problems ??
        (editable
            ? [
                for (final slot in EvidenceSlot.values)
                  if (slot.required && !have.contains(slot)) '${slot.wire}_MISSING',
              ]
            : <String>[]),
    'eligibility': {
      'eligible': eligible ?? status == VehicleStatus.approved,
      'blockers': <String>[],
    },
    'version': version,
  });
}

final allRequired = {
  for (final slot in EvidenceSlot.values)
    if (slot.required) slot,
};

/// Scripted vehicle API. Every call is recorded; failures are thrown once when set.
final class FakeVehicleApi implements VehicleApi {
  FakeVehicleApi({List<Vehicle>? vehicles}) : vehicles = vehicles ?? [];

  List<Vehicle> vehicles;
  final calls = <String>[];
  final failures = <String, Object>{};

  Future<void> _call(String name) async {
    calls.add(name);
    final failure = failures.remove(name.split(':').first);
    if (failure != null) throw failure;
  }

  Vehicle _find(String id) => vehicles.firstWhere((v) => v.id == id);

  Vehicle _replace(Vehicle next) {
    vehicles = [for (final v in vehicles) v.id == next.id ? next : v];
    return next;
  }

  @override
  Future<List<Vehicle>> list() async {
    await _call('list');
    return vehicles;
  }

  @override
  Future<Vehicle> get(String id) async {
    await _call('get:$id');
    return _find(id);
  }

  @override
  Future<Vehicle> create(VehicleInput input) async {
    await _call('create:${input.toJson()}');
    final created = vehicle();
    vehicles = [...vehicles, created];
    return created;
  }

  @override
  Future<Vehicle> update(String id, int version, VehicleInput input) async {
    await _call('update:$id:$version:${input.toJson()}');
    return _find(id);
  }

  @override
  Future<Vehicle> attach(
    String id,
    EvidenceSlot slot,
    String documentId, {
    String? expiresOn,
  }) async {
    await _call('attach:${slot.wire}:$documentId:${expiresOn ?? ''}');
    final current = _find(id);
    final have = {
      for (final e in current.evidence)
        if (e.document != null) e.slot,
      slot,
    };
    return _replace(
      vehicle(id: id, status: current.status, ready: have, version: current.version + 1),
    );
  }

  @override
  Future<Vehicle> submit(String id, {required String idempotencyKey}) async {
    await _call('submit:$id:$idempotencyKey');
    return _replace(vehicle(id: id, status: VehicleStatus.submitted, ready: allRequired));
  }

  @override
  Future<Vehicle> archive(String id) async {
    await _call('archive:$id');
    vehicles = [
      for (final v in vehicles)
        if (v.id != id) v,
    ];
    return vehicle(id: id, status: VehicleStatus.archived);
  }
}

/// Pumps the vehicle routes with fakes, starting at [initial].
Future<void> pumpVehicles(
  WidgetTester tester, {
  required FakeVehicleApi api,
  FakeOwnerApi? owner,
  FakeObjectUploader? uploader,
  FakePhotoPicker? picker,
  FakeDriverApi? uploads,
  String initial = AppRoutes.vehicles,
  Locale locale = const Locale('en'),
}) async {
  // A tall screen, so the lazily built evidence list is fully on screen.
  tester.view.physicalSize = const Size(800, 6000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues({});
  final preferences = await SharedPreferences.getInstance();
  final router = GoRouter(
    initialLocation: initial,
    routes: [
      GoRoute(path: AppRoutes.vehicles, builder: (_, _) => const VehiclesScreen()),
      GoRoute(path: AppRoutes.vehicleNew, builder: (_, _) => const VehicleFormScreen()),
      GoRoute(
        path: '/vehicles/:id',
        builder: (_, state) => VehicleScreen(vehicleId: state.pathParameters['id']!),
        routes: [
          GoRoute(
            path: 'edit',
            builder: (_, state) => VehicleFormScreen(vehicleId: state.pathParameters['id']),
          ),
          GoRoute(
            path: 'review',
            builder: (_, state) => VehicleReviewScreen(vehicleId: state.pathParameters['id']!),
          ),
        ],
      ),
      GoRoute(
        path: AppRoutes.owner,
        builder: (_, _) => const Scaffold(body: Text('owner hub')),
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    ProviderScope(
      retry: (_, _) => null,
      overrides: [
        sharedPreferencesProvider.overrideWithValue(preferences),
        vehicleApiProvider.overrideWithValue(api),
        ownerApiProvider.overrideWithValue(
          owner ??
              FakeOwnerApi(
                current: ownerProfile(type: OwnerType.individual, status: OwnerStatus.verified),
              ),
        ),
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
