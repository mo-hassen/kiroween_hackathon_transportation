import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/l10n/l10n.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../../core/widgets/state_views.dart';
import '../data/system_status_api.dart';

/// Shows whether the API is reachable, with retry on failure.
class ServiceStatusCard extends ConsumerWidget {
  const ServiceStatusCard({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final status = ref.watch(serviceStatusProvider);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.serviceStatusTitle, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            AsyncValueView(
              value: status,
              onRetry: () => ref.invalidate(serviceStatusProvider),
              loading: LoadingView(label: l10n.serviceStatusChecking),
              data: (_) => ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(Icons.check_circle, color: Theme.of(context).colorScheme.primary),
                title: Text(l10n.serviceStatusOnline),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
