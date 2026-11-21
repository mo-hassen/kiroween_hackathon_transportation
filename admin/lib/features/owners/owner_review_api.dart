import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../core/api.dart';
import '../../core/session.dart';
import '../drivers/driver_review_api.dart' show CaseDocument, CaseEvent;

DateTime? _date(Object? value) => value is String ? DateTime.parse(value) : null;

final class OwnerCaseSummary {
  const OwnerCaseSummary({
    required this.id,
    required this.ownerType,
    required this.status,
    required this.displayName,
    required this.organizationName,
    required this.submittedAt,
    required this.claimedByMe,
    required this.claimedByOther,
    required this.awaitingSecondApproval,
    required this.firstApprovedByMe,
  });

  factory OwnerCaseSummary.fromJson(Map<String, Object?> json) => OwnerCaseSummary(
    id: json['id']! as String,
    ownerType: json['ownerType']! as String,
    status: json['verificationStatus']! as String,
    displayName: json['displayName'] as String?,
    organizationName: json['organizationName'] as String?,
    submittedAt: _date(json['submittedAt']),
    claimedByMe: json['claimedByMe']! as bool,
    claimedByOther: json['claimedById'] != null && !(json['claimedByMe']! as bool),
    awaitingSecondApproval: json['awaitingSecondApproval']! as bool,
    firstApprovedByMe: json['firstApprovedByMe']! as bool,
  );

  final String id;
  final String ownerType;
  final String status;
  final String? displayName;
  final String? organizationName;
  final DateTime? submittedAt;
  final bool claimedByMe;
  final bool claimedByOther;
  final bool awaitingSecondApproval;
  final bool firstApprovedByMe;

  bool get isOrganization => ownerType == 'ORGANIZATION';

  /// Claimable now by this officer (the first approver cannot take the second step).
  bool get canClaim => status == 'PENDING' && !claimedByMe && !claimedByOther && !firstApprovedByMe;
}

final class OwnerCasePage {
  const OwnerCasePage({
    required this.items,
    required this.total,
    required this.page,
    required this.limit,
  });

  factory OwnerCasePage.fromJson(Map<String, Object?> json) => OwnerCasePage(
    items: [for (final item in json['items']! as List) OwnerCaseSummary.fromJson(asMap(item))],
    total: json['total']! as int,
    page: json['page']! as int,
    limit: json['limit']! as int,
  );

  final List<OwnerCaseSummary> items;
  final int total;
  final int page;
  final int limit;

  int get pages => total == 0 ? 1 : (total / limit).ceil();
}

final class OwnerDocumentSlot {
  const OwnerDocumentSlot({required this.purpose, required this.document});

  final String purpose;
  final CaseDocument? document;
}

final class OwnerCaseDetail {
  const OwnerCaseDetail({
    required this.summary,
    required this.representativePhone,
    required this.accountStatus,
    required this.identityStatus,
    required this.identityVerifiedName,
    required this.tinMasked,
    required this.tinCheckedByMe,
    required this.firstApprovedAt,
    required this.firstApprovalNote,
    required this.verifiedAt,
    required this.decisionReasonCode,
    required this.decisionNote,
    required this.documents,
    required this.history,
  });

  factory OwnerCaseDetail.fromJson(Map<String, Object?> json) => OwnerCaseDetail(
    summary: OwnerCaseSummary.fromJson(json),
    representativePhone: json['representativePhone']! as String,
    accountStatus: json['accountStatus']! as String,
    identityStatus: json['identityStatus']! as String,
    identityVerifiedName: json['identityVerifiedName'] as String?,
    tinMasked: json['tinMasked'] as String?,
    tinCheckedByMe: json['tinCheckedByMe'] as bool? ?? false,
    firstApprovedAt: _date(json['firstApprovedAt']),
    firstApprovalNote: json['firstApprovalNote'] as String?,
    verifiedAt: _date(json['verifiedAt']),
    decisionReasonCode: json['decisionReasonCode'] as String?,
    decisionNote: json['decisionNote'] as String?,
    documents: [
      for (final slot in json['documents']! as List)
        OwnerDocumentSlot(
          purpose: asMap(slot)['purpose']! as String,
          document: asMap(slot)['document'] == null
              ? null
              : CaseDocument.fromJson(asMap(asMap(slot)['document'])),
        ),
    ],
    history: [for (final e in json['history']! as List) CaseEvent.fromJson(asMap(e))],
  );

  final OwnerCaseSummary summary;
  final String representativePhone;
  final String accountStatus;
  final String identityStatus;
  final String? identityVerifiedName;
  final String? tinMasked;

  /// This officer confirmed the full TIN for the current submission (server-side check).
  final bool tinCheckedByMe;
  final DateTime? firstApprovedAt;
  final String? firstApprovalNote;
  final DateTime? verifiedAt;
  final String? decisionReasonCode;
  final String? decisionNote;
  final List<OwnerDocumentSlot> documents;
  final List<CaseEvent> history;
}

typedef OwnerCounts = Map<String, int>;

/// `/admin/owner-verifications`. Every call is authorized by the server (owners.review).
abstract interface class OwnerReviewApi {
  Future<OwnerCounts> counts();
  Future<OwnerCasePage> list({
    String? status,
    String? ownerType,
    bool? awaitingSecondApproval,
    String? query,
    int page = 1,
    int limit = 20,
  });
  Future<OwnerCaseDetail> detail(String id);
  Future<void> claim(String id);
  Future<void> release(String id);
  Future<void> approveIndividual(String id, {String? note});
  Future<void> firstApproval(String id, {String? note});
  Future<void> secondApproval(String id, {String? note});
  Future<void> reject(String id, {required String reasonCode, String? note});
  Future<void> suspend(String id, {required String reasonCode, required String note});
  Future<void> reinstate(String id, {required String note});

  /// A 60-second URL; the server records the access with [reason].
  Future<Uri> documentUrl(String caseId, String documentId, {required String reason});

  /// Whether [tin] (typed from the certificate) equals the stored TIN. The stored TIN is
  /// never returned. Audited with [reason]; claim holder only.
  Future<bool> checkTin(String caseId, {required String tin, required String reason});
}

final class HttpOwnerReviewApi implements OwnerReviewApi {
  const HttpOwnerReviewApi(this._client);

  final ApiClient _client;
  static const _base = '/admin/owner-verifications';
  static const _orgChecks = {
    'identityConfirmed': true,
    'documentsLegible': true,
    'organizationDetailsMatch': true,
    'representativeAuthorized': true,
  };

  @override
  Future<OwnerCounts> counts() => _client.get(
    '$_base/counts',
    (data) => {for (final e in asMap(data).entries) e.key: e.value! as int},
  );

  @override
  Future<OwnerCasePage> list({
    String? status,
    String? ownerType,
    bool? awaitingSecondApproval,
    String? query,
    int page = 1,
    int limit = 20,
  }) => _client.get(
    _base,
    (data) => OwnerCasePage.fromJson(asMap(data)),
    query: {
      'status': ?status,
      'ownerType': ?ownerType,
      if (awaitingSecondApproval != null) 'awaitingSecondApproval': '$awaitingSecondApproval',
      if (query != null && query.isNotEmpty) 'q': query,
      'page': '$page',
      'limit': '$limit',
    },
  );

  @override
  Future<OwnerCaseDetail> detail(String id) => _client.get(
    '$_base/${Uri.encodeComponent(id)}',
    (data) => OwnerCaseDetail.fromJson(asMap(data)),
  );

  Future<void> _post(String id, String action, [Object? body]) => _client.post(
    '$_base/${Uri.encodeComponent(id)}/$action',
    (_) {},
    body: body ?? const <String, Object?>{},
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
  Future<void> approveIndividual(String id, {String? note}) =>
      _decide(id, 'approve', {'identityConfirmed': true, 'note': ?note});

  @override
  Future<void> firstApproval(String id, {String? note}) =>
      _decide(id, 'first-approval', {..._orgChecks, 'note': ?note});

  @override
  Future<void> secondApproval(String id, {String? note}) =>
      _decide(id, 'second-approval', {..._orgChecks, 'note': ?note});

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
  Future<bool> checkTin(String caseId, {required String tin, required String reason}) =>
      _client.post(
        '$_base/${Uri.encodeComponent(caseId)}/tin-check',
        (data) => asMap(data)['matches']! as bool,
        body: {'tin': tin, 'reason': reason},
      );

  @override
  Future<Uri> documentUrl(String caseId, String documentId, {required String reason}) =>
      _client.get(
        '$_base/${Uri.encodeComponent(caseId)}/documents/${Uri.encodeComponent(documentId)}/url',
        (data) => Uri.parse(asMap(data)['url']! as String),
        query: {'reason': reason},
      );
}

final ownerReviewApiProvider = Provider<OwnerReviewApi>(
  (ref) => HttpOwnerReviewApi(ref.watch(apiClientProvider)),
);

const ownerRejectReasons = [
  'BLURRY',
  'MISMATCH_NAME',
  'EXPIRED',
  'INCOMPLETE',
  'INVALID_ORGANIZATION_DETAILS',
  'REPRESENTATIVE_NOT_AUTHORIZED',
  'SUSPECTED_FRAUD',
  'OTHER',
];
const ownerSuspendReasons = ['SUSPECTED_FRAUD', 'SAFETY_CONCERN', 'NOT_OWNER', 'OTHER'];
const ownerStatuses = [
  'PENDING',
  'VERIFIED',
  'REJECTED',
  'SUSPENDED',
  'EXPIRED',
  'REVERIFICATION_REQUIRED',
];
