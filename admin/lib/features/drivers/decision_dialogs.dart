import 'package:flutter/material.dart';

import '../../app/l10n/l10n.dart';
import 'driver_review_api.dart';

const minNoteLength = 10;
const maxNoteLength = 1000;

typedef Decision = ({String? reasonCode, String? note});

String? _trimmedOrNull(String text) => text.trim().isEmpty ? null : text.trim();

/// Asks why a document is being opened (audited server-side, 10–500 characters).
Future<String?> askViewReason(BuildContext context) => showDialog<String>(
  context: context,
  builder: (_) => const _TextPromptDialog(minLength: minNoteLength, maxLength: 500),
);

class _TextPromptDialog extends StatefulWidget {
  const _TextPromptDialog({required this.minLength, required this.maxLength});

  final int minLength;
  final int maxLength;

  @override
  State<_TextPromptDialog> createState() => _TextPromptDialogState();
}

class _TextPromptDialogState extends State<_TextPromptDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  bool get _valid => _controller.text.trim().length >= widget.minLength;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return AlertDialog(
      title: Text(l10n.viewReasonTitle),
      content: SizedBox(
        width: 420,
        child: TextField(
          controller: _controller,
          autofocus: true,
          maxLength: widget.maxLength,
          decoration: InputDecoration(helperText: l10n.viewReasonHint),
          onChanged: (_) => setState(() {}),
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: Text(l10n.cancelAction)),
        FilledButton(
          onPressed: _valid ? () => Navigator.pop(context, _controller.text.trim()) : null,
          child: Text(l10n.confirmAction),
        ),
      ],
    );
  }
}

enum DecisionKind { approve, reject, suspend, reinstate }

/// Confirmation dialog for a decision. Returns null when cancelled.
Future<Decision?> askDecision(BuildContext context, DecisionKind kind) => showDialog<Decision>(
  context: context,
  barrierDismissible: false,
  builder: (_) => DecisionDialog(kind: kind),
);

class DecisionDialog extends StatefulWidget {
  const DecisionDialog({required this.kind, super.key});

  final DecisionKind kind;

  @override
  State<DecisionDialog> createState() => _DecisionDialogState();
}

class _DecisionDialogState extends State<DecisionDialog> {
  final _note = TextEditingController();
  final _checks = [false, false, false];
  String? _reason;

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  bool get _noteRequired =>
      widget.kind == DecisionKind.suspend || widget.kind == DecisionKind.reinstate;

  bool get _valid {
    final noteOk = !_noteRequired || _note.text.trim().length >= minNoteLength;
    return switch (widget.kind) {
      DecisionKind.approve => _checks.every((c) => c),
      DecisionKind.reject => _reason != null,
      DecisionKind.suspend => _reason != null && noteOk,
      DecisionKind.reinstate => noteOk,
    };
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final (title, warning) = switch (widget.kind) {
      DecisionKind.approve => (l10n.approveTitle, l10n.approveWarning),
      DecisionKind.reject => (l10n.rejectTitle, l10n.rejectWarning),
      DecisionKind.suspend => (l10n.suspendTitle, l10n.suspendWarning),
      DecisionKind.reinstate => (l10n.reinstateTitle, null),
    };
    final reasons = switch (widget.kind) {
      DecisionKind.reject => rejectReasons,
      DecisionKind.suspend => suspendReasons,
      _ => const <String>[],
    };
    final noteLabel = switch (widget.kind) {
      DecisionKind.approve => l10n.noteLabel,
      DecisionKind.reject => l10n.noteForDriverLabel,
      DecisionKind.suspend || DecisionKind.reinstate => l10n.internalNoteLabel,
    };
    final checkLabels = [l10n.checkIdentity, l10n.checkDocuments, l10n.checkDetails];
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
              if (widget.kind == DecisionKind.approve)
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
                  note: _trimmedOrNull(_note.text),
                ))
              : null,
          child: Text(l10n.confirmAction),
        ),
      ],
    );
  }
}
