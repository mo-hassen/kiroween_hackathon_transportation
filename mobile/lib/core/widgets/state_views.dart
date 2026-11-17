import 'package:flutter/material.dart';

import '../../app/l10n/l10n.dart';
import '../network/api_failure.dart';
import 'failure_message.dart';

/// Centered progress indicator with an accessible label.
class LoadingView extends StatelessWidget {
  const LoadingView({super.key, this.label});

  final String? label;

  @override
  Widget build(BuildContext context) {
    final text = label ?? context.l10n.loadingLabel;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Semantics(label: text, liveRegion: true, child: const CircularProgressIndicator()),
      ),
    );
  }
}

/// Shown when a request succeeded but returned nothing.
class EmptyView extends StatelessWidget {
  const EmptyView({
    super.key,
    this.title,
    this.message,
    this.icon = Icons.inbox_outlined,
    this.action,
  });

  final String? title;
  final String? message;
  final IconData icon;

  /// Optional call to action, e.g. "Add vehicle".
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 48, color: theme.colorScheme.outline),
            const SizedBox(height: 12),
            Text(
              title ?? context.l10n.emptyTitle,
              style: theme.textTheme.titleMedium,
              textAlign: TextAlign.center,
            ),
            if (message != null) ...[
              const SizedBox(height: 8),
              Text(message!, style: theme.textTheme.bodyMedium, textAlign: TextAlign.center),
            ],
            if (action != null) ...[const SizedBox(height: 16), action!],
          ],
        ),
      ),
    );
  }
}

/// Localized error with an optional retry button and support reference.
class ErrorView extends StatelessWidget {
  const ErrorView({super.key, required this.failure, this.onRetry});

  final ApiFailure failure;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final reference = failureReference(failure);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              failure.isConnectivity ? Icons.wifi_off_outlined : Icons.error_outline,
              size: 48,
              color: theme.colorScheme.error,
            ),
            const SizedBox(height: 12),
            Text(
              failureMessage(l10n, failure),
              style: theme.textTheme.bodyLarge,
              textAlign: TextAlign.center,
            ),
            if (reference != null) ...[
              const SizedBox(height: 8),
              Text(l10n.errorReference(reference), style: theme.textTheme.bodySmall),
            ],
            if (onRetry != null) ...[
              const SizedBox(height: 16),
              OutlinedButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: Text(l10n.retryAction),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Banner above cached content when the device is offline. Actions that need
/// the server should be disabled while it is shown.
class OfflineBanner extends StatelessWidget {
  const OfflineBanner({super.key, this.onRetry});

  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      liveRegion: true,
      child: Material(
        color: scheme.secondaryContainer,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: Row(
            children: [
              Icon(Icons.cloud_off_outlined, color: scheme.onSecondaryContainer),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  context.l10n.offlineBanner,
                  style: TextStyle(color: scheme.onSecondaryContainer),
                ),
              ),
              if (onRetry != null)
                TextButton(onPressed: onRetry, child: Text(context.l10n.retryAction)),
            ],
          ),
        ),
      ),
    );
  }
}
