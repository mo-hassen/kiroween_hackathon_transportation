import 'package:dio/dio.dart';

/// A failed API call, classified for the UI. Server messages are never shown.
final class ApiFailure implements Exception {
  const ApiFailure(this.kind, {this.code, this.fieldCodes = const []});

  factory ApiFailure.from(Object error) {
    if (error is ApiFailure) return error;
    if (error is! DioException) return const ApiFailure(FailureKind.unknown);
    switch (error.type) {
      case DioExceptionType.connectionError:
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.sendTimeout:
        return const ApiFailure(FailureKind.network);
      case DioExceptionType.badResponse:
        final status = error.response?.statusCode ?? 0;
        final body = error.response?.data;
        final code = body is Map && body['code'] is String ? body['code'] as String : null;
        final errors = body is Map && body['errors'] is List
            ? body['errors'] as List
            : const <Object?>[];
        final fieldCodes = [
          for (final item in errors)
            if (item is Map && item['code'] is String) item['code'] as String,
        ];
        final kind = switch (status) {
          400 || 422 => FailureKind.validation,
          401 => FailureKind.unauthorized,
          403 => FailureKind.forbidden,
          404 => FailureKind.notFound,
          409 => FailureKind.conflict,
          429 => FailureKind.rateLimited,
          _ => FailureKind.server,
        };
        return ApiFailure(kind, code: code, fieldCodes: fieldCodes);
      default:
        return const ApiFailure(FailureKind.unknown);
    }
  }

  final FailureKind kind;

  /// Stable server code, e.g. `REVIEW_CLAIMED_BY_OTHER`.
  final String? code;
  final List<String> fieldCodes;
}

enum FailureKind {
  network,
  validation,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  rateLimited,
  server,
  unknown,
}

/// Unwraps the `{ "data": ... }` envelope and turns every error into an [ApiFailure].
final class ApiClient {
  const ApiClient(this._dio);

  final Dio _dio;

  Future<T> get<T>(String path, T Function(Object? data) decode, {Map<String, Object?>? query}) =>
      _send(() => _dio.get<Object?>(path, queryParameters: query), decode);

  Future<T> post<T>(
    String path,
    T Function(Object? data) decode, {
    Object? body,
    Map<String, String>? headers,
  }) => _send(
    () => _dio.post<Object?>(
      path,
      data: body,
      options: headers == null ? null : Options(headers: headers),
    ),
    decode,
  );

  Future<T> _send<T>(
    Future<Response<Object?>> Function() call,
    T Function(Object? data) decode,
  ) async {
    final Response<Object?> response;
    try {
      response = await call();
    } on DioException catch (error) {
      throw ApiFailure.from(error);
    }
    if (response.statusCode == 204) return decode(null);
    final body = response.data;
    if (body is! Map || !body.containsKey('data')) throw const ApiFailure(FailureKind.unknown);
    try {
      return decode(body['data']);
    } on Object {
      throw const ApiFailure(FailureKind.unknown);
    }
  }
}

Map<String, Object?> asMap(Object? value) => (value! as Map).cast<String, Object?>();
