import '../../../app/l10n/l10n.dart';
import '../../../core/network/api_failure.dart';
import '../../../core/widgets/failure_message.dart';
import '../data/driver_api.dart';
import '../data/license_upload.dart';

String blockerLabel(AppLocalizations l10n, String code) => switch (code) {
  'ACCOUNT_NOT_ACTIVE' => l10n.blockerACCOUNT_NOT_ACTIVE,
  'IDENTITY_NOT_VERIFIED' => l10n.blockerIDENTITY_NOT_VERIFIED,
  'LICENSE_MISSING' => l10n.blockerLICENSE_MISSING,
  'LICENSE_NOT_APPROVED' => l10n.blockerLICENSE_NOT_APPROVED,
  'LICENSE_EXPIRED' => l10n.blockerLICENSE_EXPIRED,
  'DOCUMENTS_NOT_APPROVED' => l10n.blockerDOCUMENTS_NOT_APPROVED,
  'DRIVER_SUSPENDED' => l10n.blockerDRIVER_SUSPENDED,
  _ => l10n.blockerOther,
};

String licenseStatusLabel(AppLocalizations l10n, ReviewStatus status) => switch (status) {
  ReviewStatus.draft => l10n.licenseStatusDraft,
  ReviewStatus.submitted => l10n.licenseStatusSubmitted,
  ReviewStatus.underReview => l10n.licenseStatusUnderReview,
  ReviewStatus.approved => l10n.licenseStatusApproved,
  ReviewStatus.rejected => l10n.licenseStatusRejected,
  ReviewStatus.expired => l10n.licenseStatusExpired,
  ReviewStatus.suspended => l10n.licenseStatusSuspended,
  ReviewStatus.unknown => l10n.licenseStatusUnknown,
};

String decisionReasonLabel(AppLocalizations l10n, String code) => switch (code) {
  'BLURRY' => l10n.reasonBLURRY,
  'MISMATCH_NAME' => l10n.reasonMISMATCH_NAME,
  'EXPIRED' => l10n.reasonEXPIRED,
  'NOT_OWNER' => l10n.reasonNOT_OWNER,
  'INCOMPLETE' => l10n.reasonINCOMPLETE,
  'INVALID_LICENSE_DETAILS' => l10n.reasonINVALID_LICENSE_DETAILS,
  'SUSPECTED_FRAUD' => l10n.reasonSUSPECTED_FRAUD,
  'SAFETY_CONCERN' => l10n.reasonSAFETY_CONCERN,
  'INVALID_ORGANIZATION_DETAILS' => l10n.reasonINVALID_ORGANIZATION_DETAILS,
  'REPRESENTATIVE_NOT_AUTHORIZED' => l10n.reasonREPRESENTATIVE_NOT_AUTHORIZED,
  'VEHICLE_DETAILS_MISMATCH' => l10n.reasonVEHICLE_DETAILS_MISMATCH,
  'INVALID_DOCUMENT' => l10n.reasonINVALID_DOCUMENT,
  _ => l10n.reasonOTHER,
};

String subCityLabel(AppLocalizations l10n, String code) => switch (code) {
  'ADDIS_KETEMA' => l10n.subCityADDIS_KETEMA,
  'AKAKY_KALITI' => l10n.subCityAKAKY_KALITI,
  'ARADA' => l10n.subCityARADA,
  'BOLE' => l10n.subCityBOLE,
  'GULLELE' => l10n.subCityGULLELE,
  'KIRKOS' => l10n.subCityKIRKOS,
  'KOLFE_KERANIO' => l10n.subCityKOLFE_KERANIO,
  'LEMI_KURA' => l10n.subCityLEMI_KURA,
  'LIDETA' => l10n.subCityLIDETA,
  'NIFAS_SILK_LAFTO' => l10n.subCityNIFAS_SILK_LAFTO,
  'YEKA' => l10n.subCityYEKA,
  _ => code,
};

String submissionProblemLabel(AppLocalizations l10n, String code) => switch (code) {
  'IDENTITY_NOT_VERIFIED' => l10n.problemIDENTITY_NOT_VERIFIED,
  'ACCOUNT_NOT_ACTIVE' => l10n.problemACCOUNT_NOT_ACTIVE,
  'LICENSE_EXPIRED' => l10n.problemLICENSE_EXPIRED,
  'LICENSE_NOT_YET_ISSUED' => l10n.problemLICENSE_NOT_YET_ISSUED,
  'FRONT_DOCUMENT_MISSING' => l10n.problemFRONT_DOCUMENT_MISSING,
  'BACK_DOCUMENT_MISSING' => l10n.problemBACK_DOCUMENT_MISSING,
  _ => l10n.blockerOther,
};

/// Text for a refused photo (client check or server failure code).
String photoRejectedLabel(AppLocalizations l10n, String code) => switch (code) {
  'UNSUPPORTED_TYPE' || 'TYPE_MISMATCH' => l10n.photoUnsupported,
  'TOO_LARGE' || 'IMAGE_TOO_LARGE' => l10n.photoTooLarge,
  'MALWARE_DETECTED' || 'ACTIVE_CONTENT' => l10n.photoRefused,
  _ => l10n.photoUnreadable,
};

/// Driver-flow failures, with the domain codes this feature can explain.
String driverFailureMessage(AppLocalizations l10n, Object error) {
  if (error is PhotoRejected) return photoRejectedLabel(l10n, error.code);
  final failure = ApiFailure.from(error);
  return switch (failure.code) {
    'LICENSE_NUMBER_IN_USE' => l10n.licenseNumberInUse,
    'DOCUMENT_SCAN_UNAVAILABLE' => l10n.photoCheckUnavailable,
    'DOCUMENT_PROCESSING' => l10n.photoStillChecking,
    'DRIVER_SUBMISSION_INCOMPLETE' when failure is ValidationFailure =>
      failure.fieldErrors.map((e) => submissionProblemLabel(l10n, e.code)).join('\n'),
    _ => failureMessage(l10n, failure),
  };
}

String sideLabel(AppLocalizations l10n, LicenseSide side) =>
    side == LicenseSide.front ? l10n.photoFront : l10n.photoBack;
