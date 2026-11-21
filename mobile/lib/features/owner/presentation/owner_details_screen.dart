import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/l10n/l10n.dart';
import '../../../core/network/api_failure.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../../core/widgets/primary_button.dart';
import '../data/owner_api.dart';
import 'owner_labels.dart';

/// Owner type and, for organizations, name and TIN. Creates the profile on first save,
/// otherwise updates it with If-Match. The full TIN is never shown (only typed).
class OwnerDetailsScreen extends ConsumerWidget {
  const OwnerDetailsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(ownerProfileProvider);
    return Scaffold(
      appBar: AppBar(title: Text(context.l10n.ownerDetailsTitle)),
      body: SafeArea(
        child: AsyncValueView(
          value: profile,
          onRetry: () => ref.invalidate(ownerProfileProvider),
          data: (owner) => _DetailsForm(existing: owner),
        ),
      ),
    );
  }
}

class _DetailsForm extends ConsumerStatefulWidget {
  const _DetailsForm({required this.existing});

  final OwnerProfile? existing;

  @override
  ConsumerState<_DetailsForm> createState() => _DetailsFormState();
}

class _DetailsFormState extends ConsumerState<_DetailsForm> {
  final _form = GlobalKey<FormState>();
  late OwnerType _type = widget.existing?.type ?? OwnerType.individual;
  late final _name = TextEditingController(text: widget.existing?.organizationName ?? '');
  final _tin = TextEditingController();
  bool _saving = false;
  String? _error;
  ApiFailure? _serverFailure;

  bool get _typeLocked => widget.existing != null && !widget.existing!.typeChangeAllowed;

  /// A TIN must be typed when none is stored for an organization yet.
  bool get _tinRequired =>
      _type == OwnerType.organization && (widget.existing?.type != OwnerType.organization);

  @override
  void dispose() {
    _name.dispose();
    _tin.dispose();
    super.dispose();
  }

  String? _serverField(String field) {
    final failure = _serverFailure;
    if (failure is! ValidationFailure) return null;
    final l10n = context.l10n;
    if (!failure.fieldErrors.any((e) => e.field == field)) return null;
    return field == 'tin' ? l10n.tinInvalid : l10n.organizationNameInvalid;
  }

  Future<void> _save() async {
    setState(() => _serverFailure = null);
    if (!(_form.currentState?.validate() ?? false)) return;
    final l10n = context.l10n;
    final messenger = ScaffoldMessenger.of(context);
    final existing = widget.existing;
    final organization = _type == OwnerType.organization;
    final tin = _tin.text.trim().isEmpty ? null : normalizeTin(_tin.text);
    final input = OwnerInput(
      type: existing == null || _type != existing.type ? _type : null,
      organizationName: organization ? _name.text.trim() : null,
      tin: organization ? tin : null,
    );
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final api = ref.read(ownerApiProvider);
      if (existing == null) {
        await api.create(
          OwnerInput(type: _type, organizationName: input.organizationName, tin: input.tin),
        );
      } else {
        await api.update(existing.version, input);
      }
      if (!mounted) return;
      _tin.clear();
      messenger.showSnackBar(SnackBar(content: Text(l10n.profileSaved)));
      context.pop();
    } on Object catch (error) {
      if (!mounted) return;
      final failure = error is ApiFailure ? error : null;
      setState(() {
        _serverFailure = failure;
        _error = failure is ValidationFailure && failure.fieldErrors.isNotEmpty
            ? null
            : ownerFailureMessage(l10n, error);
      });
      _form.currentState?.validate();
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final existing = widget.existing;
    Widget option(OwnerType type, String title, String hint) =>
        RadioListTile<OwnerType>(value: type, title: Text(title), subtitle: Text(hint));
    return Form(
      key: _form,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(l10n.ownerTypeQuestion, style: theme.textTheme.titleMedium),
          if (_typeLocked) ...[const SizedBox(height: 8), Text(l10n.ownerTypeLocked)],
          RadioGroup<OwnerType>(
            groupValue: _type,
            onChanged: (value) {
              if (_typeLocked || value == null) return;
              setState(() => _type = value);
            },
            child: IgnorePointer(
              ignoring: _typeLocked,
              child: Column(
                children: [
                  option(
                    OwnerType.individual,
                    l10n.ownerTypeIndividual,
                    l10n.ownerTypeIndividualHint,
                  ),
                  option(
                    OwnerType.organization,
                    l10n.ownerTypeOrganization,
                    l10n.ownerTypeOrganizationHint,
                  ),
                ],
              ),
            ),
          ),
          if (_type == OwnerType.organization) ...[
            const SizedBox(height: 8),
            TextFormField(
              controller: _name,
              decoration: InputDecoration(labelText: l10n.organizationNameLabel),
              maxLength: 200,
              textCapitalization: TextCapitalization.words,
              validator: (value) {
                final server = _serverField('organizationName');
                if (server != null) return server;
                final length = value?.trim().length ?? 0;
                return length < 2 || length > 200 ? l10n.organizationNameInvalid : null;
              },
            ),
            TextFormField(
              controller: _tin,
              decoration: InputDecoration(
                labelText: l10n.tinLabel,
                helperText: existing?.tinMasked != null && !_tinRequired
                    ? l10n.tinHelperKeep(existing!.tinMasked!)
                    : l10n.tinHelperNew,
              ),
              maxLength: 40,
              autocorrect: false,
              enableSuggestions: false,
              textCapitalization: TextCapitalization.characters,
              validator: (value) {
                final server = _serverField('tin');
                if (server != null) return server;
                final text = value?.trim() ?? '';
                if (text.isEmpty) return _tinRequired ? l10n.tinInvalid : null;
                return normalizeTin(text) == null ? l10n.tinInvalid : null;
              },
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
          ],
          const SizedBox(height: 16),
          PrimaryButton(label: l10n.saveAction, isLoading: _saving, onPressed: _save),
        ],
      ),
    );
  }
}
