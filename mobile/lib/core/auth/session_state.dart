/// Why the user is signed out; drives the message on the sign-in screen.
enum SignOutReason { none, signedOut, sessionExpired }

/// Authentication state of the app. Route guards read it; the backend still authorizes
/// every request.
sealed class SessionState {
  const SessionState();
}

/// Reading the stored refresh token and refreshing it.
final class SessionRestoring extends SessionState {
  const SessionRestoring();
}

/// A session exists on this device but the server cannot be reached right now.
final class SessionUnreachable extends SessionState {
  const SessionUnreachable();
}

final class SignedOut extends SessionState {
  const SignedOut([this.reason = SignOutReason.none]);

  final SignOutReason reason;
}

final class SignedIn extends SessionState {
  const SignedIn(this.sessionId);

  final String sessionId;
}
