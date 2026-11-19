import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:uuid/uuid.dart';

import '../../../app/l10n/l10n.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../../core/widgets/primary_button.dart';
import '../data/driver_api.dart';
import 'driver_labels.dart';

/// Summary and explicit confirmation before `POST .../submit`. One Idempotency-Key per
/// screen visit, so a retried tap after a timeout cannot submit twice.
class LicenseReviewScreen extends ConsumerWidget {
  const LicenseReviewScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(driverProfileProvider);
    return Scaffold(
      appBar: AppBar(title: Text(context.l10n.reviewTitle)),
      body: SafeArea(
        child: AsyncValueView(
          value: profile,
          onRetry: () => ref.invalidate(driverProfileProvider),
          data: (driver) => driver?.license == null
              ? const SizedBox.shrink()
              : _Review(license: driver!.license!),
        ),
      ),
    );
  }
}

class _Review extends ConsumerStatefulWidget {
  const _Review({required this.license});

  final DriverLicense license;

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
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await ref.read(driverApiProvider).submit(widget.license.id, idempotencyKey: _idempotencyKey);
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(l10n.submitted)));
      context.pop();
    } on Object catch (error) {
      if (mounted) setState(() => _error = driverFailureMessage(l10n, error));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final license = widget.license;
    Widget row(String label, String value) =>
        ListTile(dense: true, title: Text(label), subtitle: Text(value));
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 16),
      children: [
        Padding(padding: const EdgeInsets.symmetric(horizontal: 16), child: Text(l10n.reviewIntro)),
        const SizedBox(height: 8),
        row(l10n.licenseNumberLabel, license.numberMasked),
        row(l10n.categoriesLabel, license.categories.join(', ')),
        row(l10n.issuedOnLabel, license.issuedOn),
        row(l10n.expiresOnLabel, license.expiresOn),
        row(l10n.authorityLabel, license.issuingAuthority),
        row(
          l10n.licensePhotosAction,
          '${l10n.photoFront}: ${l10n.photoReady} · ${l10n.photoBack}: ${l10n.photoReady}',
        ),
        CheckboxListTile(
          value: _confirmed,
          onChanged: _submitting ? null : (value) => setState(() => _confirmed = value ?? false),
          title: Text(l10n.reviewConfirm),
          controlAffinity: ListTileControlAffinity.leading,
        ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ),
        Padding(
          padding: const EdgeInsets.all(16),
          child: PrimaryButton(
            label: l10n.submitAction,
            isLoading: _submitting,
            onPressed: _confirmed && license.readyToSubmit ? _submit : null,
          ),
        ),
      ],
    );
  }
}
