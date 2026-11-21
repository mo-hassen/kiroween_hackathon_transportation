import '../../../app/l10n/l10n.dart';
import '../../../core/network/api_failure.dart';
import '../../driver/presentation/driver_labels.dart';
import '../data/owner_api.dart';

String ownerStatusLabel(AppLocalizations l10n, OwnerStatus status) => switch (status) {
  OwnerStatus.unverified => l10n.ownerStatusUnverified,
  OwnerStatus.pending => l10n.ownerStatusPending,
  OwnerStatus.verified => l10n.ownerStatusVerified,
  OwnerStatus.rejected => l10n.ownerStatusRejected,
  OwnerStatus.suspended => l10n.ownerStatusSuspended,
  OwnerStatus.expired => l10n.ownerStatusExpired,
  OwnerStatus.reverificationRequired => l10n.ownerStatusReverification,
  OwnerStatus.unknown => l10n.ownerStatusUnknown,
};

/// Guidance under the status, or null when the status says enough.
String? ownerStatusGuidance(AppLocalizations l10n, OwnerStatus status) => switch (status) {
  OwnerStatus.verified => l10n.ownerVerifiedBody,
  OwnerStatus.rejected => l10n.ownerRejectedBody,
  OwnerStatus.suspended => l10n.ownerSuspendedBody,
  OwnerStatus.expired => l10n.ownerExpiredBody,
  OwnerStatus.reverificationRequired => l10n.ownerReverificationBody,
  _ => null,
};

String ownerTypeLabel(AppLocalizations l10n, OwnerType type) => type == OwnerType.organization
    ? l10n.ownerTypeOrganizationShort
    : l10n.ownerTypeIndividualShort;

String ownerDocumentLabel(AppLocalizations l10n, OwnerDocumentSlot slot) => switch (slot) {
  OwnerDocumentSlot.tin => l10n.docTin,
  OwnerDocumentSlot.businessLicense => l10n.docBusinessLicense,
  OwnerDocumentSlot.representativeLetter => l10n.docRepresentativeLetter,
};

String ownerProblemLabel(AppLocalizations l10n, String code) => switch (code) {
  'ORGANIZATION_DETAILS_MISSING' => l10n.ownerProblemORGANIZATION_DETAILS_MISSING,
  'TIN_DOCUMENT_MISSING' => l10n.ownerProblemTIN_DOCUMENT_MISSING,
  'BUSINESS_LICENSE_MISSING' => l10n.ownerProblemBUSINESS_LICENSE_MISSING,
  'REPRESENTATIVE_LETTER_MISSING' => l10n.ownerProblemREPRESENTATIVE_LETTER_MISSING,
  // IDENTITY_NOT_VERIFIED, ACCOUNT_NOT_ACTIVE: same wording as the driver flow.
  _ => submissionProblemLabel(l10n, code),
};

/// Owner-flow failures, with the domain codes this feature can explain.
String ownerFailureMessage(AppLocalizations l10n, Object error) {
  final failure = error is ApiFailure ? error : null;
  return switch (failure?.code) {
    'TIN_IN_USE' => l10n.tinInUse,
    'OWNER_SUBMISSION_INCOMPLETE' when failure is ValidationFailure =>
      failure.fieldErrors.map((e) => ownerProblemLabel(l10n, e.code)).join('\n'),
    _ => driverFailureMessage(l10n, error),
  };
}
