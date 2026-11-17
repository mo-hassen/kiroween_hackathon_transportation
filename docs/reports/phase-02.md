# Phase 2 Report: Project Foundation

Date: 2026-11-17
Scope: Phase 2 only, as defined in `docs/architecture/13-implementation-plan.md`. Phase 3 has not started.

## 1. Work completed

### Repository
- `git init` (branch `main`); nothing committed yet. Prompt folder moved to `ai-prompts/` (approved default 6).
- Layout: `backend/`, `mobile/`, `admin/` (README only, the app arrives in Phase 5), `packages/core_shared/`, `packages/test_vectors/`, `infra/`, `docs/`.
- `.gitignore` excludes `.env*` (except `.env.example`), keys/keystores, `node_modules`, build output, the Prisma client and Flutter l10n output.

### Backend (`backend/`)
| Item | Implementation |
|---|---|
| Framework | NestJS 12 (ESM-only release), TypeScript 6 in strict mode plus `noUncheckedIndexedAccess`, `noImplicitOverride` and related flags |
| Configuration | `src/config`: a zod schema validates every variable, and the process exits on invalid config without printing values. Staging and production require TLS for Postgres (`sslmode`), Redis (`rediss://`), storage and CORS origins, and reject development credentials |
| ORM, migrations | Prisma 7.10 with the `pg` driver adapter. UUIDv7 primary keys. One migration, `20261117111526_foundation` |
| Tables | `users`, `devices`, `sessions`, `audit_logs`, `idempotency_records`, `outbox_events` |
| Hand-written SQL | CHECK constraints (E.164 Ethiopian mobile format, lowercase email, CLOSED status ⇔ `closed_at`, session expiry, revocation needs a reason, token rotation, idempotency key format, event and action naming). Partial indexes (active sessions, pending outbox). `audit_logs` append-only triggers: UPDATE, DELETE and TRUNCATE are rejected, except a one-time hash-chain seal |
| Drift guard | `npm run db:drift` compares `schema.prisma` with the migrations through a shadow DB. Result: no difference |
| Validation | Global `ValidationPipe`: whitelist, forbid unknown fields (mass assignment), no implicit type coercion. Field errors are returned as `{field, code}` without echoing values |
| Errors | One exception filter returns RFC 9457 `application/problem+json` with `type`, `title`, `status`, `code` and `requestId`. 500s never include messages or stacks; they are logged server-side |
| Responses | `{ "data": ... }` envelope (interceptor). `@RawResponse()` opts out |
| Logging | pino through nestjs-pino as JSON. Request logs contain id, method, path (no query string), status and duration. Headers and bodies are never serialized. Sensitive keys are redacted at top level and one level deep. Successful health probes are not logged |
| Request ID | `X-Request-Id` is accepted only if it matches `^[A-Za-z0-9-]{8,64}$`, otherwise a UUID is generated. It is echoed in the header, in error bodies and in logs |
| API versioning | URI versioning under `/api/v1` |
| OpenAPI | `/api/docs` and `/api/docs/openapi.json`. Enabled by default in development, disabled by default in staging and production |
| Rate limiting | `@nestjs/throttler` with a custom Redis sliding-window store (atomic Lua script on the Redis clock, shared across instances). If Redis is down, it falls back to an in-memory limiter per instance at half the limit. Returns 429 problem details with `Retry-After` |
| Security headers | helmet (CSP, nosniff, frame protection, `Referrer-Policy: no-referrer`, CORP same-site). HSTS only in deployed environments. `X-Powered-By` removed |
| CORS | Explicit origin allow-list (the admin web origin). Requests without an Origin header (mobile) are unaffected. No credentials |
| Body handling | JSON only, 1 MB limit, strict. No urlencoded or multipart parsing |
| Authentication guard | Global and fail-closed: every route returns 401 unless marked `@Public()`. Token verification comes in Phase 3 |
| Health | `/api/v1/health/live` and `/api/v1/health/ready`. Readiness checks Postgres, Redis and object storage with 2 s timeouts and returns 503 with component status only |
| Object storage | `ObjectStorage` interface with an S3 adapter (connectivity and health only in Phase 2; presigned uploads come in Phase 5) |
| Shared rule | Ethiopian mobile normalization in TypeScript, tested against the same vectors as the Dart implementation |
| Docker | Multi-stage `Dockerfile`: `migrator` target runs `prisma migrate deploy` once; `runtime` target has production dependencies only and runs as non-root (`node`) with root-owned application files |

### Infrastructure (`infra/docker-compose.yml`)
Services: PostgreSQL 17, Redis 7.4 (password, AOF), S3-compatible storage (SeaweedFS 4.54, private bucket created by `storage-init`), `migrate`, and `api` with a healthcheck. All ports bind to `127.0.0.1`. An init script creates `platform_test` and `platform_shadow`.

### Shared Dart package (`packages/core_shared/`)
- `Money` uses integer minor units and only ETB. `fromJson` rejects floats. The safe-integer bound also holds on web.
- `formatMoney` (`ETB 1,500.00` / `ብር 1,500.00`) and `parseEtbInput` use integer arithmetic only.
- Ethiopian phone normalization and display formatting (`+251 91 123 4567`).
- A test fails if `double`, `num` or rounding calls appear in money code.

### Mobile (`mobile/`)
| Item | Implementation |
|---|---|
| Stack | Flutter 3.47, Material 3, Riverpod 3.5, GoRouter 18, Dio 5, flutter_secure_storage 11, shared_preferences |
| Environment config | `AppConfig` from `--dart-define-from-file=config/<env>.json` (public values only). The app refuses non-HTTPS URLs outside development |
| Networking | `createDio` sets timeouts (connect 10 s, receive 20 s, send 60 s). `RequestIdInterceptor`. `RetryInterceptor` retries only GETs or requests with an `Idempotency-Key`, only on transient errors (connection, timeouts, 502, 503, 504), at most twice, and never when a request is flagged `noRetry` (payments, payouts). `ApiClient` unwraps the envelope. `ApiFailure` is a sealed hierarchy mapped from problem details |
| Riverpod auto-retry | Disabled globally (`retry: (_, _) => null`), so only the network layer decides retries |
| Secure storage | `TokenStore` interface. `SecureTokenStore` stores the refresh token only (Keystore/Keychain, this-device-only on iOS) |
| Localization | ARB files for en and am (28 messages), gen-l10n, and a persisted language switch. Tests check key and placeholder parity and that no `Text('literal')` appears under `lib/` |
| Theme | Material 3 from a seed colour. 48 dp tap targets, 52 dp primary buttons |
| State widgets | `AsyncValueView` handles loading, data, empty, error with retry, and offline (cached data stays visible under a banner). Also `LoadingView`, `EmptyView`, `ErrorView` (localized message and support reference), `OfflineBanner`, `PrimaryButton` (ignores taps while loading), `MoneyText` |
| Router | GoRouter: `/` redirects to `/welcome`; unknown links show a not-found screen with a way home |
| Screens | Welcome screen (product summary, language menu, live service status from `GET /health/live` with retry) and the not-found screen. There are no login or registration buttons, because those arrive in Phase 3 |
| Android | `INTERNET` permission in the main manifest. Release builds are HTTPS-only and trust system CAs only. Debug builds allow cleartext to `10.0.2.2`, `localhost` and `127.0.0.1` only. `allowBackup=false` and data-extraction rules exclude app data from backup and transfer. `minSdk 26` |

### CI (`.github/workflows/ci.yml`)
- **backend job:** format, lint, typecheck, migrate on an empty DB, drift check, unit tests, integration tests (Postgres, Redis and SeaweedFS service containers), build, and dependency audit.
- **backend-image job:** builds the runtime and migrator images and asserts the image refuses an insecure production config.
- **core-shared and mobile jobs:** format, analyze, test, and a release APK build.
- **secrets-scan job:** gitleaks with an allow-list limited to the dev fixtures.

## 2. Deviations from the architecture documents

| Architecture said | Phase 2 does | Why |
|---|---|---|
| Jest | **Vitest 5 + SWC** (decorator metadata enabled) | NestJS 12 is ESM-only. `@nestjs/throttler` and `nestjs-pino` are still CommonJS and `require()` Nest, which Jest cannot load on Node 22 (it needs Node 24.9+). Vitest handles this mix |
| MinIO locally | **SeaweedFS 4.54** (Apache-2.0, S3 API) | MinIO images could not be pulled from Docker Hub or quay.io. I verified SeaweedFS rejects wrong credentials and anonymous reads |
| Testcontainers | Compose services plus a dedicated `platform_test` DB that is reset and migrated from zero before each integration run. The suite refuses DB names that don't end in `_test` | Simpler on Windows and CI. Same real engines |
| freezed / riverpod_generator / go_router_builder | Not added yet | No models or routes justify code generation yet. Dart 3 sealed classes cover `ApiFailure`. Code generation will be added when the first API DTOs appear (Phase 3) |
| drift offline cache | Not added | No user data to cache before Phase 3. The offline UI state exists and is tested |
| Monthly partitioned `audit_logs` | Plain table with append-only triggers | Partitioning needs the partition key in the primary key and complicates Prisma. Revisit in Phase 21 with real volumes |
| Rate limit per user | Per route and per IP (throttler default key) | No authenticated users yet. Per-user and auth-specific limits come in Phase 3 |
| `/metrics` (prom-client), worker process | Not created | Not in the Phase 2 scope list. The worker arrives with the first background job |
| Brief prompt `02_PROJECT_FOUNDATION.txt` lists registration, login and refresh tests | Not implemented | Your instruction and the approved plan place authentication in Phase 3. The 01 prompt says the same |

I treated your approval of the architecture as approval of the six defaults listed in `docs/architecture/README.md`.

## 3. Files changed

All files are new (greenfield). The only moved files are the prompts, `kiroween_hacka_transportation/` → `ai-prompts/`. 220 files would be tracked by git; 62 of them are the generated Flutter `android/` and `ios/` scaffolding.

- Root: `.gitignore`, `.gitattributes`, `.editorconfig`, `.gitleaks.toml`, `README.md`, `.github/workflows/ci.yml`, `admin/README.md`
- `backend/`: `package.json`, `package-lock.json`, `tsconfig*.json`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `vitest.config.ts`, `prisma.config.ts`, `Dockerfile`, `.dockerignore`, `.env.example`, `prisma/schema.prisma`, `prisma/migrations/20261117111526_foundation/migration.sql`, 29 files under `src/` (22 source, 7 unit specs), and 12 files under `test/`
- `infra/`: `docker-compose.yml`, `postgres/init-databases.sh`, `storage/s3-identities.dev.json`
- `packages/core_shared/`: package files, 4 library files, 3 test files. `packages/test_vectors/ethiopian_phone_numbers.json`
- `mobile/`: `pubspec.yaml`, `pubspec.lock`, `l10n.yaml`, `analysis_options.yaml`, `config/*`, 23 files under `lib/` (21 Dart, 2 ARB), 6 test files, Android manifest, network-security and data-extraction XML, and `minSdk` in `build.gradle.kts`
- `docs/reports/phase-02.md` (this file)

## 4. Commands run (final gate) and results

Backend (`backend/`):

| Command | Result |
|---|---|
| `npm run format:check` | pass |
| `npm run lint` (ESLint strict type-checked, bans `$queryRawUnsafe`/`$executeRawUnsafe`) | pass, 0 problems |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm run db:drift` | "No difference detected" |
| `npm test` | **70 / 70 passed** (7 files) |
| `npm run test:integration` | **68 / 68 passed** (7 files, real Postgres, Redis and storage) |
| `npm run audit:deps` and `npm audit` (all deps) | 0 vulnerabilities |

Dart / Flutter:

| Command | Result |
|---|---|
| `packages/core_shared`: `dart format --set-exit-if-changed`, `dart analyze --fatal-infos`, `dart test` | pass, pass, **62 / 62 passed** |
| `mobile`: `dart format --set-exit-if-changed lib test`, `flutter analyze --fatal-infos`, `flutter test` | pass, pass, **60 / 60 passed** |

Docker:

| Check | Result |
|---|---|
| `docker compose -f infra/docker-compose.yml up -d --build` (dev stack) | all services healthy; `migrate` and `storage-init` exit 0 |
| Isolated from-zero run (`-p mobility-verify`, fresh volumes, `--wait`) | migration `20261117111526_foundation` applied; bucket created; `/health/ready` returns 200 with all components up; `/api/docs` returns 200; both audit triggers present |
| Stop Redis in that stack | `/health/ready` returns 503 `redis: down`; after restart it returns 200 again |
| `docker run` the API image with `APP_ENV=production` and dev credentials or no TLS | refuses to start, exit 1, error names the variables without values |
| API container user | `uid=1000(node)` |
| gitleaks over the files git would track | no leaks (after replacing two high-entropy test idempotency keys) |

Total automated tests: **260**, all passing.

**Not completed: `flutter build apk --release`.** Gradle had to download its 9.3.1 distribution, and the download stalled at about 77 MB. I stopped it after about 20 minutes. Analyze and tests pass, but the Android manifest, network-security and Gradle changes have **not been validated by a real build** on this machine. The CI `mobile` job includes this build.

## 5. What the tests cover

- **Database:** unique phone and email, phone and email format, closed-account consistency, FK restrict on users, session expiry, revocation reason and token rotation, device uniqueness, idempotency uniqueness and format, outbox naming, audit UPDATE/DELETE/TRUNCATE rejection with a one-time seal, partial index WHERE clauses, UUIDv7 ordering.
- **HTTP:** envelope; prefix-only routing; request id generation, echo and replacement; problem details for 404, 409, 500 (no leakage), 400 validation (codes, no echoed values, unknown fields, no coercion), malformed JSON and 413; fail-closed guard (including a forged bearer token); helmet headers; no HSTS in development; CORS allow and deny; requests without an Origin.
- **Public-route allow-list:** discovers every controller route and fails if any `@Public()` route is missing from the reviewed list, and checks every other route returns 401.
- **Rate limiting:** limit enforced across two API instances sharing Redis; 429 with `Retry-After`; health exempt; sliding window expiry; atomic under 50 concurrent hits; key TTLs; stricter fallback when Redis is down.
- **Logging:** query strings, Authorization and Cookie headers, and body secrets never appear in logs; unit redaction tests for each sensitive key.
- **Config:** TLS and development-credential rules, CORS origin format, no secrets in error messages.
- **Mobile:** retry policy (GET, idempotency key, `noRetry`, no retry on 4xx, at most two retries); failure mapping for every status and transport error; envelope handling; config validation; locale persistence; secure token store; ARB parity; all five async states including offline-with-cache; Amharic rendering; 200% text scale on a 360 dp screen in both languages; Android tap-target and contrast guidelines; router redirect, unknown deep link and return home.

## 6. Known limitations

1. No authentication yet. Every non-public route returns 401 by design, until Phase 3.
2. The release APK build was not verified locally (see §4). Release builds are still signed with the debug key (Flutter template); release signing is a Phase 23 item.
3. CI has not run on a real runner. The workflow file was written but never executed: no remote repo, and PyYAML wasn't available for a syntax check.
4. Idempotency and outbox tables exist with their constraints, but their service code (interceptor, dispatcher) arrives with the first endpoint and job that need them.
5. The `audit_logs` hash chain columns and seal rule exist; the sealing job does not yet.
6. **Amharic strings were written by me and need native-speaker review** (risk T-2) before any user sees them. The Noto Sans Ethiopic font is not bundled; the app relies on the Android system font.
7. Readiness treats Redis as a hard dependency (503), while the API itself keeps serving with the fallback limiter. Revisit if the load balancer setup makes that undesirable.
8. The Ethiopian mobile prefixes (9, 7) are still an [ASSUMPTION] to validate against the current numbering plan.
9. The local dev stack (`kiroween-mobility`) is still running; stop it with `docker compose -f infra/docker-compose.yml down`.
10. Git Bash on Windows needs `MSYS_NO_PATHCONV=1` for compose bind mounts. Windows also reserves some ports (for example 58433), so host ports can be overridden through `*_HOST_PORT` variables.

## 7. Remaining risks

| Risk | Note |
|---|---|
| Ecosystem churn | NestJS 12 (3 months old, ESM-only), Prisma 7 and TypeScript 6 are recent. `nestjs-pino` and `@nestjs/throttler` are still CommonJS. Pinned exact versions; watch for ESM releases |
| Prisma limitations | Partial indexes are declared without their WHERE clause in `schema.prisma`; the drift check depends on names and columns matching. The migration workflow is documented in `README.md` |
| Dev credentials in repo | Intentional, localhost-only, rejected by config outside development, and allow-listed narrowly in gitleaks |
| External items unchanged | Fayda onboarding, payment provider access and the legal questions L-1 to L-10 are still open; nothing in Phase 2 depends on them |

## 8. Next step

Waiting for your approval before starting Phase 3 (Authentication).
