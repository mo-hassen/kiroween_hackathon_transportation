import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/auth/session_controller.dart';
import '../core/auth/session_state.dart';
import '../features/account/presentation/account_screen.dart';
import '../features/account/presentation/change_password_screen.dart';
import '../features/account/presentation/sessions_screen.dart';
import '../features/auth/data/auth_api.dart';
import '../features/auth/presentation/forgot_password_screen.dart';
import '../features/auth/presentation/login_screen.dart';
import '../features/auth/presentation/register_screen.dart';
import '../features/auth/presentation/verify_device_screen.dart';
import '../features/not_found/not_found_screen.dart';
import '../features/splash/splash_screen.dart';
import '../features/welcome/welcome_screen.dart';
import 'routes.dart';

/// Route guard. UX only: the backend authorizes every request.
///
/// * restoring / unreachable -> splash
/// * signed out -> only the public routes (an expired session lands on sign-in)
/// * signed in -> never the public routes
/// * unknown locations are not redirected: they show the not-found screen
String? redirectFor(SessionState session, String location) {
  if (!AppRoutes.all.contains(location)) return null;
  final isPublic = AppRoutes.signedOutRoutes.contains(location);
  return switch (session) {
    SessionRestoring() ||
    SessionUnreachable() => location == AppRoutes.splash ? null : AppRoutes.splash,
    SignedOut(:final reason) =>
      isPublic
          ? null
          : (reason == SignOutReason.sessionExpired ? AppRoutes.login : AppRoutes.welcome),
    SignedIn() =>
      isPublic || location == AppRoutes.splash || location == AppRoutes.root
          ? AppRoutes.account
          : null,
  };
}

GoRouter buildRouter({
  required ValueListenable<SessionState> session,
  String initialLocation = AppRoutes.splash,
}) => GoRouter(
  initialLocation: initialLocation,
  refreshListenable: session,
  redirect: (_, state) => redirectFor(session.value, state.matchedLocation),
  routes: [
    GoRoute(path: AppRoutes.root, redirect: (_, _) => AppRoutes.welcome),
    GoRoute(path: AppRoutes.splash, builder: (_, _) => const SplashScreen()),
    GoRoute(path: AppRoutes.welcome, builder: (_, _) => const WelcomeScreen()),
    GoRoute(path: AppRoutes.login, builder: (_, _) => const LoginScreen()),
    GoRoute(
      path: AppRoutes.loginVerify,
      // The ticket only travels in memory; a deep link to this route has none.
      redirect: (_, state) => state.extra is LoginOtpRequired ? null : AppRoutes.login,
      builder: (_, state) => VerifyDeviceScreen(ticket: state.extra! as LoginOtpRequired),
    ),
    GoRoute(path: AppRoutes.register, builder: (_, _) => const RegisterScreen()),
    GoRoute(path: AppRoutes.forgotPassword, builder: (_, _) => const ForgotPasswordScreen()),
    GoRoute(path: AppRoutes.account, builder: (_, _) => const AccountScreen()),
    GoRoute(path: AppRoutes.accountSessions, builder: (_, _) => const SessionsScreen()),
    GoRoute(path: AppRoutes.accountPassword, builder: (_, _) => const ChangePasswordScreen()),
  ],
  errorBuilder: (_, _) => const NotFoundScreen(),
);

final routerProvider = Provider<GoRouter>((ref) {
  final session = ValueNotifier<SessionState>(ref.read(sessionControllerProvider));
  ref.listen<SessionState>(sessionControllerProvider, (_, next) => session.value = next);
  final router = buildRouter(session: session);
  ref.onDispose(() {
    router.dispose();
    session.dispose();
  });
  return router;
});
