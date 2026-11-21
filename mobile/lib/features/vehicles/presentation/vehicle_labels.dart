import '../../../app/l10n/l10n.dart';
import '../../../core/network/api_failure.dart';
import '../../driver/presentation/driver_labels.dart';
import '../data/vehicle_api.dart';

String vehicleStatusLabel(AppLocalizations l10n, VehicleStatus status) => switch (status) {
  VehicleStatus.draft => l10n.vehicleStatusDraft,
  VehicleStatus.submitted => l10n.vehicleStatusSubmitted,
  VehicleStatus.underReview => l10n.vehicleStatusUnderReview,
  VehicleStatus.approved => l10n.vehicleStatusApproved,
  VehicleStatus.rejected => l10n.vehicleStatusRejected,
  VehicleStatus.expired => l10n.vehicleStatusExpired,
  VehicleStatus.suspended => l10n.vehicleStatusSuspended,
  VehicleStatus.archived => l10n.vehicleStatusArchived,
  VehicleStatus.unknown => l10n.vehicleStatusUnknown,
};

/// Guidance under the status, or null when the status says enough.
String? vehicleStatusGuidance(AppLocalizations l10n, VehicleStatus status) => switch (status) {
  VehicleStatus.draft => l10n.vehicleGuidanceDraft,
  VehicleStatus.submitted || VehicleStatus.underReview => l10n.vehicleGuidanceSubmitted,
  VehicleStatus.approved => l10n.vehicleGuidanceApproved,
  VehicleStatus.rejected => l10n.vehicleGuidanceRejected,
  VehicleStatus.expired => l10n.vehicleGuidanceExpired,
  VehicleStatus.suspended => l10n.vehicleGuidanceSuspended,
  _ => null,
};

String vehicleTypeLabel(AppLocalizations l10n, String type) => switch (type) {
  'SEDAN' => l10n.vehicleTypeSEDAN,
  'HATCHBACK' => l10n.vehicleTypeHATCHBACK,
  'SUV' => l10n.vehicleTypeSUV,
  'MINIBUS' => l10n.vehicleTypeMINIBUS,
  'PICKUP' => l10n.vehicleTypePICKUP,
  'THREE_WHEELER' => l10n.vehicleTypeTHREE_WHEELER,
  _ => l10n.vehicleTypeOTHER,
};

String transmissionLabel(AppLocalizations l10n, String value) =>
    value == 'MANUAL' ? l10n.vehicleTransmissionMANUAL : l10n.vehicleTransmissionAUTOMATIC;

String fuelLabel(AppLocalizations l10n, String value) => switch (value) {
  'PETROL' => l10n.vehicleFuelPETROL,
  'DIESEL' => l10n.vehicleFuelDIESEL,
  'ELECTRIC' => l10n.vehicleFuelELECTRIC,
  'HYBRID' => l10n.vehicleFuelHYBRID,
  _ => l10n.vehicleFuelOTHER,
};

String evidenceSlotLabel(AppLocalizations l10n, EvidenceSlot slot) => switch (slot) {
  EvidenceSlot.registration => l10n.vehicleSlotREGISTRATION,
  EvidenceSlot.ownership => l10n.vehicleSlotOWNERSHIP,
  EvidenceSlot.insurance => l10n.vehicleSlotINSURANCE,
  EvidenceSlot.inspection => l10n.vehicleSlotINSPECTION,
  EvidenceSlot.photoFront => l10n.vehicleSlotPHOTO_FRONT,
  EvidenceSlot.photoBack => l10n.vehicleSlotPHOTO_BACK,
  EvidenceSlot.photoLeft => l10n.vehicleSlotPHOTO_LEFT,
  EvidenceSlot.photoRight => l10n.vehicleSlotPHOTO_RIGHT,
  EvidenceSlot.photoPlate => l10n.vehicleSlotPHOTO_PLATE,
  EvidenceSlot.photoInterior => l10n.vehicleSlotPHOTO_INTERIOR,
};

String vehicleProblemLabel(AppLocalizations l10n, String code) => switch (code) {
  'REGISTRATION_MISSING' => l10n.vehicleProblemREGISTRATION_MISSING,
  'OWNERSHIP_MISSING' => l10n.vehicleProblemOWNERSHIP_MISSING,
  'INSURANCE_MISSING' => l10n.vehicleProblemINSURANCE_MISSING,
  'INSPECTION_MISSING' => l10n.vehicleProblemINSPECTION_MISSING,
  'PHOTO_FRONT_MISSING' => l10n.vehicleProblemPHOTO_FRONT_MISSING,
  'PHOTO_BACK_MISSING' => l10n.vehicleProblemPHOTO_BACK_MISSING,
  'PHOTO_LEFT_MISSING' => l10n.vehicleProblemPHOTO_LEFT_MISSING,
  'PHOTO_RIGHT_MISSING' => l10n.vehicleProblemPHOTO_RIGHT_MISSING,
  'PHOTO_PLATE_MISSING' => l10n.vehicleProblemPHOTO_PLATE_MISSING,
  'INSURANCE_EXPIRED' => l10n.vehicleProblemINSURANCE_EXPIRED,
  'INSPECTION_EXPIRED' => l10n.vehicleProblemINSPECTION_EXPIRED,
  'OWNER_NOT_VERIFIED' => l10n.vehicleProblemOWNER_NOT_VERIFIED,
  'OWNER_SUSPENDED' => l10n.vehicleProblemOWNER_SUSPENDED,
  // IDENTITY_NOT_VERIFIED, ACCOUNT_NOT_ACTIVE: same wording as the driver flow.
  _ => submissionProblemLabel(l10n, code),
};

/// Vehicle-flow failures, with the domain codes this feature can explain.
String vehicleFailureMessage(AppLocalizations l10n, Object error) {
  final failure = error is ApiFailure ? error : null;
  return switch (failure?.code) {
    'PLATE_IN_USE' => l10n.vehiclePlateInUse,
    'VIN_IN_USE' => l10n.vehicleVinInUse,
    'OWNER_NOT_VERIFIED' => l10n.vehicleOwnerNotVerified,
    'VEHICLE_SUBMISSION_INCOMPLETE' when failure is ValidationFailure =>
      failure.fieldErrors.map((e) => vehicleProblemLabel(l10n, e.code)).join('\n'),
    _ => driverFailureMessage(l10n, error),
  };
}
