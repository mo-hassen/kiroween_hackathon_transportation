import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../core/api.dart';
import '../../core/session.dart';
import '../drivers/driver_review_api.dart' show CaseDocument, CaseEvent;

DateTime? _date(Object? value) => value is String ? DateTime.parse(value) : null;

final class VehicleCaseSummary {
  const VehicleCaseSummary({
    required this.id,
    required this.vehicleType,
    required this.make,
    required this.model,
    required this.year,
    required this.plate,
    required this.status,
    required this.ownerName,
    required this.ownerType,
    required this.submittedAt,
    required this.claimedByMe,
    required this.claimedByOther,
  });

  factory VehicleCaseSummary.fromJson(Map<String, Object?> json) {
    final plate = asMap(json['plate']);
    return VehicleCaseSummary(
      id: json['id']! as String,
      vehicleType: json['vehicleType']! as String,
      make: json['make']! as String,
      model: json['model']! as String,
      year: json['year']! as int,
      plate: '${plate['region']} ${plate['code']} ${plate['number']}',
      status: json['status']! as String,
      ownerName: json['ownerName'] as String?,
      ownerType: json['ownerType']! as String,
      submittedAt: _date(json['submittedAt']),
      claimedByMe: json['claimedByMe']! as bool,
      claimedByOther: json['claimedById'] != null && !(json['claimedByMe']! as bool),
    );
  }

  final String id;
  final String vehicleType;
  final String make;
  final String model;
  final int year;

  /// Region, code and number as printed.
  final String plate;
  final String status;
  final String? ownerName;
  final String ownerType;
  final DateTime? submittedAt;
  final bool claimedByMe;
  final bool claimedByOther;

  /// SUBMITTED, or UNDER_REVIEW with an expired claim (the server decides; this is a hint).
  bool get canClaim => status == 'SUBMITTED' && !claimedByMe && !claimedByOther;
  bool get underMyReview => status == 'UNDER_REVIEW' && claimedByMe;
}

final class VehicleCasePage {
  const VehicleCasePage({
    required this.items,
    required this.total,
    required this.page,
    required this.limit,
  });

  factory VehicleCasePage.fromJson(Map<String, Object?> json) => VehicleCasePage(
    items: [for (final item in json['items']! as List) VehicleCaseSummary.fromJson(asMap(item))],
    total: json['total']! as int,
    page: json['page']! as int,
    limit: json['limit']! as int,
  );

  final List<VehicleCaseSummary> items;
  final int total;
  final int page;
  final int limit;

  int get pages => total == 0 ? 1 : (total / limit).ceil();
}

final class VehicleEvidence {
  const VehicleEvidence({
    required this.slot,
    required this.required,
    required this.expiresOn,
    required this.document,
  });

  final String slot;
  final bool required;
  final String? expiresOn;
  final CaseDocument? document;

  bool get isPhoto => slot.startsWith('PHOTO_');
}

final class VehicleCaseDetail {
  const VehicleCaseDetail({
    required this.summary,
    required this.ownerPhone,
    required this.ownerVerificationStatus,
    required this.accountStatus,
    required this.identityStatus,
    required this.color,
    required this.seats,
    required this.transmission,
    required this.fuelType,
    required this.vin,
    required this.vinMasked,
    required this.engineNumber,
    required this.decisionReasonCode,
    required this.decisionNote,
    required this.evidence,
    required this.approvalBlockers,
    required this.eligible,
    required this.history,
  });

  factory VehicleCaseDetail.fromJson(Map<String, Object?> json) => VehicleCaseDetail(
    summary: VehicleCaseSummary.fromJson(json),
    ownerPhone: json['ownerPhone']! as String,
    ownerVerificationStatus: json['ownerVerificationStatus']! as String,
    accountStatus: json['accountStatus']! as String,
    identityStatus: json['identityStatus']! as String,
    color: json['color'] as String?,
    seats: json['seats']! as int,
    transmission: json['transmission']! as String,
    fuelType: json['fuelType']! as String,
    vin: json['vin'] as String?,
    vinMasked: json['vinMasked'] as String?,
    engineNumber: json['engineNumber'] as String?,
    decisionReasonCode: json['decisionReasonCode'] as String?,
    decisionNote: json['decisionNote'] as String?,
    evidence: [
      for (final e in json['evidence']! as List)
        VehicleEvidence(
          slot: asMap(e)['slot']! as String,
          required: asMap(e)['required']! as bool,
          expiresOn: asMap(e)['expiresOn'] as String?,
          document: asMap(e)['document'] == null
              ? null
              : CaseDocument.fromJson(asMap(asMap(e)['document'])),
        ),
    ],
    approvalBlockers: [for (final b in json['approvalBlockers']! as List) b as String],
    eligible: asMap(json['eligibility'])['eligible']! as bool,
    history: [for (final e in json['history']! as List) CaseEvent.fromJson(asMap(e))],
  );

  final VehicleCaseSummary summary;
  final String ownerPhone;
  final String ownerVerificationStatus;
  final String accountStatus;
  final String identityStatus;
  final String? color;
  final int seats;
  final String transmission;
  final String fuelType;

  /// Full VIN: only while this officer holds the claim (the server audits that).
  final String? vin;
  final String? vinMasked;
  final String? engineNumber;
  final String? decisionReasonCode;
  final String? decisionNote;
  final List<VehicleEvidence> evidence;
  final List<String> approvalBlockers;
  final bool eligible;
  final List<CaseEvent> history;
}

typedef VehicleCounts = Map<String, int>;

/// `/admin/vehicle-verifications`. Every call is authorized by the server (vehicles.verify).
abstract interface class VehicleReviewApi {
  Future<VehicleCounts> counts();

  Future<VehicleCasePage> list({
    String? status,
    String? vehicleType,
    String? query,
    int page = 1,
    int limit = 20,
  });

  Future<VehicleCaseDetail> detail(String id);
  Future<void> claim(String id);
  Future<void> release(String id);
  Future<void> approve(String id, {String? note});
  Future<void> reject(String id, {required String reasonCode, String? note});
  Future<void> suspend(String id, {required String reasonCode, required String note});
  Future<void> reinstate(String id, {required String note});

  /// A 60-second URL; the server records the access with [reason].
  Future<Uri> documentUrl(String caseId, String documentId, {required String reason});
}

final class HttpVehicleReviewApi implements VehicleReviewApi {
  const HttpVehicleReviewApi(this._client);

  final ApiClient _client;
  static const _base = '/admin/vehicle-verifications';

  @override
  Future<VehicleCounts> counts() => _client.get(
    '$_base/counts',
    (data) => {for (final e in asMap(data).entries) e.key: e.value! as int},
  );

  @override
  Future<VehicleCasePage> list({
    String? status,
    String? vehicleType,
    String? query,
    int page = 1,
    int limit = 20,
  }) => _client.get(
    _base,
    (data) => VehicleCasePage.fromJson(asMap(data)),
    query: {
      'status': ?status,
      'vehicleType': ?vehicleType,
      if (query != null && query.isNotEmpty) 'q': query,
      'page': '$page',
      'limit': '$limit',
    },
  );

  @override
  Future<VehicleCaseDetail> detail(String id) => _client.get(
    '$_base/${Uri.encodeComponent(id)}',
    (data) => VehicleCaseDetail.fromJson(asMap(data)),
  );

  Future<void> _post(String id, String action) => _client.post(
    '$_base/${Uri.encodeComponent(id)}/$action',
    (_) {},
    body: const <String, Object?>{},
  );

  /// Decisions carry a fresh Idempotency-Key per user action.
  Future<void> _decide(String id, String action, Map<String, Object?> body) => _client.post(
    '$_base/${Uri.encodeComponent(id)}/$action',
    (_) {},
    body: body,
    headers: {'Idempotency-Key': const Uuid().v4()},
  );

  @override
  Future<void> claim(String id) => _post(id, 'claim');

  @override
  Future<void> release(String id) => _post(id, 'release');

  @override
  Future<void> approve(String id, {String? note}) => _decide(id, 'approve', {
    'detailsMatch': true,
    'ownerMatchesRegistration': true,
    'documentsLegible': true,
    'photosMatch': true,
    'note': ?note,
  });

  @override
  Future<void> reject(String id, {required String reasonCode, String? note}) =>
      _decide(id, 'reject', {'reasonCode': reasonCode, 'note': ?note});

  @override
  Future<void> suspend(String id, {required String reasonCode, required String note}) =>
      _decide(id, 'suspend', {'reasonCode': reasonCode, 'note': note});

  @override
  Future<void> reinstate(String id, {required String note}) =>
      _decide(id, 'reinstate', {'note': note});

  @override
  Future<Uri> documentUrl(String caseId, String documentId, {required String reason}) =>
      _client.get(
        '$_base/${Uri.encodeComponent(caseId)}/documents/${Uri.encodeComponent(documentId)}/url',
        (data) => Uri.parse(asMap(data)['url']! as String),
        query: {'reason': reason},
      );
}

final vehicleReviewApiProvider = Provider<VehicleReviewApi>(
  (ref) => HttpVehicleReviewApi(ref.watch(apiClientProvider)),
);

const vehicleRejectReasons = [
  'BLURRY',
  'EXPIRED',
  'NOT_OWNER',
  'INCOMPLETE',
  'VEHICLE_DETAILS_MISMATCH',
  'INVALID_DOCUMENT',
  'SUSPECTED_FRAUD',
  'OTHER',
];
const vehicleSuspendReasons = ['SUSPECTED_FRAUD', 'SAFETY_CONCERN', 'NOT_OWNER', 'OTHER'];
const vehicleReviewStatuses = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'EXPIRED',
];
const vehicleTypes = ['SEDAN', 'HATCHBACK', 'SUV', 'MINIBUS', 'PICKUP', 'THREE_WHEELER', 'OTHER'];
