import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/l10n/l10n.dart';
import '../../../app/routes.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../../core/widgets/primary_button.dart';
import '../../documents/document_upload.dart';
import '../../driver/data/driver_api.dart' show ReviewStatus;
import '../../driver/data/license_upload.dart';
import '../../driver/presentation/driver_labels.dart' show decisionReasonLabel;
import '../data/vehicle_api.dart';
import 'vehicle_labels.dart';

/// One vehicle: status and guidance, progress, details, the ten evidence slots (pick, upload
/// with progress, attach; retry without picking again) and the way to review and submit.
class VehicleScreen extends ConsumerWidget {
  const VehicleScreen({required this.vehicleId, super.key});

  final String vehicleId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final vehicle = ref.watch(vehicleProvider(vehicleId));
    return Scaffold(
      appBar: AppBar(title: Text(vehicle.value?.title ?? l10n.vehiclesTitle)),
      body: SafeArea(
        child: AsyncValueView(
          value: vehicle,
          onRetry: () => ref.invalidate(vehicleProvider(vehicleId)),
          data: (item) => RefreshIndicator(
            onRefresh: () => ref.refresh(vehicleProvider(vehicleId).future),
            child: _Body(vehicle: item),
          ),
        ),
      ),
    );
  }
}

class _Body extends ConsumerWidget {
  const _Body({required this.vehicle});

  final Vehicle vehicle;

  Future<void> _open(BuildContext context, WidgetRef ref, String route) async {
    await context.push(route);
    ref.invalidate(vehicleProvider(vehicle.id));
  }

  Future<void> _archive(BuildContext context, WidgetRef ref) async {
    final l10n = context.l10n;
    final router = GoRouter.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: Text(l10n.vehicleArchiveTitle),
        content: Text(l10n.vehicleArchiveBody),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog, false), child: Text(l10n.cancelAction)),
          FilledButton(
            onPressed: () => Navigator.pop(dialog, true),
            child: Text(l10n.vehicleArchiveConfirm),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await ref.read(vehicleApiProvider).archive(vehicle.id);
      ref.invalidate(vehiclesProvider);
      router.pop();
    } on Object catch (error) {
      messenger.showSnackBar(SnackBar(content: Text(vehicleFailureMessage(l10n, error))));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final guidance = vehicleStatusGuidance(l10n, vehicle.status);
    final done = vehicle.requiredReady;
    final total = vehicle.requiredTotal;
    final canChange = vehicle.editable || vehicle.status == VehicleStatus.approved;
    final archivable = const {
      VehicleStatus.draft,
      VehicleStatus.rejected,
      VehicleStatus.expired,
      VehicleStatus.approved,
    }.contains(vehicle.status);
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 16),
      children: [
        Card(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(vehicleStatusLabel(l10n, vehicle.status), style: theme.textTheme.titleMedium),
                if (vehicle.decisionReasonCode != null) ...[
                  const SizedBox(height: 8),
                  Text(l10n.decisionReason(decisionReasonLabel(l10n, vehicle.decisionReasonCode!))),
                ],
                // Plain text only: officer notes are never rendered as markup or links.
                if (vehicle.decisionNote != null)
                  Text(l10n.officerNoteLabel(vehicle.decisionNote!)),
                if (guidance != null) ...[const SizedBox(height: 8), Text(guidance)],
                if (vehicle.editable)
                  for (final problem in vehicle.submissionProblems)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(Icons.chevron_right, size: 20),
                          const SizedBox(width: 4),
                          Expanded(child: Text(vehicleProblemLabel(l10n, problem))),
                        ],
                      ),
                    ),
              ],
            ),
          ),
        ),
        if (canChange)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
            child: Semantics(
              label: l10n.vehicleProgressSemantics(done, total),
              excludeSemantics: true,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(l10n.vehicleProgress(done, total)),
                  const SizedBox(height: 4),
                  LinearProgressIndicator(value: total == 0 ? 0 : done / total),
                ],
              ),
            ),
          ),
        const SizedBox(height: 8),
        ListTile(
          leading: const Icon(Icons.directions_car_outlined),
          title: Text(vehicle.title),
          subtitle: Text(
            [
              vehicle.plate,
              vehicleTypeLabel(l10n, vehicle.type),
              if (vehicle.vinMasked != null) vehicle.vinMasked!,
            ].join(' · '),
          ),
          trailing: canChange ? const Icon(Icons.edit_outlined) : null,
          onTap: canChange ? () => _open(context, ref, AppRoutes.vehicleEdit(vehicle.id)) : null,
        ),
        if (vehicle.status == VehicleStatus.approved)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(l10n.vehicleApprovedChangeWarning, style: theme.textTheme.bodySmall),
          ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
          child: Text(l10n.vehicleEvidenceTitle, style: theme.textTheme.titleMedium),
        ),
        for (final slot in EvidenceSlot.values)
          // An approved vehicle can renew evidence; the server sends it back for review.
          _SlotCard(key: ValueKey(slot), vehicle: vehicle, slot: slot, canChange: canChange),
        if (vehicle.readyToSubmit)
          Padding(
            padding: const EdgeInsets.all(16),
            child: PrimaryButton(
              label: l10n.vehicleReviewAction,
              onPressed: () => _open(context, ref, AppRoutes.vehicleReview(vehicle.id)),
            ),
          ),
        if (archivable)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: TextButton.icon(
              onPressed: () => _archive(context, ref),
              icon: const Icon(Icons.delete_outline),
              label: Text(l10n.vehicleArchiveAction),
            ),
          ),
      ],
    );
  }
}

class _SlotCard extends ConsumerStatefulWidget {
  const _SlotCard({required this.vehicle, required this.slot, required this.canChange, super.key});

  final Vehicle vehicle;
  final EvidenceSlot slot;
  final bool canChange;

  @override
  ConsumerState<_SlotCard> createState() => _SlotCardState();
}

class _SlotCardState extends ConsumerState<_SlotCard> {
  DocumentUploadJob? _job;
  String? _expiresOn;
  UploadStage? _stage;
  double _progress = 0;
  String? _error;

  bool get _busy => _stage != null;

  /// Today in Addis Ababa (UTC+3, no daylight saving), as the server counts it.
  static DateTime _addisToday() {
    final now = DateTime.now().toUtc().add(const Duration(hours: 3));
    return DateTime.utc(now.year, now.month, now.day);
  }

  static String _iso(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  Future<void> _pick(PhotoSource source) async {
    final l10n = context.l10n;
    setState(() => _error = null);
    String? expires;
    if (widget.slot.expires) {
      final today = _addisToday();
      final picked = await showDatePicker(
        context: context,
        helpText: l10n.vehicleExpiryHelp,
        initialDate: today.add(const Duration(days: 180)),
        firstDate: today,
        lastDate: today.add(const Duration(days: 366 * 5)),
      );
      if (picked == null || !mounted) return;
      expires = _iso(picked);
    }
    final PickedPhoto? photo;
    try {
      photo = await ref.read(licensePhotoPickerProvider).pick(source);
    } on Object catch (error) {
      if (mounted) setState(() => _error = vehicleFailureMessage(l10n, error));
      return;
    }
    if (photo == null || !mounted) return;
    _expiresOn = expires;
    _job = DocumentUploadJob(
      api: ref.read(documentUploadApiProvider),
      uploader: ref.read(objectUploaderProvider),
      purpose: widget.slot.purpose,
      photo: photo,
    );
    await _run();
  }

  Future<void> _run() async {
    final job = _job;
    if (job == null) return;
    final l10n = context.l10n;
    setState(() {
      _error = null;
      _stage = UploadStage.sending;
      _progress = 0;
    });
    try {
      final documentId = await job.run(
        onProgress: (stage, progress) {
          if (mounted) {
            setState(() {
              _stage = stage;
              _progress = progress;
            });
          }
        },
      );
      if (mounted) setState(() => _stage = UploadStage.attaching);
      await ref
          .read(vehicleApiProvider)
          .attach(widget.vehicle.id, widget.slot, documentId, expiresOn: _expiresOn);
      _job = null;
      ref.invalidate(vehicleProvider(widget.vehicle.id));
    } on Object catch (error) {
      if (error is PhotoRejected) _job = null;
      if (mounted) setState(() => _error = vehicleFailureMessage(l10n, error));
    } finally {
      if (mounted) setState(() => _stage = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final evidence = widget.vehicle.evidenceFor(widget.slot);
    final document = evidence?.document;
    final status = switch (document) {
      null => l10n.photoMissing,
      final d when d.usableForSubmission => l10n.photoReady,
      final d
          when d.reviewStatus == ReviewStatus.submitted ||
              d.reviewStatus == ReviewStatus.underReview =>
        l10n.photoInReview,
      final d when d.reviewStatus == ReviewStatus.approved => l10n.photoReady,
      _ => l10n.photoNeedsReplacement,
    };
    final canPick = widget.canChange && !_busy;
    final label = evidenceSlotLabel(l10n, widget.slot);
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: theme.textTheme.titleSmall),
            if (widget.slot == EvidenceSlot.ownership) Text(l10n.vehicleSlotOwnershipHint),
            const SizedBox(height: 4),
            Text(status),
            if (evidence?.expiresOn != null) Text(l10n.vehicleExpiryValue(evidence!.expiresOn!)),
            if (_busy) ...[
              const SizedBox(height: 12),
              LinearProgressIndicator(value: _stage == UploadStage.sending ? _progress : null),
              const SizedBox(height: 4),
              Text(switch (_stage!) {
                UploadStage.sending => l10n.photoSending((_progress * 100).round()),
                UploadStage.checking => l10n.photoChecking,
                UploadStage.attaching => l10n.photoAttaching,
              }),
            ],
            if (_error != null) ...[
              const SizedBox(height: 12),
              Semantics(
                liveRegion: true,
                child: Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
              ),
              if (_job != null)
                TextButton(onPressed: _busy ? null : _run, child: Text(l10n.photoRetryAction)),
            ],
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton.icon(
                  onPressed: canPick ? () => _pick(PhotoSource.camera) : null,
                  icon: const Icon(Icons.photo_camera_outlined),
                  label: Text(l10n.photoTakeAction),
                ),
                OutlinedButton.icon(
                  onPressed: canPick ? () => _pick(PhotoSource.gallery) : null,
                  icon: const Icon(Icons.photo_library_outlined),
                  label: Text(l10n.photoGalleryAction),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
