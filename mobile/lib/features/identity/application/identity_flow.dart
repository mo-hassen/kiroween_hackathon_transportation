import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:uuid/uuid.dart';

import '../../../core/config/app_config.dart';
import '../../../core/network/api_failure.dart';
import '../data/identity_api.dart';

/// Opens the identity provider's page in the system browser (Android Custom Tab /
/// SFSafariViewController), never in a WebView (docs/architecture/06-flutter-architecture.md).
abstract interface class IdentityLauncher {
  Future<bool> open(Uri url);
}

typedef LaunchUrlFn = Future<bool> Function(Uri url, LaunchMode mode);
typedef SupportsModeFn = Future<bool> Function(LaunchMode mode);

Future<bool> _launch(Uri url, LaunchMode mode) => launchUrl(url, mode: mode);

final class SystemBrowserLauncher implements IdentityLauncher {
  const SystemBrowserLauncher(
    this._config, {
    LaunchUrlFn launch = _launch,
    SupportsModeFn supportsMode = supportsLaunchMode,
  }) : _launchFn = launch,
       _modeAvailable = supportsMode;

  final AppConfig _config;
  final LaunchUrlFn _launchFn;
  final SupportsModeFn _modeAvailable;

  @override
  Future<bool> open(Uri url) async {
    // The URL comes from our server; still refuse anything but https (http only in dev).
    final allowed =
        url.scheme == 'https' ||
        (url.scheme == 'http' && _config.environment == AppEnvironment.development);
    if (!allowed) return false;
    try {
      // url_launcher_android falls back to its own WebView when an in-app browser view is
      // requested but no Custom Tabs browser exists. Ask first; otherwise use the system
      // browser app. LaunchMode.inAppWebView is never used.
      final mode = await _modeAvailable(LaunchMode.inAppBrowserView)
          ? LaunchMode.inAppBrowserView
          : LaunchMode.externalApplication;
      return await _launchFn(url, mode);
    } on Object {
      return false;
    }
  }
}

final identityLauncherProvider = Provider<IdentityLauncher>(
  (ref) => SystemBrowserLauncher(ref.watch(appConfigProvider)),
);

sealed class StartOutcome {
  const StartOutcome();
}

/// The provider page is open; the result arrives through the callback, not the app.
final class StartOpened extends StartOutcome {
  const StartOpened();
}

/// No browser could be opened. The attempt exists; the user can try again.
final class StartLaunchFailed extends StartOutcome {
  const StartLaunchFailed();
}

/// Starts and resumes verification. Holds no identity state of its own: the screen always
/// shows what `GET /identity/verifications/current` returns.
final class IdentityFlow {
  IdentityFlow(this._ref);

  final Ref _ref;
  String? _retryKey;
  Uri? _openUrl;
  String? _openAttemptId;

  /// Provider page of the attempt started in this app session, if it is still [attemptId].
  Uri? resumableUrl(String attemptId) => _openAttemptId == attemptId ? _openUrl : null;

  Future<StartOutcome> start({required String locale}) async {
    // The same key is reused only to retry after a connectivity failure (lost response).
    final key = _retryKey ??= const Uuid().v4();
    final StartedVerification started;
    try {
      started = await _ref.read(identityApiProvider).start(locale: locale, idempotencyKey: key);
    } on ApiFailure catch (failure) {
      if (!failure.isConnectivity) _retryKey = null;
      rethrow;
    } finally {
      _ref.invalidate(identityOverviewProvider);
    }
    _retryKey = null;
    final url = started.authorizationUrl;
    if (url == null) return const StartLaunchFailed();
    _openUrl = url;
    _openAttemptId = started.attempt.id;
    return await _ref.read(identityLauncherProvider).open(url)
        ? const StartOpened()
        : const StartLaunchFailed();
  }

  Future<bool> resume(String attemptId) async {
    final url = resumableUrl(attemptId);
    return url != null && await _ref.read(identityLauncherProvider).open(url);
  }

  /// Called from the return link. The status shown afterwards always comes from the server.
  Future<VerificationAttempt> confirm(String attemptId, String confirmation) async {
    try {
      return await _ref.read(identityApiProvider).confirm(attemptId, confirmation);
    } finally {
      _ref.invalidate(identityOverviewProvider);
    }
  }

  Future<void> cancel(String attemptId) async {
    try {
      await _ref.read(identityApiProvider).cancel(attemptId);
    } finally {
      if (_openAttemptId == attemptId) {
        _openUrl = null;
        _openAttemptId = null;
      }
      _ref.invalidate(identityOverviewProvider);
    }
  }
}

final identityFlowProvider = Provider<IdentityFlow>(IdentityFlow.new);
