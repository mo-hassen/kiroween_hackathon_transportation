import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/l10n/l10n.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../documents/document_upload.dart';
import '../../driver/data/driver_api.dart' show ReviewStatus;
import '../../driver/data/license_upload.dart';
import '../data/owner_api.dart';
import 'owner_labels.dart';

/// The three organization documents: pick a photo (camera or gallery), upload with progress
/// through the shared document pipeline, then attach. A failed step can be retried without
/// picking the photo again; a refused file needs a new photo.
class OwnerDocumentsScreen extends ConsumerWidget {
  const OwnerDocumentsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final profile = ref.watch(ownerProfileProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.ownerDocumentsTitle)),
      body: SafeArea(
        child: AsyncValueView(
          value: profile,
          onRetry: () => ref.invalidate(ownerProfileProvider),
          data: (owner) {
            if (owner == null || !owner.isOrganization) return const SizedBox.shrink();
            return ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Text(l10n.ownerDocumentsIntro),
                const SizedBox(height: 16),
                for (final slot in OwnerDocumentSlot.values)
                  _SlotCard(key: ValueKey(slot), owner: owner, slot: slot),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _SlotCard extends ConsumerStatefulWidget {
  const _SlotCard({required this.owner, required this.slot, super.key});

  final OwnerProfile owner;
  final OwnerDocumentSlot slot;

  @override
  ConsumerState<_SlotCard> createState() => _SlotCardState();
}

class _SlotCardState extends ConsumerState<_SlotCard> {
  DocumentUploadJob? _job;
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
      if (mounted) setState(() => _error = ownerFailureMessage(l10n, error));
      return;
    }
    if (photo == null || !mounted) return;
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
      await ref.read(ownerApiProvider).attach(widget.slot, documentId);
      _job = null;
      ref.invalidate(ownerProfileProvider);
    } on Object catch (error) {
      if (error is PhotoRejected) _job = null;
      if (mounted) setState(() => _error = ownerFailureMessage(l10n, error));
    } finally {
      if (mounted) setState(() => _stage = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final document = widget.owner.documents[widget.slot];
    final status = switch (document) {
      null => l10n.photoMissing,
      final d when d.usableForSubmission => l10n.photoReady,
      final d
          when d.reviewStatus == ReviewStatus.submitted ||
              d.reviewStatus == ReviewStatus.underReview =>
        l10n.photoInReview,
      _ => l10n.photoNeedsReplacement,
    };
    final canPick = widget.owner.editable && !_busy;
    return Card(
      margin: const EdgeInsets.only(bottom: 16),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(ownerDocumentLabel(l10n, widget.slot), style: theme.textTheme.titleMedium),
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
