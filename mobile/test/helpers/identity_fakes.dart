import 'package:mobility/features/identity/application/identity_flow.dart';
import 'package:mobility/features/identity/data/identity_api.dart';

final _future = DateTime.utc(2030);

VerificationAttempt attempt(
  String id,
  AttemptStatus status, {
  String? reason,
  DateTime? verifiedAt,
  DateTime? validUntil,
}) => VerificationAttempt(
  id: id,
  status: status,
  reason: reason,
  sessionExpiresAt: _future,
  verifiedAt: verifiedAt,
  validUntil: validUntil,
);

IdentityOverview identityState(
  IdentityStatus status, {
  bool? canStart,
  VerificationAttempt? latest,
  String? verifiedName,
  DateTime? validUntil,
}) => IdentityOverview(
  status: status,
  canStart:
      canStart ??
      switch (status) {
        IdentityStatus.unverified ||
        IdentityStatus.pending ||
        IdentityStatus.rejected ||
        IdentityStatus.expired ||
        IdentityStatus.reverificationRequired => true,
        _ => false,
      },
  latest: latest,
  verifiedName: verifiedName,
  validUntil: validUntil,
);

/// Scripted identity API. Every call is recorded.
final class FakeIdentityApi implements IdentityApi {
  IdentityOverview current = identityState(IdentityStatus.unverified);
  IdentityOverview? afterStart = identityState(
    IdentityStatus.pending,
    latest: attempt('v-new', AttemptStatus.pending),
  );
  IdentityOverview? afterCancel = identityState(
    IdentityStatus.unverified,
    latest: attempt('v-new', AttemptStatus.cancelled, reason: 'CANCELLED'),
  );
  Uri? authorizationUrl = Uri.parse('https://id.example.et/authorize?state=abc');
  Object? overviewFailure;
  Object? startFailure;
  Object? confirmFailure;
  IdentityOverview? afterConfirm = identityState(
    IdentityStatus.verified,
    verifiedName: 'Abebe Bikila',
    validUntil: DateTime.utc(2028, 11, 17),
    latest: attempt('v-new', AttemptStatus.verified),
  );
  int overviewCalls = 0;
  final calls = <String>[];
  final idempotencyKeys = <String>[];

  @override
  Future<IdentityOverview> overview() async {
    overviewCalls++;
    final failure = overviewFailure;
    if (failure != null) throw failure;
    return current;
  }

  @override
  Future<StartedVerification> start({
    required String locale,
    required String idempotencyKey,
  }) async {
    calls.add('start:$locale');
    idempotencyKeys.add(idempotencyKey);
    final failure = startFailure;
    if (failure != null) throw failure;
    if (afterStart != null) current = afterStart!;
    return StartedVerification(
      attempt: attempt('v-new', AttemptStatus.pending),
      authorizationUrl: authorizationUrl,
    );
  }

  @override
  Future<VerificationAttempt> confirm(String verificationId, String confirmation) async {
    calls.add('confirm:$verificationId:$confirmation');
    final failure = confirmFailure;
    if (failure != null) throw failure;
    if (afterConfirm != null) current = afterConfirm!;
    return attempt(verificationId, AttemptStatus.verified);
  }

  @override
  Future<VerificationAttempt> cancel(String verificationId) async {
    calls.add('cancel:$verificationId');
    if (afterCancel != null) current = afterCancel!;
    return attempt(verificationId, AttemptStatus.cancelled, reason: 'CANCELLED');
  }
}

final class FakeIdentityLauncher implements IdentityLauncher {
  final opened = <Uri>[];
  bool succeeds = true;

  @override
  Future<bool> open(Uri url) async {
    opened.add(url);
    return succeeds;
  }
}
