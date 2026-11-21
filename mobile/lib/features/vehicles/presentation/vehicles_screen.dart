import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/l10n/l10n.dart';
import '../../../app/routes.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../auth/presentation/login_screen.dart' show InfoBanner;
import '../../owner/data/owner_api.dart';
import '../data/vehicle_api.dart';
import 'vehicle_labels.dart';

/// "My vehicles": the owner's vehicles with their verification status. Only a verified owner
/// can add one; the server enforces it again.
class VehiclesScreen extends ConsumerWidget {
  const VehiclesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final vehicles = ref.watch(vehiclesProvider);
    final owner = ref.watch(ownerProfileProvider).value;
    final verified = owner?.status == OwnerStatus.verified;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.vehiclesTitle)),
      floatingActionButton: verified
          ? FloatingActionButton.extended(
              onPressed: () async {
                await context.push(AppRoutes.vehicleNew);
                ref.invalidate(vehiclesProvider);
              },
              icon: const Icon(Icons.add),
              label: Text(l10n.vehiclesAddAction),
            )
          : null,
      body: SafeArea(
        child: AsyncValueView(
          value: vehicles,
          onRetry: () => ref.invalidate(vehiclesProvider),
          data: (items) => RefreshIndicator(
            onRefresh: () async {
              ref.invalidate(ownerProfileProvider);
              ref.invalidate(vehiclesProvider);
              await ref.read(vehiclesProvider.future);
            },
            child: items.isEmpty && !verified
                ? const _OwnerGate()
                : ListView(
                    padding: const EdgeInsets.only(bottom: 96),
                    children: [
                      if (!verified)
                        Padding(
                          padding: const EdgeInsets.all(16),
                          child: InfoBanner(l10n.vehiclesOwnerRequiredBody),
                        ),
                      if (items.isEmpty)
                        Padding(
                          padding: const EdgeInsets.all(24),
                          child: Column(
                            children: [
                              Text(
                                l10n.vehiclesEmptyTitle,
                                style: Theme.of(context).textTheme.titleMedium,
                              ),
                              const SizedBox(height: 8),
                              Text(l10n.vehiclesEmptyBody, textAlign: TextAlign.center),
                            ],
                          ),
                        ),
                      for (final vehicle in items) _VehicleTile(vehicle: vehicle),
                    ],
                  ),
          ),
        ),
      ),
    );
  }
}

class _OwnerGate extends StatelessWidget {
  const _OwnerGate();

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text(l10n.vehiclesOwnerRequiredTitle, style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 12),
        Text(l10n.vehiclesOwnerRequiredBody),
        const SizedBox(height: 24),
        FilledButton(
          onPressed: () => context.push(AppRoutes.owner),
          child: Text(l10n.vehiclesOwnerGoAction),
        ),
      ],
    );
  }
}

class _VehicleTile extends ConsumerWidget {
  const _VehicleTile({required this.vehicle});

  final Vehicle vehicle;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final icon = switch (vehicle.status) {
      VehicleStatus.approved => Icons.verified_outlined,
      VehicleStatus.suspended => Icons.block,
      VehicleStatus.rejected || VehicleStatus.expired => Icons.error_outline,
      _ => Icons.directions_car_outlined,
    };
    final status = vehicleStatusLabel(l10n, vehicle.status);
    return Semantics(
      label: '${vehicle.title}, ${vehicle.plate}, $status',
      button: true,
      excludeSemantics: true,
      child: ListTile(
        leading: Icon(icon),
        title: Text(vehicle.title),
        subtitle: Text([vehicle.plate, status].join(' · ')),
        trailing: const Icon(Icons.chevron_right),
        onTap: () async {
          await context.push(AppRoutes.vehicle(vehicle.id));
          ref.invalidate(vehiclesProvider);
        },
      ),
    );
  }
}
