import 'package:core_shared/core_shared.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../../core/auth/auth_tokens.dart';
import '../../../core/auth/device_identity.dart';
import '../../../core/auth/session_controller.dart';
import '../data/auth_api.dart';

/// Outcome of a sign-in attempt for the UI.
sealed class SignInOutcome {
  const SignInOutcome();
}

final class SignInCompleted extends SignInOutcome {
  const SignInCompleted();
}

final class SignInNeedsCode extends SignInOutcome {
  const SignInNeedsCode(this.ticket);

  final LoginOtpRequired ticket;
}

/// Use cases behind the auth screens. Screens own the form state; this class owns the
/// calls, the order of steps and the session hand-over. Failures surface as ApiFailure.
class AuthFlows {
  AuthFlows(this._ref);

  final Ref _ref;

  AuthApi get _api => _ref.read(authApiProvider);

  Future<DeviceDescriptor> _device() => _ref.read(deviceDescriptorProvider.future);

  static String normalizedPhone(String input) =>
      normalizeEthiopianMobile(input) ??
      (throw ArgumentError.value(input, 'phone', 'Not an Ethiopian mobile number'));

  Future<SignInOutcome> signIn({required String phone, required String password}) async {
    final result = await _api.login(
      phone: normalizedPhone(phone),
      password: password,
      device: await _device(),
    );
    return switch (result) {
      LoginAuthenticated(:final tokens) => _complete(tokens),
      final LoginOtpRequired ticket => SignInNeedsCode(ticket),
    };
  }

  Future<SignInOutcome> verifyNewDevice({required String loginTicket, required String code}) async {
    final tokens = await _api.verifyLogin(
      loginTicket: loginTicket,
      otp: code,
      device: await _device(),
    );
    return _complete(tokens);
  }

  Future<void> requestRegistrationCode({required String phone, required String locale}) =>
      _api.requestRegistrationCode(phone: normalizedPhone(phone), locale: locale);

  /// Registers (idempotent with [idempotencyKey]) and signs in from the now-trusted device.
  Future<SignInOutcome> register({
    required String phone,
    required String code,
    required String password,
    required String displayName,
    required String locale,
    required String idempotencyKey,
  }) async {
    final normalized = normalizedPhone(phone);
    await _api.register(
      phone: normalized,
      otp: code,
      password: password,
      displayName: displayName.trim(),
      locale: locale,
      device: await _device(),
      idempotencyKey: idempotencyKey,
    );
    return signIn(phone: normalized, password: password);
  }

  Future<void> requestPasswordReset({required String phone, required String locale}) =>
      _api.requestPasswordReset(phone: normalizedPhone(phone), locale: locale);

  /// Resets the password (this device becomes trusted) and signs in with the new one.
  Future<SignInOutcome> resetPassword({
    required String phone,
    required String code,
    required String newPassword,
  }) async {
    final normalized = normalizedPhone(phone);
    await _api.confirmPasswordReset(
      phone: normalized,
      otp: code,
      newPassword: newPassword,
      device: await _device(),
    );
    return signIn(phone: normalized, password: newPassword);
  }

  Future<SignInOutcome> _complete(AuthTokens tokens) async {
    await _ref.read(sessionControllerProvider.notifier).signedIn(tokens);
    return const SignInCompleted();
  }

  /// A fresh key per distinct submission; reused when the same submission is retried.
  static String newIdempotencyKey() => const Uuid().v4();
}

final authFlowsProvider = Provider<AuthFlows>(AuthFlows.new);
