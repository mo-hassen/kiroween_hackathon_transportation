import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/session.dart';
import 'l10n/l10n.dart';

/// Navigation rail + top bar around the signed-in screens.
class AppShell extends ConsumerWidget {
  const AppShell({required this.location, required this.child, super.key});

  final String location;
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final session = ref.watch(staffSessionProvider);
    final name = session is SignedIn ? session.profile.displayName : null;
    final selected = location.startsWith('/drivers') ? 1 : 0;
    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.appTitle),
        actions: [
          if (name != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Center(child: Text(name)),
            ),
          TextButton(
            onPressed: () => ref.read(staffSessionProvider.notifier).signOut(),
            child: Text(l10n.signOutAction),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: Row(
        children: [
          NavigationRail(
            selectedIndex: selected,
            labelType: NavigationRailLabelType.all,
            onDestinationSelected: (index) => context.go(index == 0 ? '/' : '/drivers'),
            destinations: [
              NavigationRailDestination(
                icon: const Icon(Icons.dashboard_outlined),
                label: Text(l10n.dashboardTitle),
              ),
              NavigationRailDestination(
                icon: const Icon(Icons.badge_outlined),
                label: Text(l10n.queueTitle),
              ),
            ],
          ),
          const VerticalDivider(width: 1),
          Expanded(child: child),
        ],
      ),
    );
  }
}

/// Shown to staff without drivers.review (e.g. SUPER_ADMIN, SUPPORT, FINANCE in Phase 5).
class NoPermissionScreen extends ConsumerWidget {
  const NoPermissionScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(l10n.noPermissionTitle, style: Theme.of(context).textTheme.headlineSmall),
                const SizedBox(height: 12),
                Text(l10n.noPermissionBody, textAlign: TextAlign.center),
                const SizedBox(height: 20),
                FilledButton(
                  onPressed: () => ref.read(staffSessionProvider.notifier).signOut(),
                  child: Text(l10n.signOutAction),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Error text with a retry button, used by every loading screen.
class FailureView extends StatelessWidget {
  const FailureView({required this.message, required this.onRetry, super.key});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(message),
        const SizedBox(height: 12),
        OutlinedButton(onPressed: onRetry, child: Text(context.l10n.retryAction)),
      ],
    ),
  );
}

/// Local `yyyy-MM-dd HH:mm` (unambiguous for staff in both languages).
String formatTimestamp(DateTime value) {
  final local = value.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${local.year}-${two(local.month)}-${two(local.day)} ${two(local.hour)}:${two(local.minute)}';
}
