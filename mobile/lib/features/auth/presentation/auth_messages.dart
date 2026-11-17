import '../../../app/l10n/l10n.dart';
import '../../../core/network/api_failure.dart';
import '../../../core/widgets/failure_message.dart';

/// User-facing text for auth failures. Never reveals whether a number is registered or
/// which credential was wrong (the server does not tell us either).
String authFailureMessage(AppLocalizations l10n, ApiFailure failure) {
  if (failure is RateLimitedFailure) {
    final seconds = failure.retryAfter?.inSeconds;
    return seconds == null
        ? l10n.errorRateLimited
        : l10n.errorRateLimitedMinutes((seconds / 60).ceil());
  }
  return switch (failure.code) {
    'INVALID_CREDENTIALS' => l10n.errorInvalidCredentials,
    'OTP_INVALID' => l10n.errorOtpInvalid,
    'SMS_UNAVAILABLE' => l10n.errorSmsUnavailable,
    'ACCOUNT_RESTRICTED' => l10n.errorAccountRestricted,
    _ => failureMessage(l10n, failure),
  };
}

/// Maps a server field error code to text, or null for codes shown as a general error.
String? fieldErrorMessage(AppLocalizations l10n, String code) => switch (code) {
  'MIN_LENGTH' => l10n.passwordTooShort,
  'PASSWORD_TOO_COMMON' => l10n.passwordTooCommon,
  'PASSWORD_CONTAINS_PHONE' => l10n.passwordContainsPhone,
  'PASSWORD_REPETITIVE' => l10n.passwordRepetitive,
  'INCORRECT' => l10n.passwordIncorrect,
  'IS_ETHIOPIAN_MOBILE' => l10n.phoneInvalid,
  'MATCHES' => l10n.codeInvalidFormat,
  _ => null,
};

/// Server field error for [field], if the failure carries one we can explain.
String? serverFieldError(AppLocalizations l10n, ApiFailure? failure, String field) {
  if (failure is! ValidationFailure) return null;
  for (final error in failure.fieldErrors) {
    if (error.field == field) return fieldErrorMessage(l10n, error.code);
  }
  return null;
}
