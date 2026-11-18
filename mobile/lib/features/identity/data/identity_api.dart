import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/session_controller.dart';
import '../../../core/network/api_client.dart';

/// Account-level identity status (`users.identity_status` on the server).
enum IdentityStatus {
  unverified,
  pending,
  verified,
  rejected,
  suspended,
  expired,
  reverificationRequired,

  /// A value this app version does not know yet. Shown as "status unavailable".
  unknown;

  static IdentityStatus parse(Object? value) => switch (value) {
    'UNVERIFIED' => unverified,
    'PENDING' => pending,
    'VERIFIED' => verified,
    'REJECTED' => rejected,
    'SUSPENDED' => suspended,
    'EXPIRED' => expired,
    'REVERIFICATION_REQUIRED' => reverificationRequired,
    _ => unknown,
  };
}

/// One verification attempt.
enum AttemptStatus {
  pending,
  verified,
  rejected,
  failed,
  expired,
  cancelled,
  superseded,
  suspended,
  reverificationRequired,
  unknown;

  static AttemptStatus parse(Object? value) => switch (value) {
    'PENDING' => pending,
    'VERIFIED' => verified,
    'REJECTED' => rejected,
    'FAILED' => failed,
    'EXPIRED' => expired,
    'CANCELLED' => cancelled,
    'SUPERSEDED' => superseded,
    'SUSPENDED' => suspended,
    'REVERIFICATION_REQUIRED' => reverificationRequired,
    _ => unknown,
  };
}

DateTime? _date(Object? value) => value is String ? DateTime.parse(value) : null;

final class VerificationAttempt {
  const VerificationAttempt({
    required this.id,
    required this.status,
    required this.reason,
    required this.sessionExpiresAt,
    this.verifiedAt,
    this.validUntil,
  });

  factory VerificationAttempt.fromJson(Map<String, Object?> json) => VerificationAttempt(
    id: json['id']! as String,
    status: AttemptStatus.parse(json['status']),
    reason: json['reason'] as String?,
    sessionExpiresAt: DateTime.parse(json['sessionExpiresAt']! as String),
    verifiedAt: _date(json['verifiedAt']),
    validUntil: _date(json['validUntil']),
  );

  final String id;
  final AttemptStatus status;

  /// Coarse server reason, e.g. `DECLINED_AT_PROVIDER`. Never says why a rejection happened.
  final String? reason;
  final DateTime sessionExpiresAt;
  final DateTime? verifiedAt;
  final DateTime? validUntil;
}

/// `GET /identity/verifications/current`. The server decides [canStart]; the app does not
/// repeat the state machine.
final class IdentityOverview {
  const IdentityOverview({
    required this.status,
    required this.canStart,
    this.verifiedName,
    this.validUntil,
    this.latest,
  });

  factory IdentityOverview.fromJson(Map<String, Object?> json) {
    final latest = json['latest'];
    return IdentityOverview(
      status: IdentityStatus.parse(json['identityStatus']),
      canStart: json['canStart']! as bool,
      verifiedName: json['verifiedName'] as String?,
      validUntil: _date(json['validUntil']),
      latest: latest is Map ? VerificationAttempt.fromJson(latest.cast<String, Object?>()) : null,
    );
  }

  final IdentityStatus status;
  final bool canStart;
  final String? verifiedName;
  final DateTime? validUntil;
  final VerificationAttempt? latest;
}

final class StartedVerification {
  const StartedVerification({required this.attempt, required this.authorizationUrl});

  factory StartedVerification.fromJson(Map<String, Object?> json) {
    final url = json['authorizationUrl'];
    return StartedVerification(
      attempt: VerificationAttempt.fromJson((json['verification']! as Map).cast<String, Object?>()),
      authorizationUrl: url is String ? Uri.parse(url) : null,
    );
  }

  final VerificationAttempt attempt;

  /// Provider page to open in the system browser; null if the attempt already ended.
  final Uri? authorizationUrl;
}

abstract interface class IdentityApi {
  Future<IdentityOverview> overview();

  /// [idempotencyKey] is reused when the same tap is retried after a network error.
  Future<StartedVerification> start({required String locale, required String idempotencyKey});

  Future<VerificationAttempt> cancel(String verificationId);

  /// Completes an attempt with the one-time token from the browser return link. Only the
  /// session that started the attempt can do this (the server enforces it).
  Future<VerificationAttempt> confirm(String verificationId, String confirmation);
}

final class HttpIdentityApi implements IdentityApi {
  const HttpIdentityApi(this._client);

  final ApiClient _client;

  @override
  Future<IdentityOverview> overview() => _client.get(
    '/identity/verifications/current',
    decode: (data) => IdentityOverview.fromJson((data! as Map).cast<String, Object?>()),
  );

  @override
  Future<StartedVerification> start({required String locale, required String idempotencyKey}) =>
      _client.post(
        '/identity/verifications',
        body: {'consent': true, 'locale': locale},
        idempotencyKey: idempotencyKey,
        decode: (data) => StartedVerification.fromJson((data! as Map).cast<String, Object?>()),
      );

  @override
  Future<VerificationAttempt> confirm(String verificationId, String confirmation) => _client.post(
    '/identity/verifications/${Uri.encodeComponent(verificationId)}/confirm',
    body: {'confirmation': confirmation},
    decode: (data) => VerificationAttempt.fromJson((data! as Map).cast<String, Object?>()),
  );

  @override
  Future<VerificationAttempt> cancel(String verificationId) => _client.post(
    '/identity/verifications/${Uri.encodeComponent(verificationId)}/cancel',
    decode: (data) => VerificationAttempt.fromJson((data! as Map).cast<String, Object?>()),
  );
}

final identityApiProvider = Provider<IdentityApi>(
  (ref) => HttpIdentityApi(ref.watch(apiClientProvider)),
);

final identityOverviewProvider = FutureProvider.autoDispose<IdentityOverview>(
  (ref) => ref.watch(identityApiProvider).overview(),
);
