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
    final profile = session is SignedIn ? session.profile : null;
    final name = profile?.displayName;
    // Only the areas this staff member may use (the router and the API check again).
    final areas = <(String, IconData, String)>[
      ('/', Icons.dashboard_outlined, l10n.dashboardTitle),
      if (profile?.canReviewDrivers ?? false) ('/drivers', Icons.badge_outlined, l10n.queueTitle),
      if (profile?.canReviewOwners ?? false)
        ('/owners', Icons.business_outlined, l10n.ownersQueueTitle),
    ];
    final match = areas.indexWhere((a) => a.$1 != '/' && location.startsWith(a.$1));
    final selected = match < 0 ? 0 : match;
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
            onDestinationSelected: (index) => context.go(areas[index].$1),
            destinations: [
              for (final (_, icon, label) in areas)
                NavigationRailDestination(icon: Icon(icon), label: Text(label)),
            ],
          ),
          const VerticalDivider(width: 1),
          Expanded(child: child),
        ],
      ),
    );
  }
}

/// Shown to staff without drivers.review or owners.review (e.g. SUPER_ADMIN, SUPPORT, FINANCE).
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
