import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/l10n/l10n.dart';
import '../../app/routes.dart';
import '../../core/l10n/locale_controller.dart';
import '../../core/widgets/primary_button.dart';
import '../system_status/presentation/service_status_card.dart';

/// First screen for signed-out users: product summary, sign-in and registration.
class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final textTheme = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.appTitle), actions: const [LanguageMenuButton()]),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text(l10n.welcomeHeadline, style: textTheme.headlineSmall),
            const SizedBox(height: 12),
            Text(l10n.welcomeBody, style: textTheme.bodyLarge),
            const SizedBox(height: 24),
            PrimaryButton(
              label: l10n.createAccountAction,
              onPressed: () => context.push(AppRoutes.register),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton(
                onPressed: () => context.push(AppRoutes.login),
                child: Text(l10n.signInAction),
              ),
            ),
            const SizedBox(height: 24),
            const ServiceStatusCard(),
          ],
        ),
      ),
    );
  }
}

enum _LanguageChoice { system, english, amharic }

/// Lets the user switch between English and Amharic; persisted on the device.
class LanguageMenuButton extends ConsumerWidget {
  const LanguageMenuButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final current = switch (ref.watch(localeControllerProvider)?.languageCode) {
      'en' => _LanguageChoice.english,
      'am' => _LanguageChoice.amharic,
      _ => _LanguageChoice.system,
    };
    return PopupMenuButton<_LanguageChoice>(
      tooltip: l10n.languageMenuTooltip,
      icon: const Icon(Icons.translate),
      initialValue: current,
      onSelected: (choice) => ref.read(localeControllerProvider.notifier).select(switch (choice) {
        _LanguageChoice.system => null,
        _LanguageChoice.english => const Locale('en'),
        _LanguageChoice.amharic => const Locale('am'),
      }),
      itemBuilder: (context) => [
        PopupMenuItem(value: _LanguageChoice.system, child: Text(l10n.languageSystem)),
        PopupMenuItem(value: _LanguageChoice.english, child: Text(l10n.languageEnglish)),
        PopupMenuItem(value: _LanguageChoice.amharic, child: Text(l10n.languageAmharic)),
      ],
    );
  }
}
