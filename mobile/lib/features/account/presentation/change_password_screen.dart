import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/l10n/l10n.dart';
import '../../../core/network/api_failure.dart';
import '../../../core/widgets/primary_button.dart';
import '../../auth/presentation/auth_messages.dart';
import '../../auth/presentation/widgets/auth_fields.dart';
import '../data/account_api.dart';

class ChangePasswordScreen extends ConsumerStatefulWidget {
  const ChangePasswordScreen({super.key});

  @override
  ConsumerState<ChangePasswordScreen> createState() => _ChangePasswordScreenState();
}

class _ChangePasswordScreenState extends ConsumerState<ChangePasswordScreen> {
  final _formKey = GlobalKey<FormState>();
  final _current = TextEditingController();
  final _next = TextEditingController();
  bool _submitting = false;
  ApiFailure? _failure;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_submitting || !(_formKey.currentState?.validate() ?? false)) return;
    final l10n = context.l10n;
    final messenger = ScaffoldMessenger.of(context);
    setState(() {
      _submitting = true;
      _failure = null;
    });
    try {
      await ref
          .read(accountApiProvider)
          .changePassword(currentPassword: _current.text, newPassword: _next.text);
      messenger.showSnackBar(SnackBar(content: Text(l10n.passwordChanged)));
      if (mounted) context.pop();
    } on ApiFailure catch (failure) {
      if (mounted) setState(() => _failure = failure);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final currentError = serverFieldError(l10n, _failure, 'currentPassword');
    final nextError = serverFieldError(l10n, _failure, 'newPassword');
    final generalError = _failure == null || currentError != null || nextError != null
        ? null
        : authFailureMessage(l10n, _failure!);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.changePasswordTitle)),
      body: SafeArea(
        child: AutofillGroup(
          child: Form(
            key: _formKey,
            child: ListView(
              padding: const EdgeInsets.all(24),
              children: [
                PasswordField(
                  controller: _current,
                  label: l10n.currentPasswordLabel,
                  errorText: currentError,
                ),
                const SizedBox(height: 16),
                PasswordField(
                  controller: _next,
                  label: l10n.newPasswordLabel,
                  isNew: true,
                  errorText: nextError,
                ),
                const SizedBox(height: 16),
                if (generalError != null) ...[
                  FormErrorBanner(generalError),
                  const SizedBox(height: 16),
                ],
                PrimaryButton(label: l10n.saveAction, onPressed: _submit, isLoading: _submitting),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
