import 'package:kiroween_admin/core/api.dart';
import 'package:kiroween_admin/features/drivers/driver_review_api.dart';
import 'package:kiroween_admin/features/vehicles/vehicle_review_api.dart';

VehicleCaseSummary vehicleSummary({
  String id = 'veh-1',
  String status = 'SUBMITTED',
  bool claimedByMe = false,
  bool claimedByOther = false,
}) => VehicleCaseSummary(
  id: id,
  vehicleType: 'SEDAN',
  make: 'Toyota',
  model: 'Vitz',
  year: 2018,
  plate: 'AA 2 12345',
  status: status,
  ownerName: 'Abebe Kebede',
  ownerType: 'INDIVIDUAL',
  submittedAt: DateTime.utc(2026, 11, 20, 9),
  claimedByMe: claimedByMe,
  claimedByOther: claimedByOther,
);

const _slots = [
  'REGISTRATION',
  'OWNERSHIP',
  'INSURANCE',
  'INSPECTION',
  'PHOTO_FRONT',
  'PHOTO_BACK',
  'PHOTO_LEFT',
  'PHOTO_RIGHT',
  'PHOTO_PLATE',
  'PHOTO_INTERIOR',
];

/// The VIN the fake server shows to the claim holder only.
const fakeVin = 'JTDKB20U777123456';

VehicleCaseDetail vehicleDetail(VehicleCaseSummary s, {List<String> blockers = const []}) =>
    VehicleCaseDetail(
      summary: s,
      ownerPhone: '+251911000002',
      ownerVerificationStatus: 'VERIFIED',
      accountStatus: 'ACTIVE',
      identityStatus: 'VERIFIED',
      color: 'White',
      seats: 5,
      transmission: 'AUTOMATIC',
      fuelType: 'PETROL',
      vin: s.claimedByMe ? fakeVin : null,
      vinMasked: '••••3456',
      engineNumber: s.claimedByMe ? 'ENG123' : null,
      decisionReasonCode: null,
      decisionNote: null,
      evidence: [
        for (final slot in _slots)
          VehicleEvidence(
            slot: slot,
            required: slot != 'PHOTO_INTERIOR',
            expiresOn: slot == 'INSURANCE' || slot == 'INSPECTION' ? '2027-06-01' : null,
            document: slot == 'PHOTO_INTERIOR'
                ? null
                : CaseDocument(id: 'doc-$slot', mimeType: 'image/jpeg', uploadStatus: 'AVAILABLE'),
          ),
      ],
      approvalBlockers: blockers,
      eligible: s.status == 'APPROVED',
      history: [
        CaseEvent(
          action: 'submitted',
          toStatus: 'SUBMITTED',
          reasonCode: null,
          note: null,
          at: DateTime.utc(2026, 11, 20, 9),
        ),
      ],
    );

/// Scripted vehicle review API. Every call is recorded.
final class FakeVehicleReviewApi implements VehicleReviewApi {
  FakeVehicleReviewApi({List<VehicleCaseSummary>? cases}) : cases = cases ?? [vehicleSummary()];

  List<VehicleCaseSummary> cases;
  final calls = <String>[];
  ApiFailure? actionFailure;
  VehicleCounts countsResponse = const {'SUBMITTED': 3, 'UNDER_REVIEW': 1, 'APPROVED': 7};

  VehicleCaseSummary _find(String id) => cases.firstWhere((c) => c.id == id);
  void _replace(VehicleCaseSummary next) =>
      cases = [for (final c in cases) c.id == next.id ? next : c];

  Future<void> _action(String call) async {
    calls.add(call);
    if (actionFailure != null) throw actionFailure!;
  }

  @override
  Future<VehicleCounts> counts() async => countsResponse;

  @override
  Future<VehicleCasePage> list({
    String? status,
    String? vehicleType,
    String? query,
    int page = 1,
    int limit = 20,
  }) async {
    calls.add('list:$status:${vehicleType ?? ''}:${query ?? ''}');
    final items = cases
        .where((c) => status == null || c.status == status)
        .where((c) => vehicleType == null || c.vehicleType == vehicleType)
        .toList();
    return VehicleCasePage(items: items, total: items.length, page: page, limit: limit);
  }

  @override
  Future<VehicleCaseDetail> detail(String id) async => vehicleDetail(_find(id));

  @override
  Future<void> claim(String id) async {
    await _action('claim:$id');
    _replace(vehicleSummary(id: id, status: 'UNDER_REVIEW', claimedByMe: true));
  }

  @override
  Future<void> release(String id) async {
    await _action('release:$id');
    _replace(vehicleSummary(id: id));
  }

  @override
  Future<void> approve(String id, {String? note}) async {
    await _action('approve:$id');
    _replace(vehicleSummary(id: id, status: 'APPROVED'));
  }

  @override
  Future<void> reject(String id, {required String reasonCode, String? note}) async {
    await _action('reject:$id:$reasonCode');
    _replace(vehicleSummary(id: id, status: 'REJECTED'));
  }

  @override
  Future<void> suspend(String id, {required String reasonCode, required String note}) async {
    await _action('suspend:$id:$reasonCode:$note');
    _replace(vehicleSummary(id: id, status: 'SUSPENDED'));
  }

  @override
  Future<void> reinstate(String id, {required String note}) async {
    await _action('reinstate:$id:$note');
    _replace(vehicleSummary(id: id, status: 'APPROVED'));
  }

  @override
  Future<Uri> documentUrl(String caseId, String documentId, {required String reason}) async {
    calls.add('url:$caseId:$documentId:$reason');
    return Uri.parse('https://storage.test/$documentId?sig=1');
  }
}
