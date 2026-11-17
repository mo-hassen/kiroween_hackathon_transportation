import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../app/l10n/l10n.dart';
import '../../app/routes.dart';
import '../../core/widgets/state_views.dart';

/// Shown for unknown routes and deep links that the app does not handle.
class NotFoundScreen extends StatelessWidget {
  const NotFoundScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.notFoundTitle)),
      body: EmptyView(
        icon: Icons.link_off,
        title: l10n.notFoundTitle,
        message: l10n.notFoundBody,
        action: FilledButton(
          onPressed: () => context.go(AppRoutes.welcome),
          child: Text(l10n.goHomeAction),
        ),
      ),
    );
  }
}
