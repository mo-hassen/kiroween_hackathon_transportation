import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

typedef FakeHandler = Object Function(RequestOptions options);

/// Scripted Dio transport. Each handler returns a [ResponseBody] or a
/// [DioException] to throw, in order.
final class FakeHttpAdapter implements HttpClientAdapter {
  FakeHttpAdapter(List<FakeHandler> handlers) : _handlers = [...handlers];

  final List<FakeHandler> _handlers;
  final List<RequestOptions> requests = [];

  /// Headers as they were when each request was sent (RequestOptions are mutable).
  final List<Map<String, Object?>> sentHeaders = [];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    sentHeaders.add(Map.of(options.headers));
    if (_handlers.isEmpty) {
      throw StateError('Unexpected request ${options.method} ${options.path}');
    }
    final result = _handlers.removeAt(0)(options);
    if (result is ResponseBody) return result;
    throw result;
  }

  @override
  void close({bool force = false}) {}
}

ResponseBody jsonResponse(Object? body, int status, {Map<String, String> headers = const {}}) =>
    ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
        for (final entry in headers.entries) entry.key: [entry.value],
      },
    );

FakeHandler respond(Object? body, int status, {Map<String, String> headers = const {}}) =>
    (_) => jsonResponse(body, status, headers: headers);

FakeHandler connectionError() =>
    (options) => DioException(requestOptions: options, type: DioExceptionType.connectionError);

Map<String, Object?> problem(String code, int status, {String? requestId, List<Object?>? errors}) =>
    {
      'type': 'urn:mobility:problem:x',
      'title': 'server title that must not be shown',
      'status': status,
      'code': code,
      'requestId': ?requestId,
      'errors': ?errors,
    };
