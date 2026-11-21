import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/l10n/l10n.dart';
import '../../app/shell.dart';
import '../../core/api.dart';
import 'owner_review_api.dart';

/// Owner review queue: filter by status and type (or cases awaiting a second approval),
/// search, page through, claim or release.
class OwnerQueueScreen extends ConsumerStatefulWidget {
  const OwnerQueueScreen({
    this.initialStatus,
    this.initialType,
    this.awaitingSecond = false,
    super.key,
  });

  final String? initialStatus;
  final String? initialType;
  final bool awaitingSecond;

  @override
  ConsumerState<OwnerQueueScreen> createState() => _OwnerQueueScreenState();
}

class _OwnerQueueScreenState extends ConsumerState<OwnerQueueScreen> {
  final _search = TextEditingController();
  String? _status;
  String? _type;
  late bool _awaitingSecond = widget.awaitingSecond;
  String _query = '';
  int _page = 1;
  OwnerCasePage? _data;
  ApiFailure? _failure;
  bool _loading = false;
  String? _actionError;
  int _generation = 0;

  OwnerReviewApi get _api => ref.read(ownerReviewApiProvider);

  @override
  void initState() {
    super.initState();
    _status = ownerStatuses.contains(widget.initialStatus) ? widget.initialStatus : 'PENDING';
    _type = const ['INDIVIDUAL', 'ORGANIZATION'].contains(widget.initialType)
        ? widget.initialType
        : null;
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final generation = ++_generation;
    setState(() {
      _loading = true;
      _failure = null;
    });
    try {
      final page = await _api.list(
        status: _awaitingSecond ? 'PENDING' : _status,
        ownerType: _type,
        awaitingSecondApproval: _awaitingSecond ? true : null,
        query: _query,
        page: _page,
      );
      if (mounted && generation == _generation) setState(() => _data = page);
    } on ApiFailure catch (failure) {
      if (mounted && generation == _generation) setState(() => _failure = failure);
    } finally {
      if (mounted && generation == _generation) setState(() => _loading = false);
    }
  }

  void _reload({bool resetPage = true}) {
    if (resetPage) _page = 1;
    _load();
  }

  Future<void> _act(Future<void> Function() action, {String? openId}) async {
    setState(() => _actionError = null);
    try {
      await action();
      if (!mounted) return;
      if (openId != null) {
        context.go('/owners/${Uri.encodeComponent(openId)}');
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
          Text(l10n.ownersQueueTitle, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 16),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              DropdownButton<String?>(
                key: const ValueKey('owner-status'),
                value: _status,
                onChanged: _awaitingSecond
                    ? null
                    : (value) {
                        _status = value;
                        _reload();
                      },
                items: [
                  DropdownMenuItem(child: Text(l10n.statusAll)),
                  for (final status in ownerStatuses)
                    DropdownMenuItem(value: status, child: Text(statusText(l10n, status))),
                ],
              ),
              DropdownButton<String?>(
                key: const ValueKey('owner-type'),
                value: _type,
                onChanged: (value) {
                  _type = value;
                  _reload();
                },
                items: [
                  DropdownMenuItem(child: Text(l10n.ownerTypeAll)),
                  DropdownMenuItem(value: 'INDIVIDUAL', child: Text(l10n.ownerTypeIndividual)),
                  DropdownMenuItem(value: 'ORGANIZATION', child: Text(l10n.ownerTypeOrganization)),
                ],
              ),
              FilterChip(
                label: Text(l10n.filterAwaitingSecond),
                selected: _awaitingSecond,
                onSelected: (value) {
                  _awaitingSecond = value;
                  _reload();
                },
              ),
              SizedBox(
                width: 280,
                child: TextField(
                  controller: _search,
                  decoration: InputDecoration(labelText: l10n.searchOwnerLabel),
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
    _reload();
  }

  void _goToPage(int page) {
    _page = page;
    _load();
  }

  Widget _row(OwnerCaseSummary item) {
    final l10n = context.l10n;
    final subtitle = [
      ownerTypeText(l10n, item.ownerType),
      statusText(l10n, item.status),
      if (item.submittedAt != null) l10n.submittedOn(formatTimestamp(item.submittedAt!)),
      if (item.awaitingSecondApproval) l10n.awaitingSecondBadge,
      if (item.firstApprovedByMe) l10n.firstApprovedByYouBadge,
      if (item.claimedByMe) l10n.claimedByYou,
      if (item.claimedByOther) l10n.claimedByOther,
    ].join(' · ');
    return ListTile(
      title: Text(item.organizationName ?? item.displayName ?? '—'),
      subtitle: Text(subtitle),
      trailing: Wrap(
        spacing: 8,
        children: [
          if (item.canClaim)
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
            onPressed: () => context.go('/owners/${Uri.encodeComponent(item.id)}'),
            child: Text(l10n.openAction),
          ),
        ],
      ),
    );
  }
}
