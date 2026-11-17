import 'dart:async';

import 'package:mobility/core/auth/auth_tokens.dart';
import 'package:mobility/core/auth/device_identity.dart';
import 'package:mobility/core/network/api_failure.dart';
import 'package:mobility/core/storage/token_store.dart';
import 'package:mobility/features/account/data/account_api.dart';
import 'package:mobility/features/auth/data/auth_api.dart';

AuthTokens tokens(String suffix, {String session = 'session-1'}) => AuthTokens(
  accessToken: 'access-$suffix',
  accessTokenExpiresAt: DateTime.utc(2030),
  refreshToken: 'rt_refresh-$suffix',
  refreshTokenExpiresAt: DateTime.utc(2030),
  sessionId: session,
);

final class MemoryTokenStore implements TokenStore {
  MemoryTokenStore([this.value]);

  String? value;
  int writes = 0;

  @override
  Future<void> clear() async => value = null;

  @override
  Future<String?> readRefreshToken() async => value;

  @override
  Future<void> writeRefreshToken(String token) async {
    writes++;
    value = token;
  }
}

final class FixedInstallationId implements InstallationIdStore {
  @override
  Future<String> installationId() async => 'install-0000-test';
}

/// Records every call; each method's behaviour can be scripted per test.
final class FakeAuthApi implements AuthApi {
  final calls = <String>[];
  final idempotencyKeys = <String>[];
  Object? failWith;
  LoginResult loginResult = LoginAuthenticated(tokens('login'));
  FutureOr<AuthTokens> Function(String refreshToken) onRefresh = (_) => tokens('refreshed');

  Future<void> _maybeFail() async {
    final failure = failWith;
    if (failure != null) throw failure;
  }

  @override
  Future<void> requestRegistrationCode({required String phone, required String locale}) async {
    calls.add('otp:$phone:$locale');
    await _maybeFail();
  }

  @override
  Future<void> register({
    required String phone,
    required String otp,
    required String password,
    required String displayName,
    required String locale,
    required DeviceDescriptor device,
    required String idempotencyKey,
  }) async {
    calls.add('register:$phone:$otp:$displayName');
    idempotencyKeys.add(idempotencyKey);
    await _maybeFail();
  }

  @override
  Future<LoginResult> login({
    required String phone,
    required String password,
    required DeviceDescriptor device,
  }) async {
    calls.add('login:$phone:${device.installationId}');
    await _maybeFail();
    return loginResult;
  }

  @override
  Future<AuthTokens> verifyLogin({
    required String loginTicket,
    required String otp,
    required DeviceDescriptor device,
  }) async {
    calls.add('verify:$loginTicket:$otp');
    await _maybeFail();
    return tokens('verified');
  }

  @override
  Future<AuthTokens> refresh(String refreshToken) async {
    calls.add('refresh:$refreshToken');
    return onRefresh(refreshToken);
  }

  @override
  Future<void> logout(String refreshToken) async => calls.add('logout:$refreshToken');

  @override
  Future<void> requestPasswordReset({required String phone, required String locale}) async {
    calls.add('reset-request:$phone');
    await _maybeFail();
  }

  @override
  Future<void> confirmPasswordReset({
    required String phone,
    required String otp,
    required String newPassword,
    required DeviceDescriptor device,
  }) async {
    calls.add('reset-confirm:$phone:$otp');
    await _maybeFail();
  }
}

final class FakeAccountApi implements AccountApi {
  AccountProfile profile = const AccountProfile(
    id: 'user-1',
    phone: '+251911234567',
    displayName: 'Abebe Kebede',
    preferredLocale: 'en',
    status: 'ACTIVE',
    version: 3,
  );
  List<SessionSummary> sessionList = [
    SessionSummary(
      id: 's-current',
      current: true,
      platform: 'ANDROID',
      appVersion: '0.2.0',
      lastUsedAt: DateTime.utc(2026, 11, 17, 9),
    ),
    SessionSummary(
      id: 's-tablet',
      current: false,
      platform: 'IOS',
      appVersion: '0.2.0',
      lastUsedAt: DateTime.utc(2026, 11, 16, 18),
    ),
  ];
  final revoked = <String>[];
  final calls = <String>[];
  ApiFailure? changePasswordFailure;

  @override
  Future<AccountProfile> me() async => profile;

  @override
  Future<List<SessionSummary>> sessions() async =>
      sessionList.where((s) => !revoked.contains(s.id)).toList();

  @override
  Future<void> revokeSession(String sessionId) async => revoked.add(sessionId);

  @override
  Future<AccountProfile> update({
    required int version,
    String? displayName,
    String? preferredLocale,
  }) async {
    calls.add('update:$version:$displayName');
    return profile;
  }

  @override
  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    calls.add('password:$currentPassword');
    final failure = changePasswordFailure;
    if (failure != null) throw failure;
  }
}
