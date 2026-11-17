import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/l10n/l10n.dart';
import '../../../app/routes.dart';
import '../../../core/auth/session_controller.dart';
import '../../../core/auth/session_state.dart';
import '../../../core/network/api_failure.dart';
import '../../../core/widgets/primary_button.dart';
import '../../welcome/welcome_screen.dart';
import '../application/auth_flows.dart';
import 'auth_messages.dart';
import 'widgets/auth_fields.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _phone = TextEditingController();
  final _password = TextEditingController();
  bool _submitting = false;
  ApiFailure? _failure;

  @override
  void dispose() {
    _phone.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_submitting || !(_formKey.currentState?.validate() ?? false)) return;
    setState(() {
      _submitting = true;
      _failure = null;
    });
    try {
      final outcome = await ref
          .read(authFlowsProvider)
          .signIn(phone: _phone.text, password: _password.text);
      if (!mounted) return;
      if (outcome is SignInNeedsCode) {
        await context.push(AppRoutes.loginVerify, extra: outcome.ticket);
      }
      // SignInCompleted: the router guard moves to the account screen.
    } on ApiFailure catch (failure) {
      if (mounted) setState(() => _failure = failure);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final session = ref.watch(sessionControllerProvider);
    final expired = session is SignedOut && session.reason == SignOutReason.sessionExpired;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.signInTitle), actions: const [LanguageMenuButton()]),
      body: SafeArea(
        child: AutofillGroup(
          child: Form(
            key: _formKey,
            child: ListView(
              padding: const EdgeInsets.all(24),
              children: [
                if (expired) ...[InfoBanner(l10n.sessionExpiredBanner), const SizedBox(height: 16)],
                PhoneField(controller: _phone, enabled: !_submitting),
                const SizedBox(height: 16),
                PasswordField(
                  controller: _password,
                  label: l10n.passwordLabel,
                  onSubmitted: _submit,
                ),
                const SizedBox(height: 16),
                if (_failure != null) ...[
                  FormErrorBanner(authFailureMessage(l10n, _failure!)),
                  const SizedBox(height: 16),
                ],
                PrimaryButton(label: l10n.signInAction, onPressed: _submit, isLoading: _submitting),
                const SizedBox(height: 8),
                TextButton(
                  onPressed: _submitting ? null : () => context.push(AppRoutes.forgotPassword),
                  child: Text(l10n.forgotPasswordAction),
                ),
                TextButton(
                  onPressed: _submitting ? null : () => context.push(AppRoutes.register),
                  child: Text(l10n.createAccountAction),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Neutral notice (not an error), e.g. "your session has ended".
class InfoBanner extends StatelessWidget {
  const InfoBanner(this.message, {super.key});

  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Semantics(
      liveRegion: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: scheme.secondaryContainer,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          children: [
            Icon(Icons.info_outline, color: scheme.onSecondaryContainer),
            const SizedBox(width: 12),
            Expanded(
              child: Text(message, style: TextStyle(color: scheme.onSecondaryContainer)),
            ),
          ],
        ),
      ),
    );
  }
}
