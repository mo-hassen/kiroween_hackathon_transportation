import 'package:flutter/material.dart';

import '../../app/l10n/l10n.dart';
import '../drivers/decision_dialogs.dart' show Decision, maxNoteLength, minNoteLength;
import 'owner_review_api.dart';

enum OwnerDecisionKind {
  approveIndividual,
  firstApproval,
  secondApproval,
  reject,
  suspend,
  reinstate,
}

/// Confirmation dialog for an owner decision. Returns null when cancelled.
Future<Decision?> askOwnerDecision(BuildContext context, OwnerDecisionKind kind) =>
    showDialog<Decision>(
      context: context,
      barrierDismissible: false,
      builder: (_) => OwnerDecisionDialog(kind: kind),
    );

class OwnerDecisionDialog extends StatefulWidget {
  const OwnerDecisionDialog({required this.kind, super.key});

  final OwnerDecisionKind kind;

  @override
  State<OwnerDecisionDialog> createState() => _OwnerDecisionDialogState();
}

class _OwnerDecisionDialogState extends State<OwnerDecisionDialog> {
  final _note = TextEditingController();
  late final List<bool> _checks = List.filled(_checkCount, false);
  String? _reason;

  int get _checkCount => switch (widget.kind) {
    OwnerDecisionKind.approveIndividual => 1,
    OwnerDecisionKind.firstApproval || OwnerDecisionKind.secondApproval => 4,
    _ => 0,
  };

  bool get _noteRequired =>
      widget.kind == OwnerDecisionKind.suspend || widget.kind == OwnerDecisionKind.reinstate;

  bool get _valid {
    final noteOk = !_noteRequired || _note.text.trim().length >= minNoteLength;
    final needsReason =
        widget.kind == OwnerDecisionKind.reject || widget.kind == OwnerDecisionKind.suspend;
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
      OwnerDecisionKind.approveIndividual => (l10n.approveOwnerTitle, null),
      OwnerDecisionKind.firstApproval => (l10n.firstApprovalTitle, l10n.firstApprovalWarning),
      OwnerDecisionKind.secondApproval => (l10n.secondApprovalTitle, l10n.secondApprovalWarning),
      OwnerDecisionKind.reject => (l10n.rejectOwnerTitle, l10n.rejectOwnerWarning),
      OwnerDecisionKind.suspend => (l10n.suspendOwnerTitle, l10n.suspendOwnerWarning),
      OwnerDecisionKind.reinstate => (l10n.reinstateOwnerTitle, null),
    };
    final checkLabels = switch (widget.kind) {
      OwnerDecisionKind.approveIndividual => [l10n.checkIndividualIdentity],
      OwnerDecisionKind.firstApproval || OwnerDecisionKind.secondApproval => [
        l10n.checkRepresentativeIdentity,
        l10n.checkOrganizationDocuments,
        l10n.checkOrganizationDetails,
        l10n.checkRepresentativeAuthorized,
      ],
      _ => const <String>[],
    };
    final reasons = switch (widget.kind) {
      OwnerDecisionKind.reject => ownerRejectReasons,
      OwnerDecisionKind.suspend => ownerSuspendReasons,
      _ => const <String>[],
    };
    final noteLabel = switch (widget.kind) {
      OwnerDecisionKind.reject => l10n.noteForDriverLabel,
      OwnerDecisionKind.suspend || OwnerDecisionKind.reinstate => l10n.internalNoteLabel,
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
