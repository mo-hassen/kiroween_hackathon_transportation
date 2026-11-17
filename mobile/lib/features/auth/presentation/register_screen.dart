import 'package:core_shared/core_shared.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/l10n/l10n.dart';
import '../../../app/routes.dart';
import '../../../core/network/api_failure.dart';
import '../../../core/widgets/primary_button.dart';
import '../application/auth_flows.dart';
import 'auth_messages.dart';
import 'widgets/auth_fields.dart';
import 'widgets/resend_timer.dart';

/// Registration (journey J1): phone -> SMS code + name + password -> signed in.
class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({super.key});

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  final _phoneForm = GlobalKey<FormState>();
  final _detailsForm = GlobalKey<FormState>();
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _name = TextEditingController();
  final _password = TextEditingController();
  bool _codeSent = false;
  bool _submitting = false;
  ApiFailure? _failure;

  /// Same key while the same details are retried; a new key once any detail changes.
  String? _idempotencyKey;

  @override
  void initState() {
    super.initState();
    for (final controller in [_code, _name, _password]) {
      controller.addListener(() => _idempotencyKey = null);
    }
  }

  @override
  void dispose() {
    for (final controller in [_phone, _code, _name, _password]) {
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
      await ref
          .read(authFlowsProvider)
          .requestRegistrationCode(phone: _phone.text, locale: _locale);
      if (mounted) setState(() => _codeSent = true);
    });
  }

  Future<void> _register() async {
    if (_submitting || !(_detailsForm.currentState?.validate() ?? false)) return;
    final key = _idempotencyKey ??= AuthFlows.newIdempotencyKey();
    await _run(() async {
      await ref
          .read(authFlowsProvider)
          .register(
            phone: _phone.text,
            code: _code.text,
            password: _password.text,
            displayName: _name.text,
            locale: _locale,
            idempotencyKey: key,
          );
      // Signed in: the router guard moves to the account screen.
    });
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.registerTitle)),
      body: SafeArea(child: _codeSent ? _details(l10n) : _phoneStep(l10n)),
    );
  }

  Widget _phoneStep(AppLocalizations l10n) => Form(
    key: _phoneForm,
    child: ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text(l10n.registerPhoneIntro, style: Theme.of(context).textTheme.bodyLarge),
        const SizedBox(height: 24),
        PhoneField(controller: _phone, enabled: !_submitting),
        const SizedBox(height: 16),
        if (_failure != null) ...[
          FormErrorBanner(authFailureMessage(l10n, _failure!)),
          const SizedBox(height: 16),
        ],
        PrimaryButton(label: l10n.sendCodeAction, onPressed: _sendCode, isLoading: _submitting),
        TextButton(onPressed: () => context.go(AppRoutes.login), child: Text(l10n.signInAction)),
      ],
    ),
  );

  Widget _details(AppLocalizations l10n) {
    final phone = normalizeEthiopianMobile(_phone.text);
    final passwordError = serverFieldError(l10n, _failure, 'password');
    final generalError = _failure == null || passwordError != null
        ? null
        : authFailureMessage(l10n, _failure!);
    return AutofillGroup(
      child: Form(
        key: _detailsForm,
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            Text(l10n.registerDetailsIntro, style: Theme.of(context).textTheme.bodyLarge),
            if (phone != null) ...[
              const SizedBox(height: 8),
              Text(l10n.codeSentTo(formatEthiopianMobile(phone))),
            ],
            const SizedBox(height: 24),
            CodeField(controller: _code),
            ResendCodeButton(
              onResend: () => ref
                  .read(authFlowsProvider)
                  .requestRegistrationCode(phone: _phone.text, locale: _locale),
            ),
            const SizedBox(height: 8),
            TextFormField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              autofillHints: const [AutofillHints.name],
              maxLength: 100,
              decoration: InputDecoration(
                labelText: l10n.nameLabel,
                prefixIcon: const Icon(Icons.person_outline),
              ),
              validator: (value) => (value ?? '').trim().isEmpty ? l10n.nameRequired : null,
            ),
            const SizedBox(height: 8),
            PasswordField(
              controller: _password,
              label: l10n.passwordLabel,
              isNew: true,
              errorText: passwordError,
            ),
            const SizedBox(height: 16),
            if (generalError != null) ...[
              FormErrorBanner(generalError),
              const SizedBox(height: 16),
            ],
            PrimaryButton(
              label: l10n.createAccountAction,
              onPressed: _register,
              isLoading: _submitting,
            ),
          ],
        ),
      ),
    );
  }
}
