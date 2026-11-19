import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/l10n/l10n.dart';
import '../../../core/network/api_failure.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../../core/widgets/primary_button.dart';
import '../data/driver_api.dart';
import 'driver_labels.dart';

/// Same normalization as the API: separators removed, 4–20 letters/digits.
String? normalizeLicenseNumber(String input) {
  final value = input.toUpperCase().replaceAll(RegExp(r'[\s\-/.]'), '');
  return RegExp(r'^[A-Z0-9]{4,20}$').hasMatch(value) ? value : null;
}

/// Category codes as printed, comma separated. Not checked against an official list
/// (none is published in a machine-readable form; see docs/reports/phase-05.md L-4).
List<String>? parseCategories(String input) {
  final codes = [
    for (final part in input.split(RegExp(r'[,;\s]+')))
      if (part.trim().isNotEmpty) part.trim().toUpperCase(),
  ];
  if (codes.isEmpty || codes.length > 10) return null;
  if (!codes.every(RegExp(r'^[A-Z0-9][A-Z0-9-]{0,9}$').hasMatch)) return null;
  return codes.toSet().length == codes.length ? codes : null;
}

String isoDate(DateTime date) =>
    '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';

/// Licence details form. Creating posts a new licence; editing (allowed in DRAFT, REJECTED
/// and EXPIRED) re-sends every field, including the number, which the API never returns.
class LicenseFormScreen extends ConsumerWidget {
  const LicenseFormScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profile = ref.watch(driverProfileProvider);
    return Scaffold(
      appBar: AppBar(title: Text(context.l10n.licenseFormTitle)),
      body: SafeArea(
        child: AsyncValueView(
          value: profile,
          onRetry: () => ref.invalidate(driverProfileProvider),
          data: (driver) => _LicenseForm(existing: driver?.license),
        ),
      ),
    );
  }
}

class _LicenseForm extends ConsumerStatefulWidget {
  const _LicenseForm({required this.existing});

  final DriverLicense? existing;

  @override
  ConsumerState<_LicenseForm> createState() => _LicenseFormState();
}

class _LicenseFormState extends ConsumerState<_LicenseForm> {
  final _form = GlobalKey<FormState>();
  final _number = TextEditingController();
  late final _categories = TextEditingController(
    text: widget.existing?.categories.join(', ') ?? '',
  );
  late final _authority = TextEditingController(text: widget.existing?.issuingAuthority ?? '');
  late String? _issuedOn = widget.existing?.issuedOn;
  late String? _expiresOn = widget.existing?.expiresOn;
  bool _saving = false;
  String? _error;
  ApiFailure? _serverFailure;

  @override
  void dispose() {
    _number.dispose();
    _categories.dispose();
    _authority.dispose();
    super.dispose();
  }

  String get _today => isoDate(DateTime.now());

  String? _serverField(String field) {
    final failure = _serverFailure;
    if (failure is! ValidationFailure) return null;
    final l10n = context.l10n;
    for (final error in failure.fieldErrors.where((e) => e.field == field)) {
      return switch (error.code) {
        'IN_FUTURE' => l10n.dateInFuture,
        'BEFORE_ISSUE_DATE' => l10n.dateBeforeIssue,
        'EXPIRED' => l10n.dateExpired,
        'IS_DATE' || 'MATCHES' => l10n.dateRequired,
        _ => switch (field) {
          'licenseNumber' => l10n.licenseNumberInvalid,
          'categories' => l10n.categoriesInvalid,
          'issuingAuthority' => l10n.authorityInvalid,
          _ => null,
        },
      };
    }
    return null;
  }

  Future<void> _pickDate({required bool issue}) async {
    final now = DateTime.now();
    final current = DateTime.tryParse((issue ? _issuedOn : _expiresOn) ?? '');
    final picked = await showDatePicker(
      context: context,
      initialDate: current ?? now,
      firstDate: DateTime(now.year - 60),
      lastDate: issue ? now : DateTime(now.year + 30),
    );
    if (picked == null) return;
    setState(() {
      if (issue) {
        _issuedOn = isoDate(picked);
      } else {
        _expiresOn = isoDate(picked);
      }
    });
  }

  Future<void> _save() async {
    setState(() => _serverFailure = null);
    if (!(_form.currentState?.validate() ?? false)) return;
    final l10n = context.l10n;
    final messenger = ScaffoldMessenger.of(context);
    final input = LicenseInput(
      licenseNumber: normalizeLicenseNumber(_number.text)!,
      categories: parseCategories(_categories.text)!,
      issuedOn: _issuedOn!,
      expiresOn: _expiresOn!,
      issuingAuthority: _authority.text.trim(),
    );
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final api = ref.read(driverApiProvider);
      final existing = widget.existing;
      if (existing == null) {
        await api.createLicense(input);
      } else {
        await api.updateLicense(existing.id, existing.version, input);
      }
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(l10n.profileSaved)));
      context.pop();
    } on Object catch (error) {
      if (!mounted) return;
      final failure = error is ApiFailure ? error : null;
      setState(() {
        _serverFailure = failure;
        _error = failure is ValidationFailure && failure.fieldErrors.isNotEmpty
            ? null
            : driverFailureMessage(l10n, error);
      });
      _form.currentState?.validate();
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final existing = widget.existing;
    Widget dateField({required bool issue}) {
      final value = issue ? _issuedOn : _expiresOn;
      return FormField<String>(
        key: ValueKey('date-$issue-$value'),
        initialValue: value,
        validator: (_) {
          final server = _serverField(issue ? 'issuedOn' : 'expiresOn');
          if (server != null) return server;
          if (value == null) return l10n.dateRequired;
          if (issue && value.compareTo(_today) > 0) return l10n.dateInFuture;
          if (!issue && _issuedOn != null && value.compareTo(_issuedOn!) <= 0) {
            return l10n.dateBeforeIssue;
          }
          if (!issue && value.compareTo(_today) <= 0) return l10n.dateExpired;
          return null;
        },
        builder: (field) => InkWell(
          onTap: () => _pickDate(issue: issue),
          child: InputDecorator(
            decoration: InputDecoration(
              labelText: issue ? l10n.issuedOnLabel : l10n.expiresOnLabel,
              errorText: field.errorText,
              suffixIcon: const Icon(Icons.calendar_today_outlined),
            ),
            child: Text(value ?? ''),
          ),
        ),
      );
    }

    return Form(
      key: _form,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(l10n.licenseFormIntro),
          const SizedBox(height: 16),
          TextFormField(
            controller: _number,
            decoration: InputDecoration(
              labelText: l10n.licenseNumberLabel,
              hintText: existing?.numberMasked,
            ),
            textCapitalization: TextCapitalization.characters,
            autocorrect: false,
            enableSuggestions: false,
            maxLength: 40,
            validator: (value) =>
                _serverField('licenseNumber') ??
                (normalizeLicenseNumber(value ?? '') == null ? l10n.licenseNumberInvalid : null),
          ),
          const SizedBox(height: 8),
          TextFormField(
            controller: _categories,
            decoration: InputDecoration(
              labelText: l10n.categoriesLabel,
              helperText: l10n.categoriesHelper,
            ),
            textCapitalization: TextCapitalization.characters,
            autocorrect: false,
            validator: (value) =>
                _serverField('categories') ??
                (parseCategories(value ?? '') == null ? l10n.categoriesInvalid : null),
          ),
          const SizedBox(height: 12),
          dateField(issue: true),
          const SizedBox(height: 12),
          dateField(issue: false),
          const SizedBox(height: 12),
          TextFormField(
            controller: _authority,
            decoration: InputDecoration(labelText: l10n.authorityLabel),
            maxLength: 120,
            validator: (value) {
              final server = _serverField('issuingAuthority');
              if (server != null) return server;
              final length = value?.trim().length ?? 0;
              return length < 2 ? l10n.authorityInvalid : null;
            },
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
