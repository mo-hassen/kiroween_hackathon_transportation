import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/l10n/l10n.dart';
import '../../../app/routes.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../../core/widgets/primary_button.dart';
import '../../auth/presentation/login_screen.dart' show InfoBanner;
import '../../driver/presentation/driver_labels.dart' show decisionReasonLabel;
import '../../welcome/welcome_screen.dart';
import '../data/owner_api.dart';
import 'owner_labels.dart';

/// Owner onboarding hub: status, guidance, details, documents and the next step. Everything
/// comes from `GET /owners/me`; the server decides what is allowed.
class OwnerScreen extends ConsumerWidget {
  const OwnerScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final profile = ref.watch(ownerProfileProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.ownerTitle), actions: const [LanguageMenuButton()]),
      body: SafeArea(
        child: AsyncValueView(
          value: profile,
          onRetry: () => ref.invalidate(ownerProfileProvider),
          data: (owner) => RefreshIndicator(
            onRefresh: () => ref.refresh(ownerProfileProvider.future),
            child: owner == null ? const _Intro() : _Hub(owner: owner),
          ),
        ),
      ),
    );
  }
}

Future<void> _open(BuildContext context, WidgetRef ref, String route) async {
  await context.push(route);
  ref.invalidate(ownerProfileProvider);
}

class _Intro extends ConsumerWidget {
  const _Intro();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text(l10n.ownerIntroTitle, style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 12),
        Text(l10n.ownerIntroBody),
        const SizedBox(height: 24),
        PrimaryButton(
          label: l10n.driverStartAction,
          onPressed: () => _open(context, ref, AppRoutes.ownerDetails),
        ),
      ],
    );
  }
}

class _Hub extends ConsumerWidget {
  const _Hub({required this.owner});

  final OwnerProfile owner;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final guidance = ownerStatusGuidance(l10n, owner.status);
    final icon = switch (owner.status) {
      OwnerStatus.verified => Icons.verified_outlined,
      OwnerStatus.suspended => Icons.block,
      OwnerStatus.rejected => Icons.error_outline,
      _ => Icons.hourglass_empty,
    };
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 16),
      children: [
        Card(
          margin: const EdgeInsets.symmetric(horizontal: 16),
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(icon),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        ownerStatusLabel(l10n, owner.status),
                        style: theme.textTheme.titleMedium,
                      ),
                    ),
                  ],
                ),
                if (owner.decisionReasonCode != null) ...[
                  const SizedBox(height: 8),
                  Text(l10n.decisionReason(decisionReasonLabel(l10n, owner.decisionReasonCode!))),
                ],
                // Plain text only: officer notes are never rendered as markup or links.
                if (owner.decisionNote != null) Text(l10n.officerNoteLabel(owner.decisionNote!)),
                if (guidance != null) ...[const SizedBox(height: 8), Text(guidance)],
                if (owner.editable)
                  for (final problem in owner.submissionProblems)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(Icons.chevron_right, size: 20),
                          const SizedBox(width: 4),
                          Expanded(child: Text(ownerProblemLabel(l10n, problem))),
                        ],
                      ),
                    ),
              ],
            ),
          ),
        ),
        if (!owner.identityVerified) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
            child: InfoBanner(l10n.identityRequiredBanner),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: OutlinedButton(
              onPressed: () => _open(context, ref, AppRoutes.identity),
              child: Text(l10n.identityGoAction),
            ),
          ),
        ],
        const SizedBox(height: 8),
        ListTile(
          leading: Icon(owner.isOrganization ? Icons.business_outlined : Icons.person_outline),
          title: Text(owner.organizationName ?? ownerTypeLabel(l10n, owner.type)),
          subtitle: Text(
            [
              ownerTypeLabel(l10n, owner.type),
              if (owner.tinMasked != null) '${l10n.tinLabel} ${owner.tinMasked}',
            ].join(' · '),
          ),
          trailing: owner.editable ? const Icon(Icons.chevron_right) : null,
          onTap: owner.editable ? () => _open(context, ref, AppRoutes.ownerDetails) : null,
        ),
        if (owner.isOrganization && owner.editable)
          ListTile(
            leading: const Icon(Icons.photo_camera_outlined),
            title: Text(l10n.ownerDocumentsAction),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _open(context, ref, AppRoutes.ownerDocuments),
          ),
        if (owner.readyToSubmit)
          Padding(
            padding: const EdgeInsets.all(16),
            child: PrimaryButton(
              label: l10n.ownerReviewAction,
              onPressed: () => _open(context, ref, AppRoutes.ownerReview),
            ),
          ),
      ],
    );
  }
}
