import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/l10n/l10n.dart';
import '../../../app/routes.dart';
import '../../../core/widgets/async_value_view.dart';
import '../../../core/widgets/primary_button.dart';
import '../../auth/presentation/login_screen.dart' show InfoBanner;
import '../../welcome/welcome_screen.dart';
import '../data/driver_api.dart';
import 'driver_labels.dart';

/// Driver onboarding hub: eligibility, profile, licence status and the next step.
/// Everything shown comes from `GET /drivers/me`; the server decides what is allowed.
class DriverScreen extends ConsumerWidget {
  const DriverScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final profile = ref.watch(driverProfileProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.driverTitle), actions: const [LanguageMenuButton()]),
      body: SafeArea(
        child: AsyncValueView(
          value: profile,
          onRetry: () => ref.invalidate(driverProfileProvider),
          data: (driver) => RefreshIndicator(
            onRefresh: () => ref.refresh(driverProfileProvider.future),
            child: driver == null ? const _Intro() : _Hub(driver: driver),
          ),
        ),
      ),
    );
  }
}

Future<void> _open(BuildContext context, WidgetRef ref, String route) async {
  await context.push(route);
  ref.invalidate(driverProfileProvider);
}

class _Intro extends ConsumerWidget {
  const _Intro();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text(l10n.driverIntroTitle, style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 12),
        Text(l10n.driverIntroBody),
        const SizedBox(height: 24),
        PrimaryButton(
          label: l10n.driverStartAction,
          onPressed: () => _open(context, ref, AppRoutes.driverProfile),
        ),
      ],
    );
  }
}

class _Hub extends ConsumerWidget {
  const _Hub({required this.driver});

  final DriverProfile driver;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final license = driver.license;
    final (eligibilityTitle, eligibilityIcon) = switch (driver.eligibility) {
      Eligibility.eligible => (l10n.driverEligibleTitle, Icons.check_circle_outline),
      Eligibility.suspended => (l10n.driverSuspendedTitle, Icons.block),
      _ => (l10n.driverIneligibleTitle, Icons.hourglass_empty),
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
                    Icon(eligibilityIcon),
                    const SizedBox(width: 12),
                    Expanded(child: Text(eligibilityTitle, style: theme.textTheme.titleMedium)),
                  ],
                ),
                if (driver.eligibility == Eligibility.suspended) ...[
                  const SizedBox(height: 8),
                  if (driver.suspendedReason != null)
                    Text(l10n.decisionReason(decisionReasonLabel(l10n, driver.suspendedReason!))),
                  Text(l10n.driverSuspendedBody),
                ] else
                  for (final blocker in driver.blockers)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Icon(Icons.chevron_right, size: 20),
                          const SizedBox(width: 4),
                          Expanded(child: Text(blockerLabel(l10n, blocker))),
                        ],
                      ),
                    ),
              ],
            ),
          ),
        ),
        if (!driver.identityVerified)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
            child: InfoBanner(l10n.identityRequiredBanner),
          ),
        if (!driver.identityVerified)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: OutlinedButton(
              onPressed: () => _open(context, ref, AppRoutes.identity),
              child: Text(l10n.identityGoAction),
            ),
          ),
        const SizedBox(height: 8),
        ListTile(
          leading: const Icon(Icons.person_outline),
          title: Text(l10n.driverProfileSection),
          subtitle: Text(
            [
              if (driver.yearsLicensed != null)
                '${l10n.yearsLicensedLabel}: ${driver.yearsLicensed}',
              if (driver.homeSubCity != null) subCityLabel(l10n, driver.homeSubCity!),
            ].join(' · '),
          ),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => _open(context, ref, AppRoutes.driverProfile),
        ),
        const Divider(),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: Text(l10n.licenseSection, style: theme.textTheme.titleMedium),
        ),
        if (license == null)
          ListTile(
            leading: const Icon(Icons.add_card_outlined),
            title: Text(l10n.licenseAddAction),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _open(context, ref, AppRoutes.driverLicense),
          )
        else ...[
          _LicenseStatus(license: license),
          if (license.editable) ...[
            ListTile(
              leading: const Icon(Icons.edit_outlined),
              title: Text(l10n.licenseEditAction),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => _open(context, ref, AppRoutes.driverLicense),
            ),
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: Text(l10n.licensePhotosAction),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => _open(context, ref, AppRoutes.driverPhotos),
            ),
          ],
          if (license.readyToSubmit)
            Padding(
              padding: const EdgeInsets.all(16),
              child: PrimaryButton(
                label: l10n.licenseReviewAction,
                onPressed: () => _open(context, ref, AppRoutes.driverReview),
              ),
            ),
        ],
      ],
    );
  }
}

class _LicenseStatus extends StatelessWidget {
  const _LicenseStatus({required this.license});

  final DriverLicense license;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(l10n.licenseNumberMasked(license.numberMasked)),
          Text(l10n.licenseExpiresOn(license.expiresOn)),
          const SizedBox(height: 8),
          Text(
            licenseStatusLabel(l10n, license.status),
            style: Theme.of(context).textTheme.titleSmall,
          ),
          if (license.status == ReviewStatus.rejected) ...[
            if (license.decisionReasonCode != null)
              Text(l10n.decisionReason(decisionReasonLabel(l10n, license.decisionReasonCode!))),
            // Plain text only: officer notes are never rendered as markup or links.
            if (license.decisionNote != null) Text(l10n.officerNoteLabel(license.decisionNote!)),
            const SizedBox(height: 4),
            Text(l10n.licenseRejectedBody),
          ],
        ],
      ),
    );
  }
}
