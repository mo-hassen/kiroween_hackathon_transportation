import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/auth/session_controller.dart';
import '../core/auth/session_state.dart';
import '../features/account/presentation/account_screen.dart';
import '../features/account/presentation/change_password_screen.dart';
import '../features/account/presentation/sessions_screen.dart';
import '../features/auth/data/auth_api.dart';
import '../features/driver/presentation/driver_profile_screen.dart';
import '../features/driver/presentation/driver_screen.dart';
import '../features/driver/presentation/license_form_screen.dart';
import '../features/driver/presentation/license_photos_screen.dart';
import '../features/driver/presentation/license_review_screen.dart';
import '../features/auth/presentation/forgot_password_screen.dart';
import '../features/auth/presentation/login_screen.dart';
import '../features/auth/presentation/register_screen.dart';
import '../features/auth/presentation/verify_device_screen.dart';
import '../features/identity/presentation/identity_return_screen.dart';
import '../features/identity/presentation/identity_screen.dart';
import '../features/not_found/not_found_screen.dart';
import '../features/owner/presentation/owner_details_screen.dart';
import '../features/owner/presentation/owner_documents_screen.dart';
import '../features/owner/presentation/owner_review_screen.dart';
import '../features/owner/presentation/owner_screen.dart';
import '../features/splash/splash_screen.dart';
import '../features/welcome/welcome_screen.dart';
import 'routes.dart';

/// Route guard. UX only: the backend authorizes every request.
///
/// * restoring / unreachable -> splash
/// * signed out -> only the public routes (an expired session lands on sign-in)
/// * signed in -> never the public routes
/// * unknown locations are not redirected: they show the not-found screen
///
/// The identity return link is kept across session restore (cold start from the browser):
/// splash carries it in `next` and it is resumed once signed in. Signed out, it is dropped.
String? redirectFor(SessionState session, String location, {Uri? uri}) {
  if (!AppRoutes.all.contains(location)) return null;
  final isPublic = AppRoutes.signedOutRoutes.contains(location);
  return switch (session) {
    SessionRestoring() || SessionUnreachable() =>
      location == AppRoutes.splash
          ? null
          : location == AppRoutes.identityReturn && uri != null
          ? Uri(
              path: AppRoutes.splash,
              queryParameters: {'next': identityReturnLocation(uri.queryParameters)},
            ).toString()
          : AppRoutes.splash,
    SignedOut(:final reason) =>
      isPublic
          ? null
          : (reason == SignOutReason.sessionExpired ? AppRoutes.login : AppRoutes.welcome),
    SignedIn() =>
      isPublic || location == AppRoutes.root
          ? AppRoutes.account
          : location == AppRoutes.splash
          ? (_resumableNext(uri) ?? AppRoutes.account)
          : null,
  };
}

/// The return route with only its two known parameters (anything else is dropped).
String identityReturnLocation(Map<String, String> query) => Uri(
  path: AppRoutes.identityReturn,
  queryParameters: {
    for (final key in const ['verification', 'confirmation'])
      if (query[key] != null) key: query[key]!,
  },
).toString();

/// Only the identity return route may be resumed from splash (no open redirect).
String? _resumableNext(Uri? uri) {
  final next = Uri.tryParse(uri?.queryParameters['next'] ?? '');
  if (next == null ||
      next.hasScheme ||
      next.hasAuthority ||
      next.path != AppRoutes.identityReturn) {
    return null;
  }
  return identityReturnLocation(next.queryParameters);
}

GoRouter buildRouter({
  required ValueListenable<SessionState> session,
  String initialLocation = AppRoutes.splash,
}) => GoRouter(
  initialLocation: initialLocation,
  refreshListenable: session,
  redirect: (_, state) => redirectFor(session.value, state.matchedLocation, uri: state.uri),
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
    GoRoute(path: AppRoutes.identity, builder: (_, _) => const IdentityScreen()),
    GoRoute(path: AppRoutes.driver, builder: (_, _) => const DriverScreen()),
    GoRoute(path: AppRoutes.driverProfile, builder: (_, _) => const DriverProfileScreen()),
    GoRoute(path: AppRoutes.driverLicense, builder: (_, _) => const LicenseFormScreen()),
    GoRoute(path: AppRoutes.driverPhotos, builder: (_, _) => const LicensePhotosScreen()),
    GoRoute(path: AppRoutes.driverReview, builder: (_, _) => const LicenseReviewScreen()),
    GoRoute(path: AppRoutes.owner, builder: (_, _) => const OwnerScreen()),
    GoRoute(path: AppRoutes.ownerDetails, builder: (_, _) => const OwnerDetailsScreen()),
    GoRoute(path: AppRoutes.ownerDocuments, builder: (_, _) => const OwnerDocumentsScreen()),
    GoRoute(path: AppRoutes.ownerReview, builder: (_, _) => const OwnerReviewScreen()),
    // Browser return: confirms the provider result from this session, then shows the status.
    GoRoute(
      path: AppRoutes.identityReturn,
      builder: (_, state) => IdentityReturnScreen(query: state.uri.queryParameters),
    ),
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
