import 'package:core_shared/core_shared.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/l10n/l10n.dart';
import '../../../app/routes.dart';
import '../../../core/auth/session_controller.dart';
import '../../../core/network/api_failure.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../auth/presentation/auth_messages.dart';
import '../../auth/presentation/login_screen.dart';
import '../../identity/presentation/identity_labels.dart';
import '../../welcome/welcome_screen.dart';
import '../data/account_api.dart';

/// Signed-in home for Phase 3: own profile, devices/sessions, password, sign-out.
class AccountScreen extends ConsumerWidget {
  const AccountScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final profile = ref.watch(accountProfileProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.accountTitle), actions: const [LanguageMenuButton()]),
      body: SafeArea(
        child: AsyncValueView(
          value: profile,
          onRetry: () => ref.invalidate(accountProfileProvider),
          data: (account) => ListView(
            padding: const EdgeInsets.symmetric(vertical: 16),
            children: [
              if (account.isRestricted)
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                  child: InfoBanner(l10n.accountSuspendedBanner),
                ),
              ListTile(
                leading: const CircleAvatar(child: Icon(Icons.person_outline)),
                title: Text(account.displayName ?? '—'),
                subtitle: Text(formatEthiopianMobile(account.phone)),
                trailing: account.isRestricted
                    ? null
                    : IconButton(
                        tooltip: l10n.editNameAction,
                        icon: const Icon(Icons.edit_outlined),
                        onPressed: () => _editName(context, ref, account),
                      ),
              ),
              const Divider(),
              ListTile(
                leading: const Icon(Icons.badge_outlined),
                title: Text(l10n.identityTitle),
                subtitle: Text(identityStatusLabel(l10n, account.identityStatus)),
                trailing: const Icon(Icons.chevron_right),
                onTap: () async {
                  await context.push(AppRoutes.identity);
                  ref.invalidate(accountProfileProvider);
                },
              ),
              ListTile(
                leading: const Icon(Icons.directions_car_outlined),
                title: Text(l10n.driverTitle),
                subtitle: Text(l10n.driverMenuSubtitle),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.push(AppRoutes.driver),
              ),
              ListTile(
                leading: const Icon(Icons.devices_outlined),
                title: Text(l10n.devicesTitle),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.push(AppRoutes.accountSessions),
              ),
              if (!account.isRestricted)
                ListTile(
                  leading: const Icon(Icons.password_outlined),
                  title: Text(l10n.changePasswordTitle),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => context.push(AppRoutes.accountPassword),
                ),
              ListTile(
                leading: const Icon(Icons.logout),
                title: Text(l10n.signOutAction),
                onTap: () => _confirmSignOut(context, ref),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _confirmSignOut(BuildContext context, WidgetRef ref) async {
    final l10n = context.l10n;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        content: Text(l10n.signOutConfirm),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.cancelAction),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.signOutAction),
          ),
        ],
      ),
    );
    if (confirmed ?? false) {
      await ref.read(sessionControllerProvider.notifier).signOut();
    }
  }

  Future<void> _editName(BuildContext context, WidgetRef ref, AccountProfile account) async {
    final l10n = context.l10n;
    final messenger = ScaffoldMessenger.of(context);
    final name = await showDialog<String>(
      context: context,
      builder: (context) => _EditNameDialog(initial: account.displayName ?? ''),
    );
    if (name == null || name.trim().isEmpty || name.trim() == account.displayName) return;
    try {
      await ref.read(accountApiProvider).update(version: account.version, displayName: name.trim());
      messenger.showSnackBar(SnackBar(content: Text(l10n.nameSaved)));
    } on ApiFailure catch (failure) {
      messenger.showSnackBar(SnackBar(content: Text(authFailureMessage(l10n, failure))));
    }
    ref.invalidate(accountProfileProvider);
  }
}

class _EditNameDialog extends StatefulWidget {
  const _EditNameDialog({required this.initial});

  final String initial;

  @override
  State<_EditNameDialog> createState() => _EditNameDialogState();
}

class _EditNameDialogState extends State<_EditNameDialog> {
  late final TextEditingController _controller = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return AlertDialog(
      title: Text(l10n.editNameAction),
      content: TextField(
        controller: _controller,
        autofocus: true,
        maxLength: 100,
        textCapitalization: TextCapitalization.words,
        decoration: InputDecoration(labelText: l10n.nameLabel),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: Text(l10n.cancelAction)),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_controller.text),
          child: Text(l10n.saveAction),
        ),
      ],
    );
  }
}
