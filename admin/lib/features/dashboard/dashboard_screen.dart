import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/l10n/l10n.dart';
import '../../app/shell.dart';
import '../../core/api.dart';
import '../drivers/driver_review_api.dart';

final caseCountsProvider = FutureProvider.autoDispose<CaseCounts>(
  (ref) => ref.watch(driverReviewApiProvider).counts(),
);

/// Counts per review status; each card opens the filtered queue.
class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final counts = ref.watch(caseCountsProvider);
    final cards = [
      ('SUBMITTED', l10n.countSubmitted),
      ('UNDER_REVIEW', l10n.countUnderReview),
      ('APPROVED', l10n.countApproved),
      ('REJECTED', l10n.countRejected),
      ('SUSPENDED', l10n.statusSuspended),
      ('EXPIRED', l10n.statusExpired),
    ];
    return switch (counts) {
      AsyncData(:final value) => ListView(
        padding: const EdgeInsets.all(24),
        children: [
          Text(l10n.dashboardTitle, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 16),
          Wrap(
            spacing: 16,
            runSpacing: 16,
            children: [
              for (final (status, label) in cards)
                SizedBox(
                  width: 220,
                  child: Card(
                    child: InkWell(
                      onTap: () => context.go(
                        Uri(path: '/drivers', queryParameters: {'status': status}).toString(),
                      ),
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(label),
                            const SizedBox(height: 8),
                            Text(
                              '${value[status] ?? 0}',
                              style: Theme.of(context).textTheme.displaySmall,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
      AsyncError(:final error) => FailureView(
        message: failureText(l10n, ApiFailure.from(error)),
        onRetry: () => ref.invalidate(caseCountsProvider),
      ),
      _ => const Center(child: CircularProgressIndicator()),
    };
  }
}
