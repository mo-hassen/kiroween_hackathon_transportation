import 'package:dio/dio.dart';

import 'token_manager.dart';

const _authRetriedExtra = 'authRetried';

/// Paths under `/auth/` carry their own credentials (codes, refresh tokens) and must never
/// trigger a token refresh.
bool isAuthEndpoint(String path) => path.startsWith('/auth/');

/// Attaches the access token and, on 401, performs one single-flight refresh and retries
/// the original request once (docs/architecture/06-flutter-architecture.md).
final class AuthInterceptor extends Interceptor {
  AuthInterceptor({required this.retry, required this.tokens, required this.onSessionExpired});

  /// Re-sends a request through the client this interceptor is attached to.
  final Future<Response<Object?>> Function(RequestOptions options) retry;
  final TokenManager tokens;

  /// Called when the server rejected the refresh token: the user must sign in again.
  final void Function() onSessionExpired;

  @override
  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {
    final token = tokens.accessToken;
    if (!isAuthEndpoint(options.path) && token != null) {
      options.headers['Authorization'] = 'Bearer $token';
    }
    handler.next(options);
  }

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    final options = err.requestOptions;
    if (err.response?.statusCode != 401 ||
        isAuthEndpoint(options.path) ||
        options.extra[_authRetriedExtra] == true) {
      handler.next(err);
      return;
    }
    final outcome = await tokens.refresh();
    if (outcome == RefreshOutcome.signedOut) {
      onSessionExpired();
      handler.next(err);
      return;
    }
    if (outcome == RefreshOutcome.unreachable) {
      handler.next(err);
      return;
    }
    options.extra[_authRetriedExtra] = true;
    options.headers.remove('Authorization');
    try {
      handler.resolve(await retry(options));
    } on DioException catch (retryError) {
      handler.next(retryError);
    }
  }
}
