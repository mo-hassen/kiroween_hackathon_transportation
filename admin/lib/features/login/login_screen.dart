import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/l10n/l10n.dart';
import '../../core/api.dart';
import '../../core/session.dart';

/// Staff sign-in: phone, password and the current TOTP code (Phase 3 staff login).
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _form = GlobalKey<FormState>();
  final _phone = TextEditingController();
  final _password = TextEditingController();
  final _totp = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _phone.dispose();
    _password.dispose();
    _totp.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    final l10n = context.l10n;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(staffSessionProvider.notifier)
          .signIn(phone: _phone.text.trim(), password: _password.text, totpCode: _totp.text.trim());
    } on ApiFailure catch (failure) {
      if (mounted) setState(() => _error = failureText(l10n, failure));
    } finally {
      // The code is single-use (replay protection): clear it after every attempt.
      _totp.clear();
      _password.clear();
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final session = ref.watch(staffSessionProvider);
    String? required(String? value) =>
        (value == null || value.trim().isEmpty) ? l10n.fieldRequired : null;
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 400),
          child: Card(
            margin: const EdgeInsets.all(24),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Form(
                key: _form,
                child: AutofillGroup(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(l10n.signInTitle, style: Theme.of(context).textTheme.headlineSmall),
                      if (session is SignedOut && session.expired) ...[
                        const SizedBox(height: 12),
                        Text(l10n.sessionExpired),
                      ],
                      const SizedBox(height: 16),
                      TextFormField(
                        controller: _phone,
                        decoration: InputDecoration(labelText: l10n.phoneLabel),
                        keyboardType: TextInputType.phone,
                        autofillHints: const [AutofillHints.telephoneNumber],
                        validator: required,
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: _password,
                        decoration: InputDecoration(labelText: l10n.passwordLabel),
                        obscureText: true,
                        autofillHints: const [AutofillHints.password],
                        validator: required,
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: _totp,
                        decoration: InputDecoration(labelText: l10n.totpLabel),
                        keyboardType: TextInputType.number,
                        autofillHints: const [AutofillHints.oneTimeCode],
                        inputFormatters: [
                          FilteringTextInputFormatter.digitsOnly,
                          LengthLimitingTextInputFormatter(6),
                        ],
                        validator: (value) => RegExp(r'^\d{6}$').hasMatch(value ?? '')
                            ? null
                            : l10n.totpInvalidFormat,
                        onFieldSubmitted: (_) => _submit(),
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: 12),
                        Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                      ],
                      const SizedBox(height: 20),
                      FilledButton(
                        onPressed: _busy ? null : _submit,
                        child: _busy
                            ? const SizedBox.square(
                                dimension: 20,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            : Text(l10n.signInAction),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
