import 'package:flutter/material.dart';

import '../../app/l10n/l10n.dart';

/// Main call-to-action button. While [isLoading] it shows progress and ignores
/// taps, which prevents duplicate submissions on slow networks.
class PrimaryButton extends StatelessWidget {
  const PrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.isLoading = false,
  });

  final String label;

  /// `null` disables the button.
  final VoidCallback? onPressed;
  final bool isLoading;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: FilledButton(
        onPressed: isLoading ? null : onPressed,
        child: isLoading
            ? Semantics(
                label: context.l10n.loadingLabel,
                child: const SizedBox.square(
                  dimension: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              )
            : Text(label),
      ),
    );
  }
}
