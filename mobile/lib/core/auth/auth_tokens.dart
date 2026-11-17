/// Tokens returned by login, step-up verification and refresh.
///
/// Only [refreshToken] is persisted (secure storage). The access token lives in memory.
final class AuthTokens {
  const AuthTokens({
    required this.accessToken,
    required this.accessTokenExpiresAt,
    required this.refreshToken,
    required this.refreshTokenExpiresAt,
    required this.sessionId,
  });

  factory AuthTokens.fromJson(Map<String, Object?> json) {
    final access = json['accessToken'];
    final refresh = json['refreshToken'];
    final session = json['sessionId'];
    final accessExpiry = DateTime.tryParse(json['accessTokenExpiresAt'] as String? ?? '');
    final refreshExpiry = DateTime.tryParse(json['refreshTokenExpiresAt'] as String? ?? '');
    if (access is! String ||
        refresh is! String ||
        session is! String ||
        accessExpiry == null ||
        refreshExpiry == null) {
      throw const FormatException('Malformed token response');
    }
    return AuthTokens(
      accessToken: access,
      accessTokenExpiresAt: accessExpiry,
      refreshToken: refresh,
      refreshTokenExpiresAt: refreshExpiry,
      sessionId: session,
    );
  }

  final String accessToken;
  final DateTime accessTokenExpiresAt;
  final String refreshToken;
  final DateTime refreshTokenExpiresAt;
  final String sessionId;

  /// Never print tokens (logs, crash reports).
  @override
  String toString() => 'AuthTokens(session: $sessionId)';
}
