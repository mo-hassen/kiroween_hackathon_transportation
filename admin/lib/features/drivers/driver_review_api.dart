import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api.dart';
import '../../core/session.dart';

DateTime? _date(Object? value) => value is String ? DateTime.parse(value) : null;

final class CaseSummary {
  const CaseSummary({
    required this.id,
    required this.status,
    required this.driverName,
    required this.submittedAt,
    required this.claimedByMe,
    required this.claimedByOther,
    required this.expiresOn,
  });

  factory CaseSummary.fromJson(Map<String, Object?> json) => CaseSummary(
    id: json['id']! as String,
    status: json['reviewStatus']! as String,
    driverName: json['driverName'] as String?,
    submittedAt: _date(json['submittedAt']),
    claimedByMe: json['claimedByMe']! as bool,
    claimedByOther: json['claimedById'] != null && !(json['claimedByMe']! as bool),
    expiresOn: json['expiresOn']! as String,
  );

  final String id;
  final String status;
  final String? driverName;
  final DateTime? submittedAt;
  final bool claimedByMe;
  final bool claimedByOther;
  final String expiresOn;
}

final class CasePage {
  const CasePage({
    required this.items,
    required this.total,
    required this.page,
    required this.limit,
  });

  factory CasePage.fromJson(Map<String, Object?> json) => CasePage(
    items: [for (final item in json['items']! as List) CaseSummary.fromJson(asMap(item))],
    total: json['total']! as int,
    page: json['page']! as int,
    limit: json['limit']! as int,
  );

  final List<CaseSummary> items;
  final int total;
  final int page;
  final int limit;

  int get pages => total == 0 ? 1 : (total / limit).ceil();
}

final class CaseDocument {
  const CaseDocument({required this.id, required this.mimeType, required this.uploadStatus});

  factory CaseDocument.fromJson(Map<String, Object?> json) => CaseDocument(
    id: json['id']! as String,
    mimeType: json['mimeType']! as String,
    uploadStatus: json['uploadStatus']! as String,
  );

  final String id;
  final String mimeType;
  final String uploadStatus;

  bool get isPdf => mimeType == 'application/pdf';
}

final class CaseEvent {
  const CaseEvent({
    required this.action,
    required this.toStatus,
    required this.reasonCode,
    required this.note,
    required this.at,
  });

  factory CaseEvent.fromJson(Map<String, Object?> json) => CaseEvent(
    action: json['action']! as String,
    toStatus: json['toStatus']! as String,
    reasonCode: json['reasonCode'] as String?,
    note: json['note'] as String?,
    at: DateTime.parse(json['createdAt']! as String),
  );

  final String action;
  final String toStatus;
  final String? reasonCode;
  final String? note;
  final DateTime at;
}

final class CaseDetail {
  const CaseDetail({
    required this.summary,
    required this.driverPhone,
    required this.licenseNumber,
    required this.categories,
    required this.issuedOn,
    required this.issuingAuthority,
    required this.identityStatus,
    required this.identityVerifiedName,
    required this.yearsLicensed,
    required this.homeSubCity,
    required this.decisionReasonCode,
    required this.decisionNote,
    required this.front,
    required this.back,
    required this.history,
  });

  factory CaseDetail.fromJson(Map<String, Object?> json) {
    CaseDocument? document(Object? value) =>
        value == null ? null : CaseDocument.fromJson(asMap(value));
    return CaseDetail(
      summary: CaseSummary.fromJson(json),
      driverPhone: json['driverPhone']! as String,
      licenseNumber: json['licenseNumber']! as String,
      categories: [for (final c in json['categories']! as List) c as String],
      issuedOn: json['issuedOn']! as String,
      issuingAuthority: json['issuingAuthority']! as String,
      identityStatus: json['identityStatus']! as String,
      identityVerifiedName: json['identityVerifiedName'] as String?,
      yearsLicensed: json['yearsLicensed'] as int?,
      homeSubCity: json['homeSubCity'] as String?,
      decisionReasonCode: json['decisionReasonCode'] as String?,
      decisionNote: json['decisionNote'] as String?,
      front: document(json['frontDocument']),
      back: document(json['backDocument']),
      history: [for (final e in json['history']! as List) CaseEvent.fromJson(asMap(e))],
    );
  }

  final CaseSummary summary;
  final String driverPhone;
  final String licenseNumber;
  final List<String> categories;
  final String issuedOn;
  final String issuingAuthority;
  final String identityStatus;
  final String? identityVerifiedName;
  final int? yearsLicensed;
  final String? homeSubCity;
  final String? decisionReasonCode;
  final String? decisionNote;
  final CaseDocument? front;
  final CaseDocument? back;
  final List<CaseEvent> history;
}

typedef CaseCounts = Map<String, int>;

/// `/admin/driver-verifications`. Every call is authorized by the server (drivers.review).
abstract interface class DriverReviewApi {
  Future<CaseCounts> counts();
  Future<CasePage> list({String? status, String? query, int page = 1, int limit = 20});
  Future<CaseDetail> detail(String id);
  Future<void> claim(String id);
  Future<void> release(String id);
  Future<void> approve(String id, {String? note});
  Future<void> reject(String id, {required String reasonCode, String? note});
  Future<void> suspend(String id, {required String reasonCode, required String note});
  Future<void> reinstate(String id, {required String note});

  /// A 60-second URL; the server records the access with [reason].
  Future<Uri> documentUrl(String caseId, String documentId, {required String reason});
}

final class HttpDriverReviewApi implements DriverReviewApi {
  const HttpDriverReviewApi(this._client);

  final ApiClient _client;
  static const _base = '/admin/driver-verifications';

  @override
  Future<CaseCounts> counts() => _client.get(
    '$_base/counts',
    (data) => {for (final e in asMap(data).entries) e.key: e.value! as int},
  );

  @override
  Future<CasePage> list({String? status, String? query, int page = 1, int limit = 20}) =>
      _client.get(
        _base,
        (data) => CasePage.fromJson(asMap(data)),
        query: {
          'status': ?status,
          if (query != null && query.isNotEmpty) 'q': query,
          'page': '$page',
          'limit': '$limit',
        },
      );

  @override
  Future<CaseDetail> detail(String id) =>
      _client.get('$_base/${Uri.encodeComponent(id)}', (data) => CaseDetail.fromJson(asMap(data)));

  Future<void> _post(String id, String action, [Object? body]) => _client.post(
    '$_base/${Uri.encodeComponent(id)}/$action',
    (_) {},
    body: body ?? const <String, Object?>{},
  );

  @override
  Future<void> claim(String id) => _post(id, 'claim');

  @override
  Future<void> release(String id) => _post(id, 'release');

  @override
  Future<void> approve(String id, {String? note}) => _post(id, 'approve', {
    'identityMatches': true,
    'documentsLegible': true,
    'detailsMatch': true,
    'note': ?note,
  });

  @override
  Future<void> reject(String id, {required String reasonCode, String? note}) =>
      _post(id, 'reject', {'reasonCode': reasonCode, 'note': ?note});

  @override
  Future<void> suspend(String id, {required String reasonCode, required String note}) =>
      _post(id, 'suspend', {'reasonCode': reasonCode, 'note': note});

  @override
  Future<void> reinstate(String id, {required String note}) =>
      _post(id, 'reinstate', {'note': note});

  @override
  Future<Uri> documentUrl(String caseId, String documentId, {required String reason}) =>
      _client.get(
        '$_base/${Uri.encodeComponent(caseId)}/documents/${Uri.encodeComponent(documentId)}/url',
        (data) => Uri.parse(asMap(data)['url']! as String),
        query: {'reason': reason},
      );
}

final driverReviewApiProvider = Provider<DriverReviewApi>(
  (ref) => HttpDriverReviewApi(ref.watch(apiClientProvider)),
);

const rejectReasons = [
  'BLURRY',
  'MISMATCH_NAME',
  'EXPIRED',
  'NOT_OWNER',
  'INCOMPLETE',
  'INVALID_LICENSE_DETAILS',
  'SUSPECTED_FRAUD',
  'OTHER',
];
const suspendReasons = ['SUSPECTED_FRAUD', 'SAFETY_CONCERN', 'NOT_OWNER', 'OTHER'];
