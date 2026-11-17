import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/auth_tokens.dart';
import '../../../core/auth/device_identity.dart';
import '../../../core/network/api_client.dart';

/// Result of `POST /auth/login`.
sealed class LoginResult {
  const LoginResult();
}

final class LoginAuthenticated extends LoginResult {
  const LoginAuthenticated(this.tokens);

  final AuthTokens tokens;
}

/// Signing in from a new device: the server sent an SMS code.
final class LoginOtpRequired extends LoginResult {
  const LoginOtpRequired({required this.loginTicket, required this.expiresAt});

  /// Held in memory only, never in the URL or storage.
  final String loginTicket;
  final DateTime expiresAt;
}

/// Customer authentication endpoints (`/api/v1/auth/*`).
abstract interface class AuthApi {
  Future<void> requestRegistrationCode({required String phone, required String locale});

  Future<void> register({
    required String phone,
    required String otp,
    required String password,
    required String displayName,
    required String locale,
    required DeviceDescriptor device,
    required String idempotencyKey,
  });

  Future<LoginResult> login({
    required String phone,
    required String password,
    required DeviceDescriptor device,
  });

  Future<AuthTokens> verifyLogin({
    required String loginTicket,
    required String otp,
    required DeviceDescriptor device,
  });

  Future<AuthTokens> refresh(String refreshToken);

  Future<void> logout(String refreshToken);

  Future<void> requestPasswordReset({required String phone, required String locale});

  Future<void> confirmPasswordReset({
    required String phone,
    required String otp,
    required String newPassword,
    required DeviceDescriptor device,
  });
}

final class HttpAuthApi implements AuthApi {
  const HttpAuthApi(this._client);

  final ApiClient _client;

  static void _ignore(Object? _) {}

  static AuthTokens _tokens(Object? data) =>
      AuthTokens.fromJson((data! as Map).cast<String, Object?>());

  @override
  Future<void> requestRegistrationCode({required String phone, required String locale}) =>
      _client.post('/auth/otp', body: {'phone': phone, 'locale': locale}, decode: _ignore);

  @override
  Future<void> register({
    required String phone,
    required String otp,
    required String password,
    required String displayName,
    required String locale,
    required DeviceDescriptor device,
    required String idempotencyKey,
  }) => _client.post(
    '/auth/register',
    body: {
      'phone': phone,
      'otp': otp,
      'password': password,
      'displayName': displayName,
      'preferredLocale': locale,
      'device': device.toJson(),
    },
    idempotencyKey: idempotencyKey,
    decode: _ignore,
  );

  @override
  Future<LoginResult> login({
    required String phone,
    required String password,
    required DeviceDescriptor device,
  }) => _client.post(
    '/auth/login',
    body: {'phone': phone, 'password': password, 'device': device.toJson()},
    decode: (data) {
      final map = (data! as Map).cast<String, Object?>();
      if (map['result'] == 'OTP_REQUIRED') {
        return LoginOtpRequired(
          loginTicket: map['loginTicket']! as String,
          expiresAt: DateTime.parse(map['otpExpiresAt']! as String),
        );
      }
      return LoginAuthenticated(AuthTokens.fromJson(map));
    },
  );

  @override
  Future<AuthTokens> verifyLogin({
    required String loginTicket,
    required String otp,
    required DeviceDescriptor device,
  }) => _client.post(
    '/auth/login/verify',
    body: {'loginTicket': loginTicket, 'otp': otp, 'device': device.toJson()},
    decode: _tokens,
  );

  /// Never retried automatically: a rotated token must not be presented twice by us.
  @override
  Future<AuthTokens> refresh(String refreshToken) => _client.post(
    '/auth/refresh',
    body: {'refreshToken': refreshToken},
    decode: _tokens,
    noRetry: true,
  );

  @override
  Future<void> logout(String refreshToken) => _client.post(
    '/auth/logout',
    body: {'refreshToken': refreshToken},
    decode: _ignore,
    noRetry: true,
  );

  @override
  Future<void> requestPasswordReset({required String phone, required String locale}) =>
      _client.post(
        '/auth/password/reset/request',
        body: {'phone': phone, 'locale': locale},
        decode: _ignore,
      );

  @override
  Future<void> confirmPasswordReset({
    required String phone,
    required String otp,
    required String newPassword,
    required DeviceDescriptor device,
  }) => _client.post(
    '/auth/password/reset/confirm',
    body: {'phone': phone, 'otp': otp, 'newPassword': newPassword, 'device': device.toJson()},
    decode: _ignore,
  );
}

final authApiProvider = Provider<AuthApi>((ref) => HttpAuthApi(ref.watch(publicApiClientProvider)));
