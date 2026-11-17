import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Deployment environment of this build.
enum AppEnvironment { development, staging, production }

/// Public, build-time configuration. Supplied with
/// `--dart-define-from-file=config/<env>.json`.
///
/// Only values that are safe to ship in an APK belong here: never API keys,
/// client secrets or credentials (docs/architecture/07-security-architecture.md).
final class AppConfig {
  AppConfig._({required this.environment, required this.apiBaseUrl});

  /// Validates raw values. Deployed builds must use HTTPS.
  factory AppConfig.parse({required String environment, required String apiBaseUrl}) {
    final env = AppEnvironment.values.where((e) => e.name == environment).firstOrNull;
    if (env == null) {
      throw const AppConfigException('APP_ENV must be development, staging or production');
    }
    final uri = Uri.tryParse(apiBaseUrl);
    if (uri == null || !uri.hasScheme || uri.host.isEmpty || uri.hasQuery || uri.hasFragment) {
      throw const AppConfigException('API_BASE_URL must be an absolute URL without query');
    }
    if (env != AppEnvironment.development && uri.scheme != 'https') {
      throw const AppConfigException('API_BASE_URL must use https outside development');
    }
    if (uri.scheme != 'https' && uri.scheme != 'http') {
      throw const AppConfigException('API_BASE_URL must use http or https');
    }
    final normalized = uri.replace(
      path: uri.path.endsWith('/') ? uri.path.substring(0, uri.path.length - 1) : uri.path,
    );
    return AppConfig._(environment: env, apiBaseUrl: normalized);
  }

  /// Reads the values compiled in with `--dart-define`.
  factory AppConfig.fromEnvironment() => AppConfig.parse(
    environment: const String.fromEnvironment('APP_ENV'),
    apiBaseUrl: const String.fromEnvironment('API_BASE_URL'),
  );

  final AppEnvironment environment;

  /// Server origin, without the `/api/v1` prefix and without a trailing slash.
  final Uri apiBaseUrl;

  /// Versioned API root used by the HTTP client.
  String get apiRoot => '$apiBaseUrl/api/v1';
}

final class AppConfigException implements Exception {
  const AppConfigException(this.message);

  final String message;

  @override
  String toString() => 'AppConfigException: $message';
}

/// Overridden in `main()` with the validated build configuration.
final appConfigProvider = Provider<AppConfig>(
  (ref) => throw UnimplementedError('appConfigProvider must be overridden'),
);
