# 06 — Flutter Architecture

## Apps

| App | Target | Users |
|---|---|---|
| `mobile/` | Android first (minSdk 26 / Android 8.0), iOS buildable | Drivers, owners |
| `admin/` | Flutter web | Staff only; separate build, separate origin |

Shared code (API client models, design tokens, formatters, l10n helpers) lives in `packages/core_shared` as a local Dart package. Admin code never ships in the mobile APK.

## Stack

- Flutter 3.47 / Dart 3.13, Material 3, `flutter_lints` + stricter rules (`strict-casts`, `strict-raw-types`, `strict-inference`).
- State: **Riverpod** (`flutter_riverpod` + `riverpod_annotation` code-gen). `AsyncNotifier` per screen/use case.
- Navigation: **GoRouter** with a `redirect` driven by an auth/onboarding state provider; typed routes (`go_router_builder`).
- HTTP: **Dio** with interceptors.
- Models: **freezed + json_serializable** for API DTOs and UI state unions (justified: many immutable models and sealed `Loading/Data/Error` states; manual `copyWith`/`==` would be error-prone).
- Secure storage: `flutter_secure_storage` (Android Keystore-backed) for refresh token only. Access token kept in memory.
- Local cache: `drift` (SQLite) for offline read-only copies of the user's own data (profile, vehicles, agreements, assignments, notifications, wallet summary). Not used for marketplace data beyond the last page viewed.
- Localization: `flutter_localizations` + `intl`, ARB files `app_en.arb`, `app_am.arb`; `gen-l10n`. A test fails if any ARB key is missing in `am`. Font: Noto Sans Ethiopic bundled for Amharic glyphs.
- Images: `cached_network_image` with size-bounded cache; uploads compressed client-side (`flutter_image_compress`, max 1600px, JPEG q80) before upload to cut data cost.
- Push: `firebase_messaging` behind a `PushService` interface; app works without push.
- Identity flow: `flutter_custom_tabs` / system browser + Android App Links. **No WebView** for login or identity.

## Folder structure (feature-first, layered inside each feature)

```
mobile/lib/
  main_dev.dart, main_staging.dart, main_prod.dart   # flavors; only public config (API base URL)
  app/            app.dart, router.dart, theme/, l10n/
  core/
    network/      dio_client.dart, auth_interceptor.dart, idempotency_interceptor.dart,
                  retry_policy.dart, api_error.dart, connectivity.dart
    storage/      secure_token_store.dart, local_db/
    auth/         session_controller.dart (auth state source of truth)
    format/       etb_formatter.dart, phone_formatter.dart, date_formatter.dart (Ethiopian calendar display optional)
    widgets/      async_value_view.dart, empty_view.dart, error_view.dart, offline_banner.dart,
                  primary_button.dart, money_text.dart, status_chip.dart, document_picker.dart
  features/
    auth/ onboarding/ identity/ driver_profile/ owner_profile/ vehicles/ listings/
    marketplace/ applications/ agreements/ assignments/ payments/ wallet/
    notifications/ conversations/ support/ disputes/ ratings/ settings/
      each feature:
        data/         <feature>_api.dart, <feature>_repository.dart, dto/
        domain/       models, pure rules for display (never authorization)
        presentation/ screens/, widgets/, controllers/ (Riverpod notifiers)
```

## Networking behaviour

- Timeouts: connect 10 s, receive 20 s, upload 60 s.
- `AuthInterceptor`: attaches access token; on 401 performs a **single-flight** refresh (one refresh request even if many calls fail concurrently), retries the original once; refresh failure → session cleared → login route.
- `IdempotencyInterceptor`: mutating requests flagged `idempotent: true` get a UUID key generated when the user action starts and reused on retry.
- Retry policy: automatic retry with backoff (max 2) **only** for GET and for requests carrying an idempotency key on network errors/502/503/504. Payment-creation and payout requests are never auto-retried; the UI shows "checking status" and queries the payment by ID.
- Errors mapped to a sealed `ApiFailure` (`network`, `timeout`, `unauthorized`, `forbidden/notFound`, `conflict(code)`, `validation(fields)`, `rateLimited(retryAfter)`, `server`) and then to localized messages by `code`. Raw server messages are not shown.
- Cancellation: Dio `CancelToken` bound to provider lifecycle (`ref.onDispose`) so leaving a screen cancels its requests.

## UI state contract

Every data screen renders through `AsyncValueView` with five explicit states: **loading** (skeleton), **data**, **empty** (with call to action), **error** (message + Retry), **offline** (cached data with "last updated" banner, actions disabled). Mutations show inline progress, disable the button while in flight, and surface conflict errors (e.g. "This vehicle was just taken").

## Routing & guards

GoRouter `redirect` reads `SessionState` (`unknown → unauthenticated → authenticated(roles, onboardingStep)`):
- unauthenticated → `/welcome`, `/login`, `/register`
- authenticated but phone/identity incomplete → onboarding routes
- role-specific shells: driver tabs (Marketplace, Applications, My Vehicle, Wallet, More), owner tabs (Vehicles, Requests, Agreements, Earnings, More). Dual-role users switch shells.

Route guards are UX only. Every screen tolerates a 403/404 from the backend.

Deep links (`/n/{notificationId}`, `/identity/return?verification={id}`) are parsed through a whitelist of route patterns; unknown links go to home. Deep links never carry tokens or authorization codes.

## Ethiopian formatting

- ETB: `NumberFormat.currency(locale, symbol: 'ብር' / 'ETB', decimalDigits: 2)` over integer santim converted with integer math only (`amountMinor ~/ 100`, `% 100`) — no `double` for money anywhere in the app. Lint check (custom test) scans for `double` in money models.
- Phone: input accepts `09…`, `07…`, `9…`, `+2519…`; normalized to E.164 for API; displayed `+251 9X XXX XXXX`. Server re-validates.
- Address: structured `sub-city` (picker) + `woreda` (optional) + free-text landmark ("near Edna Mall"). Map pin optional, never required.
- Dates: Gregorian stored; optional Ethiopian-calendar display behind a setting [ASSUMPTION — useful for Amharic users, implemented via a small tested converter].

## Accessibility & low-end devices

Touch targets ≥ 48 dp, text scale up to 200% without overflow (widget tests at 2.0 scale), contrast AA, semantics labels on icons. Avoid heavy animations; lists use `ListView.builder` with pagination; images thumbnail-sized in lists.

## Testing (mobile)

Unit (formatters, retry policy, refresh single-flight, error mapping), state tests (Riverpod notifiers with fake repositories), widget tests (each screen's 5 states, l10n in both locales, text scale), router tests (redirect matrix), golden tests for key screens, and `integration_test` flows against a local backend (register → verify (dev provider) → browse → apply).
