import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mobility/core/config/app_config.dart';
import 'package:mobility/core/network/api_client.dart';
import 'package:mobility/core/network/api_failure.dart';
import 'package:mobility/core/network/interceptors.dart';

import '../../helpers/fake_http_adapter.dart';

final _config = AppConfig.parse(environment: 'development', apiBaseUrl: 'http://10.0.2.2:3000');

/// Dio wired like production but with instant retry delays.
({Dio dio, FakeHttpAdapter adapter}) _dioWith(List<FakeHandler> handlers) {
  final adapter = FakeHttpAdapter(handlers);
  final dio = Dio(BaseOptions(baseUrl: _config.apiRoot))..httpClientAdapter = adapter;
  dio.interceptors.addAll([
    RequestIdInterceptor(),
    RetryInterceptor(dio: dio, sleep: (_) async {}),
  ]);
  return (dio: dio, adapter: adapter);
}

void main() {
  group('createDio', () {
    test('targets the versioned API root with mobile-friendly timeouts', () {
      final dio = createDio(_config);
      expect(dio.options.baseUrl, 'http://10.0.2.2:3000/api/v1');
      expect(dio.options.connectTimeout, const Duration(seconds: 10));
      expect(dio.options.receiveTimeout, const Duration(seconds: 20));
    });
  });

  group('RequestIdInterceptor', () {
    test('adds a unique X-Request-Id to every request', () async {
      final (:dio, :adapter) = _dioWith([
        respond({'data': 1}, 200),
        respond({'data': 2}, 200),
      ]);
      await dio.get<Object?>('/a');
      await dio.get<Object?>('/b');
      final ids = adapter.requests.map((r) => r.headers[requestIdHeader]).toList();
      expect(ids.every((id) => id is String && id.length == 36), isTrue);
      expect(ids.toSet(), hasLength(2));
    });
  });

  group('RetryInterceptor', () {
    test('retries a GET after a connection error and succeeds', () async {
      final (:dio, :adapter) = _dioWith([
        connectionError(),
        respond({'data': 'ok'}, 200),
      ]);
      final response = await dio.get<Object?>('/health/live');
      expect(response.statusCode, 200);
      expect(adapter.requests, hasLength(2));
    });

    test('retries 503 at most twice', () async {
      final (:dio, :adapter) = _dioWith([
        respond(problem('SERVICE_UNAVAILABLE', 503), 503),
        respond(problem('SERVICE_UNAVAILABLE', 503), 503),
        respond(problem('SERVICE_UNAVAILABLE', 503), 503),
      ]);
      await expectLater(dio.get<Object?>('/x'), throwsA(isA<DioException>()));
      expect(adapter.requests, hasLength(3));
    });

    test('does not retry a POST without an idempotency key', () async {
      final (:dio, :adapter) = _dioWith([connectionError()]);
      await expectLater(dio.post<Object?>('/x', data: {}), throwsA(isA<DioException>()));
      expect(adapter.requests, hasLength(1));
    });

    test('retries a POST that carries an idempotency key, reusing the same key', () async {
      final (:dio, :adapter) = _dioWith([
        connectionError(),
        respond({'data': 1}, 201),
      ]);
      await dio.post<Object?>(
        '/x',
        data: {},
        options: Options(headers: {idempotencyKeyHeader: '00000000-0000-4000-8000-000000000001'}),
      );
      expect(adapter.requests.map((r) => r.headers[idempotencyKeyHeader]), [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000001',
      ]);
    });

    test('never retries requests flagged noRetry (payments, payouts)', () async {
      final (:dio, :adapter) = _dioWith([connectionError()]);
      await expectLater(
        dio.post<Object?>(
          '/charges/1/payments',
          data: {},
          options: Options(
            headers: {idempotencyKeyHeader: '00000000-0000-4000-8000-000000000001'},
            extra: {noRetryExtra: true},
          ),
        ),
        throwsA(isA<DioException>()),
      );
      expect(adapter.requests, hasLength(1));
    });

    test('does not retry client errors', () async {
      final (:dio, :adapter) = _dioWith([respond(problem('NOT_FOUND', 404), 404)]);
      await expectLater(dio.get<Object?>('/x'), throwsA(isA<DioException>()));
      expect(adapter.requests, hasLength(1));
    });
  });

  group('ApiClient', () {
    ApiClient clientWith(List<FakeHandler> handlers) => ApiClient(_dioWith(handlers).dio);

    test('unwraps the data envelope', () async {
      final client = clientWith([
        respond({
          'data': {'status': 'ok'},
        }, 200),
      ]);
      final result = await client.get('/health/live', decode: (data) => (data! as Map)['status']);
      expect(result, 'ok');
    });

    test('treats a response without an envelope as unknown', () async {
      final client = clientWith([
        respond({'status': 'ok'}, 200),
      ]);
      await expectLater(client.get('/x', decode: (d) => d), throwsA(isA<UnknownFailure>()));
    });

    test('treats a decode error as unknown', () async {
      final client = clientWith([
        respond({'data': 'text'}, 200),
      ]);
      await expectLater(
        client.get('/x', decode: (d) => (d! as Map)['a']),
        throwsA(isA<UnknownFailure>()),
      );
    });

    test('maps problem details to typed failures with code and request id', () async {
      final client = clientWith([
        respond(problem('LISTING_NOT_AVAILABLE', 409, requestId: 'req-12345678'), 409),
      ]);
      await expectLater(
        client.get('/x', decode: (d) => d),
        throwsA(
          isA<ConflictFailure>()
              .having((f) => f.code, 'code', 'LISTING_NOT_AVAILABLE')
              .having((f) => f.requestId, 'requestId', 'req-12345678'),
        ),
      );
    });

    test('maps connectivity errors after retries to NetworkFailure', () async {
      final client = clientWith([connectionError(), connectionError(), connectionError()]);
      await expectLater(client.get('/x', decode: (d) => d), throwsA(isA<NetworkFailure>()));
    });
  });

  group('ApiFailure mapping', () {
    ApiFailure fromStatus(int status, Object? body, {Map<String, String> headers = const {}}) {
      final options = RequestOptions(path: '/x');
      return ApiFailure.fromDioException(
        DioException(
          requestOptions: options,
          type: DioExceptionType.badResponse,
          response: Response<Object?>(
            requestOptions: options,
            statusCode: status,
            data: body,
            headers: Headers.fromMap({
              for (final entry in headers.entries) entry.key: [entry.value],
            }),
          ),
        ),
      );
    }

    test('maps each status to its failure type', () {
      expect(fromStatus(401, problem('UNAUTHENTICATED', 401)), isA<UnauthorizedFailure>());
      expect(fromStatus(403, problem('FORBIDDEN', 403)), isA<ForbiddenFailure>());
      expect(fromStatus(404, problem('NOT_FOUND', 404)), isA<NotFoundFailure>());
      expect(fromStatus(500, problem('INTERNAL_ERROR', 500)), isA<ServerFailure>());
      expect(fromStatus(502, '<html>bad gateway</html>'), isA<ServerFailure>());
    });

    test('keeps field errors of validation failures', () {
      final failure = fromStatus(
        400,
        problem(
          'VALIDATION_FAILED',
          400,
          errors: [
            {'field': 'phone', 'code': 'INVALID'},
            {'field': 1, 'code': 'IGNORED'},
          ],
        ),
      );
      expect(
        failure,
        isA<ValidationFailure>().having((f) => f.fieldErrors, 'fieldErrors', [
          const FieldError(field: 'phone', code: 'INVALID'),
        ]),
      );
    });

    test('reads Retry-After for rate limiting', () {
      final failure = fromStatus(429, problem('RATE_LIMITED', 429), headers: {'retry-after': '30'});
      expect(
        failure,
        isA<RateLimitedFailure>().having(
          (f) => f.retryAfter,
          'retryAfter',
          const Duration(seconds: 30),
        ),
      );
    });

    test('falls back to the X-Request-Id header when the body has none', () {
      final failure = fromStatus(500, 'oops', headers: {'x-request-id': 'hdr-12345678'});
      expect(failure.requestId, 'hdr-12345678');
    });

    test('classifies transport errors', () {
      DioException of(DioExceptionType type) => DioException(
        requestOptions: RequestOptions(path: '/x'),
        type: type,
      );
      expect(ApiFailure.from(of(DioExceptionType.connectionTimeout)), isA<TimeoutFailure>());
      expect(ApiFailure.from(of(DioExceptionType.receiveTimeout)), isA<TimeoutFailure>());
      expect(ApiFailure.from(of(DioExceptionType.connectionError)), isA<NetworkFailure>());
      expect(ApiFailure.from(of(DioExceptionType.badCertificate)), isA<NetworkFailure>());
      expect(ApiFailure.from(of(DioExceptionType.cancel)), isA<CancelledFailure>());
      expect(ApiFailure.from(StateError('x')), isA<UnknownFailure>());
    });
  });
}
