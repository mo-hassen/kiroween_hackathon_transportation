/// Route paths. Deep links are matched only against these patterns; anything
/// else lands on the not-found screen (docs/architecture/06-flutter-architecture.md).
abstract final class AppRoutes {
  static const root = '/';
  static const splash = '/splash';
  static const welcome = '/welcome';
  static const login = '/login';
  static const loginVerify = '/login/verify';
  static const register = '/register';
  static const forgotPassword = '/forgot-password';
  static const account = '/account';
  static const accountSessions = '/account/sessions';
  static const accountPassword = '/account/password';
  static const identity = '/identity';

  /// Where the browser returns after the identity provider (App Link / app scheme). Carries
  /// only `?verification=<id>`; the screen reads the result from the server.
  static const identityReturn = '/identity/return';

  /// Reachable without a session.
  static const signedOutRoutes = {welcome, login, loginVerify, register, forgotPassword};

  /// Every route the guard knows. Anything else is left to the not-found screen.
  static const all = {
    root,
    splash,
    ...signedOutRoutes,
    account,
    accountSessions,
    accountPassword,
    identity,
    identityReturn,
  };
}
