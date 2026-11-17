import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/auth/data/auth_api.dart';
import '../config/app_config.dart';
import '../network/api_client.dart';
import '../storage/token_store.dart';
import 'auth_interceptor.dart';
import 'auth_tokens.dart';
import 'session_state.dart';
import 'token_manager.dart';

final tokenManagerProvider = Provider<TokenManager>(
  (ref) => TokenManager(
    store: ref.watch(tokenStoreProvider),
    transport: (token) => ref.read(authApiProvider).refresh(token),
  ),
);

/// Source of truth for "is the user signed in". Restores the session on start by
/// refreshing the stored token; never deletes it because of a network error.
class SessionController extends Notifier<SessionState> {
  @override
  SessionState build() {
    unawaited(Future<void>.microtask(_restore));
    return const SessionRestoring();
  }

  TokenManager get _tokens => ref.read(tokenManagerProvider);

  Future<void> _restore() async {
    final outcome = await _tokens.refresh();
    state = switch (outcome) {
      RefreshOutcome.refreshed => SignedIn(_tokens.sessionId ?? ''),
      RefreshOutcome.signedOut => const SignedOut(),
      RefreshOutcome.unreachable => const SessionUnreachable(),
    };
  }

  /// From the "can't connect" screen.
  Future<void> retryRestore() async {
    state = const SessionRestoring();
    await _restore();
  }

  Future<void> signedIn(AuthTokens tokens) async {
    await _tokens.adopt(tokens);
    state = SignedIn(tokens.sessionId);
  }

  /// Local sign-out always succeeds; the server is told on a best-effort basis.
  Future<void> signOut() async {
    final refreshToken = await _tokens.storedRefreshToken();
    await _tokens.clear();
    state = const SignedOut(SignOutReason.signedOut);
    if (refreshToken != null) {
      unawaited(
        ref
            .read(authApiProvider)
            .logout(refreshToken)
            .timeout(const Duration(seconds: 10))
            .catchError((_) {}),
      );
    }
  }

  /// Called by AuthInterceptor when the server rejected the refresh token.
  void sessionExpired() {
    if (state is SignedIn) {
      state = const SignedOut(SignOutReason.sessionExpired);
    }
  }
}

final sessionControllerProvider = NotifierProvider<SessionController, SessionState>(
  SessionController.new,
);

/// Authenticated client: adds the access token and refresh-on-401.
final dioProvider = Provider<Dio>((ref) {
  late final Dio dio;
  final auth = AuthInterceptor(
    retry: (options) => dio.fetch<Object?>(options),
    tokens: ref.watch(tokenManagerProvider),
    onSessionExpired: () => ref.read(sessionControllerProvider.notifier).sessionExpired(),
  );
  dio = createDio(ref.watch(appConfigProvider), extra: [auth]);
  ref.onDispose(dio.close);
  return dio;
});

final apiClientProvider = Provider<ApiClient>((ref) => ApiClient(ref.watch(dioProvider)));
