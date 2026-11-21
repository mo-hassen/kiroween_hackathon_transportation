import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/l10n/l10n.dart';
import '../../app/shell.dart';
import '../../core/api.dart';
import '../drivers/case_detail_screen.dart' show documentViewerProvider;
import '../drivers/decision_dialogs.dart' show askViewReason;
import '../drivers/driver_review_api.dart' show CaseDocument;
import 'owner_decision_dialogs.dart';
import 'owner_review_api.dart';

/// One owner case: representative identity, organization details (TIN masked), documents
/// opened on demand with a reason, approvals, history and the decisions allowed now. The
/// server re-checks every rule, including the four-eyes requirement.
class OwnerCaseScreen extends ConsumerStatefulWidget {
  const OwnerCaseScreen({required this.caseId, super.key});

  final String caseId;

  @override
  ConsumerState<OwnerCaseScreen> createState() => _OwnerCaseScreenState();
}

class _OwnerCaseScreenState extends ConsumerState<OwnerCaseScreen> {
  OwnerCaseDetail? _case;
  ApiFailure? _loadFailure;
  String? _actionError;
  bool _busy = false;

  OwnerReviewApi get _api => ref.read(ownerReviewApiProvider);

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

  Future<void> _decide(OwnerDecisionKind kind) async {
    final decision = await askOwnerDecision(context, kind);
    if (decision == null) return;
    final id = widget.caseId;
    await _run(announce: true, () {
      return switch (kind) {
        OwnerDecisionKind.approveIndividual => _api.approveIndividual(id, note: decision.note),
        OwnerDecisionKind.firstApproval => _api.firstApproval(id, note: decision.note),
        OwnerDecisionKind.secondApproval => _api.secondApproval(id, note: decision.note),
        OwnerDecisionKind.reject => _api.reject(
          id,
          reasonCode: decision.reasonCode!,
          note: decision.note,
        ),
        OwnerDecisionKind.suspend => _api.suspend(
          id,
          reasonCode: decision.reasonCode!,
          note: decision.note!,
        ),
        OwnerDecisionKind.reinstate => _api.reinstate(id, note: decision.note!),
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
    final pending = s.status == 'PENDING';
    final reviewing = pending && s.claimedByMe;
    // Documents: the claim holder while pending, anyone with owners.review once decided.
    final canView = reviewing || !pending;

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
      OwnerDecisionKind kind, {
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
        Text(l10n.ownerCaseTitle, style: theme.textTheme.headlineSmall),
        const SizedBox(height: 8),
        Text(
          [
            ownerTypeText(l10n, s.ownerType),
            statusText(l10n, s.status),
            if (s.awaitingSecondApproval) l10n.awaitingSecondBadge,
            if (s.firstApprovedByMe) l10n.firstApprovedByYouBadge,
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
              if (!s.isOrganization)
                button(l10n.approveOwnerAction, OwnerDecisionKind.approveIndividual),
              if (s.isOrganization && !s.awaitingSecondApproval)
                button(l10n.firstApprovalAction, OwnerDecisionKind.firstApproval),
              if (s.isOrganization && s.awaitingSecondApproval && !s.firstApprovedByMe)
                button(l10n.secondApprovalAction, OwnerDecisionKind.secondApproval),
              button(l10n.rejectAction, OwnerDecisionKind.reject, tonal: true),
              OutlinedButton(
                onPressed: _busy ? null : () => _run(() => _api.release(widget.caseId)),
                child: Text(l10n.releaseAction),
              ),
            ],
            if (s.status == 'VERIFIED')
              button(l10n.suspendOwnerAction, OwnerDecisionKind.suspend, outlined: true),
            if (s.status == 'SUSPENDED')
              button(l10n.reinstateOwnerAction, OwnerDecisionKind.reinstate),
          ],
        ),
        if (_actionError != null) ...[
          const SizedBox(height: 12),
          Text(_actionError!, style: TextStyle(color: theme.colorScheme.error)),
        ],
        const SizedBox(height: 16),
        section(l10n.representativeSection, [
          field(l10n.nameLabel, s.displayName),
          field(l10n.verifiedNameLabel, detail.identityVerifiedName),
          field(l10n.identityStatusLabel, statusText(l10n, detail.identityStatus)),
          field(l10n.accountStatusLabel, detail.accountStatus),
          field(l10n.phoneLabel, detail.representativePhone),
        ]),
        if (s.isOrganization)
          section(l10n.organizationSection, [
            field(l10n.organizationNameLabel, s.organizationName),
            field(l10n.tinLabel, detail.tinMasked),
          ]),
        section(l10n.documentsSection, [
          if (detail.documents.isEmpty) Text(l10n.noDocumentsRequired),
          for (final slot in detail.documents)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                children: [
                  SizedBox(width: 260, child: Text(ownerDocumentText(l10n, slot.purpose))),
                  Expanded(child: Text(slot.document?.mimeType ?? l10n.missingDocument)),
                  if (slot.document != null && canView)
                    OutlinedButton(
                      onPressed: _busy ? null : () => _view(slot.document!),
                      child: Text(l10n.viewDocumentAction),
                    ),
                ],
              ),
            ),
        ]),
        if (s.isOrganization || detail.verifiedAt != null)
          section(l10n.approvalsSection, [
            if (s.isOrganization)
              field(
                l10n.firstApprovalLabel,
                detail.firstApprovedAt == null
                    ? l10n.firstApprovalNone
                    : [
                        formatTimestamp(detail.firstApprovedAt!),
                        if (s.firstApprovedByMe) l10n.firstApprovedByYouBadge,
                        if (detail.firstApprovalNote != null) detail.firstApprovalNote!,
                      ].join(' · '),
              ),
            field(
              l10n.verifiedAtLabel,
              detail.verifiedAt == null ? null : formatTimestamp(detail.verifiedAt!),
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
