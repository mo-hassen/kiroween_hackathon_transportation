import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/l10n/l10n.dart';
import '../../../core/network/api_failure.dart';
import '../../../core/widgets/primary_button.dart';
import '../application/auth_flows.dart';
import '../data/auth_api.dart';
import 'auth_messages.dart';
import 'widgets/auth_fields.dart';

/// New-device step-up: the SMS code completes the sign-in started on the login screen.
/// The ticket is passed in memory (router `extra`), never through the URL.
class VerifyDeviceScreen extends ConsumerStatefulWidget {
  const VerifyDeviceScreen({super.key, required this.ticket});

  final LoginOtpRequired ticket;

  @override
  ConsumerState<VerifyDeviceScreen> createState() => _VerifyDeviceScreenState();
}

class _VerifyDeviceScreenState extends ConsumerState<VerifyDeviceScreen> {
  final _formKey = GlobalKey<FormState>();
  final _code = TextEditingController();
  bool _submitting = false;
  ApiFailure? _failure;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_submitting || !(_formKey.currentState?.validate() ?? false)) return;
    setState(() {
      _submitting = true;
      _failure = null;
    });
    try {
      await ref
          .read(authFlowsProvider)
          .verifyNewDevice(loginTicket: widget.ticket.loginTicket, code: _code.text);
    } on ApiFailure catch (failure) {
      if (mounted) setState(() => _failure = failure);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.verifyDeviceTitle)),
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              Text(l10n.verifyDeviceBody, style: Theme.of(context).textTheme.bodyLarge),
              const SizedBox(height: 24),
              CodeField(controller: _code),
              const SizedBox(height: 16),
              if (_failure != null) ...[
                FormErrorBanner(authFailureMessage(l10n, _failure!)),
                const SizedBox(height: 16),
              ],
              PrimaryButton(label: l10n.verifyAction, onPressed: _submit, isLoading: _submitting),
            ],
          ),
        ),
      ),
    );
  }
}
