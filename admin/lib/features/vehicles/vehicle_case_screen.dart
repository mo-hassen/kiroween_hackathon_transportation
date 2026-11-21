import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/l10n/l10n.dart';
import '../../app/shell.dart';
import '../../core/api.dart';
import '../drivers/case_detail_screen.dart' show documentViewerProvider;
import '../drivers/decision_dialogs.dart' show askViewReason;
import '../drivers/driver_review_api.dart' show CaseDocument;
import 'vehicle_decision_dialogs.dart';
import 'vehicle_review_api.dart';

/// One vehicle case: details, owner, documents and photos opened on demand with a reason
/// (short-lived URLs), history and the decisions allowed now. The server re-checks every rule.
class VehicleCaseScreen extends ConsumerStatefulWidget {
  const VehicleCaseScreen({required this.caseId, super.key});

  final String caseId;

  @override
  ConsumerState<VehicleCaseScreen> createState() => _VehicleCaseScreenState();
}

class _VehicleCaseScreenState extends ConsumerState<VehicleCaseScreen> {
  VehicleCaseDetail? _case;
  ApiFailure? _loadFailure;
  String? _actionError;
  bool _busy = false;

  VehicleReviewApi get _api => ref.read(vehicleReviewApiProvider);

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loadFailure = null);
    try {
      final detail = await _api.detail(widget.caseId);
      if (mounted) setState(() => _case = detail);
    } on ApiFailure catch (failure) {
      if (mounted) setState(() => _loadFailure = failure);
    }
  }

  Future<void> _run(Future<void> Function() action, {bool announce = false}) async {
    setState(() {
      _busy = true;
      _actionError = null;
    });
    try {
      await action();
      if (announce && mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(context.l10n.decisionSaved)));
      }
    } on ApiFailure catch (failure) {
      if (mounted) setState(() => _actionError = failureText(context.l10n, failure));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
    await _load();
  }

  Future<void> _decide(VehicleDecisionKind kind) async {
    final decision = await askVehicleDecision(context, kind);
    if (decision == null) return;
    final id = widget.caseId;
    await _run(announce: true, () {
      return switch (kind) {
        VehicleDecisionKind.approve => _api.approve(id, note: decision.note),
        VehicleDecisionKind.reject => _api.reject(
          id,
          reasonCode: decision.reasonCode!,
          note: decision.note,
        ),
        VehicleDecisionKind.suspend => _api.suspend(
          id,
          reasonCode: decision.reasonCode!,
          note: decision.note!,
        ),
        VehicleDecisionKind.reinstate => _api.reinstate(id, note: decision.note!),
      };
    });
  }

  Future<void> _view(CaseDocument document) async {
    final reason = await askViewReason(context);
    if (reason == null || !mounted) return;
    setState(() => _actionError = null);
    try {
      final url = await _api.documentUrl(widget.caseId, document.id, reason: reason);
      if (!mounted) return;
      await ref.read(documentViewerProvider).show(context, url, isPdf: document.isPdf);
    } on ApiFailure catch (failure) {
      if (mounted) setState(() => _actionError = failureText(context.l10n, failure));
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final detail = _case;
    if (detail == null) {
      return _loadFailure == null
          ? const Center(child: CircularProgressIndicator())
          : FailureView(message: failureText(l10n, _loadFailure!), onRetry: _load);
    }
    final s = detail.summary;
    final theme = Theme.of(context);
    final reviewing = s.underMyReview;
    // Evidence opens for the claim holder while the case is open, for any officer once decided.
    final canView = reviewing || !(s.status == 'SUBMITTED' || s.status == 'UNDER_REVIEW');

    Widget field(String label, String? value) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 220, child: Text(label, style: theme.textTheme.bodySmall)),
          Expanded(child: SelectableText(value ?? '—')),
        ],
      ),
    );
    Widget section(String title, List<Widget> children) => Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            ...children,
          ],
        ),
      ),
    );
    Widget button(
      String label,
      VehicleDecisionKind kind, {
      bool tonal = false,
      bool outlined = false,
    }) {
      final onPressed = _busy ? null : () => _decide(kind);
      if (outlined) return OutlinedButton(onPressed: onPressed, child: Text(label));
      if (tonal) return FilledButton.tonal(onPressed: onPressed, child: Text(label));
      return FilledButton(onPressed: onPressed, child: Text(label));
    }

    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text(l10n.vehicleCaseTitle, style: theme.textTheme.headlineSmall),
        const SizedBox(height: 8),
        Text(
          [
            s.plate,
            statusText(l10n, s.status),
            if (s.claimedByMe) l10n.claimedByYou,
            if (s.claimedByOther) l10n.claimedByOther,
          ].join(' · '),
        ),
        if (detail.decisionReasonCode != null) Text(reasonText(l10n, detail.decisionReasonCode!)),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            if (s.canClaim)
              FilledButton(
                onPressed: _busy ? null : () => _run(() => _api.claim(widget.caseId)),
                child: Text(l10n.claimAction),
              ),
            if (reviewing) ...[
              button(l10n.approveVehicleAction, VehicleDecisionKind.approve),
              button(l10n.rejectAction, VehicleDecisionKind.reject, tonal: true),
              OutlinedButton(
                onPressed: _busy ? null : () => _run(() => _api.release(widget.caseId)),
                child: Text(l10n.releaseAction),
              ),
            ],
            if (s.status == 'APPROVED')
              button(l10n.suspendVehicleAction, VehicleDecisionKind.suspend, outlined: true),
            if (s.status == 'SUSPENDED')
              button(l10n.reinstateVehicleAction, VehicleDecisionKind.reinstate),
          ],
        ),
        if (_actionError != null) ...[
          const SizedBox(height: 12),
          Text(_actionError!, style: TextStyle(color: theme.colorScheme.error)),
        ],
        const SizedBox(height: 16),
        section(l10n.vehicleSection, [
          field(l10n.vehicleTypeLabel, vehicleTypeText(l10n, s.vehicleType)),
          field(l10n.plateLabel, s.plate),
          field(l10n.makeLabel, s.make),
          field(l10n.modelLabel, s.model),
          field(l10n.yearLabel, '${s.year}'),
          field(l10n.colorLabel, detail.color),
          field(l10n.seatsLabel, '${detail.seats}'),
          field(l10n.transmissionLabel, detail.transmission),
          field(l10n.fuelLabel, detail.fuelType),
          field(l10n.vinLabel, detail.vin ?? detail.vinMasked),
          field(l10n.engineNumberLabel, detail.engineNumber),
          if (detail.vin == null) Text(l10n.vinMaskedHint) else Text(l10n.identifiersAuditedHint),
          field(l10n.eligibilityLabel, detail.eligible ? l10n.eligibleYes : l10n.eligibleNo),
          if (detail.approvalBlockers.isNotEmpty)
            field(l10n.approvalBlockersLabel, detail.approvalBlockers.join(', ')),
        ]),
        section(l10n.vehicleOwnerSection, [
          field(l10n.nameLabel, s.ownerName),
          field(l10n.ownerVerificationLabel, statusText(l10n, detail.ownerVerificationStatus)),
          field(l10n.identityStatusLabel, statusText(l10n, detail.identityStatus)),
          field(l10n.accountStatusLabel, detail.accountStatus),
          field(l10n.phoneLabel, detail.ownerPhone),
        ]),
        section(l10n.vehicleEvidenceSection, [
          for (final item in detail.evidence)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                children: [
                  SizedBox(width: 260, child: Text(evidenceSlotText(l10n, item.slot))),
                  Expanded(
                    child: Text(
                      item.document == null
                          ? (item.required ? l10n.missingDocument : '—')
                          : [
                              item.document!.mimeType,
                              if (item.expiresOn != null) l10n.evidenceValidUntil(item.expiresOn!),
                            ].join(' · '),
                    ),
                  ),
                  if (item.document != null && canView)
                    OutlinedButton(
                      onPressed: _busy ? null : () => _view(item.document!),
                      child: Text(l10n.viewDocumentAction),
                    ),
                ],
              ),
            ),
        ]),
        section(l10n.historySection, [
          for (final event in detail.history)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Text(
                [
                  formatTimestamp(event.at),
                  event.action,
                  statusText(l10n, event.toStatus),
                  if (event.reasonCode != null) reasonText(l10n, event.reasonCode!),
                  if (event.note != null) event.note!,
                ].join(' · '),
              ),
            ),
        ]),
      ],
    );
  }
}
