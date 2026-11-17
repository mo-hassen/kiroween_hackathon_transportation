import '../network/api_failure.dart';
import '../storage/token_store.dart';
import 'auth_tokens.dart';

/// Calls `POST /auth/refresh`. Throws [ApiFailure] on failure.
typedef RefreshTransport = Future<AuthTokens> Function(String refreshToken);

enum RefreshOutcome {
  /// New tokens are in place.
  refreshed,

  /// The server rejected the refresh token: the session is over.
  signedOut,

  /// The server could not be reached; the stored refresh token is kept.
  unreachable,
}

/// Holds the access token in memory and the rotating refresh token in secure storage
/// (docs/architecture/07-security-architecture.md §1).
///
/// Refreshes are single-flight: concurrent callers share one request, so the rotating
/// refresh token is never presented twice (which the server treats as theft).
class TokenManager {
  TokenManager({required this.store, required this.transport});

  final TokenStore store;
  final RefreshTransport transport;
  AuthTokens? _current;
  Future<RefreshOutcome>? _inFlight;

  String? get accessToken => _current?.accessToken;
  String? get sessionId => _current?.sessionId;

  /// Stores new tokens. The refresh token is persisted BEFORE the new access token is
  /// used, so a crash cannot leave the app holding only a rotated-out token.
  Future<void> adopt(AuthTokens tokens) async {
    await store.writeRefreshToken(tokens.refreshToken);
    _current = tokens;
  }

  Future<String?> storedRefreshToken() => store.readRefreshToken();

  Future<RefreshOutcome> refresh() =>
      _inFlight ??= _doRefresh().whenComplete(() => _inFlight = null);

  Future<RefreshOutcome> _doRefresh() async {
    final stored = await store.readRefreshToken();
    if (stored == null) {
      _current = null;
      return RefreshOutcome.signedOut;
    }
    try {
      await adopt(await transport(stored));
      return RefreshOutcome.refreshed;
    } on UnauthorizedFailure {
      await clear();
      return RefreshOutcome.signedOut;
    } on ApiFailure catch (failure) {
      // Only a definite rejection ends the session; network trouble keeps it.
      if (failure.isConnectivity || failure is ServerFailure || failure is RateLimitedFailure) {
        return RefreshOutcome.unreachable;
      }
      await clear();
      return RefreshOutcome.signedOut;
    }
  }

  Future<void> clear() async {
    _current = null;
    await store.clear();
  }
}
