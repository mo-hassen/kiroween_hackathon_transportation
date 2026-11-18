import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../app/l10n/l10n.dart';
import '../../../core/network/api_failure.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../../core/widgets/failure_message.dart';
import '../../../core/widgets/primary_button.dart';
import '../application/identity_flow.dart';
import '../data/identity_api.dart';

/// Identity verification (journey J2): introduction and consent, status, retry and cancel.
///
/// Everything shown comes from the server; the app never decides a status. The screen
/// refreshes when the app returns to the foreground, because the result is delivered to
/// the server by the provider's browser redirect, not to the app.
class IdentityScreen extends ConsumerStatefulWidget {
  const IdentityScreen({super.key});

  @override
  ConsumerState<IdentityScreen> createState() => _IdentityScreenState();
}

class _IdentityScreenState extends ConsumerState<IdentityScreen> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) ref.invalidate(identityOverviewProvider);
  }

  @override
  Widget build(BuildContext context) {
    final overview = ref.watch(identityOverviewProvider);
    return Scaffold(
      appBar: AppBar(title: Text(context.l10n.identityTitle)),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () => ref.refresh(identityOverviewProvider.future),
          child: AsyncValueView(
            value: overview,
            onRetry: () => ref.invalidate(identityOverviewProvider),
            data: (data) => ListView(
              padding: const EdgeInsets.all(16),
              children: [IdentityStatusView(overview: data)],
            ),
          ),
        ),
      ),
    );
  }
}

/// Title, explanation and available actions for one server state.
class IdentityStatusView extends ConsumerStatefulWidget {
  const IdentityStatusView({super.key, required this.overview});

  final IdentityOverview overview;

  @override
  ConsumerState<IdentityStatusView> createState() => _IdentityStatusViewState();
}

class _IdentityStatusViewState extends ConsumerState<IdentityStatusView> {
  bool _consented = false;
  bool _busy = false;
  String? _error;

  IdentityOverview get _overview => widget.overview;

  Future<void> _start() async {
    final l10n = context.l10n;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final outcome = await ref
          .read(identityFlowProvider)
          .start(locale: Localizations.localeOf(context).languageCode == 'am' ? 'am' : 'en');
      if (outcome is StartLaunchFailed && mounted) {
        setState(() => _error = l10n.identityLaunchFailed);
      }
    } on ApiFailure catch (failure) {
      if (mounted) setState(() => _error = identityFailureMessage(l10n, failure));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _resume(String attemptId) async {
    final message = context.l10n.identityLaunchFailed;
    final opened = await ref.read(identityFlowProvider).resume(attemptId);
    if (!opened && mounted) setState(() => _error = message);
  }

  Future<void> _cancel(String attemptId) async {
    final l10n = context.l10n;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(l10n.identityCancelConfirm),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.identityKeepAction),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.identityCancelAction),
          ),
        ],
      ),
    );
    if (!(confirmed ?? false)) return;
    setState(() => _busy = true);
    try {
      await ref.read(identityFlowProvider).cancel(attemptId);
    } on ApiFailure catch (failure) {
      if (mounted) setState(() => _error = identityFailureMessage(l10n, failure));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final latest = _overview.latest;
    final locale = Localizations.localeOf(context).toLanguageTag();
    String date(DateTime value) => DateFormat.yMMMd(locale).format(value.toLocal());

    final children = <Widget>[];
    switch (_overview.status) {
      case IdentityStatus.verified:
        children.add(
          _StatusHeader(
            icon: Icons.verified_user_outlined,
            tone: _Tone.success,
            title: l10n.identityStatusVerified,
            lines: [
              if (_overview.verifiedName != null) l10n.identityVerifiedAs(_overview.verifiedName!),
              if (_overview.validUntil != null)
                l10n.identityValidUntil(date(_overview.validUntil!)),
            ],
          ),
        );
      case IdentityStatus.pending:
        children.add(
          _StatusHeader(
            icon: Icons.hourglass_top_outlined,
            tone: _Tone.progress,
            title: l10n.identityStatusPending,
            lines: [l10n.identityPendingBody, l10n.identityPendingFinishHint],
          ),
        );
        if (latest != null && latest.status == AttemptStatus.pending) {
          final resumable = ref.read(identityFlowProvider).resumableUrl(latest.id) != null;
          children.addAll([
            const SizedBox(height: 16),
            if (resumable)
              PrimaryButton(
                label: l10n.identityContinueAction,
                isLoading: _busy,
                onPressed: () => _resume(latest.id),
              ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: _busy ? null : () => ref.invalidate(identityOverviewProvider),
              icon: const Icon(Icons.refresh),
              label: Text(l10n.identityCheckStatusAction),
            ),
            TextButton(
              onPressed: _busy ? null : () => _cancel(latest.id),
              child: Text(l10n.identityCancelAction),
            ),
          ]);
        }
      case IdentityStatus.suspended:
        children.add(
          _StatusHeader(
            icon: Icons.block_outlined,
            tone: _Tone.error,
            title: l10n.identityStatusSuspended,
            lines: [l10n.identitySuspendedBody],
          ),
        );
      case IdentityStatus.rejected:
        children.add(
          _StatusHeader(
            icon: Icons.gpp_bad_outlined,
            tone: _Tone.error,
            title: l10n.identityStatusRejected,
            lines: [l10n.identityRejectedBody],
          ),
        );
      case IdentityStatus.expired:
        children.add(
          _StatusHeader(
            icon: Icons.event_busy_outlined,
            tone: _Tone.warning,
            title: l10n.identityStatusExpired,
            lines: [l10n.identityValidityEndedBody],
          ),
        );
      case IdentityStatus.reverificationRequired:
        children.add(
          _StatusHeader(
            icon: Icons.restart_alt_outlined,
            tone: _Tone.warning,
            title: l10n.identityStatusReverification,
            lines: [l10n.identityReverificationBody],
          ),
        );
      case IdentityStatus.unverified:
        children.add(
          _StatusHeader(
            icon: Icons.badge_outlined,
            tone: _Tone.neutral,
            title: l10n.identityStatusNotVerified,
            lines: [l10n.identityIntroBody],
          ),
        );
      case IdentityStatus.unknown:
        children.add(
          _StatusHeader(
            icon: Icons.help_outline,
            tone: _Tone.neutral,
            title: l10n.identityStatusUnknown,
            lines: const [],
          ),
        );
    }

    // What happened to the last attempt, when it did not end in a verified identity.
    final lastOutcome = latest == null || _overview.status == IdentityStatus.pending
        ? null
        : lastAttemptMessage(l10n, latest);
    if (lastOutcome != null) {
      children.addAll([const SizedBox(height: 12), _Notice(lastOutcome)]);
    }

    if (_overview.canStart && _overview.status != IdentityStatus.pending) {
      children.addAll([
        const SizedBox(height: 24),
        _ConsentSection(
          consented: _consented,
          onChanged: _busy ? null : (value) => setState(() => _consented = value),
        ),
        const SizedBox(height: 16),
        PrimaryButton(
          label: latest == null ? l10n.identityStartAction : l10n.identityRetryAction,
          isLoading: _busy,
          onPressed: _consented ? _start : null,
        ),
      ]);
    } else if (!_overview.canStart && _startableStatus(_overview.status)) {
      // The server can verify nobody right now (no provider configured or reachable).
      children.addAll([const SizedBox(height: 16), _Notice(l10n.identityUnavailable)]);
    }

    if (_error != null) {
      children.addAll([
        const SizedBox(height: 16),
        Semantics(
          liveRegion: true,
          child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
        ),
      ]);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children);
  }
}

bool _startableStatus(IdentityStatus status) => switch (status) {
  IdentityStatus.unverified ||
  IdentityStatus.rejected ||
  IdentityStatus.expired ||
  IdentityStatus.reverificationRequired => true,
  _ => false,
};

/// Explains the last attempt from the server's coarse reason. Unknown reasons fall back
/// to the generic failure text.
String? lastAttemptMessage(AppLocalizations l10n, VerificationAttempt attempt) =>
    switch (attempt.status) {
      AttemptStatus.failed =>
        attempt.reason == 'PROVIDER_UNAVAILABLE'
            ? l10n.identityProviderUnavailableBody
            : l10n.identityFailedBody,
      AttemptStatus.expired =>
        attempt.reason == 'VALIDITY_ENDED' ? null : l10n.identitySessionExpiredBody,
      AttemptStatus.cancelled => switch (attempt.reason) {
        'DECLINED_AT_PROVIDER' => l10n.identityDeclinedBody,
        'CLOSED_BY_SUPPORT' => l10n.identityClosedBySupportBody,
        _ => l10n.identityCancelledBody,
      },
      _ => null,
    };

/// Text for failures of identity actions.
String identityFailureMessage(AppLocalizations l10n, ApiFailure failure) => switch (failure.code) {
  'IDENTITY_UNAVAILABLE' => l10n.identityUnavailable,
  'IDENTITY_VERIFICATION_NOT_ALLOWED' || 'INVALID_STATE_TRANSITION' => l10n.identityNotAllowed,
  _ when failure is RateLimitedFailure => l10n.errorRateLimited,
  _ => failureMessage(l10n, failure),
};

class _ConsentSection extends StatelessWidget {
  const _ConsentSection({required this.consented, required this.onChanged});

  final bool consented;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    Widget point(IconData icon, String text) => Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 20, color: theme.colorScheme.primary),
          const SizedBox(width: 12),
          Expanded(child: Text(text, style: theme.textTheme.bodyMedium)),
        ],
      ),
    );
    return Card.outlined(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.identityConsentTitle, style: theme.textTheme.titleMedium),
            const SizedBox(height: 12),
            point(Icons.person_outline, l10n.identityConsentShared),
            point(Icons.no_photography_outlined, l10n.identityConsentNotStored),
            point(Icons.open_in_browser_outlined, l10n.identityConsentBrowser),
            point(Icons.phonelink_lock_outlined, l10n.identityPendingFinishHint),
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              value: consented,
              onChanged: onChanged == null ? null : (value) => onChanged!(value ?? false),
              title: Text(l10n.identityConsentCheckbox),
            ),
          ],
        ),
      ),
    );
  }
}

enum _Tone { neutral, progress, success, warning, error }

class _StatusHeader extends StatelessWidget {
  const _StatusHeader({
    required this.icon,
    required this.tone,
    required this.title,
    required this.lines,
  });

  final IconData icon;
  final _Tone tone;
  final String title;
  final List<String> lines;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final (background, foreground) = switch (tone) {
      _Tone.success => (scheme.primaryContainer, scheme.onPrimaryContainer),
      _Tone.error => (scheme.errorContainer, scheme.onErrorContainer),
      _Tone.warning => (scheme.tertiaryContainer, scheme.onTertiaryContainer),
      _Tone.progress || _Tone.neutral => (scheme.surfaceContainerHighest, scheme.onSurfaceVariant),
    };
    return Semantics(
      liveRegion: true,
      child: Card(
        color: background,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, size: 32, color: foreground),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: theme.textTheme.titleMedium?.copyWith(color: foreground)),
                    for (final line in lines) ...[
                      const SizedBox(height: 6),
                      Text(line, style: theme.textTheme.bodyMedium?.copyWith(color: foreground)),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice(this.message);

  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.info_outline, size: 20, color: scheme.onSurfaceVariant),
        const SizedBox(width: 8),
        Expanded(child: Text(message)),
      ],
    );
  }
}
