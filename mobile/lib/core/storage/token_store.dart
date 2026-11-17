import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Persists the refresh token only. Access tokens live in memory and are never
/// written to disk (docs/architecture/07-security-architecture.md §1).
abstract interface class TokenStore {
  Future<String?> readRefreshToken();
  Future<void> writeRefreshToken(String token);
  Future<void> clear();
}

/// Android Keystore / iOS Keychain backed storage.
final class SecureTokenStore implements TokenStore {
  SecureTokenStore([FlutterSecureStorage? storage])
    : _storage =
          storage ??
          const FlutterSecureStorage(
            iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device),
          );

  static const _refreshTokenKey = 'auth.refresh_token';

  final FlutterSecureStorage _storage;

  @override
  Future<String?> readRefreshToken() => _storage.read(key: _refreshTokenKey);

  @override
  Future<void> writeRefreshToken(String token) {
    if (token.isEmpty) {
      throw ArgumentError.value(token, 'token', 'must not be empty');
    }
    return _storage.write(key: _refreshTokenKey, value: token);
  }

  @override
  Future<void> clear() => _storage.delete(key: _refreshTokenKey);
}

final tokenStoreProvider = Provider<TokenStore>((ref) => SecureTokenStore());
