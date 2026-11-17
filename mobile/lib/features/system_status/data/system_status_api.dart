import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_client.dart';

/// Result of the server liveness probe.
enum ServiceStatus { online }

/// Whether the API is reachable.
abstract interface class SystemStatusApi {
  Future<ServiceStatus> fetchStatus();
}

/// Reads `GET /api/v1/health/live`. The only call in Phase 2; it proves the
/// network stack end to end and tells the user whether the service is reachable.
final class HttpSystemStatusApi implements SystemStatusApi {
  const HttpSystemStatusApi(this._client);

  final ApiClient _client;

  @override
  Future<ServiceStatus> fetchStatus() => _client.get(
    '/health/live',
    decode: (data) {
      if (data is Map && data['status'] == 'ok') return ServiceStatus.online;
      throw const FormatException('Unexpected health payload');
    },
  );
}

final systemStatusApiProvider = Provider<SystemStatusApi>(
  (ref) => HttpSystemStatusApi(ref.watch(publicApiClientProvider)),
);

final serviceStatusProvider = FutureProvider.autoDispose<ServiceStatus>(
  (ref) => ref.watch(systemStatusApiProvider).fetchStatus(),
);
