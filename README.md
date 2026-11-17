# Kiroween Mobility

A platform that connects verified vehicle owners with verified drivers in Addis Ababa.

Status: **Phase 3 (authentication) complete.** Customers can register, sign in (with an SMS
code on new devices), manage sessions and reset passwords; staff sign in with password + TOTP.
See [`docs/reports/phase-03.md`](docs/reports/phase-03.md),
[`docs/reports/phase-02.md`](docs/reports/phase-02.md) and the roadmap in
[`docs/architecture/13-implementation-plan.md`](docs/architecture/13-implementation-plan.md).

## Repository layout

| Path | Contents |
|---|---|
| `backend/` | NestJS 12 + TypeScript API (ESM), Prisma 7, PostgreSQL, Redis |
| `mobile/` | Flutter driver/owner app (Android first) |
| `admin/` | Staff web app, created in Phase 5 |
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
