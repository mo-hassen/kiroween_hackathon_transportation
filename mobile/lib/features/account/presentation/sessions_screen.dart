import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

import '../../../app/l10n/l10n.dart';
import '../../../core/network/api_failure.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../auth/presentation/auth_messages.dart';
import '../data/account_api.dart';

/// Devices signed in to this account; any other device can be signed out remotely.
class SessionsScreen extends ConsumerWidget {
  const SessionsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.devicesTitle)),
      body: SafeArea(
        child: AsyncValueView(
          value: ref.watch(accountSessionsProvider),
          onRetry: () => ref.invalidate(accountSessionsProvider),
          isEmpty: (sessions) => sessions.isEmpty,
          data: (sessions) => RefreshIndicator(
            onRefresh: () => ref.refresh(accountSessionsProvider.future),
            child: ListView.separated(
              itemCount: sessions.length,
              separatorBuilder: (_, _) => const Divider(height: 1),
              itemBuilder: (context, index) => _SessionTile(session: sessions[index]),
            ),
          ),
        ),
      ),
    );
  }
}

class _SessionTile extends ConsumerWidget {
  const _SessionTile({required this.session});

  final SessionSummary session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final locale = Localizations.localeOf(context).toLanguageTag();
    final lastActive = DateFormat.yMMMd(locale).add_Hm().format(session.lastUsedAt.toLocal());
    final (icon, label) = switch (session.platform) {
      'ANDROID' => (Icons.phone_android, l10n.platformAndroid),
      'IOS' => (Icons.phone_iphone, l10n.platformIos),
      'WEB' => (Icons.language, l10n.platformWeb),
      _ => (Icons.devices_other, l10n.platformUnknown),
    };
    return ListTile(
      leading: Icon(icon),
      title: Text(label),
      subtitle: Text(
        [
          l10n.lastActive(lastActive),
          if (session.appVersion != null) 'v${session.appVersion}',
        ].join(' · '),
      ),
      trailing: session.current
          ? Chip(label: Text(l10n.thisDevice))
          : IconButton(
              tooltip: l10n.signOutDevice,
              icon: const Icon(Icons.logout),
              onPressed: () => _revoke(context, ref),
            ),
    );
  }

  Future<void> _revoke(BuildContext context, WidgetRef ref) async {
    final l10n = context.l10n;
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(l10n.signOutDeviceConfirm),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.cancelAction),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.signOutDevice),
          ),
        ],
      ),
    );
    if (!(confirmed ?? false)) return;
    try {
      await ref.read(accountApiProvider).revokeSession(session.id);
    } on ApiFailure catch (failure) {
      messenger.showSnackBar(SnackBar(content: Text(authFailureMessage(l10n, failure))));
    }
    ref.invalidate(accountSessionsProvider);
  }
}
