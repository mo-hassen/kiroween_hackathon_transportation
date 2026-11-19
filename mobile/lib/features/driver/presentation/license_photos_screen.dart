import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/l10n/l10n.dart';
import '../../../core/widgets/async_value_view.dart';
import '../data/driver_api.dart';
import '../data/license_upload.dart';
import 'driver_labels.dart';

/// Front and back photos of the licence: pick (camera or gallery), upload with progress,
/// server check, attach. A failed step can be retried without picking the photo again.
class LicensePhotosScreen extends ConsumerWidget {
  const LicensePhotosScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final profile = ref.watch(driverProfileProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.licensePhotosAction)),
      body: SafeArea(
        child: AsyncValueView(
          value: profile,
          onRetry: () => ref.invalidate(driverProfileProvider),
          data: (driver) {
            final license = driver?.license;
            if (license == null) return const SizedBox.shrink();
            return ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Text(l10n.photosIntro),
                const SizedBox(height: 16),
                for (final side in LicenseSide.values)
                  _SideCard(key: ValueKey(side), license: license, side: side),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _SideCard extends ConsumerStatefulWidget {
  const _SideCard({required this.license, required this.side, super.key});

  final DriverLicense license;
  final LicenseSide side;

  @override
  ConsumerState<_SideCard> createState() => _SideCardState();
}

class _SideCardState extends ConsumerState<_SideCard> {
  LicenseUploadJob? _job;
  UploadStage? _stage;
  double _progress = 0;
  String? _error;

  bool get _busy => _stage != null;

  Future<void> _pick(PhotoSource source) async {
    final l10n = context.l10n;
    setState(() => _error = null);
    final PickedPhoto? photo;
    try {
      photo = await ref.read(licensePhotoPickerProvider).pick(source);
    } on Object catch (error) {
      if (mounted) setState(() => _error = driverFailureMessage(l10n, error));
      return;
    }
    if (photo == null || !mounted) return;
    _job = LicenseUploadJob(
      api: ref.read(driverApiProvider),
      uploader: ref.read(objectUploaderProvider),
      licenseId: widget.license.id,
      side: widget.side,
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
      await job.run(
        onProgress: (stage, progress) {
          if (mounted) {
            setState(() {
              _stage = stage;
              _progress = progress;
            });
          }
        },
      );
      _job = null;
      ref.invalidate(driverProfileProvider);
    } on Object catch (error) {
      // A refused file cannot be retried: the user must pick a new photo.
      if (error is PhotoRejected) _job = null;
      if (mounted) setState(() => _error = driverFailureMessage(l10n, error));
    } finally {
      if (mounted) setState(() => _stage = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final document = widget.license.document(widget.side);
    final status = switch (document) {
      null => l10n.photoMissing,
      final d when d.usableForSubmission => l10n.photoReady,
      final d
          when d.reviewStatus == ReviewStatus.submitted ||
              d.reviewStatus == ReviewStatus.underReview =>
        l10n.photoInReview,
      _ => l10n.photoNeedsReplacement,
    };
    final canPick = widget.license.editable && !_busy;
    return Card(
      margin: const EdgeInsets.only(bottom: 16),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(sideLabel(l10n, widget.side), style: theme.textTheme.titleMedium),
            const SizedBox(height: 4),
            Text(status),
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
              Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
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
