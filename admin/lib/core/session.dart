import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import 'api.dart';
import 'config.dart';

/// Permissions for the review areas (backend: drivers.review, owners.review, vehicles.verify). Navigation only:
/// the API checks the permission on every call.
const driversReviewPermission = 'drivers.review';
const ownersReviewPermission = 'owners.review';
const vehiclesVerifyPermission = 'vehicles.verify';

final class StaffProfile {
  const StaffProfile({required this.displayName, required this.roles, required this.permissions});

  factory StaffProfile.fromJson(Map<String, Object?> json) => StaffProfile(
    displayName: json['displayName'] as String?,
    roles: [for (final role in json['roles']! as List) role as String],
    permissions: [for (final p in (json['permissions'] as List?) ?? const []) p as String],
  );

  final String? displayName;
  final List<String> roles;

  /// For navigation only. The API checks the permission on every call.
  final List<String> permissions;

  bool get canReviewDrivers => permissions.contains(driversReviewPermission);
  bool get canReviewOwners => permissions.contains(ownersReviewPermission);
  bool get canReviewVehicles => permissions.contains(vehiclesVerifyPermission);
  bool get canReviewAnything => canReviewDrivers || canReviewOwners || canReviewVehicles;
}

sealed class StaffSession {
  const StaffSession();
}

final class SignedOut extends StaffSession {
  const SignedOut({this.expired = false});
  final bool expired;
}

final class SignedIn extends StaffSession {
  const SignedIn(this.profile);
  final StaffProfile profile;
}

/// Staff tokens. Kept in memory only: nothing is written to browser storage, so a reload
/// or a closed tab requires password + TOTP again (staff sessions are short anyway).
final class TokenHolder {
  String? accessToken;
  String? refreshToken;

  void clear() {
    accessToken = null;
    refreshToken = null;
  }
}

/// The calls that do not need a session (staff login, refresh, logout).
abstract interface class StaffAuthApi {
  Future<({String accessToken, String refreshToken})> login({
    required String phone,
    required String password,
    required String totpCode,
    required String installationId,
  });

  Future<({String accessToken, String refreshToken})> refresh(String refreshToken);

  Future<void> logout(String refreshToken);

  /// `GET /me` with the given access token.
  Future<Map<String, Object?>> me(String accessToken);
}

final class HttpStaffAuthApi implements StaffAuthApi {
  HttpStaffAuthApi(this._dio);

  final Dio _dio;

  ({String accessToken, String refreshToken}) _pair(Object? data) {
    final map = asMap(data);
    return (
      accessToken: map['accessToken']! as String,
      refreshToken: map['refreshToken']! as String,
    );
  }

  @override
  Future<({String accessToken, String refreshToken})> login({
    required String phone,
    required String password,
    required String totpCode,
    required String installationId,
  }) => ApiClient(_dio).post(
    '/auth/staff/login',
    _pair,
    body: {
      'phone': phone,
      'password': password,
      'totpCode': totpCode,
      'device': {'installationId': installationId, 'platform': 'WEB', 'appVersion': '0.1.0'},
    },
  );

  @override
  Future<({String accessToken, String refreshToken})> refresh(String refreshToken) =>
      ApiClient(_dio).post('/auth/refresh', _pair, body: {'refreshToken': refreshToken});

  @override
  Future<void> logout(String refreshToken) =>
      ApiClient(_dio).post('/auth/logout', (_) {}, body: {'refreshToken': refreshToken});

  @override
  Future<Map<String, Object?>> me(String accessToken) async {
    try {
      final response = await _dio.get<Object?>(
        '/me',
        options: Options(headers: {'Authorization': 'Bearer $accessToken'}),
      );
      return asMap(asMap(response.data)['data']);
    } on DioException catch (error) {
      throw ApiFailure.from(error);
    }
  }
}

Dio _baseDio(AdminConfig config) => Dio(
  BaseOptions(
    baseUrl: config.apiRoot,
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 20),
    headers: {'Accept': 'application/json'},
  ),
);

final publicDioProvider = Provider<Dio>((ref) {
  final dio = _baseDio(ref.watch(adminConfigProvider));
  ref.onDispose(dio.close);
  return dio;
});

final staffAuthApiProvider = Provider<StaffAuthApi>(
  (ref) => HttpStaffAuthApi(ref.watch(publicDioProvider)),
);

final tokenHolderProvider = Provider<TokenHolder>((ref) => TokenHolder());

class StaffSessionController extends Notifier<StaffSession> {
  // A random id per page load: staff devices are not trusted (TOTP is needed every time).
  final String _installationId = const Uuid().v4();
  Future<bool>? _refreshing;

  @override
  StaffSession build() => const SignedOut();

  TokenHolder get _tokens => ref.read(tokenHolderProvider);
  StaffAuthApi get _api => ref.read(staffAuthApiProvider);

  /// Staff login (password + TOTP). Customer accounts are refused here and by the API.
  Future<void> signIn({
    required String phone,
    required String password,
    required String totpCode,
  }) async {
    final pair = await _api.login(
      phone: phone,
      password: password,
      totpCode: totpCode,
      installationId: _installationId,
    );
    final me = await _api.me(pair.accessToken);
    if (me['accountType'] != 'STAFF') {
      unawaited(_api.logout(pair.refreshToken).catchError((_) {}));
      throw const ApiFailure(FailureKind.forbidden, code: 'NOT_STAFF');
    }
    _tokens
      ..accessToken = pair.accessToken
      ..refreshToken = pair.refreshToken;
    state = SignedIn(StaffProfile.fromJson(me));
  }

  /// One refresh at a time; concurrent 401s wait for the same result.
  Future<bool> refresh() => _refreshing ??= _doRefresh().whenComplete(() => _refreshing = null);

  Future<bool> _doRefresh() async {
    final refreshToken = _tokens.refreshToken;
    if (refreshToken == null) return false;
    try {
      final pair = await _api.refresh(refreshToken);
      _tokens
        ..accessToken = pair.accessToken
        ..refreshToken = pair.refreshToken;
      return true;
    } on ApiFailure catch (failure) {
      if (failure.kind == FailureKind.network) return false;
      expire();
      return false;
    }
  }

  void expire() {
    _tokens.clear();
    if (state is SignedIn) state = const SignedOut(expired: true);
  }

  Future<void> signOut() async {
    final refreshToken = _tokens.refreshToken;
    _tokens.clear();
    state = const SignedOut();
    if (refreshToken != null) {
      unawaited(_api.logout(refreshToken).timeout(const Duration(seconds: 10)).catchError((_) {}));
    }
  }
}

final staffSessionProvider = NotifierProvider<StaffSessionController, StaffSession>(
  StaffSessionController.new,
);

/// Adds the access token; on 401 refreshes once and repeats the request, else ends the session.
/// A plain (not queued) interceptor: a retried request that fails again must not wait behind
/// its own error handler. Concurrent refreshes are already merged by [StaffSessionController].
final class StaffAuthInterceptor extends Interceptor {
  StaffAuthInterceptor(this._ref, this._dio);

  final Ref _ref;
  final Dio _dio;
  static const _retried = 'staffAuthRetried';

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    final token = _ref.read(tokenHolderProvider).accessToken;
    if (token != null) options.headers['Authorization'] = 'Bearer $token';
    handler.next(options);
  }

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    if (err.response?.statusCode != 401 || err.requestOptions.extra[_retried] == true) {
      if (err.response?.statusCode == 401) _ref.read(staffSessionProvider.notifier).expire();
      handler.next(err);
      return;
    }
    final refreshed = await _ref.read(staffSessionProvider.notifier).refresh();
    if (!refreshed) {
      _ref.read(staffSessionProvider.notifier).expire();
      handler.next(err);
      return;
    }
    final options = err.requestOptions..extra[_retried] = true;
    options.headers['Authorization'] = 'Bearer ${_ref.read(tokenHolderProvider).accessToken}';
    try {
      handler.resolve(await _dio.fetch<Object?>(options));
    } on DioException catch (error) {
      handler.next(error);
    }
  }
}

final authedDioProvider = Provider<Dio>((ref) {
  final dio = _baseDio(ref.watch(adminConfigProvider));
  dio.interceptors.add(StaffAuthInterceptor(ref, dio));
  ref.onDispose(dio.close);
  return dio;
});

final apiClientProvider = Provider<ApiClient>((ref) => ApiClient(ref.watch(authedDioProvider)));
