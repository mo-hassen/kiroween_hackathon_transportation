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

Driver onboarding (Phase 5): `features/driver/` creates the driver profile, takes the licence
details and uploads the front and back photos. Photos come from the system camera or gallery
(`image_picker`, resized to 2400 px, JPEG quality 85, no storage permission). The app hashes them
(SHA-256), asks for a presigned URL, PUTs the bytes straight to storage with a separate Dio client
(no Authorization header), then asks the API to check them. A failed step resumes where it stopped
(a scanner outage repeats only the check). Submission needs an explicit confirmation and sends one
Idempotency-Key per visit. Officer notes are shown as plain text. The screens only show what
`GET /drivers/me` allows (`editable`, eligibility blockers); the server enforces every rule. With
the emulator, run `adb reverse tcp:58333 tcp:58333` so presigned storage URLs resolve.

Owner onboarding (Phase 6): `features/owner/` lets a customer choose individual or organization,
enter the organization name and TIN (only ever shown masked), upload the three organization
documents and submit. Uploads go through `features/documents/document_upload.dart`, the same
resumable job the driver licence photos use (`LicenseUploadJob` now delegates to it). Statuses:
not submitted, pending, verified, rejected (reason and note as plain text), suspended, expired and
re-verification required, each with guidance.

Vehicles (Phase 7): `features/vehicles/` ("My vehicles" on the account screen). Only a verified owner
can add a vehicle. A vehicle has a details form (type, make, model, year, plate, optional VIN and
engine number, both only ever shown masked), ten evidence slots (four documents, five photos and an
optional interior photo; insurance and inspection ask for their end date), a progress bar, a review
step and submit with an Idempotency-Key. The server's blockers are shown in words. Uploads reuse
`DocumentUploadJob`. Approved means verified, not listed for rent.

Rules: no hard-coded user-facing strings (a test enforces this for `Text('...')`), no
`double` for money (use `Money` from `packages/core_shared`), no secrets in `config/*.json`.
