import 'package:flutter/material.dart';

import '../../app/l10n/l10n.dart';
import '../drivers/decision_dialogs.dart' show Decision, maxNoteLength, minNoteLength;
import 'vehicle_review_api.dart';

enum VehicleDecisionKind { approve, reject, suspend, reinstate }

/// Confirmation dialog for a vehicle decision. Returns null when cancelled.
Future<Decision?> askVehicleDecision(BuildContext context, VehicleDecisionKind kind) =>
    showDialog<Decision>(
      context: context,
      barrierDismissible: false,
      builder: (_) => VehicleDecisionDialog(kind: kind),
    );

class VehicleDecisionDialog extends StatefulWidget {
  const VehicleDecisionDialog({required this.kind, super.key});

  final VehicleDecisionKind kind;

  @override
  State<VehicleDecisionDialog> createState() => _VehicleDecisionDialogState();
}

class _VehicleDecisionDialogState extends State<VehicleDecisionDialog> {
  final _note = TextEditingController();
  late final List<bool> _checks = List.filled(
    widget.kind == VehicleDecisionKind.approve ? 4 : 0,
    false,
  );
  String? _reason;

  bool get _noteRequired =>
      widget.kind == VehicleDecisionKind.suspend || widget.kind == VehicleDecisionKind.reinstate;

  bool get _valid {
    final noteOk = !_noteRequired || _note.text.trim().length >= minNoteLength;
    final needsReason =
        widget.kind == VehicleDecisionKind.reject || widget.kind == VehicleDecisionKind.suspend;
    return _checks.every((c) => c) && (!needsReason || _reason != null) && noteOk;
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final (title, warning) = switch (widget.kind) {
      VehicleDecisionKind.approve => (l10n.approveVehicleTitle, l10n.approveVehicleWarning),
      VehicleDecisionKind.reject => (l10n.rejectVehicleTitle, l10n.rejectVehicleWarning),
      VehicleDecisionKind.suspend => (l10n.suspendVehicleTitle, l10n.suspendVehicleWarning),
      VehicleDecisionKind.reinstate => (l10n.reinstateVehicleTitle, null),
    };
    final checkLabels = widget.kind == VehicleDecisionKind.approve
        ? [
            l10n.checkVehicleDetailsMatch,
            l10n.checkOwnerMatchesRegistration,
            l10n.checkVehicleDocumentsLegible,
            l10n.checkPhotosMatch,
          ]
        : const <String>[];
    final reasons = switch (widget.kind) {
      VehicleDecisionKind.reject => vehicleRejectReasons,
      VehicleDecisionKind.suspend => vehicleSuspendReasons,
      _ => const <String>[],
    };
    final noteLabel = switch (widget.kind) {
      VehicleDecisionKind.reject => l10n.noteForVehicleOwnerLabel,
      VehicleDecisionKind.suspend || VehicleDecisionKind.reinstate => l10n.internalNoteLabel,
      _ => l10n.noteLabel,
    };
    return AlertDialog(
      title: Text(title),
      content: SizedBox(
        width: 480,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (warning != null) Text(warning),
              for (var i = 0; i < checkLabels.length; i++)
                CheckboxListTile(
                  value: _checks[i],
                  title: Text(checkLabels[i]),
                  controlAffinity: ListTileControlAffinity.leading,
                  onChanged: (value) => setState(() => _checks[i] = value ?? false),
                ),
              if (reasons.isNotEmpty) ...[
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _reason,
                  isExpanded: true,
                  decoration: InputDecoration(labelText: l10n.reasonLabel),
                  items: [
                    for (final code in reasons)
                      DropdownMenuItem(value: code, child: Text(reasonText(l10n, code))),
                  ],
                  onChanged: (value) => setState(() => _reason = value),
                ),
              ],
              const SizedBox(height: 12),
              TextField(
                controller: _note,
                maxLength: maxNoteLength,
                maxLines: 3,
                decoration: InputDecoration(
                  labelText: noteLabel,
                  helperText: _noteRequired ? l10n.reasonTooShort : null,
                ),
                onChanged: (_) => setState(() {}),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: Text(l10n.cancelAction)),
        FilledButton(
          onPressed: _valid
              ? () => Navigator.pop<Decision>(context, (
                  reasonCode: _reason,
                  note: _note.text.trim().isEmpty ? null : _note.text.trim(),
                ))
              : null,
          child: Text(l10n.confirmAction),
        ),
      ],
    );
  }
}
