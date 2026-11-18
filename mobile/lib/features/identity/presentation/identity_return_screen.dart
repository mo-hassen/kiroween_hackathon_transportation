import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/l10n/l10n.dart';
import '../../../app/routes.dart';
import '../../../core/network/api_failure.dart';
import '../../../core/widgets/state_views.dart';
import '../application/identity_flow.dart';

final _uuid = RegExp(
  r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
);
final _token = RegExp(r'^[A-Za-z0-9_-]{43}$');

/// The two values of a valid identity return link, or null.
({String verification, String confirmation})? parseIdentityReturn(Map<String, String> query) {
  final verification = query['verification'];
  final confirmation = query['confirmation'];
  if (verification == null || confirmation == null) return null;
  if (!_uuid.hasMatch(verification) || !_token.hasMatch(confirmation)) return null;
  return (verification: verification, confirmation: confirmation);
}

/// Target of `kiroweenmobility://app/identity/return?verification=<id>&confirmation=<token>`.
///
/// Sends the one-time token to the server (from this signed-in session), then shows the
/// status screen. Nothing in the link is trusted as a result: a link without a valid token
/// (provider error, cancelled, forged) just opens the status screen.
class IdentityReturnScreen extends ConsumerStatefulWidget {
  const IdentityReturnScreen({super.key, required this.query});

  final Map<String, String> query;

  @override
  ConsumerState<IdentityReturnScreen> createState() => _IdentityReturnScreenState();
}

class _IdentityReturnScreenState extends ConsumerState<IdentityReturnScreen> {
  @override
  void initState() {
    super.initState();
    unawaited(Future<void>.microtask(_finish));
  }

  Future<void> _finish() async {
    final link = parseIdentityReturn(widget.query);
    String? problem;
    if (link != null) {
      try {
        await ref.read(identityFlowProvider).confirm(link.verification, link.confirmation);
      } on ApiFailure catch (failure) {
        if (!mounted) return;
        problem = failure.isConnectivity
            ? context.l10n.errorNetwork
            : context.l10n.identityConfirmFailed;
      }
    }
    if (!mounted) return;
    final messenger = ScaffoldMessenger.maybeOf(context);
    context.go(AppRoutes.identity);
    if (problem != null) messenger?.showSnackBar(SnackBar(content: Text(problem)));
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(child: LoadingView(label: context.l10n.identityFinishing)),
  );
}
