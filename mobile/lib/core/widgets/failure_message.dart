import '../../app/l10n/l10n.dart';
import '../network/api_failure.dart';

/// Localized, user-safe text for a failure. Never includes server messages.
String failureMessage(AppLocalizations l10n, ApiFailure failure) => switch (failure) {
  NetworkFailure() => l10n.errorNetwork,
  TimeoutFailure() => l10n.errorTimeout,
  UnauthorizedFailure() => l10n.errorUnauthorized,
  ForbiddenFailure() => l10n.errorForbidden,
  NotFoundFailure() => l10n.errorNotFound,
  ConflictFailure() => l10n.errorConflict,
  ValidationFailure() => l10n.errorValidation,
  RateLimitedFailure() => l10n.errorRateLimited,
  ServerFailure() => l10n.errorServer,
  CancelledFailure() || UnknownFailure() => l10n.errorUnknown,
};

/// Short support reference derived from the server request id.
String? failureReference(ApiFailure failure) {
  final id = failure.requestId;
  if (id == null || id.isEmpty) return null;
  return id.length <= 8 ? id : id.substring(0, 8);
}
