import 'package:core_shared/core_shared.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/l10n/l10n.dart';
import '../../../core/network/api_failure.dart';
import '../../../core/widgets/primary_button.dart';
import '../application/auth_flows.dart';
import 'auth_messages.dart';
import 'widgets/auth_fields.dart';
import 'widgets/resend_timer.dart';

/// Password reset by SMS code. The server ends every session; this device is then
/// trusted and signed in with the new password.
class ForgotPasswordScreen extends ConsumerStatefulWidget {
  const ForgotPasswordScreen({super.key});

  @override
  ConsumerState<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

class _ForgotPasswordScreenState extends ConsumerState<ForgotPasswordScreen> {
  final _phoneForm = GlobalKey<FormState>();
  final _resetForm = GlobalKey<FormState>();
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _password = TextEditingController();
  bool _codeSent = false;
  bool _submitting = false;
  ApiFailure? _failure;

  @override
  void dispose() {
    for (final controller in [_phone, _code, _password]) {
      controller.dispose();
    }
    super.dispose();
  }

  String get _locale => Localizations.localeOf(context).languageCode;

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _submitting = true;
      _failure = null;
    });
    try {
      await action();
    } on ApiFailure catch (failure) {
      if (mounted) setState(() => _failure = failure);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _sendCode() async {
    if (_submitting || !(_phoneForm.currentState?.validate() ?? false)) return;
    await _run(() async {
      await ref.read(authFlowsProvider).requestPasswordReset(phone: _phone.text, locale: _locale);
      if (mounted) setState(() => _codeSent = true);
    });
  }

  Future<void> _reset() async {
    if (_submitting || !(_resetForm.currentState?.validate() ?? false)) return;
    await _run(
      () => ref
          .read(authFlowsProvider)
          .resetPassword(phone: _phone.text, code: _code.text, newPassword: _password.text),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final error = _failure == null ? null : authFailureMessage(l10n, _failure!);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.resetPasswordTitle)),
      body: SafeArea(
        child: _codeSent
            ? Form(
                key: _resetForm,
                child: ListView(
                  padding: const EdgeInsets.all(24),
                  children: [
                    if (normalizeEthiopianMobile(_phone.text) case final phone?)
                      Text(l10n.codeSentTo(formatEthiopianMobile(phone))),
                    const SizedBox(height: 24),
                    CodeField(controller: _code),
                    ResendCodeButton(
                      onResend: () => ref
                          .read(authFlowsProvider)
                          .requestPasswordReset(phone: _phone.text, locale: _locale),
                    ),
                    const SizedBox(height: 8),
                    PasswordField(
                      controller: _password,
                      label: l10n.newPasswordLabel,
                      isNew: true,
                      errorText: serverFieldError(l10n, _failure, 'newPassword'),
                    ),
                    const SizedBox(height: 16),
                    if (error != null &&
                        serverFieldError(l10n, _failure, 'newPassword') == null) ...[
                      FormErrorBanner(error),
                      const SizedBox(height: 16),
                    ],
                    PrimaryButton(
                      label: l10n.resetPasswordAction,
                      onPressed: _reset,
                      isLoading: _submitting,
                    ),
                  ],
                ),
              )
            : Form(
                key: _phoneForm,
                child: ListView(
                  padding: const EdgeInsets.all(24),
                  children: [
                    Text(l10n.resetPasswordIntro, style: Theme.of(context).textTheme.bodyLarge),
                    const SizedBox(height: 24),
                    PhoneField(controller: _phone, enabled: !_submitting),
                    const SizedBox(height: 16),
                    if (error != null) ...[FormErrorBanner(error), const SizedBox(height: 16)],
                    PrimaryButton(
                      label: l10n.sendCodeAction,
                      onPressed: _sendCode,
                      isLoading: _submitting,
                    ),
                  ],
                ),
              ),
      ),
    );
  }
}
