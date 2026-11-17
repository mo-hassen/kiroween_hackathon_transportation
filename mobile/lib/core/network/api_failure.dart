import 'package:dio/dio.dart';

/// A failed API call, classified for the UI. Raw server messages are never shown;
/// screens map these to localized text (see `failureMessage`).
sealed class ApiFailure implements Exception {
  const ApiFailure({this.code, this.requestId});

  /// Stable machine code from the problem-details body (e.g. `LISTING_NOT_AVAILABLE`).
  final String? code;

  /// Server request id, shown as a support reference.
  final String? requestId;

  /// True when the device could not reach the server; cached data may be shown.
  bool get isConnectivity => false;

  /// Converts any error into an [ApiFailure].
  static ApiFailure from(Object error) => switch (error) {
    final ApiFailure failure => failure,
    final DioException exception => fromDioException(exception),
    _ => const UnknownFailure(),
  };

  static ApiFailure fromDioException(DioException exception) {
    switch (exception.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.transformTimeout:
        return const TimeoutFailure();
      case DioExceptionType.connectionError:
        return const NetworkFailure();
      case DioExceptionType.badCertificate:
        // Never retried or bypassed; treated as a connectivity problem for the user.
        return const NetworkFailure();
      case DioExceptionType.cancel:
        return const CancelledFailure();
      case DioExceptionType.badResponse:
        return _fromResponse(exception.response);
      case DioExceptionType.unknown:
        return const UnknownFailure();
    }
  }

  static ApiFailure _fromResponse(Response<Object?>? response) {
    final status = response?.statusCode ?? 0;
    final problem = ProblemDetails.tryParse(response?.data);
    final requestId = problem?.requestId ?? response?.headers.value('x-request-id');
    final code = problem?.code;
    return switch (status) {
      400 || 422 when problem?.errors.isNotEmpty ?? false => ValidationFailure(
        fieldErrors: problem!.errors,
        code: code,
        requestId: requestId,
      ),
      401 => UnauthorizedFailure(code: code, requestId: requestId),
      403 => ForbiddenFailure(code: code, requestId: requestId),
      404 => NotFoundFailure(code: code, requestId: requestId),
      409 => ConflictFailure(code: code, requestId: requestId),
      429 => RateLimitedFailure(
        retryAfter: _parseRetryAfter(response?.headers.value('retry-after')),
        code: code,
        requestId: requestId,
      ),
      >= 400 && < 500 => ValidationFailure(fieldErrors: const [], code: code, requestId: requestId),
      _ => ServerFailure(code: code, requestId: requestId),
    };
  }

  static Duration? _parseRetryAfter(String? value) {
    final seconds = int.tryParse(value ?? '');
    return seconds == null || seconds < 0 ? null : Duration(seconds: seconds);
  }
}

final class NetworkFailure extends ApiFailure {
  const NetworkFailure();

  @override
  bool get isConnectivity => true;
}

final class TimeoutFailure extends ApiFailure {
  const TimeoutFailure();

  @override
  bool get isConnectivity => true;
}

final class CancelledFailure extends ApiFailure {
  const CancelledFailure();
}

final class UnauthorizedFailure extends ApiFailure {
  const UnauthorizedFailure({super.code, super.requestId});
}

final class ForbiddenFailure extends ApiFailure {
  const ForbiddenFailure({super.code, super.requestId});
}

final class NotFoundFailure extends ApiFailure {
  const NotFoundFailure({super.code, super.requestId});
}

final class ConflictFailure extends ApiFailure {
  const ConflictFailure({super.code, super.requestId});
}

final class ValidationFailure extends ApiFailure {
  const ValidationFailure({required this.fieldErrors, super.code, super.requestId});

  final List<FieldError> fieldErrors;
}

final class RateLimitedFailure extends ApiFailure {
  const RateLimitedFailure({this.retryAfter, super.code, super.requestId});

  final Duration? retryAfter;
}

final class ServerFailure extends ApiFailure {
  const ServerFailure({super.code, super.requestId});
}

final class UnknownFailure extends ApiFailure {
  const UnknownFailure();
}

/// One invalid field reported by the server.
final class FieldError {
  const FieldError({required this.field, required this.code});

  final String field;
  final String code;

  @override
  bool operator ==(Object other) =>
      other is FieldError && other.field == field && other.code == code;

  @override
  int get hashCode => Object.hash(field, code);
}

/// RFC 9457 problem-details body returned by the API on every error.
final class ProblemDetails {
  const ProblemDetails({
    required this.code,
    required this.status,
    this.requestId,
    this.errors = const [],
  });

  final String code;
  final int status;
  final String? requestId;
  final List<FieldError> errors;

  static ProblemDetails? tryParse(Object? body) {
    if (body is! Map) return null;
    final code = body['code'];
    final status = body['status'];
    if (code is! String || status is! int) return null;
    final requestId = body['requestId'];
    final rawErrors = body['errors'];
    final errors = <FieldError>[
      if (rawErrors is List)
        for (final item in rawErrors)
          if (item is Map && item['field'] is String && item['code'] is String)
            FieldError(field: item['field'] as String, code: item['code'] as String),
    ];
    return ProblemDetails(
      code: code,
      status: status,
      requestId: requestId is String ? requestId : null,
      errors: errors,
    );
  }
}
