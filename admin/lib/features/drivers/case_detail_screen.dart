import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/l10n/l10n.dart';
import '../../app/shell.dart';
import '../../core/api.dart';
import 'decision_dialogs.dart';
import 'driver_review_api.dart';

/// Opens a short-lived document URL. Replaceable in tests (no network images there).
abstract interface class DocumentViewer {
  Future<void> show(BuildContext context, Uri url, {required bool isPdf});
}

final class BrowserDocumentViewer implements DocumentViewer {
  const BrowserDocumentViewer();

  @override
  Future<void> show(BuildContext context, Uri url, {required bool isPdf}) async {
    if (isPdf) {
      // A new tab; the link stops working after 60 s and the response is `no-store`.
      await launchUrl(url, webOnlyWindowName: '_blank');
      return;
    }
    if (!context.mounted) return;
    await showDialog<void>(
      context: context,
      builder: (_) => _ImagePreviewDialog(url: url),
    );
  }
}

final documentViewerProvider = Provider<DocumentViewer>((ref) => const BrowserDocumentViewer());

class _ImagePreviewDialog extends StatelessWidget {
  const _ImagePreviewDialog({required this.url});

  final Uri url;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return AlertDialog(
      content: SizedBox(
        width: 900,
        height: 640,
        child: Column(
          children: [
            Text(l10n.documentLinkExpires),
            const SizedBox(height: 8),
            Expanded(
              child: InteractiveViewer(
                maxScale: 5,
                // An <img> element: the storage origin needs no CORS rule, and the
                // `private, no-store` response header keeps it out of the browser cache.
                child: Image.network(
                  url.toString(),
                  webHtmlElementStrategy: WebHtmlElementStrategy.prefer,
                  errorBuilder: (_, _, _) => Center(child: Text(l10n.errorServer)),
                ),
              ),
            ),
          ],
        ),
      ),
      actions: [TextButton(onPressed: () => Navigator.pop(context), child: Text(l10n.closeAction))],
    );
  }
}

/// One driver licence case: details, documents (opened on demand with a reason), history and
/// the decisions allowed in the current state. The server re-checks every rule.
class CaseDetailScreen extends ConsumerStatefulWidget {
  const CaseDetailScreen({required this.caseId, super.key});

  final String caseId;

  @override
  ConsumerState<CaseDetailScreen> createState() => _CaseDetailScreenState();
}

class _CaseDetailScreenState extends ConsumerState<CaseDetailScreen> {
  CaseDetail? _case;
  ApiFailure? _loadFailure;
  String? _actionError;
  bool _busy = false;

  DriverReviewApi get _api => ref.read(driverReviewApiProvider);

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

  Future<void> _decide(DecisionKind kind) async {
    final decision = await askDecision(context, kind);
    if (decision == null) return;
    final id = widget.caseId;
    await _run(announce: true, () {
      return switch (kind) {
        DecisionKind.approve => _api.approve(id, note: decision.note),
        DecisionKind.reject => _api.reject(
          id,
          reasonCode: decision.reasonCode!,
          note: decision.note,
        ),
        DecisionKind.suspend => _api.suspend(
          id,
          reasonCode: decision.reasonCode!,
          note: decision.note!,
        ),
        DecisionKind.reinstate => _api.reinstate(id, note: decision.note!),
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
    final decided = const {'APPROVED', 'REJECTED', 'SUSPENDED', 'EXPIRED'}.contains(s.status);
    final canView = s.claimedByMe || decided;
    final canClaim =
        s.status == 'SUBMITTED' ||
        (s.status == 'UNDER_REVIEW' && !s.claimedByMe && !s.claimedByOther);
    final reviewing = s.status == 'UNDER_REVIEW' && s.claimedByMe;
    final theme = Theme.of(context);

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
    Widget documentRow(String label, CaseDocument? document) => Row(
      children: [
        SizedBox(width: 220, child: Text(label)),
        Expanded(child: Text(document == null ? l10n.missingDocument : document.mimeType)),
        if (document != null && canView)
          OutlinedButton(
            onPressed: _busy ? null : () => _view(document),
            child: Text(l10n.viewDocumentAction),
          ),
      ],
    );

    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text(l10n.caseTitle, style: theme.textTheme.headlineSmall),
        const SizedBox(height: 8),
        Text(
          [
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
            if (canClaim)
              FilledButton(
                onPressed: _busy ? null : () => _run(() => _api.claim(widget.caseId)),
                child: Text(l10n.claimAction),
              ),
            if (reviewing) ...[
              FilledButton(
                onPressed: _busy ? null : () => _decide(DecisionKind.approve),
                child: Text(l10n.approveAction),
              ),
              FilledButton.tonal(
                onPressed: _busy ? null : () => _decide(DecisionKind.reject),
                child: Text(l10n.rejectAction),
              ),
              OutlinedButton(
                onPressed: _busy ? null : () => _run(() => _api.release(widget.caseId)),
                child: Text(l10n.releaseAction),
              ),
            ],
            if (s.status == 'APPROVED')
              OutlinedButton(
                onPressed: _busy ? null : () => _decide(DecisionKind.suspend),
                child: Text(l10n.suspendAction),
              ),
            if (s.status == 'SUSPENDED')
              FilledButton(
                onPressed: _busy ? null : () => _decide(DecisionKind.reinstate),
                child: Text(l10n.reinstateAction),
              ),
          ],
        ),
        if (_actionError != null) ...[
          const SizedBox(height: 12),
          Text(_actionError!, style: TextStyle(color: theme.colorScheme.error)),
        ],
        const SizedBox(height: 16),
        section(l10n.driverSection, [
          field(l10n.nameLabel, s.driverName),
          field(l10n.verifiedNameLabel, detail.identityVerifiedName),
          field(l10n.identityStatusLabel, detail.identityStatus),
          field(l10n.phoneLabel, detail.driverPhone),
          field(l10n.yearsLicensedLabel, detail.yearsLicensed?.toString()),
          field(l10n.subCityLabel, detail.homeSubCity),
        ]),
        section(l10n.licenseSection, [
          field(l10n.licenseNumberLabel, detail.licenseNumber),
          field(l10n.categoriesLabel, detail.categories.join(', ')),
          field(l10n.issuedOnLabel, detail.issuedOn),
          field(l10n.expiresOnLabel, s.expiresOn),
          field(l10n.authorityLabel, detail.issuingAuthority),
        ]),
        section(l10n.documentsSection, [
          documentRow(l10n.frontLabel, detail.front),
          const SizedBox(height: 8),
          documentRow(l10n.backLabel, detail.back),
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
