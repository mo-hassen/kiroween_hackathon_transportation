import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/session_controller.dart';
import '../../../core/network/api_client.dart';
import '../../identity/data/identity_api.dart';

/// The signed-in user's account (`GET /me`).
final class AccountProfile {
  const AccountProfile({
    required this.id,
    required this.phone,
    required this.displayName,
    required this.preferredLocale,
    required this.status,
    required this.version,
    this.identityStatus = IdentityStatus.unverified,
  });

  factory AccountProfile.fromJson(Map<String, Object?> json) => AccountProfile(
    id: json['id']! as String,
    phone: json['phone']! as String,
    displayName: json['displayName'] as String?,
    preferredLocale: json['preferredLocale']! as String,
    status: json['status']! as String,
    version: json['version']! as int,
    identityStatus: IdentityStatus.parse(json['identityStatus']),
  );

  final String id;
  final String phone;
  final String? displayName;
  final String preferredLocale;

  /// ACTIVE, or SUSPENDED/LOCKED (read-only, BR-ACC-3).
  final String status;

  /// Sent as If-Match on updates.
  final int version;

  /// Server-managed; changed only by the identity verification flow.
  final IdentityStatus identityStatus;

  bool get isRestricted => status == 'SUSPENDED' || status == 'LOCKED';
}

final class SessionSummary {
  const SessionSummary({
    required this.id,
    required this.current,
    required this.platform,
    required this.appVersion,
    required this.lastUsedAt,
  });

  factory SessionSummary.fromJson(Map<String, Object?> json) {
    final device = (json['device'] as Map?)?.cast<String, Object?>();
    return SessionSummary(
      id: json['id']! as String,
      current: json['current']! as bool,
      platform: device?['platform'] as String?,
      appVersion: device?['appVersion'] as String?,
      lastUsedAt: DateTime.parse(json['lastUsedAt']! as String),
    );
  }

  final String id;
  final bool current;
  final String? platform;
  final String? appVersion;
  final DateTime lastUsedAt;
}

abstract interface class AccountApi {
  Future<AccountProfile> me();
  Future<AccountProfile> update({
    required int version,
    String? displayName,
    String? preferredLocale,
  });
  Future<List<SessionSummary>> sessions();
  Future<void> revokeSession(String sessionId);
  Future<void> changePassword({required String currentPassword, required String newPassword});
}

final class HttpAccountApi implements AccountApi {
  const HttpAccountApi(this._client);

  final ApiClient _client;

  static AccountProfile _profile(Object? data) =>
      AccountProfile.fromJson((data! as Map).cast<String, Object?>());

  @override
  Future<AccountProfile> me() => _client.get('/me', decode: _profile);

  @override
  Future<AccountProfile> update({
    required int version,
    String? displayName,
    String? preferredLocale,
  }) => _client.patch(
    '/me',
    body: {'displayName': ?displayName, 'preferredLocale': ?preferredLocale},
    headers: {'If-Match': '$version'},
    decode: _profile,
  );

  @override
  Future<List<SessionSummary>> sessions() => _client.get(
    '/me/sessions',
    decode: (data) => [
      for (final item in data! as List)
        SessionSummary.fromJson((item as Map).cast<String, Object?>()),
    ],
  );

  @override
  Future<void> revokeSession(String sessionId) =>
      _client.delete('/me/sessions/${Uri.encodeComponent(sessionId)}');

  @override
  Future<void> changePassword({required String currentPassword, required String newPassword}) =>
      _client.post(
        '/me/password',
        body: {'currentPassword': currentPassword, 'newPassword': newPassword},
        decode: (_) {},
      );
}

final accountApiProvider = Provider<AccountApi>(
  (ref) => HttpAccountApi(ref.watch(apiClientProvider)),
);

final accountProfileProvider = FutureProvider.autoDispose<AccountProfile>(
  (ref) => ref.watch(accountApiProvider).me(),
);

final accountSessionsProvider = FutureProvider.autoDispose<List<SessionSummary>>(
  (ref) => ref.watch(accountApiProvider).sessions(),
);
