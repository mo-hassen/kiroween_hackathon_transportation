import 'package:flutter/widgets.dart';

import '../../core/api.dart';
import 'generated/app_localizations.dart';

export 'generated/app_localizations.dart';

extension AppLocalizationsContext on BuildContext {
  AppLocalizations get l10n => AppLocalizations.of(this);
}

/// Localized, safe text for a failure (never the server's message).
String failureText(AppLocalizations l10n, ApiFailure failure) {
  switch (failure.code) {
    case 'INVALID_CREDENTIALS':
      return l10n.errorInvalidCredentials;
    case 'NOT_STAFF':
      return l10n.errorNotStaff;
    case 'REVIEW_CLAIMED_BY_OTHER':
      return l10n.errorClaimedByOther;
    case 'REVIEW_CLAIM_REQUIRED':
      return l10n.errorClaimRequired;
    case 'DRIVER_SUBMISSION_INCOMPLETE':
    case 'OWNER_SUBMISSION_INCOMPLETE':
      return l10n.errorIncomplete(failure.fieldCodes.join(', '));
    case 'SECOND_APPROVER_REQUIRED':
      return l10n.errorSecondApprover;
    case 'FIRST_APPROVAL_REQUIRED':
      return l10n.errorFirstApprovalRequired;
  }
  return switch (failure.kind) {
    FailureKind.network => l10n.errorNetwork,
    FailureKind.forbidden => l10n.errorForbidden,
    FailureKind.notFound => l10n.errorNotFound,
    FailureKind.conflict => l10n.errorConflict,
    FailureKind.rateLimited => l10n.errorRateLimited,
    FailureKind.unauthorized => l10n.sessionExpired,
    FailureKind.validation || FailureKind.server || FailureKind.unknown => l10n.errorServer,
  };
}

String statusText(AppLocalizations l10n, String status) => switch (status) {
  'SUBMITTED' => l10n.statusSubmitted,
  'UNDER_REVIEW' => l10n.statusUnderReview,
  'APPROVED' => l10n.statusApproved,
  'REJECTED' => l10n.statusRejected,
  'EXPIRED' => l10n.statusExpired,
  'SUSPENDED' => l10n.statusSuspended,
  'DRAFT' => l10n.statusDraft,
  'PENDING' => l10n.statusPending,
  'VERIFIED' => l10n.statusVerified,
  'UNVERIFIED' => l10n.statusUnverified,
  'REVERIFICATION_REQUIRED' => l10n.statusReverification,
  _ => status,
};

String reasonText(AppLocalizations l10n, String code) => switch (code) {
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
  _ => l10n.reasonOTHER,
};

String ownerTypeText(AppLocalizations l10n, String type) =>
    type == 'ORGANIZATION' ? l10n.ownerTypeOrganization : l10n.ownerTypeIndividual;

String ownerDocumentText(AppLocalizations l10n, String purpose) => switch (purpose) {
  'OWNER_TIN' => l10n.docOWNER_TIN,
  'OWNER_BUSINESS_LICENSE' => l10n.docOWNER_BUSINESS_LICENSE,
  _ => l10n.docOWNER_REPRESENTATIVE_LETTER,
};
