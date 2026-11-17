import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/l10n/l10n.dart';
import '../../core/auth/session_controller.dart';
import '../../core/auth/session_state.dart';
import '../../core/widgets/state_views.dart';

/// Shown while the stored session is restored. If the server cannot be reached the
/// session is kept and the user can retry; the app never signs out because of a network
/// error.
class SplashScreen extends ConsumerWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final unreachable = ref.watch(sessionControllerProvider) is SessionUnreachable;
    return Scaffold(
      body: SafeArea(
        child: unreachable
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        l10n.connectionProblemTitle,
                        style: Theme.of(context).textTheme.titleLarge,
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 8),
                      Text(l10n.errorNetwork, textAlign: TextAlign.center),
                      const SizedBox(height: 16),
                      OutlinedButton.icon(
                        onPressed: () =>
                            ref.read(sessionControllerProvider.notifier).retryRestore(),
                        icon: const Icon(Icons.refresh),
                        label: Text(l10n.retryAction),
                      ),
                    ],
                  ),
                ),
              )
            : const LoadingView(),
      ),
    );
  }
}
