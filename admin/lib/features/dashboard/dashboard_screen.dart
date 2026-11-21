import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/l10n/l10n.dart';
import '../../app/shell.dart';
import '../../core/api.dart';
import '../../core/session.dart';
import '../drivers/driver_review_api.dart';
import '../owners/owner_review_api.dart';
import '../vehicles/vehicle_review_api.dart';

final caseCountsProvider = FutureProvider.autoDispose<CaseCounts>(
  (ref) => ref.watch(driverReviewApiProvider).counts(),
);

final ownerCountsProvider = FutureProvider.autoDispose<OwnerCounts>(
  (ref) => ref.watch(ownerReviewApiProvider).counts(),
);

final vehicleCountsProvider = FutureProvider.autoDispose<VehicleCounts>(
  (ref) => ref.watch(vehicleReviewApiProvider).counts(),
);

/// Counts per area the staff member may review; each card opens the filtered queue.
class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final session = ref.watch(staffSessionProvider);
    final profile = session is SignedIn ? session.profile : null;
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text(l10n.dashboardTitle, style: Theme.of(context).textTheme.headlineSmall),
        if (profile?.canReviewDrivers ?? false)
          _CountSection(
            title: l10n.driverDashboardSection,
            counts: ref.watch(caseCountsProvider),
            onRetry: () => ref.invalidate(caseCountsProvider),
            cards: [
              ('SUBMITTED', l10n.countSubmitted, '/drivers?status=SUBMITTED'),
              ('UNDER_REVIEW', l10n.countUnderReview, '/drivers?status=UNDER_REVIEW'),
              ('APPROVED', l10n.countApproved, '/drivers?status=APPROVED'),
              ('REJECTED', l10n.countRejected, '/drivers?status=REJECTED'),
              ('SUSPENDED', l10n.statusSuspended, '/drivers?status=SUSPENDED'),
              ('EXPIRED', l10n.statusExpired, '/drivers?status=EXPIRED'),
            ],
          ),
        if (profile?.canReviewOwners ?? false)
          _CountSection(
            title: l10n.ownerDashboardSection,
            counts: ref.watch(ownerCountsProvider),
            onRetry: () => ref.invalidate(ownerCountsProvider),
            cards: [
              (
                'PENDING_INDIVIDUAL',
                l10n.countPendingIndividual,
                '/owners?status=PENDING&ownerType=INDIVIDUAL',
              ),
              (
                'PENDING_ORGANIZATION',
                l10n.countPendingOrganization,
                '/owners?status=PENDING&ownerType=ORGANIZATION',
              ),
              (
                'AWAITING_SECOND_APPROVAL',
                l10n.countAwaitingSecond,
                '/owners?awaitingSecondApproval=true',
              ),
              ('VERIFIED', l10n.countVerified, '/owners?status=VERIFIED'),
              ('REJECTED', l10n.countRejected, '/owners?status=REJECTED'),
              ('SUSPENDED', l10n.statusSuspended, '/owners?status=SUSPENDED'),
            ],
          ),
        if (profile?.canReviewVehicles ?? false)
          _CountSection(
            title: l10n.vehicleDashboardSection,
            counts: ref.watch(vehicleCountsProvider),
            onRetry: () => ref.invalidate(vehicleCountsProvider),
            cards: [
              ('SUBMITTED', l10n.countSubmitted, '/vehicles?status=SUBMITTED'),
              ('UNDER_REVIEW', l10n.countUnderReview, '/vehicles?status=UNDER_REVIEW'),
              ('APPROVED', l10n.countApproved, '/vehicles?status=APPROVED'),
              ('REJECTED', l10n.countRejected, '/vehicles?status=REJECTED'),
              ('SUSPENDED', l10n.statusSuspended, '/vehicles?status=SUSPENDED'),
              ('EXPIRED', l10n.statusExpired, '/vehicles?status=EXPIRED'),
            ],
          ),
      ],
    );
  }
}

class _CountSection extends StatelessWidget {
  const _CountSection({
    required this.title,
    required this.counts,
    required this.onRetry,
    required this.cards,
  });

  final String title;
  final AsyncValue<Map<String, int>> counts;
  final VoidCallback onRetry;
  final List<(String key, String label, String location)> cards;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: theme.textTheme.titleMedium),
          const SizedBox(height: 12),
          switch (counts) {
            AsyncData(:final value) => Wrap(
              spacing: 16,
              runSpacing: 16,
              children: [
                for (final (key, label, location) in cards)
                  SizedBox(
                    width: 220,
                    child: Card(
                      child: InkWell(
                        onTap: () => context.go(location),
                        child: Padding(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(label),
                              const SizedBox(height: 8),
                              Text('${value[key] ?? 0}', style: theme.textTheme.displaySmall),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
            AsyncError(:final error) => SizedBox(
              height: 120,
              child: FailureView(
                message: failureText(l10n, ApiFailure.from(error)),
                onRetry: onRetry,
              ),
            ),
            _ => const Padding(padding: EdgeInsets.all(16), child: CircularProgressIndicator()),
          },
        ],
      ),
    );
  }
}
