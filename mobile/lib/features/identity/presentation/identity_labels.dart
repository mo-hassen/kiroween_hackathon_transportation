import '../../../app/l10n/l10n.dart';
import '../data/identity_api.dart';

/// Short label for an account's identity status (e.g. in the account menu).
String identityStatusLabel(AppLocalizations l10n, IdentityStatus status) => switch (status) {
  IdentityStatus.unverified => l10n.identityStatusNotVerified,
  IdentityStatus.pending => l10n.identityStatusPending,
  IdentityStatus.verified => l10n.identityStatusVerified,
  IdentityStatus.rejected => l10n.identityStatusRejected,
  IdentityStatus.suspended => l10n.identityStatusSuspended,
  IdentityStatus.expired => l10n.identityStatusExpired,
  IdentityStatus.reverificationRequired => l10n.identityStatusReverification,
  IdentityStatus.unknown => l10n.identityStatusUnknown,
};
