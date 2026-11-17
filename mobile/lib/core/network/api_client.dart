import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/app_config.dart';
import 'api_failure.dart';
import 'interceptors.dart';

/// Timeouts sized for variable mobile networks in Addis Ababa.
const connectTimeout = Duration(seconds: 10);
const receiveTimeout = Duration(seconds: 20);
const sendTimeout = Duration(seconds: 60);

/// Builds a Dio instance with request ids and safe retries. The authenticated client adds
/// `AuthInterceptor` on top (see core/auth/auth_providers.dart).
Dio createDio(AppConfig config, {HttpClientAdapter? adapter, List<Interceptor> extra = const []}) {
  final dio = Dio(
    BaseOptions(
      baseUrl: config.apiRoot,
      connectTimeout: connectTimeout,
      receiveTimeout: receiveTimeout,
      sendTimeout: sendTimeout,
      responseType: ResponseType.json,
      headers: {'Accept': 'application/json'},
    ),
  );
  if (adapter != null) {
    dio.httpClientAdapter = adapter;
  }
  dio.interceptors.addAll([RequestIdInterceptor(), ...extra, RetryInterceptor(dio: dio)]);
  return dio;
}

/// Thin typed wrapper over Dio: unwraps the `{ "data": ... }` envelope and turns
/// every failure into an [ApiFailure].
final class ApiClient {
  const ApiClient(this._dio);

  final Dio _dio;

  Future<T> get<T>(
    String path, {
    required T Function(Object? data) decode,
    Map<String, Object?>? query,
    CancelToken? cancelToken,
  }) => _send(
    () => _dio.get<Object?>(path, queryParameters: query, cancelToken: cancelToken),
    decode,
  );

  /// [idempotencyKey] makes the request safe to retry (also automatically, by
  /// RetryInterceptor). [noRetry] forbids automatic retries entirely.
  Future<T> post<T>(
    String path, {
    Object? body,
    required T Function(Object? data) decode,
    String? idempotencyKey,
    bool noRetry = false,
  }) => _send(
    () =>
        _dio.post<Object?>(path, data: body, options: _options(idempotencyKey, noRetry, const {})),
    decode,
  );

  Future<T> patch<T>(
    String path, {
    Object? body,
    required T Function(Object? data) decode,
    Map<String, String> headers = const {},
  }) => _send(
    () => _dio.patch<Object?>(path, data: body, options: _options(null, false, headers)),
    decode,
  );

  Future<void> delete(String path) => _send(() => _dio.delete<Object?>(path), (_) {});

  Options _options(String? idempotencyKey, bool noRetry, Map<String, String> headers) => Options(
    headers: {...headers, idempotencyKeyHeader: ?idempotencyKey},
    extra: {if (noRetry) noRetryExtra: true},
  );

  Future<T> _send<T>(
    Future<Response<Object?>> Function() call,
    T Function(Object? data) decode,
  ) async {
    final Response<Object?> response;
    try {
      response = await call();
    } on DioException catch (error) {
      throw ApiFailure.fromDioException(error);
    }
    if (response.statusCode == 204) {
      return decode(null);
    }
    final body = response.data;
    if (body is! Map || !body.containsKey('data')) {
      throw const UnknownFailure();
    }
    try {
      return decode(body['data']);
    } on Object {
      // A response that does not match the expected shape is treated as unknown.
      throw const UnknownFailure();
    }
  }
}

/// Unauthenticated client: system status and the `/auth/*` endpoints.
final publicDioProvider = Provider<Dio>((ref) {
  final dio = createDio(ref.watch(appConfigProvider));
  ref.onDispose(dio.close);
  return dio;
});

final publicApiClientProvider = Provider<ApiClient>(
  (ref) => ApiClient(ref.watch(publicDioProvider)),
);
