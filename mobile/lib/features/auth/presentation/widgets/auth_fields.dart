import 'package:core_shared/core_shared.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../app/l10n/l10n.dart';

/// Ethiopian mobile number. Validates locally with the shared rule; the server re-checks.
class PhoneField extends StatelessWidget {
  const PhoneField({super.key, required this.controller, this.enabled = true, this.errorText});

  final TextEditingController controller;
  final bool enabled;
  final String? errorText;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return TextFormField(
      controller: controller,
      enabled: enabled,
      keyboardType: TextInputType.phone,
      autofillHints: const [AutofillHints.telephoneNumber],
      textInputAction: TextInputAction.next,
      inputFormatters: [
        FilteringTextInputFormatter.allow(RegExp(r'[0-9+\s()-]')),
        LengthLimitingTextInputFormatter(20),
      ],
      decoration: InputDecoration(
        labelText: l10n.phoneLabel,
        hintText: l10n.phoneHint,
        prefixIcon: const Icon(Icons.phone_outlined),
        errorText: errorText,
      ),
      validator: (value) =>
          normalizeEthiopianMobile(value ?? '') == null ? l10n.phoneInvalid : null,
    );
  }
}

/// Password with a show/hide toggle. [isNew] applies the minimum length and shows advice.
class PasswordField extends StatefulWidget {
  const PasswordField({
    super.key,
    required this.controller,
    required this.label,
    this.isNew = false,
    this.errorText,
    this.onSubmitted,
  });

  final TextEditingController controller;
  final String label;
  final bool isNew;
  final String? errorText;
  final VoidCallback? onSubmitted;

  @override
  State<PasswordField> createState() => _PasswordFieldState();
}

class _PasswordFieldState extends State<PasswordField> {
  bool _obscured = true;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return TextFormField(
      controller: widget.controller,
      obscureText: _obscured,
      enableSuggestions: false,
      autocorrect: false,
      autofillHints: [widget.isNew ? AutofillHints.newPassword : AutofillHints.password],
      onFieldSubmitted: (_) => widget.onSubmitted?.call(),
      inputFormatters: [LengthLimitingTextInputFormatter(128)],
      decoration: InputDecoration(
        labelText: widget.label,
        helperText: widget.isNew ? l10n.passwordHelper : null,
        helperMaxLines: 2,
        errorText: widget.errorText,
        errorMaxLines: 3,
        prefixIcon: const Icon(Icons.lock_outline),
        suffixIcon: IconButton(
          tooltip: _obscured ? l10n.showPassword : l10n.hidePassword,
          icon: Icon(_obscured ? Icons.visibility_outlined : Icons.visibility_off_outlined),
          onPressed: () => setState(() => _obscured = !_obscured),
        ),
      ),
      validator: (value) {
        final text = value ?? '';
        if (text.isEmpty) return l10n.passwordRequired;
        if (widget.isNew && text.length < 10) return l10n.passwordTooShort;
        return null;
      },
    );
  }
}

/// 6-digit SMS code; supports the platform's one-time-code autofill.
class CodeField extends StatelessWidget {
  const CodeField({super.key, required this.controller, this.errorText});

  final TextEditingController controller;
  final String? errorText;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return TextFormField(
      controller: controller,
      keyboardType: TextInputType.number,
      autofillHints: const [AutofillHints.oneTimeCode],
      inputFormatters: [
        FilteringTextInputFormatter.digitsOnly,
        LengthLimitingTextInputFormatter(6),
      ],
      decoration: InputDecoration(
        labelText: l10n.codeLabel,
        prefixIcon: const Icon(Icons.sms_outlined),
        errorText: errorText,
      ),
      validator: (value) =>
          RegExp(r'^\d{6}$').hasMatch(value ?? '') ? null : l10n.codeInvalidFormat,
    );
  }
}

/// Inline error shown above a form's submit button.
class FormErrorBanner extends StatelessWidget {
  const FormErrorBanner(this.message, {super.key});

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
          color: scheme.errorContainer,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.error_outline, color: scheme.onErrorContainer),
            const SizedBox(width: 12),
            Expanded(
              child: Text(message, style: TextStyle(color: scheme.onErrorContainer)),
            ),
          ],
        ),
      ),
    );
  }
}
