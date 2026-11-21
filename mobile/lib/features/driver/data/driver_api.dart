import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/session_controller.dart';
import '../../../core/network/api_client.dart';
import '../../../core/network/api_failure.dart';
import '../../documents/document_upload.dart';

Map<String, Object?> _map(Object? value) => (value! as Map).cast<String, Object?>();
DateTime? _date(Object? value) => value is String ? DateTime.parse(value) : null;

/// Licence review status (server `ReviewStatus`).
enum ReviewStatus {
  draft,
  submitted,
  underReview,
  approved,
  rejected,
  expired,
  suspended,
  unknown;

  static ReviewStatus parse(Object? value) => switch (value) {
    'DRAFT' => draft,
    'SUBMITTED' => submitted,
    'UNDER_REVIEW' => underReview,
    'APPROVED' => approved,
    'REJECTED' => rejected,
    'EXPIRED' => expired,
    'SUSPENDED' => suspended,
    _ => unknown,
  };
}

enum Eligibility {
  ineligible,
  eligible,
  suspended,
  unknown;

  static Eligibility parse(Object? value) => switch (value) {
    'INELIGIBLE' => ineligible,
    'ELIGIBLE' => eligible,
    'SUSPENDED' => suspended,
    _ => unknown,
  };
}

/// Upload/processing status of one document (server `DocumentUploadStatus`).
enum UploadStatus {
  pendingUpload,
  uploaded,
  processing,
  available,
  invalid,
  infected,
  deleted,
  unknown;

  static UploadStatus parse(Object? value) => switch (value) {
    'PENDING_UPLOAD' => pendingUpload,
    'UPLOADED' => uploaded,
    'PROCESSING' => processing,
    'AVAILABLE' => available,
    'INVALID' => invalid,
    'INFECTED' => infected,
    'DELETED' => deleted,
    _ => unknown,
  };
}

enum LicenseSide {
  front('front', 'DRIVER_LICENSE_FRONT'),
  back('back', 'DRIVER_LICENSE_BACK');

  const LicenseSide(this.path, this.purpose);

  final String path;
  final String purpose;
}

/// The 11 Addis Ababa sub-cities accepted by the API.
const addisSubCities = [
  'ADDIS_KETEMA',
  'AKAKY_KALITI',
  'ARADA',
  'BOLE',
  'GULLELE',
  'KIRKOS',
  'KOLFE_KERANIO',
  'LEMI_KURA',
  'LIDETA',
  'NIFAS_SILK_LAFTO',
  'YEKA',
];

final class DocumentInfo {
  const DocumentInfo({
    required this.id,
    required this.status,
    required this.reviewStatus,
    required this.mimeType,
    required this.failureCode,
  });

  factory DocumentInfo.fromJson(Map<String, Object?> json) => DocumentInfo(
    id: json['id']! as String,
    status: UploadStatus.parse(json['uploadStatus']),
    reviewStatus: ReviewStatus.parse(json['reviewStatus']),
    mimeType: json['mimeType']! as String,
    failureCode: json['failureCode'] as String?,
  );

  final String id;
  final UploadStatus status;
  final ReviewStatus reviewStatus;
  final String mimeType;

  /// Why processing refused the file, e.g. `TYPE_MISMATCH`, `MALWARE_DETECTED`.
  final String? failureCode;

  /// Usable in a new submission (processed and not yet part of a decided review).
  bool get usableForSubmission =>
      status == UploadStatus.available && reviewStatus == ReviewStatus.draft;
}

final class DriverLicense {
  const DriverLicense({
    required this.id,
    required this.numberMasked,
    required this.categories,
    required this.issuedOn,
    required this.expiresOn,
    required this.issuingAuthority,
    required this.status,
    required this.submittedAt,
    required this.decisionReasonCode,
    required this.decisionNote,
    required this.front,
    required this.back,
    required this.editable,
    required this.version,
  });

  factory DriverLicense.fromJson(Map<String, Object?> json) {
    DocumentInfo? document(Object? value) =>
        value == null ? null : DocumentInfo.fromJson(_map(value));
    return DriverLicense(
      id: json['id']! as String,
      numberMasked: json['licenseNumberMasked']! as String,
      categories: [for (final c in json['categories']! as List) c as String],
      issuedOn: json['issuedOn']! as String,
      expiresOn: json['expiresOn']! as String,
      issuingAuthority: json['issuingAuthority']! as String,
      status: ReviewStatus.parse(json['reviewStatus']),
      submittedAt: _date(json['submittedAt']),
      decisionReasonCode: json['decisionReasonCode'] as String?,
      decisionNote: json['decisionNote'] as String?,
      front: document(json['frontDocument']),
      back: document(json['backDocument']),
      editable: json['editable']! as bool,
      version: json['version']! as int,
    );
  }

  final String id;
  final String numberMasked;
  final List<String> categories;
  final String issuedOn;
  final String expiresOn;
  final String issuingAuthority;
  final ReviewStatus status;
  final DateTime? submittedAt;
  final String? decisionReasonCode;

  /// Officer note for the driver (plain text, may be null).
  final String? decisionNote;
  final DocumentInfo? front;
  final DocumentInfo? back;
  final bool editable;
  final int version;

  DocumentInfo? document(LicenseSide side) => side == LicenseSide.front ? front : back;

  bool get readyToSubmit =>
      status == ReviewStatus.draft &&
      (front?.usableForSubmission ?? false) &&
      (back?.usableForSubmission ?? false);
}

final class DriverProfile {
  const DriverProfile({
    required this.yearsLicensed,
    required this.bio,
    required this.homeSubCity,
    required this.identityStatus,
    required this.eligibility,
    required this.blockers,
    required this.suspendedReason,
    required this.license,
    required this.version,
  });

  factory DriverProfile.fromJson(Map<String, Object?> json) {
    final eligibility = _map(json['eligibility']);
    final license = json['license'];
    return DriverProfile(
      yearsLicensed: json['yearsLicensed'] as int?,
      bio: json['bio'] as String?,
      homeSubCity: json['homeSubCity'] as String?,
      identityStatus: json['identityStatus']! as String,
      eligibility: Eligibility.parse(eligibility['status']),
      blockers: [for (final b in eligibility['blockers']! as List) b as String],
      suspendedReason: json['suspendedReason'] as String?,
      license: license == null ? null : DriverLicense.fromJson(_map(license)),
      version: json['version']! as int,
    );
  }

  final int? yearsLicensed;
  final String? bio;
  final String? homeSubCity;
  final String identityStatus;
  final Eligibility eligibility;

  /// What still blocks driving, e.g. `IDENTITY_NOT_VERIFIED`, `LICENSE_NOT_APPROVED`.
  final List<String> blockers;
  final String? suspendedReason;
  final DriverLicense? license;
  final int version;

  bool get identityVerified => identityStatus == 'VERIFIED';
}

final class ProfileInput {
  const ProfileInput({this.yearsLicensed, this.bio, this.homeSubCity});

  final int? yearsLicensed;
  final String? bio;
  final String? homeSubCity;

  Map<String, Object?> toJson() => {
    'yearsLicensed': ?yearsLicensed,
    'bio': ?bio,
    'homeSubCity': ?homeSubCity,
  };
}

final class LicenseInput {
  const LicenseInput({
    required this.licenseNumber,
    required this.categories,
    required this.issuedOn,
    required this.expiresOn,
    required this.issuingAuthority,
  });

  final String licenseNumber;
  final List<String> categories;
  final String issuedOn;
  final String expiresOn;
  final String issuingAuthority;

  Map<String, Object?> toJson() => {
    'licenseNumber': licenseNumber,
    'categories': categories,
    'issuedOn': issuedOn,
    'expiresOn': expiresOn,
    'issuingAuthority': issuingAuthority,
  };
}

/// A presigned PUT: the app sends the file bytes straight to object storage.
final class UploadIntent {
  const UploadIntent({required this.document, required this.url, required this.headers});

  factory UploadIntent.fromJson(Map<String, Object?> json) {
    final upload = _map(json['upload']);
    return UploadIntent(
      document: DocumentInfo.fromJson(_map(json['document'])),
      url: Uri.parse(upload['url']! as String),
      headers: _map(upload['headers']).map((key, value) => MapEntry(key, value! as String)),
    );
  }

  final DocumentInfo document;
  final Uri url;
  final Map<String, String> headers;
}

/// `/drivers/me` and `/documents`. The server decides every transition; the app only
/// shows what the response allows (e.g. [DriverLicense.editable]).
abstract interface class DriverApi implements DocumentUploadApi {
  /// Null when the user has not started driver onboarding (404).
  Future<DriverProfile?> profile();

  Future<DriverProfile> createProfile(ProfileInput input);

  Future<DriverProfile> updateProfile(int version, ProfileInput input);

  Future<DriverLicense> createLicense(LicenseInput input);

  Future<DriverLicense> updateLicense(String id, int version, LicenseInput input);

  Future<DriverLicense> attach(String licenseId, LicenseSide side, String documentId);

  Future<DriverLicense> submit(String licenseId, {required String idempotencyKey});
}

final class HttpDriverApi implements DriverApi {
  const HttpDriverApi(this._client);

  final ApiClient _client;

  DriverProfile _profile(Object? data) => DriverProfile.fromJson(_map(data));
  DriverLicense _license(Object? data) => DriverLicense.fromJson(_map(data));

  @override
  Future<DriverProfile?> profile() async {
    try {
      return await _client.get('/drivers/me', decode: _profile);
    } on NotFoundFailure {
      return null;
    }
  }

  @override
  Future<DriverProfile> createProfile(ProfileInput input) =>
      _client.post('/drivers/me', body: input.toJson(), decode: _profile);

  @override
  Future<DriverProfile> updateProfile(int version, ProfileInput input) => _client.patch(
    '/drivers/me',
    body: input.toJson(),
    headers: {'If-Match': '$version'},
    decode: _profile,
  );

  @override
  Future<DriverLicense> createLicense(LicenseInput input) =>
      _client.post('/drivers/me/licenses', body: input.toJson(), decode: _license);

  @override
  Future<DriverLicense> updateLicense(String id, int version, LicenseInput input) => _client.patch(
    '/drivers/me/licenses/${Uri.encodeComponent(id)}',
    body: input.toJson(),
    headers: {'If-Match': '$version'},
    decode: _license,
  );

  @override
  Future<DriverLicense> attach(String licenseId, LicenseSide side, String documentId) =>
      _client.put(
        '/drivers/me/licenses/${Uri.encodeComponent(licenseId)}/documents/${side.path}',
        body: {'documentId': documentId},
        decode: _license,
      );

  @override
  Future<DriverLicense> submit(String licenseId, {required String idempotencyKey}) => _client.post(
    '/drivers/me/licenses/${Uri.encodeComponent(licenseId)}/submit',
    idempotencyKey: idempotencyKey,
    decode: _license,
  );

  @override
  Future<UploadIntent> createUpload({
    required String purpose,
    required String mimeType,
    required int sizeBytes,
    required String sha256,
  }) => _client.post(
    '/documents',
    body: {'purpose': purpose, 'mimeType': mimeType, 'sizeBytes': sizeBytes, 'sha256': sha256},
    // A retried intent would only create an unused document; never repeat automatically.
    noRetry: true,
    decode: (data) => UploadIntent.fromJson(_map(data)),
  );

  @override
  Future<DocumentInfo> completeUpload(String documentId) => _client.post(
    '/documents/${Uri.encodeComponent(documentId)}/complete',
    decode: (data) => DocumentInfo.fromJson(_map(data)),
  );
}

final driverApiProvider = Provider<DriverApi>((ref) => HttpDriverApi(ref.watch(apiClientProvider)));

final driverProfileProvider = FutureProvider.autoDispose<DriverProfile?>(
  (ref) => ref.watch(driverApiProvider).profile(),
);
