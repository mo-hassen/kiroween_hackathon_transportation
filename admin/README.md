# Admin web console (staff)

Flutter Web, Material 3, Riverpod 3, GoRouter, Dio. For `VERIFICATION_OFFICER` staff: the driver
licence queue (Phase 5, `drivers.review`) and the owner verification queue (Phase 6,
`owners.review`). Each area is shown only with its permission; the API checks again.

Owner review: individuals need one approval. Organizations need "Record first approval" by one
officer and "Give second approval" by a different officer; the first officer sees the case as
"You gave the first approval" and has no second-approval or claim action. Decisions send a fresh
`Idempotency-Key`. The TIN is shown masked only.

```sh
flutter pub get                                         # also generates l10n
flutter run -d chrome --web-port 8080 --dart-define-from-file=config/development.json
flutter analyze --fatal-infos
flutter test
flutter build web --release --dart-define-from-file=config/production.example.json
```

The API must list the console origin in `CORS_ALLOWED_ORIGINS` (development:
`http://localhost:8080`, already set in `backend/.env.example` and `infra/docker-compose.yml`).
Serve the console from its own origin, separate from the API and the marketing site.

Structure:
- `lib/core/`: build config, `ApiClient`/`ApiFailure`, staff session (`session.dart`)
- `lib/app/`: app widget, router guard, shell, localization (en/am ARB files)
- `lib/features/login/`: staff sign-in (phone + password + TOTP)
- `lib/features/dashboard/`: case counts per review status
- `lib/features/drivers/`: queue, case detail, decision dialogs, API client

Security rules:
- Tokens are kept in memory only (`TokenHolder`). Nothing goes to `localStorage`,
  `sessionStorage`, IndexedDB or cookies, so a reload or a new tab needs password + TOTP again.
  The installation id is random per page load.
- `/me` `permissions` drive navigation only. The API checks `drivers.review` on every call;
  other staff roles see the no-permission screen and get 403 from the API.
- Documents are never preloaded. Opening one asks for a reason (10+ characters, audited), and
  the API returns a 60-second URL. Images are shown as an `<img>` element (no CORS rule needed on
  the storage origin); PDFs open in a new tab. Responses carry `Cache-Control: private, no-store`.
- All server text is rendered with `Text`/`SelectableText` (no HTML). Server error messages are
  never shown; stable codes are mapped to localized text.
- `index.html` sets `noindex` and `no-referrer`. A Content-Security-Policy and HSTS belong on the
  hosting server [EXTERNAL]; see `docs/reports/phase-05.md`.
