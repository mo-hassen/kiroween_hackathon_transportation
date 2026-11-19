import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/l10n/l10n.dart';
import '../../app/shell.dart';
import '../../core/api.dart';
import 'driver_review_api.dart';

const queueStatuses = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED', 'EXPIRED'];

/// The review queue: filter by status, search by name/phone, page through, claim or release.
class QueueScreen extends ConsumerStatefulWidget {
  const QueueScreen({this.initialStatus, super.key});

  final String? initialStatus;

  @override
  ConsumerState<QueueScreen> createState() => _QueueScreenState();
}

class _QueueScreenState extends ConsumerState<QueueScreen> {
  final _search = TextEditingController();
  String? _status;
  String _query = '';
  int _page = 1;
  CasePage? _data;
  ApiFailure? _failure;
  bool _loading = false;
  String? _actionError;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _status = queueStatuses.contains(widget.initialStatus) ? widget.initialStatus : 'SUBMITTED';
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  DriverReviewApi get _api => ref.read(driverReviewApiProvider);

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _loading = true;
      _failure = null;
    });
    try {
      final page = await _api.list(status: _status, query: _query, page: _page);
      if (!mounted || generation != _generation) return;
      setState(() => _data = page);
    } on ApiFailure catch (failure) {
      if (!mounted || generation != _generation) return;
      setState(() => _failure = failure);
    } finally {
      if (mounted && generation == _generation) setState(() => _loading = false);
    }
  }

  Future<void> _act(Future<void> Function() action, {String? openId}) async {
    setState(() => _actionError = null);
    try {
      await action();
      if (!mounted) return;
      if (openId != null) {
        context.go('/drivers/${Uri.encodeComponent(openId)}');
        return;
      }
    } on ApiFailure catch (failure) {
      if (!mounted) return;
      setState(() => _actionError = failureText(context.l10n, failure));
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final data = _data;
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(l10n.queueTitle, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 16),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              DropdownButton<String?>(
                value: _status,
                onChanged: (value) {
                  _status = value;
                  _page = 1;
                  _load();
                },
                items: [
                  DropdownMenuItem(child: Text(l10n.statusAll)),
                  for (final status in queueStatuses)
                    DropdownMenuItem(value: status, child: Text(statusText(l10n, status))),
                ],
              ),
              SizedBox(
                width: 280,
                child: TextField(
                  controller: _search,
                  decoration: InputDecoration(labelText: l10n.searchLabel),
                  onSubmitted: (_) => _applySearch(),
                ),
              ),
              OutlinedButton(onPressed: _applySearch, child: Text(l10n.searchAction)),
              if (_loading)
                const SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
            ],
          ),
          if (_actionError != null) ...[
            const SizedBox(height: 12),
            Text(_actionError!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
          ],
          const SizedBox(height: 16),
          Expanded(
            child: _failure != null
                ? FailureView(message: failureText(l10n, _failure!), onRetry: _load)
                : data == null
                ? const SizedBox.shrink()
                : data.items.isEmpty
                ? Center(child: Text(l10n.noCases))
                : ListView.separated(
                    itemCount: data.items.length,
                    separatorBuilder: (_, _) => const Divider(height: 1),
                    itemBuilder: (_, index) => _row(data.items[index]),
                  ),
          ),
          if (data != null && data.total > 0)
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                Text(l10n.pageOf(data.page, data.pages)),
                const SizedBox(width: 12),
                TextButton(
                  onPressed: _page > 1 && !_loading ? () => _goToPage(_page - 1) : null,
                  child: Text(l10n.previousPage),
                ),
                TextButton(
                  onPressed: _page < data.pages && !_loading ? () => _goToPage(_page + 1) : null,
                  child: Text(l10n.nextPage),
                ),
              ],
            ),
        ],
      ),
    );
  }

  void _applySearch() {
    _query = _search.text.trim();
    _page = 1;
    _load();
  }

  void _goToPage(int page) {
    _page = page;
    _load();
  }

  Widget _row(CaseSummary item) {
    final l10n = context.l10n;
    final subtitle = [
      statusText(l10n, item.status),
      if (item.submittedAt != null) l10n.submittedOn(formatTimestamp(item.submittedAt!)),
      if (item.claimedByMe) l10n.claimedByYou,
      if (item.claimedByOther) l10n.claimedByOther,
    ].join(' · ');
    final canClaim =
        item.status == 'SUBMITTED' ||
        (item.status == 'UNDER_REVIEW' && !item.claimedByMe && !item.claimedByOther);
    return ListTile(
      title: Text(item.driverName ?? '—'),
      subtitle: Text(subtitle),
      trailing: Wrap(
        spacing: 8,
        children: [
          if (canClaim)
            FilledButton(
              onPressed: () => _act(() => _api.claim(item.id), openId: item.id),
              child: Text(l10n.claimAction),
            ),
          if (item.claimedByMe)
            OutlinedButton(
              onPressed: () => _act(() => _api.release(item.id)),
              child: Text(l10n.releaseAction),
            ),
          TextButton(
            onPressed: () => context.go('/drivers/${Uri.encodeComponent(item.id)}'),
            child: Text(l10n.openAction),
          ),
        ],
      ),
    );
  }
}
