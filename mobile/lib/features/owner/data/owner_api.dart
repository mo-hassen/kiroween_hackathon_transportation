import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/session_controller.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_failure.dart';
import '../../driver/data/driver_api.dart' show DocumentInfo;

Map<String, Object?> _map(Object? value) => (value! as Map).cast<String, Object?>();
DateTime? _date(Object? value) => value is String ? DateTime.parse(value) : null;

enum OwnerType {
  individual('INDIVIDUAL'),
  organization('ORGANIZATION');

  const OwnerType(this.wire);

  final String wire;

  static OwnerType parse(Object? value) => value == 'ORGANIZATION' ? organization : individual;
}

/// Owner verification status (02 §3.4).
enum OwnerStatus {
  unverified,
  pending,
  verified,
  rejected,
  suspended,
  expired,
  reverificationRequired,
  unknown;

  static OwnerStatus parse(Object? value) => switch (value) {
    'UNVERIFIED' => unverified,
    'PENDING' => pending,
    'VERIFIED' => verified,
    'REJECTED' => rejected,
    'SUSPENDED' => suspended,
    'EXPIRED' => expired,
    'REVERIFICATION_REQUIRED' => reverificationRequired,
    _ => unknown,
  };
}

/// The three organization document slots (path segment, document purpose).
enum OwnerDocumentSlot {
  tin('tin', 'OWNER_TIN'),
  businessLicense('business-license', 'OWNER_BUSINESS_LICENSE'),
  representativeLetter('representative-letter', 'OWNER_REPRESENTATIVE_LETTER');

  const OwnerDocumentSlot(this.path, this.purpose);

  final String path;
  final String purpose;

  static OwnerDocumentSlot? fromPurpose(Object? purpose) =>
      values.where((slot) => slot.purpose == purpose).firstOrNull;
}

final class OwnerProfile {
  const OwnerProfile({
    required this.type,
    required this.organizationName,
    required this.tinMasked,
    required this.status,
    required this.identityStatus,
    required this.decisionReasonCode,
    required this.decisionNote,
    required this.editable,
    required this.typeChangeAllowed,
    required this.documents,
    required this.submissionProblems,
    required this.eligible,
    required this.version,
    this.submittedAt,
  });

  factory OwnerProfile.fromJson(Map<String, Object?> json) {
    final documents = <OwnerDocumentSlot, DocumentInfo?>{};
    for (final raw in json['documents']! as List) {
      final slot = _map(raw);
      final key = OwnerDocumentSlot.fromPurpose(slot['purpose']);
      if (key == null) continue;
      documents[key] = slot['document'] == null
          ? null
          : DocumentInfo.fromJson(_map(slot['document']));
    }
    final eligibility = _map(json['eligibility']);
    return OwnerProfile(
      type: OwnerType.parse(json['ownerType']),
      organizationName: json['organizationName'] as String?,
      tinMasked: json['tinMasked'] as String?,
      status: OwnerStatus.parse(json['verificationStatus']),
      identityStatus: json['identityStatus']! as String,
      decisionReasonCode: json['decisionReasonCode'] as String?,
      decisionNote: json['decisionNote'] as String?,
      editable: json['editable']! as bool,
      typeChangeAllowed: json['typeChangeAllowed']! as bool,
      documents: documents,
      submissionProblems: [for (final p in json['submissionProblems']! as List) p as String],
      eligible: eligibility['eligible']! as bool,
      version: json['version']! as int,
      submittedAt: _date(json['submittedAt']),
    );
  }

  final OwnerType type;
  final String? organizationName;

  /// Always masked (`••••1234`); the app never receives the full TIN.
  final String? tinMasked;
  final OwnerStatus status;
  final String identityStatus;
  final String? decisionReasonCode;

  /// Officer note for a rejection (plain text).
  final String? decisionNote;
  final bool editable;
  final bool typeChangeAllowed;

  /// Organization owners only: the three slots (a slot may be empty).
  final Map<OwnerDocumentSlot, DocumentInfo?> documents;

  /// What still blocks a submission, computed by the server.
  final List<String> submissionProblems;
  final bool eligible;
  final int version;
  final DateTime? submittedAt;

  bool get isOrganization => type == OwnerType.organization;
  bool get identityVerified => identityStatus == 'VERIFIED';
  bool get readyToSubmit => editable && submissionProblems.isEmpty;
}

/// Creating or changing the owner profile. [tin] is sent only when the user typed one.
final class OwnerInput {
  const OwnerInput({this.type, this.organizationName, this.tin});

  final OwnerType? type;
  final String? organizationName;
  final String? tin;

  Map<String, Object?> toJson() => {
    'ownerType': ?type?.wire,
    'organizationName': ?organizationName,
    'tin': ?tin,
  };
}

/// `/owners/me`. The server decides every transition; the app only shows what the response
/// allows ([OwnerProfile.editable], [OwnerProfile.typeChangeAllowed]).
abstract interface class OwnerApi {
  /// Null when the user has not started owner onboarding (404).
  Future<OwnerProfile?> profile();

  Future<OwnerProfile> create(OwnerInput input);

  Future<OwnerProfile> update(int version, OwnerInput input);

  Future<OwnerProfile> attach(OwnerDocumentSlot slot, String documentId);

  Future<OwnerProfile> submit({required String idempotencyKey});
}

final class HttpOwnerApi implements OwnerApi {
  const HttpOwnerApi(this._client);

  final ApiClient _client;

  OwnerProfile _decode(Object? data) => OwnerProfile.fromJson(_map(data));

  @override
  Future<OwnerProfile?> profile() async {
    try {
      return await _client.get('/owners/me', decode: _decode);
    } on NotFoundFailure {
      return null;
    }
  }

  @override
  Future<OwnerProfile> create(OwnerInput input) =>
      _client.post('/owners/me', body: input.toJson(), decode: _decode);

  @override
  Future<OwnerProfile> update(int version, OwnerInput input) => _client.patch(
    '/owners/me',
    body: input.toJson(),
    headers: {'If-Match': '$version'},
    decode: _decode,
  );

  @override
  Future<OwnerProfile> attach(OwnerDocumentSlot slot, String documentId) => _client.put(
    '/owners/me/documents/${slot.path}',
    body: {'documentId': documentId},
    decode: _decode,
  );

  @override
  Future<OwnerProfile> submit({required String idempotencyKey}) =>
      _client.post('/owners/me/submit', idempotencyKey: idempotencyKey, decode: _decode);
}

final ownerApiProvider = Provider<OwnerApi>((ref) => HttpOwnerApi(ref.watch(apiClientProvider)));

final ownerProfileProvider = FutureProvider.autoDispose<OwnerProfile?>(
  (ref) => ref.watch(ownerApiProvider).profile(),
);

/// Same normalization as the API: separators removed, 4–20 letters and digits.
String? normalizeTin(String input) {
  final value = input.toUpperCase().replaceAll(RegExp(r'[\s\-/.]'), '');
  return RegExp(r'^[A-Z0-9]{4,20}$').hasMatch(value) ? value : null;
}
