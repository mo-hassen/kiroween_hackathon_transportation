import 'package:kiroween_admin/core/api.dart';
import 'package:kiroween_admin/features/drivers/driver_review_api.dart';
import 'package:kiroween_admin/features/owners/owner_review_api.dart';

OwnerCaseSummary ownerSummary({
  String id = 'own-1',
  String type = 'ORGANIZATION',
  String status = 'PENDING',
  bool claimedByMe = false,
  bool claimedByOther = false,
  bool awaitingSecond = false,
  bool firstByMe = false,
}) => OwnerCaseSummary(
  id: id,
  ownerType: type,
  status: status,
  displayName: 'Rep $id',
  organizationName: type == 'ORGANIZATION' ? 'Org $id PLC' : null,
  submittedAt: DateTime.utc(2026, 11, 19, 9),
  claimedByMe: claimedByMe,
  claimedByOther: claimedByOther,
  awaitingSecondApproval: awaitingSecond,
  firstApprovedByMe: firstByMe,
);

OwnerCaseDetail ownerDetail(OwnerCaseSummary s) => OwnerCaseDetail(
  summary: s,
  representativePhone: '+251911000002',
  accountStatus: 'ACTIVE',
  identityStatus: 'VERIFIED',
  identityVerifiedName: 'Abebe Kebede',
  tinMasked: s.isOrganization ? '••••6789' : null,
  firstApprovedAt: s.awaitingSecondApproval ? DateTime.utc(2026, 11, 19, 10) : null,
  firstApprovalNote: null,
  verifiedAt: null,
  decisionReasonCode: null,
  decisionNote: null,
  documents: s.isOrganization
      ? const [
          OwnerDocumentSlot(
            purpose: 'OWNER_TIN',
            document: CaseDocument(
              id: 'doc-tin',
              mimeType: 'image/jpeg',
              uploadStatus: 'AVAILABLE',
            ),
          ),
          OwnerDocumentSlot(
            purpose: 'OWNER_BUSINESS_LICENSE',
            document: CaseDocument(id: 'doc-bl', mimeType: 'image/jpeg', uploadStatus: 'AVAILABLE'),
          ),
          OwnerDocumentSlot(
            purpose: 'OWNER_REPRESENTATIVE_LETTER',
            document: CaseDocument(id: 'doc-rl', mimeType: 'image/png', uploadStatus: 'AVAILABLE'),
          ),
        ]
      : const [],
  history: [
    CaseEvent(
      action: 'submitted',
      toStatus: 'PENDING',
      reasonCode: null,
      note: null,
      at: DateTime.utc(2026, 11, 19, 9),
    ),
  ],
);

/// Scripted owner review API. Every call is recorded.
final class FakeOwnerReviewApi implements OwnerReviewApi {
  FakeOwnerReviewApi({List<OwnerCaseSummary>? cases}) : cases = cases ?? [ownerSummary()];

  List<OwnerCaseSummary> cases;
  final calls = <String>[];
  ApiFailure? actionFailure;
  OwnerCounts countsResponse = const {
    'PENDING_INDIVIDUAL': 2,
    'PENDING_ORGANIZATION': 4,
    'AWAITING_SECOND_APPROVAL': 1,
  };

  OwnerCaseSummary _find(String id) => cases.firstWhere((c) => c.id == id);
  void _replace(OwnerCaseSummary next) =>
      cases = [for (final c in cases) c.id == next.id ? next : c];

  Future<void> _action(String call) async {
    calls.add(call);
    if (actionFailure != null) throw actionFailure!;
  }

  @override
  Future<OwnerCounts> counts() async => countsResponse;

  @override
  Future<OwnerCasePage> list({
    String? status,
    String? ownerType,
    bool? awaitingSecondApproval,
    String? query,
    int page = 1,
    int limit = 20,
  }) async {
    calls.add('list:$status:${ownerType ?? ''}:${awaitingSecondApproval ?? ''}:${query ?? ''}');
    final items = cases
        .where((c) => status == null || c.status == status)
        .where((c) => ownerType == null || c.ownerType == ownerType)
        .where((c) => awaitingSecondApproval != true || c.awaitingSecondApproval)
        .toList();
    return OwnerCasePage(items: items, total: items.length, page: page, limit: limit);
  }

  @override
  Future<OwnerCaseDetail> detail(String id) async => ownerDetail(_find(id));

  @override
  Future<void> claim(String id) async {
    await _action('claim:$id');
    final c = _find(id);
    _replace(
      ownerSummary(
        id: id,
        type: c.ownerType,
        claimedByMe: true,
        awaitingSecond: c.awaitingSecondApproval,
      ),
    );
  }

  @override
  Future<void> release(String id) async {
    await _action('release:$id');
    final c = _find(id);
    _replace(ownerSummary(id: id, type: c.ownerType, awaitingSecond: c.awaitingSecondApproval));
  }

  @override
  Future<void> approveIndividual(String id, {String? note}) async {
    await _action('approve:$id');
    _replace(ownerSummary(id: id, type: 'INDIVIDUAL', status: 'VERIFIED'));
  }

  @override
  Future<void> firstApproval(String id, {String? note}) async {
    await _action('first:$id');
    _replace(ownerSummary(id: id, awaitingSecond: true, firstByMe: true));
  }

  @override
  Future<void> secondApproval(String id, {String? note}) async {
    await _action('second:$id');
    _replace(ownerSummary(id: id, status: 'VERIFIED'));
  }

  @override
  Future<void> reject(String id, {required String reasonCode, String? note}) async {
    await _action('reject:$id:$reasonCode');
    _replace(ownerSummary(id: id, type: _find(id).ownerType, status: 'REJECTED'));
  }

  @override
  Future<void> suspend(String id, {required String reasonCode, required String note}) async {
    await _action('suspend:$id:$reasonCode:$note');
    _replace(ownerSummary(id: id, type: _find(id).ownerType, status: 'SUSPENDED'));
  }

  @override
  Future<void> reinstate(String id, {required String note}) async {
    await _action('reinstate:$id:$note');
    _replace(ownerSummary(id: id, type: _find(id).ownerType, status: 'VERIFIED'));
  }

  @override
  Future<Uri> documentUrl(String caseId, String documentId, {required String reason}) async {
    calls.add('url:$caseId:$documentId:$reason');
    return Uri.parse('https://storage.test/$documentId?sig=1');
  }
}
