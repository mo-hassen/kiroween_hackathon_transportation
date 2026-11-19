# Kiroween Mobility

A platform that connects verified vehicle owners with verified drivers in Addis Ababa.

Status: **Phase 5 (documents, driver licence verification, minimal admin web) implemented, awaiting
review.** Drivers upload licence photos that are checked and re-encoded by the API; verification
officers review them in the staff console. Phase 4 (identity verification) and Phase 3
(authentication) are complete. See [`docs/reports/phase-05.md`](docs/reports/phase-05.md),
[`docs/reports/phase-04.md`](docs/reports/phase-04.md),
[`docs/reports/phase-03.md`](docs/reports/phase-03.md),
[`docs/reports/phase-02.md`](docs/reports/phase-02.md) and the roadmap in
[`docs/architecture/13-implementation-plan.md`](docs/architecture/13-implementation-plan.md).

## Repository layout

| Path | Contents |
|---|---|
| `backend/` | NestJS 12 + TypeScript API (ESM), Prisma 7, PostgreSQL, Redis |
| `mobile/` | Flutter driver/owner app (Android first) |
| `admin/` | Flutter Web staff console (driver licence review) |
| `packages/core_shared/` | Pure-Dart money and phone rules shared by the Flutter apps |
| `packages/test_vectors/` | Test data shared by the TypeScript and Dart test suites |
| `infra/` | Local Docker Compose stack |
| `docs/architecture/` | Approved architecture |
| `docs/reports/` | Per-phase verification reports |
| `ai-prompts/` | The phase prompts this project is built from |

## Prerequisites

Node.js 22.12+, Docker with Compose v2, Flutter 3.47 / Dart 3.13, and the Android SDK for device builds.

## Run the stack locally

```sh
docker compose -f infra/docker-compose.yml up -d --build
curl http://127.0.0.1:3000/api/v1/health/ready
```

This starts PostgreSQL (`127.0.0.1:55432`), Redis (`:56379`), S3-compatible storage (`:58333`),
runs migrations, creates the private bucket and starts the API on `:3000`. OpenAPI docs are at
<http://127.0.0.1:3000/api/docs>. All ports bind to localhost only, and the bundled credentials
are development-only; the API refuses to start with them in staging or production.

On Git Bash for Windows, run `export MSYS_NO_PATHCONV=1` first so container paths are not rewritten.

## Backend development

```sh
cd backend
cp .env.example .env        # local values matching the compose stack
npm ci
npx prisma generate
npm run db:deploy           # apply migrations to the dev database
npm run build && npm run start:dev
```

| Command | Purpose |
|---|---|
| `npm run format:check` / `npm run format` | Prettier |
| `npm run lint` | ESLint (strict, type-aware) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (no services needed) |
| `npm run test:integration` | Integration and HTTP tests. Needs the compose services. Resets `platform_test` and applies all migrations from zero |
| `npm run db:migrate` | Create a migration (`prisma migrate dev`) |
| `npm run db:drift` | Fails if `schema.prisma` and the migrations disagree |
| `npm run test:coverage:auth` | Coverage of auth/authorization code; fails below 90% lines |
| `npm run test:coverage:identity` | Coverage of identity code; fails below 90% lines |
| `npm run test:coverage:drivers` | Coverage of documents, drivers and scanner code; fails below 90% lines |
| `npm run identity:expire` | Applies due identity expiries (run from a scheduler; after `npm run build`) |
| `npm run drivers:refresh` | Nightly: expires licences by Addis Ababa date and refreshes driver eligibility |
| `npm run audit:deps` | Production dependency audit |

Schema changes: edit `prisma/schema.prisma`, run `npx prisma migrate dev --create-only --name <name>`,
add any CHECK constraints, partial-index `WHERE` clauses or triggers by hand to the generated SQL,
apply it with `npx prisma migrate dev`, then run `npm run db:drift`.

## Authentication in development

No real SMS gateway is integrated. With `SMS_PROVIDER=dev` (development/test only) messages are
kept in memory and can be read, including codes:

```sh
curl "http://127.0.0.1:3000/api/v1/dev/sms/messages?phone=0911234567"
```

Outside development the API defaults to `SMS_PROVIDER=disabled`: code-sending endpoints answer
`503 SMS_UNAVAILABLE` until a provider adapter is implemented from official documentation.

Create the first super administrator (only works while none exists), then activate it with
`POST /api/v1/auth/staff/activate` and `POST /api/v1/auth/staff/activate/confirm`:

```sh
docker compose -f infra/docker-compose.yml exec api node dist/cli/bootstrap-super-admin.js --phone 0911234567 --name "Full Name"
# or, from backend/ after `npm run build`:
npm run staff:bootstrap -- --phone 0911234567 --name "Full Name"
```

Staging and production refuse to start without `AUTH_JWT_PRIVATE_KEY`, `AUTH_JWT_KEY_ID`,
`HASHING_PEPPER` and `FIELD_ENCRYPTION_KEYS`/`FIELD_ENCRYPTION_ACTIVE_KEY_ID` (see
`backend/.env.example`).

## Identity verification in development

No real identity provider is connected. With `IDENTITY_PROVIDER=dev` (development/test only) the
API serves a **test consent page** with synthetic people and failure simulations; the flow
(state, nonce, PKCE, one-time code, callback) is the same as with a real OIDC provider.

1. The app calls `POST /api/v1/identity/verifications` and opens the returned URL in the browser.
2. The test page at `/api/v1/dev/identity/authorize` offers "Approve as …", "Decline" and failures.
3. The API callback redirects to `kiroweenmobility://app/identity/return?verification=…&confirmation=…`,
   which opens the app. The app confirms the result from the session that started it
   (`POST /api/v1/identity/verifications/{id}/confirm`); only then is the identity linked.

`PUBLIC_API_BASE_URL` must be the address the *browser* uses: the compose stack defaults to
`http://10.0.2.2:3000` (Android emulator); use `http://localhost:3000` on a desktop browser.
Outside development the API defaults to `IDENTITY_PROVIDER=disabled` (`503 IDENTITY_UNAVAILABLE`)
and rejects `dev`. The `esignet` adapter needs the NIDP relying-party credentials listed in
`backend/.env.example` and [`docs/reports/phase-04.md`](docs/reports/phase-04.md).

## Documents and driver verification in development

The app asks the API for a presigned URL (`POST /api/v1/documents`), PUTs the photo straight to
object storage and calls `POST /api/v1/documents/{id}/complete`. The API then checks size,
SHA-256 and magic bytes, re-encodes images without metadata, scans the original bytes and only
then stores the copy that can be downloaded (60-second URLs).

- Scanner: the compose stack uses `FILE_SCANNER=dev`, which **only detects the EICAR test file
  and is not malware protection**. For real scanning start ClamAV:
  `FILE_SCANNER=clamav docker compose -f infra/docker-compose.yml --profile scanner up -d`
  (clamd is also published on `127.0.0.1:53310`). Staging and production refuse `dev`; without
  a scanner they default to `disabled` and uploads stay retryable (`503 DOCUMENT_SCAN_UNAVAILABLE`).
- Presigned URLs use `STORAGE_PUBLIC_ENDPOINT` (default `http://localhost:58333`). For a phone
  or emulator run `adb reverse tcp:58333 tcp:58333`.
- Reviews need a staff account with the `VERIFICATION_OFFICER` role (assigned by a super
  administrator with `POST /api/v1/admin/staff/{id}/roles`). Super administrators, support and
  finance staff cannot review licences.

## Admin web console

```sh
cd admin
flutter pub get
flutter run -d chrome --web-port 8080 --dart-define-from-file=config/development.json
```

Sign in with a staff phone number, password and authenticator code. Tokens are kept in memory
only, so reloading the page signs you out. See [`admin/README.md`](admin/README.md).

## Mobile development

```sh
cd mobile
flutter pub get
flutter run --dart-define-from-file=config/development.json   # Android emulator -> host API
flutter analyze
flutter test
```

`config/*.json` contains public build settings only. Never put secrets in the app.

## Shared Dart package

```sh
cd packages/core_shared && dart pub get && dart test
```
