import 'package:flutter_riverpod/flutter_riverpod.dart';

enum AdminEnvironment { development, staging, production }

/// Public build settings (`--dart-define-from-file=config/<env>.json`). Never secrets.
final class AdminConfig {
  AdminConfig._({required this.environment, required this.apiBaseUrl});

  factory AdminConfig.parse({required String environment, required String apiBaseUrl}) {
    final env = AdminEnvironment.values.where((e) => e.name == environment).firstOrNull;
    if (env == null) {
      throw const AdminConfigException('APP_ENV must be development, staging or production');
    }
    final uri = Uri.tryParse(apiBaseUrl);
    if (uri == null || !uri.hasScheme || uri.host.isEmpty || uri.hasQuery || uri.hasFragment) {
      throw const AdminConfigException('API_BASE_URL must be an absolute URL without query');
    }
    if (env != AdminEnvironment.development && uri.scheme != 'https') {
      throw const AdminConfigException('API_BASE_URL must use https outside development');
    }
    final path = uri.path.endsWith('/') ? uri.path.substring(0, uri.path.length - 1) : uri.path;
    return AdminConfig._(
      environment: env,
      apiBaseUrl: uri.replace(path: path),
    );
  }

  factory AdminConfig.fromEnvironment() => AdminConfig.parse(
    environment: const String.fromEnvironment('APP_ENV'),
    apiBaseUrl: const String.fromEnvironment('API_BASE_URL'),
  );

  final AdminEnvironment environment;
  final Uri apiBaseUrl;

  String get apiRoot => '$apiBaseUrl/api/v1';
}

final class AdminConfigException implements Exception {
  const AdminConfigException(this.message);
  final String message;
  @override
  String toString() => 'AdminConfigException: $message';
}

final adminConfigProvider = Provider<AdminConfig>(
  (ref) => throw UnimplementedError('adminConfigProvider must be overridden'),
);
