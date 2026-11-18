# Mobile app (drivers and owners)

Flutter 3.47, Material 3, Riverpod 3, GoRouter, Dio. Android first (minSdk 26).

```sh
flutter pub get                                              # also generates l10n
flutter run --dart-define-from-file=config/development.json  # emulator -> local API
flutter analyze --fatal-infos
flutter test
```

Structure (docs/architecture/06-flutter-architecture.md):

- `lib/app/`: app widget, router, theme, localization (ARB files in `lib/app/l10n/arb`)
- `lib/core/`: config, networking (`ApiClient`, retry rules, `ApiFailure`), secure token
  storage, locale, shared state widgets (`AsyncValueView`, loading/empty/error/offline)
- `lib/features/<feature>/`: data + presentation per feature

Authentication (Phase 3): `core/auth/` holds the session state, the token manager (access
token in memory, rotating refresh token in secure storage, single-flight refresh) and the
interceptor that refreshes once on 401. `features/auth/` has sign-in, new-device code,
registration and password reset; `features/account/` has profile, devices/sessions and
password change. The router guard in `app/router.dart` is UX only; the API authorizes.

Identity verification (Phase 4): `features/identity/` shows the consent text, starts a
verification and opens the provider page with `url_launcher` in a Custom Tab (never a WebView).
The result reaches the server through the provider redirect; the app only re-reads
`GET /identity/verifications/current` (on return, on resume and on "Check status"). The
return link `kiroweenmobility://app/identity/return` (intent filter in `AndroidManifest.xml`)
carries only the attempt id and a one-time confirmation token, which `IdentityReturnScreen`
sends back from the same session; never an authorization code, OAuth token or claim. Production needs an https App Link instead [EXTERNAL].

Rules: no hard-coded user-facing strings (a test enforces this for `Text('...')`), no
`double` for money (use `Money` from `packages/core_shared`), no secrets in `config/*.json`.
