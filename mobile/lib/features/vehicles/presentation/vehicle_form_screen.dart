import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/l10n/l10n.dart';
import '../../../app/routes.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../../core/widgets/primary_button.dart';
import '../data/vehicle_api.dart';
import 'vehicle_labels.dart';

/// Create ([vehicleId] null) or change a vehicle. Client checks mirror the API's and are only
/// a convenience: the server validates everything again. VIN and engine number are only
/// typed, never shown back.
class VehicleFormScreen extends ConsumerWidget {
  const VehicleFormScreen({this.vehicleId, super.key});

  final String? vehicleId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final id = vehicleId;
    return Scaffold(
      appBar: AppBar(
        title: Text(id == null ? l10n.vehicleFormTitleNew : l10n.vehicleFormTitleEdit),
      ),
      body: SafeArea(
        child: id == null
            ? const _Form(existing: null)
            : AsyncValueView(
                value: ref.watch(vehicleProvider(id)),
                onRetry: () => ref.invalidate(vehicleProvider(id)),
                data: (vehicle) => _Form(existing: vehicle),
              ),
      ),
    );
  }
}

class _Form extends ConsumerStatefulWidget {
  const _Form({required this.existing});

  final Vehicle? existing;

  @override
  ConsumerState<_Form> createState() => _FormState();
}

class _FormState extends ConsumerState<_Form> {
  final _form = GlobalKey<FormState>();
  late String _type = widget.existing?.type ?? 'SEDAN';
  late String _transmission = widget.existing?.transmission ?? 'MANUAL';
  late String _fuel = widget.existing?.fuel ?? 'PETROL';
  late final _make = TextEditingController(text: widget.existing?.make);
  late final _model = TextEditingController(text: widget.existing?.model);
  late final _year = TextEditingController(text: widget.existing?.year.toString());
  late final _color = TextEditingController(text: widget.existing?.color);
  late final _seats = TextEditingController(text: widget.existing?.seats.toString() ?? '5');
  late final _region = TextEditingController(text: widget.existing?.plateRegion);
  late final _code = TextEditingController(text: widget.existing?.plateCode);
  late final _number = TextEditingController(text: widget.existing?.plateNumber);
  final _vin = TextEditingController();
  final _engine = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    for (final c in [
      _make,
      _model,
      _year,
      _color,
      _seats,
      _region,
      _code,
      _number,
      _vin,
      _engine,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  String? _text(String? value, {required int max, bool optional = false}) {
    if ((value ?? '').trim().isEmpty) return optional ? null : context.l10n.vehicleFieldRequired;
    return validDisplayText(value!, max: max) ? null : context.l10n.vehicleTextInvalid;
  }

  String? _plate(String? value) {
    if ((value ?? '').trim().isEmpty) return context.l10n.vehicleFieldRequired;
    return validPlatePart(value!) ? null : context.l10n.vehiclePlateInvalid;
  }

  Future<void> _save() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    final l10n = context.l10n;
    final messenger = ScaffoldMessenger.of(context);
    final router = GoRouter.of(context);
    final existing = widget.existing;
    final vin = _vin.text.trim().isEmpty ? null : normalizeVin(_vin.text);
    final engine = _engine.text.trim().isEmpty ? null : normalizeEngineNumber(_engine.text);
    final input = VehicleInput(
      type: _type,
      make: _make.text.trim(),
      model: _model.text.trim(),
      year: int.parse(_year.text.trim()),
      color: _color.text.trim().isEmpty ? null : _color.text.trim(),
      seats: int.parse(_seats.text.trim()),
      transmission: _transmission,
      fuel: _fuel,
      plateRegion: _region.text.trim(),
      plateCode: _code.text.trim(),
      plateNumber: _number.text.trim(),
      vin: vin,
      engineNumber: engine,
    );
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final api = ref.read(vehicleApiProvider);
      final Vehicle saved = existing == null
          ? await api.create(input)
          : await api.update(existing.id, existing.version, input);
      if (!mounted) return;
      _vin.clear();
      _engine.clear();
      ref.invalidate(vehiclesProvider);
      ref.invalidate(vehicleProvider(saved.id));
      messenger.showSnackBar(SnackBar(content: Text(l10n.vehicleSaved)));
      if (existing == null) {
        unawaited(router.pushReplacement(AppRoutes.vehicle(saved.id)));
      } else {
        router.pop();
      }
    } on Object catch (error) {
      if (mounted) setState(() => _error = vehicleFailureMessage(l10n, error));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final existing = widget.existing;
    final year = DateTime.now().year;

    DropdownButtonFormField<String> dropdown(
      String label,
      String value,
      List<String> values,
      String Function(String) text,
      ValueChanged<String> onChanged,
    ) => DropdownButtonFormField<String>(
      initialValue: value,
      isExpanded: true,
      decoration: InputDecoration(labelText: label),
      items: [for (final v in values) DropdownMenuItem(value: v, child: Text(text(v)))],
      onChanged: (v) => v == null ? null : setState(() => onChanged(v)),
    );

    return Form(
      key: _form,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (existing?.status == VehicleStatus.approved) ...[
            Text(l10n.vehicleApprovedChangeWarning),
            const SizedBox(height: 12),
          ],
          dropdown(
            l10n.vehicleTypeLabel,
            _type,
            vehicleTypes,
            (v) => vehicleTypeLabel(l10n, v),
            (v) => _type = v,
          ),
          TextFormField(
            controller: _make,
            decoration: InputDecoration(labelText: l10n.vehicleMakeLabel),
            maxLength: 60,
            textCapitalization: TextCapitalization.words,
            validator: (v) => _text(v, max: 60),
          ),
          TextFormField(
            controller: _model,
            decoration: InputDecoration(labelText: l10n.vehicleModelLabel),
            maxLength: 60,
            textCapitalization: TextCapitalization.words,
            validator: (v) => _text(v, max: 60),
          ),
          TextFormField(
            controller: _year,
            decoration: InputDecoration(labelText: l10n.vehicleYearLabel),
            keyboardType: TextInputType.number,
            maxLength: 4,
            validator: (v) {
              final n = int.tryParse((v ?? '').trim());
              return n == null || n < 1980 || n > year + 1 ? l10n.vehicleYearInvalid : null;
            },
          ),
          TextFormField(
            controller: _color,
            decoration: InputDecoration(labelText: l10n.vehicleColorLabel),
            maxLength: 30,
            validator: (v) => _text(v, max: 30, optional: true),
          ),
          TextFormField(
            controller: _seats,
            decoration: InputDecoration(labelText: l10n.vehicleSeatsLabel),
            keyboardType: TextInputType.number,
            maxLength: 2,
            validator: (v) {
              final n = int.tryParse((v ?? '').trim());
              return n == null || n < 1 || n > 60 ? l10n.vehicleSeatsInvalid : null;
            },
          ),
          dropdown(
            l10n.vehicleTransmissionLabel,
            _transmission,
            vehicleTransmissions,
            (v) => transmissionLabel(l10n, v),
            (v) => _transmission = v,
          ),
          dropdown(
            l10n.vehicleFuelLabel,
            _fuel,
            vehicleFuels,
            (v) => fuelLabel(l10n, v),
            (v) => _fuel = v,
          ),
          const SizedBox(height: 16),
          Text(l10n.vehiclePlateTitle, style: theme.textTheme.titleMedium),
          TextFormField(
            controller: _region,
            decoration: InputDecoration(labelText: l10n.vehiclePlateRegionLabel),
            maxLength: 12,
            textCapitalization: TextCapitalization.characters,
            validator: _plate,
          ),
          TextFormField(
            controller: _code,
            decoration: InputDecoration(labelText: l10n.vehiclePlateCodeLabel),
            maxLength: 12,
            textCapitalization: TextCapitalization.characters,
            validator: _plate,
          ),
          TextFormField(
            controller: _number,
            decoration: InputDecoration(labelText: l10n.vehiclePlateNumberLabel),
            maxLength: 12,
            textCapitalization: TextCapitalization.characters,
            validator: _plate,
          ),
          const SizedBox(height: 8),
          TextFormField(
            controller: _vin,
            decoration: InputDecoration(
              labelText: l10n.vehicleVinLabel,
              helperText: existing?.vinMasked == null
                  ? null
                  : l10n.vehicleVinHelperKeep(existing!.vinMasked!),
            ),
            maxLength: 40,
            autocorrect: false,
            enableSuggestions: false,
            textCapitalization: TextCapitalization.characters,
            validator: (v) => (v ?? '').trim().isEmpty || normalizeVin(v!) != null
                ? null
                : l10n.vehicleVinInvalid,
          ),
          TextFormField(
            controller: _engine,
            decoration: InputDecoration(
              labelText: l10n.vehicleEngineLabel,
              helperText: existing?.engineNumberOnFile ?? false
                  ? l10n.vehicleEngineHelperKeep
                  : null,
            ),
            maxLength: 40,
            autocorrect: false,
            enableSuggestions: false,
            textCapitalization: TextCapitalization.characters,
            validator: (v) => (v ?? '').trim().isEmpty || normalizeEngineNumber(v!) != null
                ? null
                : l10n.vehicleEngineInvalid,
          ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Semantics(
              liveRegion: true,
              child: Text(_error!, style: TextStyle(color: theme.colorScheme.error)),
            ),
          ],
          const SizedBox(height: 16),
          PrimaryButton(label: l10n.saveAction, isLoading: _saving, onPressed: _save),
        ],
      ),
    );
  }
}
