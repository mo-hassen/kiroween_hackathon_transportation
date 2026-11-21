import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:uuid/uuid.dart';

import '../../../app/l10n/l10n.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../../core/widgets/primary_button.dart';
import '../data/vehicle_api.dart';
import 'vehicle_labels.dart';

/// Summary and explicit confirmation before `POST /vehicles/:id/submit`. One Idempotency-Key
/// per screen visit, so a retried tap after a timeout cannot submit twice.
class VehicleReviewScreen extends ConsumerWidget {
  const VehicleReviewScreen({required this.vehicleId, super.key});

  final String vehicleId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final vehicle = ref.watch(vehicleProvider(vehicleId));
    return Scaffold(
      appBar: AppBar(title: Text(context.l10n.reviewTitle)),
      body: SafeArea(
        child: AsyncValueView(
          value: vehicle,
          onRetry: () => ref.invalidate(vehicleProvider(vehicleId)),
          data: (item) => _Review(vehicle: item),
        ),
      ),
    );
  }
}

class _Review extends ConsumerStatefulWidget {
  const _Review({required this.vehicle});

  final Vehicle vehicle;

  @override
  ConsumerState<_Review> createState() => _ReviewState();
}

class _ReviewState extends ConsumerState<_Review> {
  final _idempotencyKey = const Uuid().v4();
  bool _confirmed = false;
  bool _submitting = false;
  String? _error;

  Future<void> _submit() async {
    final l10n = context.l10n;
    final messenger = ScaffoldMessenger.of(context);
    final router = GoRouter.of(context);
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await ref.read(vehicleApiProvider).submit(widget.vehicle.id, idempotencyKey: _idempotencyKey);
      if (!mounted) return;
      ref.invalidate(vehiclesProvider);
      messenger.showSnackBar(SnackBar(content: Text(l10n.vehicleSubmitted)));
      router.pop();
    } on Object catch (error) {
      if (mounted) setState(() => _error = vehicleFailureMessage(l10n, error));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final vehicle = widget.vehicle;
    Widget row(String label, String value) =>
        ListTile(dense: true, title: Text(label), subtitle: Text(value));
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 16),
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Text(l10n.vehicleReviewIntro),
        ),
        const SizedBox(height: 8),
        row(l10n.vehicleTypeLabel, vehicleTypeLabel(l10n, vehicle.type)),
        row(l10n.vehicleMakeLabel, vehicle.make),
        row(l10n.vehicleModelLabel, vehicle.model),
        row(l10n.vehicleYearLabel, '${vehicle.year}'),
        row(l10n.vehiclePlateRow, vehicle.plate),
        if (vehicle.vinMasked != null) row(l10n.vehicleVinLabel, vehicle.vinMasked!),
        for (final slot in EvidenceSlot.values)
          if (vehicle.evidenceFor(slot) case final item? when item.ready)
            row(
              evidenceSlotLabel(l10n, slot),
              [
                l10n.photoReady,
                if (item.expiresOn != null) l10n.vehicleExpiryValue(item.expiresOn!),
              ].join(' · '),
            ),
        CheckboxListTile(
          value: _confirmed,
          onChanged: _submitting ? null : (value) => setState(() => _confirmed = value ?? false),
          title: Text(l10n.vehicleReviewConfirm),
          controlAffinity: ListTileControlAffinity.leading,
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Semantics(
              liveRegion: true,
              child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ),
          ),
        Padding(
          padding: const EdgeInsets.all(16),
          child: PrimaryButton(
            label: l10n.submitAction,
            isLoading: _submitting,
            onPressed: _confirmed && vehicle.readyToSubmit ? _submit : null,
          ),
        ),
      ],
    );
  }
}
