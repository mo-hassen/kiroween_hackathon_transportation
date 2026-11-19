import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/l10n/l10n.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../../core/widgets/primary_button.dart';
import '../data/driver_api.dart';
import 'driver_labels.dart';

/// Creates the driver profile (first visit) or edits it (If-Match with the shown version).
class DriverProfileScreen extends ConsumerWidget {
  const DriverProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(driverProfileProvider);
    return Scaffold(
      appBar: AppBar(title: Text(context.l10n.driverProfileTitle)),
      body: SafeArea(
        child: AsyncValueView(
          value: profile,
          onRetry: () => ref.invalidate(driverProfileProvider),
          data: (driver) => _ProfileForm(existing: driver),
        ),
      ),
    );
  }
}

class _ProfileForm extends ConsumerStatefulWidget {
  const _ProfileForm({required this.existing});

  final DriverProfile? existing;

  @override
  ConsumerState<_ProfileForm> createState() => _ProfileFormState();
}

class _ProfileFormState extends ConsumerState<_ProfileForm> {
  final _form = GlobalKey<FormState>();
  late final _years = TextEditingController(text: widget.existing?.yearsLicensed?.toString() ?? '');
  late final _bio = TextEditingController(text: widget.existing?.bio ?? '');
  late String? _subCity = widget.existing?.homeSubCity;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _years.dispose();
    _bio.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    final l10n = context.l10n;
    final messenger = ScaffoldMessenger.of(context);
    final input = ProfileInput(
      yearsLicensed: _years.text.trim().isEmpty ? null : int.parse(_years.text.trim()),
      bio: _bio.text.trim(),
      homeSubCity: _subCity,
    );
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final api = ref.read(driverApiProvider);
      final existing = widget.existing;
      if (existing == null) {
        await api.createProfile(input);
      } else {
        await api.updateProfile(existing.version, input);
      }
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(l10n.profileSaved)));
      context.pop();
    } on Object catch (error) {
      if (mounted) setState(() => _error = driverFailureMessage(l10n, error));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Form(
      key: _form,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextFormField(
            controller: _years,
            decoration: InputDecoration(labelText: l10n.yearsLicensedLabel),
            keyboardType: TextInputType.number,
            inputFormatters: [
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(2),
            ],
            validator: (value) {
              final text = value?.trim() ?? '';
              if (text.isEmpty) return null;
              final years = int.tryParse(text);
              return years == null || years > 60 ? l10n.yearsLicensedInvalid : null;
            },
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<String?>(
            initialValue: _subCity,
            isExpanded: true,
            decoration: InputDecoration(labelText: l10n.subCityLabel),
            items: [
              DropdownMenuItem(child: Text(l10n.subCityNone)),
              for (final code in addisSubCities)
                DropdownMenuItem(value: code, child: Text(subCityLabel(l10n, code))),
            ],
            onChanged: (value) => setState(() => _subCity = value),
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _bio,
            decoration: InputDecoration(labelText: l10n.bioLabel),
            maxLength: 500,
            maxLines: 3,
          ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ],
          const SizedBox(height: 16),
          PrimaryButton(label: l10n.saveAction, isLoading: _saving, onPressed: _save),
        ],
      ),
    );
  }
}
