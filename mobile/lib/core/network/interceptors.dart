import 'package:dio/dio.dart';
import 'package:uuid/uuid.dart';

const requestIdHeader = 'X-Request-Id';
const idempotencyKeyHeader = 'Idempotency-Key';

/// `RequestOptions.extra` flag that forbids automatic retries for a request.
/// Payment and payout calls must set it (docs/architecture/06-flutter-architecture.md).
const noRetryExtra = 'noRetry';
const _attemptExtra = 'retryAttempt';

/// Adds a client request id so mobile logs and server logs can be correlated.
final class RequestIdInterceptor extends Interceptor {
  RequestIdInterceptor({Uuid? uuid}) : _uuid = uuid ?? const Uuid();

  final Uuid _uuid;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    options.headers.putIfAbsent(requestIdHeader, _uuid.v4);
    handler.next(options);
  }
}

/// Retries transient failures with backoff, but only for requests that are safe
/// to repeat: GET, or requests that carry an `Idempotency-Key` header. Requests
/// flagged with [noRetryExtra] are never retried.
final class RetryInterceptor extends Interceptor {
  RetryInterceptor({
    required this.dio,
    this.delays = const [Duration(milliseconds: 500), Duration(milliseconds: 1500)],
    Future<void> Function(Duration)? sleep,
  }) : _sleep = sleep ?? Future<void>.delayed;

  /// Client used to re-send the request (the same instance this is attached to).
  final Dio dio;
  final List<Duration> delays;
  final Future<void> Function(Duration) _sleep;

  static const _retryableStatuses = {502, 503, 504};

  static bool isSafeToRetry(RequestOptions options) {
    if (options.extra[noRetryExtra] == true) return false;
    return options.method.toUpperCase() == 'GET' ||
        options.headers.containsKey(idempotencyKeyHeader);
  }

  static bool isTransient(DioException error) => switch (error.type) {
    DioExceptionType.connectionError ||
    DioExceptionType.connectionTimeout ||
    DioExceptionType.receiveTimeout => true,
    DioExceptionType.badResponse => _retryableStatuses.contains(error.response?.statusCode),
    _ => false,
  };

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    final options = err.requestOptions;
    final attempt = (options.extra[_attemptExtra] as int?) ?? 0;
    if (attempt >= delays.length || !isSafeToRetry(options) || !isTransient(err)) {
      handler.next(err);
      return;
    }
    if (options.cancelToken?.isCancelled ?? false) {
      handler.next(err);
      return;
    }
    await _sleep(delays[attempt]);
    options.extra[_attemptExtra] = attempt + 1;
    try {
      handler.resolve(await dio.fetch<Object?>(options));
    } on DioException catch (retryError) {
      handler.next(retryError);
    }
  }
}
