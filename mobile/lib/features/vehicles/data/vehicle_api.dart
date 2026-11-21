import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/session_controller.dart';
import '../../../core/network/api_client.dart';
import '../../driver/data/driver_api.dart' show DocumentInfo, ReviewStatus, UploadStatus;

Map<String, Object?> _map(Object? value) => (value! as Map).cast<String, Object?>();

/// 02 §3.3 plus ARCHIVED. The server owns every transition; the app shows what it reports.
enum VehicleStatus {
  draft,
  submitted,
  underReview,
  approved,
  rejected,
  expired,
  suspended,
  archived,
  unknown;

  static VehicleStatus parse(Object? value) => switch (value) {
    'DRAFT' => draft,
    'SUBMITTED' => submitted,
    'UNDER_REVIEW' => underReview,
    'APPROVED' => approved,
    'REJECTED' => rejected,
    'EXPIRED' => expired,
    'SUSPENDED' => suspended,
    'ARCHIVED' => archived,
    _ => unknown,
  };
}

/// Same lists as the API (docs/architecture/03: vehicle types; transmission and fuel are an
/// [ASSUMPTION] there).
const vehicleTypes = ['SEDAN', 'HATCHBACK', 'SUV', 'MINIBUS', 'PICKUP', 'THREE_WHEELER', 'OTHER'];
const vehicleTransmissions = ['MANUAL', 'AUTOMATIC'];
const vehicleFuels = ['PETROL', 'DIESEL', 'ELECTRIC', 'HYBRID', 'OTHER'];

/// The ten evidence slots (the API path segment is the wire name).
enum EvidenceSlot {
  registration('REGISTRATION', 'VEHICLE_REGISTRATION', required: true, expires: false),
  ownership('OWNERSHIP', 'VEHICLE_OWNERSHIP', required: true, expires: false),
  insurance('INSURANCE', 'VEHICLE_INSURANCE', required: true, expires: true),
  inspection('INSPECTION', 'VEHICLE_INSPECTION', required: true, expires: true),
  photoFront('PHOTO_FRONT', 'VEHICLE_PHOTO', required: true, expires: false),
  photoBack('PHOTO_BACK', 'VEHICLE_PHOTO', required: true, expires: false),
  photoLeft('PHOTO_LEFT', 'VEHICLE_PHOTO', required: true, expires: false),
  photoRight('PHOTO_RIGHT', 'VEHICLE_PHOTO', required: true, expires: false),
  photoPlate('PHOTO_PLATE', 'VEHICLE_PHOTO', required: true, expires: false),
  photoInterior('PHOTO_INTERIOR', 'VEHICLE_PHOTO', required: false, expires: false);

  const EvidenceSlot(this.wire, this.purpose, {required this.required, required this.expires});

  final String wire;
  final String purpose;
  final bool required;

  /// Insurance and inspection carry an end date the owner enters.
  final bool expires;

  bool get isPhoto => purpose == 'VEHICLE_PHOTO';

  static EvidenceSlot? parse(Object? value) =>
      values.where((slot) => slot.wire == value).firstOrNull;
}

final class VehicleEvidence {
  const VehicleEvidence({required this.slot, required this.expiresOn, required this.document});

  final EvidenceSlot slot;

  /// `YYYY-MM-DD`, insurance and inspection only.
  final String? expiresOn;
  final DocumentInfo? document;

  /// Processed and not rejected by an officer (the server applies the same rule).
  bool get ready =>
      document != null &&
      document!.status == UploadStatus.available &&
      document!.reviewStatus != ReviewStatus.rejected;
}

final class Vehicle {
  const Vehicle({
    required this.id,
    required this.type,
    required this.make,
    required this.model,
    required this.year,
    required this.color,
    required this.seats,
    required this.transmission,
    required this.fuel,
    required this.plateRegion,
    required this.plateCode,
    required this.plateNumber,
    required this.vinMasked,
    required this.engineNumberOnFile,
    required this.status,
    required this.decisionReasonCode,
    required this.decisionNote,
    required this.editable,
    required this.evidence,
    required this.submissionProblems,
    required this.eligible,
    required this.version,
  });

  factory Vehicle.fromJson(Map<String, Object?> json) {
    final plate = _map(json['plate']);
    return Vehicle(
      id: json['id']! as String,
      type: json['vehicleType']! as String,
      make: json['make']! as String,
      model: json['model']! as String,
      year: json['year']! as int,
      color: json['color'] as String?,
      seats: json['seats']! as int,
      transmission: json['transmission']! as String,
      fuel: json['fuelType']! as String,
      plateRegion: plate['region']! as String,
      plateCode: plate['code']! as String,
      plateNumber: plate['number']! as String,
      vinMasked: json['vinMasked'] as String?,
      engineNumberOnFile: json['engineNumberOnFile']! as bool,
      status: VehicleStatus.parse(json['status']),
      decisionReasonCode: json['decisionReasonCode'] as String?,
      decisionNote: json['decisionNote'] as String?,
      editable: json['editable']! as bool,
      evidence: [
        for (final raw in json['evidence']! as List)
          if (EvidenceSlot.parse(_map(raw)['slot']) case final slot?)
            VehicleEvidence(
              slot: slot,
              expiresOn: _map(raw)['expiresOn'] as String?,
              document: _map(raw)['document'] == null
                  ? null
                  : DocumentInfo.fromJson(_map(_map(raw)['document'])),
            ),
      ],
      submissionProblems: [for (final p in json['submissionProblems']! as List) p as String],
      eligible: _map(json['eligibility'])['eligible']! as bool,
      version: json['version']! as int,
    );
  }

  final String id;
  final String type;
  final String make;
  final String model;
  final int year;
  final String? color;
  final int seats;
  final String transmission;
  final String fuel;
  final String plateRegion;
  final String plateCode;
  final String plateNumber;

  /// Always masked (`••••1234`): the app never receives the full VIN.
  final String? vinMasked;
  final bool engineNumberOnFile;
  final VehicleStatus status;
  final String? decisionReasonCode;

  /// Officer note for a rejection (plain text).
  final String? decisionNote;
  final bool editable;
  final List<VehicleEvidence> evidence;

  /// What still blocks a submission, computed by the server.
  final List<String> submissionProblems;

  /// Verified and in date. This is not marketplace availability.
  final bool eligible;
  final int version;

  String get plate => '$plateRegion $plateCode $plateNumber';
  String get title => '$make $model ($year)';

  VehicleEvidence? evidenceFor(EvidenceSlot slot) =>
      evidence.where((e) => e.slot == slot).firstOrNull;

  int get requiredTotal => EvidenceSlot.values.where((s) => s.required).length;
  int get requiredReady => EvidenceSlot.values
      .where((s) => s.required)
      .where((s) => evidenceFor(s)?.ready ?? false)
      .length;
  bool get readyToSubmit => editable && submissionProblems.isEmpty;
}

/// Creating or changing a vehicle. VIN and engine number are sent only when typed.
final class VehicleInput {
  const VehicleInput({
    required this.type,
    required this.make,
    required this.model,
    required this.year,
    required this.seats,
    required this.transmission,
    required this.fuel,
    required this.plateRegion,
    required this.plateCode,
    required this.plateNumber,
    this.color,
    this.vin,
    this.engineNumber,
  });

  final String type;
  final String make;
  final String model;
  final int year;
  final String? color;
  final int seats;
  final String transmission;
  final String fuel;
  final String plateRegion;
  final String plateCode;
  final String plateNumber;
  final String? vin;
  final String? engineNumber;

  Map<String, Object?> toJson() => {
    'vehicleType': type,
    'make': make,
    'model': model,
    'year': year,
    'color': ?color,
    'seats': seats,
    'transmission': transmission,
    'fuelType': fuel,
    'plateRegion': plateRegion,
    'plateCode': plateCode,
    'plateNumber': plateNumber,
    'vin': ?vin,
    'engineNumber': ?engineNumber,
  };
}

/// `/vehicles`. The server decides every transition and every rule; the app only shows what
/// the response allows ([Vehicle.editable], [Vehicle.submissionProblems]).
abstract interface class VehicleApi {
  Future<List<Vehicle>> list();
  Future<Vehicle> get(String id);
  Future<Vehicle> create(VehicleInput input);
  Future<Vehicle> update(String id, int version, VehicleInput input);
  Future<Vehicle> attach(String id, EvidenceSlot slot, String documentId, {String? expiresOn});
  Future<Vehicle> submit(String id, {required String idempotencyKey});
  Future<Vehicle> archive(String id);
}

final class HttpVehicleApi implements VehicleApi {
  const HttpVehicleApi(this._client);

  final ApiClient _client;

  Vehicle _decode(Object? data) => Vehicle.fromJson(_map(data));

  @override
  Future<List<Vehicle>> list() => _client.get(
    '/vehicles',
    decode: (data) => [
      for (final item in _map(data)['items']! as List) Vehicle.fromJson(_map(item)),
    ],
  );

  @override
  Future<Vehicle> get(String id) =>
      _client.get('/vehicles/${Uri.encodeComponent(id)}', decode: _decode);

  @override
  Future<Vehicle> create(VehicleInput input) =>
      _client.post('/vehicles', body: input.toJson(), decode: _decode);

  @override
  Future<Vehicle> update(String id, int version, VehicleInput input) => _client.patch(
    '/vehicles/${Uri.encodeComponent(id)}',
    body: input.toJson(),
    headers: {'If-Match': '$version'},
    decode: _decode,
  );

  @override
  Future<Vehicle> attach(String id, EvidenceSlot slot, String documentId, {String? expiresOn}) =>
      _client.put(
        '/vehicles/${Uri.encodeComponent(id)}/evidence/${slot.wire}',
        body: {'documentId': documentId, 'expiresOn': ?expiresOn},
        decode: _decode,
      );

  @override
  Future<Vehicle> submit(String id, {required String idempotencyKey}) => _client.post(
    '/vehicles/${Uri.encodeComponent(id)}/submit',
    idempotencyKey: idempotencyKey,
    decode: _decode,
  );

  @override
  Future<Vehicle> archive(String id) =>
      _client.post('/vehicles/${Uri.encodeComponent(id)}/archive', decode: _decode);
}

final vehicleApiProvider = Provider<VehicleApi>(
  (ref) => HttpVehicleApi(ref.watch(apiClientProvider)),
);

final vehiclesProvider = FutureProvider.autoDispose<List<Vehicle>>(
  (ref) => ref.watch(vehicleApiProvider).list(),
);

final vehicleProvider = FutureProvider.autoDispose.family<Vehicle, String>(
  (ref, id) => ref.watch(vehicleApiProvider).get(id),
);

/// Same normalization as the API (VIN: separators removed, 5–25 letters and digits).
String? normalizeVin(String input) {
  final value = input.toUpperCase().replaceAll(RegExp(r'[\s\-]'), '');
  return RegExp(r'^[A-Z0-9]{5,25}$').hasMatch(value) ? value : null;
}

String? normalizeEngineNumber(String input) {
  final value = input.toUpperCase().replaceAll(RegExp(r'[\s\-]'), '');
  return RegExp(r'^[A-Z0-9]{3,30}$').hasMatch(value) ? value : null;
}

/// 1–12 letters (any script) or digits with inner spaces or hyphens, as the API accepts.
bool validPlatePart(String input) {
  final value = input.trim();
  return value.isNotEmpty &&
      value.length <= 12 &&
      RegExp(r'^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} \-]*$', unicode: true).hasMatch(value);
}

/// Make, model and colour: letters, digits and common punctuation; no control characters.
bool validDisplayText(String input, {required int max}) {
  final value = input.trim();
  return value.isNotEmpty &&
      value.length <= max &&
      RegExp(r"^[\p{L}\p{M}\p{N} .,'\-/&()+]+$", unicode: true).hasMatch(value);
}
