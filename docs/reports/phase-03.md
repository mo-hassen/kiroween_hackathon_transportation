# Phase 3 Report: Authentication

Date: 2026-11-17
Scope: Phase 3 only (`docs/architecture/13-implementation-plan.md`, row 3). Phase 4 (identity/Fayda) has not started.

## 1. Implementation completed

| Area | What exists now |
|---|---|
| Dev SMS/OTP adapter | `SmsProvider` boundary with two adapters: `dev` (in-memory inbox, codes readable at `GET /api/v1/dev/sms/messages`, development/test only) and `disabled` (default outside development; code-sending endpoints answer `503 SMS_UNAVAILABLE`). No real SMS gateway is integrated or simulated as one. |
| Registration | `POST /auth/otp` sends a 6-digit code. `POST /auth/register` (Idempotency-Key required) verifies it, creates an `ACTIVE` customer with an argon2id password and marks the device as trusted. |
| OTP verification | Codes are stored as keyed hashes (HMAC-SHA256 with a pepper, bound to the challenge id). They expire after 5 minutes and allow 5 attempts. Each attempt is counted in its own committed statement before the comparison, and a code can be consumed exactly once. |
| Login | Phone + password. An untrusted (new) installation also needs an SMS code (`OTP_REQUIRED` + login ticket → `POST /auth/login/verify`). |
| Tokens | Ed25519 access JWTs (15 min) and opaque 256-bit refresh tokens (`rt_…`) stored only as SHA-256. Customer sessions last 30 days and staff sessions 12 hours (absolute). |
| Refresh rotation and reuse detection | Each refresh rotates the token, and every retired hash is recorded. Presenting a retired token revokes the session, removes the device's trust, writes an audit entry and queues an `auth.session_compromised` outbox event. The previous token is accepted again only within a 2-minute network-retry grace window. |
| Logout | `POST /auth/logout` revokes the session immediately. Unknown tokens also get 204. |
| Sessions/devices | `GET /me/sessions` lists only the caller's active sessions and marks the current one. `DELETE /me/sessions/{id}` ends one of them; another user's session returns 404. Revoking another device also removes its trust. |
| Password reset | SMS code, then a new password. All sessions end, the lockout clears, other devices lose trust, and the device used for the reset is trusted. |
| Password change | `POST /me/password` requires the current password. Other sessions end and other devices lose trust. |
| Lockout and rate limiting | Account lockout after 5 consecutive failures for 1 minute, doubling each further failure, capped at 24 h. Redis sliding-window limits per phone and per IP for logins and code sends, per IP for code checks and refreshes, and per user for authenticated traffic and sensitive actions. |
| Staff authentication | Separate `POST /auth/staff/login` with password + TOTP (RFC 6238) on every login, TOTP replay protection, an optional IP allow-list, and 12 h sessions. Step-up re-authentication (`POST /auth/staff/reauthenticate`) is required within 5 minutes for staff and role changes. |
| Staff onboarding | A CLI bootstraps the first super admin (one-time activation code, only while none exists). Super admins create staff, who activate with the code plus a password and then enroll TOTP. Super admins can also grant/revoke roles and reset credentials. |
| Authorization framework | Global fail-closed `AuthenticationGuard` that re-reads the session, account status and roles from the database on every request. `AuthorizationGuard` makes non-staff on admin routes get 404, staff without the permission get 403, and stale step-up get 403 `REAUTHENTICATION_REQUIRED`. The role → permission map lives in code, and pure resource policies return 404 for resources the caller has no relationship with. BR-ACC-3: suspended/locked accounts are read-only. |
| Audit, outbox and idempotency | Every security event is audited in the same transaction as the change. Outbox events: `user.registered`, `auth.session_compromised`, `auth.password_reset`, `auth.password_changed`. The idempotency service claims the key, runs the work and stores the response in one database transaction (used by registration). |
| Flutter | Session restoration, guarded routes, sign-in, new-device code, registration, password reset, account (profile edit with If-Match, devices/sessions with remote sign-out, password change, sign-out), expired-session handling, the "can't reach the service" state, and a single-flight refresh interceptor. |

## 2. Files changed

130 files were created or modified after the Phase 2 report. How they map to Git commits is described in §13.

**Backend: new**
- Auth module (`src/modules/auth/`): `auth.controller.ts`, `staff-auth.controller.ts`, `auth.module.ts`, `auth-policy.ts`, `auth-errors.ts`. DTOs in `dto/`. `login/` (login, lockout, failure bookkeeping), `otp/otp-challenge.service.ts`, `password/` (hashing, policy), `registration/` (OTP requests, registration, password reset), `sessions/` (sessions, devices), `staff/` (staff auth, TOTP).
- Account (`src/modules/me/`) and staff administration (`src/modules/admin/`).
- Common services:
  - `src/common/auth/`: access tokens, guards, decorators, permissions, policies, principal.
  - `src/common/crypto/`: field encryption, secret hasher, random values, UUIDv7.
  - `src/common/idempotency/`, `src/common/audit/`, `src/common/outbox/`, `src/common/rate-limit/rate-limit.service.ts`, `src/common/http/request-meta.ts`, `src/common/validation/ethiopian-mobile.decorator.ts`, `src/common/common.module.ts`.
- SMS boundary (`src/providers/sms/`): provider interface, dev/disabled adapters, templates, sender, dev inbox controller, module.
- CLI (`src/cli/`): `bootstrap.ts`, `bootstrap-super-admin.ts`.
- `assets/common-passwords.txt` (9,113 entries) and `assets/README.md` (source and license).
- Migration `prisma/migrations/20261117132000_auth/migration.sql`.
- Tests:
  - `test/e2e/`: `auth-registration`, `auth-login`, `auth-sessions`, `auth-staff`, `authorization-matrix`, `auth-config-modes`.
  - `test/integration/auth-db-constraints.spec.ts`.
  - `test/helpers/auth-helpers.ts`, `test/helpers/routes.ts`.
  - Unit tests: `src/common/auth/authorization.spec.ts`, `src/common/crypto/crypto.spec.ts`, `src/modules/auth/auth-domain.spec.ts`.

**Backend: modified**
- `prisma/schema.prisma`, `src/app.module.ts`, `src/bootstrap/configure-app.ts` (adds `Cache-Control: no-store`).
- `src/common/auth/authentication.guard.ts`: the Phase 2 fail-closed stub became real token verification.
- `src/common/http/problem-details*.ts`: new codes; errors can carry headers.
- `src/config/env.schema.ts`, `src/config/app-config.ts`, `package.json`, `package-lock.json`, `Dockerfile` (copies `assets/`), `.env.example`.

**Phase 2 tests adjusted**
- `src/config/app-config.spec.ts`: the production fixture now includes the new required secrets; all assertions unchanged, 12 tests added.
- `test/e2e/public-routes.e2e.spec.ts`: the allow-list now includes the reviewed Phase 3 public routes, route discovery moved to a helper, and path joining was fixed.

**Mobile: new**
- `lib/core/auth/`: tokens, token manager, session state and controller, auth interceptor, device identity.
- `lib/core/config/app_info.dart`.
- `lib/features/auth/`: data, application, presentation and widgets.
- `lib/features/account/`, `lib/features/splash/`.
- Tests: `test/core/auth/auth_core_test.dart`, `test/features/auth_flows_test.dart`, `test/features/account_test.dart`, `test/helpers/app_harness.dart`, `test/helpers/fakes.dart`.

**Mobile: modified**
- `lib/app/router.dart` (session guard), `lib/app/routes.dart`, `lib/core/network/api_client.dart` (POST/PATCH/DELETE, 204, public client).
- `lib/features/welcome/welcome_screen.dart` (sign-in and registration buttons), `lib/features/system_status/data/system_status_api.dart` (public client).
- The two ARB files (63 new messages each).
- `pubspec.yaml` (version 0.2.0+2) and `pubspec.lock`.

**Mobile: Phase 2 tests adjusted**
- `test/features/welcome_and_router_test.dart`: `buildRouter` now takes the session, and the status card is scrolled into view before tapping because it sits below the new buttons.
- `test/helpers/fake_http_adapter.dart`: records the headers as they were when each request was sent.

**Other**
- `infra/docker-compose.yml` (`SMS_PROVIDER=dev`), `.github/workflows/ci.yml` (SMS env and coverage gate), `.gitleaks.toml` (two synthetic test passwords and the migration-name pattern).
- `README.md`, `mobile/README.md`, this report.

## 3. Database migration: `20261117132000_auth`

| Change | Details |
|---|---|
| Enums | `StaffRole` (SUPPORT, VERIFICATION_OFFICER, FINANCE, SUPER_ADMIN). `OtpPurpose` (REGISTER, LOGIN_STEP_UP, PASSWORD_RESET, STAFF_ACTIVATION, STAFF_MFA_ENROLLMENT). `AccountStatus` gains `PENDING_ACTIVATION`. |
| `users` | `mfa_enrolled_at`, `mfa_last_used_step`, `password_changed_at`. |
| `devices` | `trusted_at`. |
| `sessions` | `authenticated_at` (step-up), `rotated_at` (grace window). |
| New tables | `retired_refresh_tokens` (hash PK, session FK cascade). `staff_role_assignments` (one row per user+role; revocation by `revoked_at`; history in audit). `otp_challenges`. |
| CHECK constraints | Customers have no MFA data. ACTIVE staff must have enrolled MFA. Session and retired token hashes must be 64-hex. No self-grant. `revoked_by` requires `revoked_at`. OTP rules: phone format, hash formats, bounded attempts and `max_attempts`, expiry after creation, consumed after creation, and a per-purpose shape check (which ids/hashes each purpose must or must not have). |
| Triggers | `users.account_type` is immutable (BR-ACC-2). Roles can only be held and granted by staff accounts. |

Verified from an empty database: integration global setup and an isolated `docker compose -p mobility-verify` run both applied the two migrations. `npm run db:drift` reports "No difference detected".

## 4. API endpoints (all under `/api/v1`)

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /auth/otp` | public | 202 with the same body for every number. An existing number gets an "account exists" SMS instead of a code. |
| `POST /auth/register` | public, Idempotency-Key | 201 `{userId}`. A replay returns the stored response with `Idempotent-Replayed: true`. Same key with a different body → 422. |
| `POST /auth/login` | public | `AUTHENTICATED` (tokens) or `OTP_REQUIRED` (ticket). Every failure is 401 `INVALID_CREDENTIALS`. |
| `POST /auth/login/verify` | public | ticket + code + same installation → tokens. |
| `POST /auth/refresh` | public | Rotates. Any problem → 401 `UNAUTHENTICATED`. |
| `POST /auth/logout` | public | Always 204. |
| `POST /auth/password/reset/request` | public | Always 202. Unknown numbers get nothing. |
| `POST /auth/password/reset/confirm` | public | 204. Ends all sessions. |
| `POST /auth/staff/login` | public | Password + TOTP. 12 h session. |
| `POST /auth/staff/activate` | public | Activation code + new password → TOTP secret and enrollment ticket (shown once). |
| `POST /auth/staff/activate/confirm` | public | Ticket + TOTP → staff `ACTIVE`. |
| `POST /auth/staff/reauthenticate` | staff | Step-up for 5 minutes. |
| `GET /me`, `PATCH /me` | any signed-in user | PATCH requires `If-Match` (428 without, 409 on stale). Server-controlled fields are rejected. |
| `GET /me/sessions`, `DELETE /me/sessions/{id}` | any signed-in user | Own sessions only. Others → 404. |
| `POST /me/password` | any signed-in user | Wrong current password → 400 field error (never 401). |
| `GET /admin/staff` | `staff.read` | Customer → 404. Other staff → 403. |
| `POST /admin/staff` | `staff.manage` + step-up | 201 with a one-time activation code. Duplicate phone → 409 `PHONE_IN_USE`. |
| `POST /admin/staff/{id}/roles`, `DELETE /admin/staff/{id}/roles/{role}` | `staff.manage` + step-up | Not on oneself. The last super admin cannot be removed. |
| `POST /admin/staff/{id}/credentials/reset` | `staff.manage` + step-up | Back to `PENDING_ACTIVATION`. Sessions end. |
| `GET /dev/sms/messages` | public, dev/test only | Mounted only with `SMS_PROVIDER=dev`, which config rejects outside development/test. Excluded from OpenAPI. |

New error codes (RFC 9457 format unchanged): `INVALID_CREDENTIALS`, `OTP_INVALID`, `ACCOUNT_RESTRICTED`, `REAUTHENTICATION_REQUIRED`, `SMS_UNAVAILABLE`, `IDEMPOTENCY_KEY_REQUIRED|INVALID|REUSED`, `REQUEST_IN_PROGRESS`, `PRECONDITION_REQUIRED`, `VERSION_CONFLICT`, `PHONE_IN_USE`, `CANNOT_MODIFY_OWN_ACCOUNT`, `LAST_SUPER_ADMIN`. 401 responses carry `WWW-Authenticate: Bearer`, 429 responses carry `Retry-After`, and every response carries `Cache-Control: no-store`. OpenAPI documents 20 auth/me/admin paths.

## 5. Flutter flows

- **Start:** the splash screen restores the session by refreshing the stored token.
  - Success → Account.
  - Rejected → Welcome, and storage is wiped.
  - Network failure → "Can't reach the service" with Retry; the token is kept.
- **Welcome:** Create account / Sign in / language / service status.
- **Sign in:**
  - Local validation of phone and password, with generic error messages and rate-limit wait times.
  - On a new device, the SMS-code screen opens. Its ticket is passed only in memory (router `extra`); a deep link to that route redirects to sign-in.
- **Create account:** phone → code (with resend countdown) + name + password → automatic sign-in. The idempotency key is reused when the same details are retried and renewed after any change. Server password-policy errors appear under the field.
- **Forgot password:** phone → code + new password → automatic sign-in.
- **Account:**
  - Profile, with name editing that sends the version it read (If-Match).
  - Devices and sessions, with "This device" marked and remote sign-out after confirmation.
  - Change password, with sign-out confirmation.
  - Suspended accounts see a read-only notice and no edit actions.
- **Expired session:** the router moves to sign-in with "Your session has ended".
- **Token handling:**
  - The access token stays in memory; the refresh token is in `flutter_secure_storage`, and the new one is persisted before the new access token is used.
  - Refresh is single-flight, and on a 401 a request is retried once.
  - `/auth/*` requests are never sent with a bearer token and never trigger a refresh; refresh and logout requests are never auto-retried.
  - Sign-out clears local storage first, then tells the server on a best-effort basis.

## 6. Security decisions

1. **The database check on every request is authoritative.** The guard verifies the JWT, then loads session + account status + active roles (one indexed query). Logout, reuse revocation, suspension and role revocation take effect on the next request, not after the token expires.
2. **Enumeration resistance.** Identical 202 bodies for code requests. Identical 401 bodies for unknown, wrong, staff-on-customer, closed and locked accounts. An argon2 dummy verification runs for unknown and locked accounts (tested with spies). Registering an existing number produces the same `OTP_INVALID` as a wrong code. SMS is sent in the background, so its latency leaks nothing.
3. **Lockout blocks new logins only.** Existing sessions keep working, so an attacker cannot lock a victim out of the session they are already using. The lock itself is invisible (generic 401). Password reset clears it.
4. **New-device step-up (SMS code)** after a correct password from an unknown installation. This blunts credential stuffing with passwords leaked elsewhere. It implements the threat model's `[ASSUMPTION: step-up OTP on new device login]`.
5. **Refresh reuse detection** covers every retired token, not only the previous one. A 2-minute grace window for the previous token prevents logouts when a response is lost on a bad network. If an attacker uses it, the legitimate client's next refresh is detected as reuse and revokes everything.
6. **Secrets.** Passwords use argon2id (19 MiB, t=2, p=1), NFKC-normalized. OTP codes, tickets and idempotency fingerprints use HMAC with an HKDF-derived pepper. Refresh tokens are stored as SHA-256. TOTP secrets use AES-256-GCM with a key id and row-bound associated data. Staging and production refuse to start without non-development keys, and dev SMS is rejected there.
7. **No secrets in logs.** Verified in tests and in the running container's logs: 0 passwords, refresh tokens or JWTs. The dev SMS log shows a masked number and template id only.
8. **Responses never cached** (`Cache-Control: no-store`). Registration returns no tokens, so the idempotency store never holds credentials.
9. **Staff and customer accounts are separate** (DB trigger plus endpoints). Super-admin actions require recent re-authentication. There is no self-grant (DB CHECK plus service rule), and the last super admin is protected under a row lock.

## 7. Tests added

| Suite | Tests | Covers |
|---|---|---|
| `src/modules/auth/auth-domain.spec.ts` | 36 | RFC 6238 vectors, clock window, base32, otpauth URI, lockout backoff table, password policy (common, phone, repetitive, NFKC), argon2id parameters, unusable hashes |
| `src/common/auth/authorization.spec.ts` | 24 | Separation of duties (only super admin manages staff, only officers verify, only finance moves payouts, propose ≠ approve), decision table, step-up window, 404 policies, bearer parsing, IP allow-list |
| `src/common/crypto/crypto.spec.ts` | 14 | HMAC purposes and pepper, constant-time compare, AES-GCM round trip/tamper/AAD/rotation, tokens, codes, activation codes, UUIDv7 |
| `src/config/app-config.spec.ts` (+12) | 23 | Development defaults, required production secrets, dev secrets rejected, SMS fail-closed, key formats, allow-list, no values in errors |
| `test/e2e/auth-registration` | 22 | Journey J1, normalization, hashed codes, idempotent replay, 3 concurrent duplicates → 1 account, key reuse → 422, failures not cached, 5-attempt exhaustion, expiry, newest code only, enumeration, password policy, rate limits per phone/IP, no secrets in logs/audit |
| `test/e2e/auth-login` | 13 | Trusted device, new-device step-up (wrong code, other device, reused ticket, exhaustion), identical failures, dummy-hash spies, per-phone/per-IP limits, lockout + expiry + doubling, suspended read-only, closed accounts |
| `test/e2e/auth-sessions` | 20 | Rotation, absolute lifetime, grace retry, reuse after grace (revocation, device untrust, audit, outbox), older-token reuse, invalid/expired tokens, concurrent refresh, forged/foreign/unsigned/expired/relabelled JWTs, logout, session list, remote revoke → step-up, IDOR 404, If-Match profile, mass assignment, password change, reset, reset enumeration |
| `test/e2e/auth-staff` | 11 | Password + TOTP, 12 h session, generic failures, TOTP replay, customer login refused, admin 401/404/403/200, immediate role revocation, full activation lifecycle (single-use code and ticket), step-up, role grant/revoke rules, credential reset, duplicate phone |
| `test/e2e/authorization-matrix` | 13 | Every protected route × 7 actors (anonymous, customer, other customer, support, verification officer, finance, super admin). Fails if a protected route has no row. |
| `test/e2e/auth-config-modes` | 5 | Disabled SMS → 503 and no dev inbox, staff IP allow-list deny/allow, bootstrap CLI core (concurrent runs → exactly one) |
| `test/integration/auth-db-constraints` | 14 | Every new CHECK and trigger, with raw SQL |
| `mobile/test/core/auth/auth_core_test.dart` | 34 | Token manager (persist before use, single flight, sign-out only on rejection), interceptor (attach, refresh + retry once, shared refresh, expiry, offline, never on `/auth/*`), session controller, route-guard table |
| `mobile/test/features/auth_flows_test.dart` | 20 | Restore success/offline/rejected, sign-in validation/success/errors/rate limit/new device, expired banner, registration + idempotency key reuse, password policy, reset, 200% text in en/am, tap targets, Amharic |
| `mobile/test/features/account_test.dart` | 8 | Profile, If-Match edit, suspended read-only, devices + remote sign-out, password change errors/success, sign-out, guard, app version = pubspec |

## 8. Commands executed (final gate) and exact results

Backend (`backend/`):

| Command | Result |
|---|---|
| `npm run format:check` | All matched files use Prettier code style |
| `npm run lint` | 0 problems |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm run db:drift` | No difference detected |
| `npm test` | **156 passed** (10 files) |
| `npm run test:integration` | **166 passed** (14 files, real Postgres 17, Redis 7.4, SeaweedFS) |
| `npm run test:coverage:auth` | Lines **97.5%** (743/762), statements 94.57%, functions 97.86%, branches 84.23%. Threshold: 90% lines |
| `npm run audit:deps` / `npm audit` | 0 vulnerabilities / 0 vulnerabilities |

Dart / Flutter:

| Command | Result |
|---|---|
| `mobile`: `dart format --output=none --set-exit-if-changed lib test` | 56 files, 0 changed |
| `mobile`: `flutter analyze --fatal-infos` | No issues found |
| `mobile`: `flutter test` | **122 passed** |
| `packages/core_shared`: format / `dart analyze --fatal-infos` / `dart test` | 0 changed / no issues / **62 passed** |

Docker and end to end:

| Check | Result |
|---|---|
| `docker compose -f infra/docker-compose.yml up -d --build --wait` | All services healthy |
| Isolated from-zero stack (`-p mobility-verify`, fresh volumes) | Both migrations applied; `/health/ready` 200; 3 auth/audit triggers present; then `down -v` |
| Customer smoke test against the container (curl) | otp 202 → code from the dev inbox → register 201 → login `AUTHENTICATED` → `/me` 200 → refresh rotated → logout 204 → `/me` 401 |
| Staff smoke test against the container | Bootstrap CLI → activate → TOTP confirm 204 → staff login → `/admin/staff` shows `ACTIVE:SUPER_ADMIN`; a second bootstrap is refused with exit 1 |
| API container logs | 0 occurrences of the password, `rt_` tokens or JWTs |
| `docker run` the image with `APP_ENV=production` and dev/insecure settings | Refuses to start, exit 1, listing the 7 violated rules without values |
| gitleaks over the files git would track | No leaks (after allow-listing 2 synthetic test passwords and the migration-name pattern) |

Total automated tests: **506** (backend 322, core_shared 62, mobile 122), all passing. Phase 3 added 246: backend 184, mobile 62.

## 9. Failures and limitations

1. **Release APK still not built locally.** The Gradle 9.3.1 download restarted and reached about 13 MB in roughly 20 minutes before I stopped it. Android manifest/Gradle changes remain unverified by a real build here; CI includes the build.
2. **CI has still never run** (no remote repository).
3. **No production SMS provider.** Deployed environments default to `disabled`, so registration, new-device sign-in and password reset return 503 there until an adapter is written from an Ethiopian SMS gateway's official documentation [EXTERNAL].
4. **Outbox events are written but not delivered.** There is no worker yet, so users are not yet notified of refresh-token reuse, password reset or password change. Delivery comes in Phase 15; the plan writes events from now on.
5. **No admin web UI** (Phase 5). The staff endpoints are exercised by tests and curl. How the browser will hold staff refresh tokens (memory/cookie) is a Phase 5 decision.
6. **Not built:** `POST /me/close`, which needs the "no open assignments/balances" checks from later phases, and `POST /me/devices/push-token` (Phase 15). Journey J1 step 5 (choose driver/owner) needs the profiles from Phases 5 and 6.
7. **Translation review.** The 63 new Amharic UI messages and the 4 Amharic SMS templates are my translations and need native-speaker review.
8. The audit hash-chain sealer is still deferred (Phase 2 limitation).
9. Adding npm packages again dropped platform-specific optional dependencies from the lockfile (npm bug). The lockfile was regenerated, and Windows and Linux bindings for rolldown, swc and argon2 were verified.
10. The dev stack is running with the Phase 3 image. The dev database contains smoke-test accounts and a bootstrapped dev super admin.

## 10. Deviations from the architecture

| Architecture said | Implemented | Reason |
|---|---|---|
| `sid` checked against a Redis revocation cache, falling back to DB (07 §1) | Database lookup on every request (session, status, roles) | Stricter and always correct (fail closed). Revocation, suspension and role changes apply on the next request. Caching can be added in Phase 21 if measurements require it. |
| Account state `ACTIVE → LOCKED` on failed logins (02 §3.1) | `locked_until` with backoff; status stays `ACTIVE` | A LOCKED status would make the victim's existing sessions read-only (BR-ACC-3), letting an attacker lock people out. `LOCKED` remains available for staff action. |
| `PENDING_PHONE → ACTIVE` | Customers are created only after OTP proof, directly `ACTIVE`. New status `PENDING_ACTIVATION` for staff. `PENDING_PHONE` stays as the fail-closed column default. | Avoids half-registered accounts; staff need a distinct pre-activation state |
| J1 step 4: registration returns tokens | Registration returns `{userId}`; the app signs in next from the now-trusted device (no second SMS) | Idempotent responses are stored; storing live refresh tokens there would be a credential leak |
| Failure scenario "SMS provider down → OTP failure message" (11 §2) | SMS is sent in the background; delivery failures are logged with a masked number. A provider-wide outage (or no provider) still fails closed with 503. | Waiting for delivery would make response time depend on whether the number is registered (enumeration) |
| Rate limit "Login per phone 5/15 min **then lock with backoff**" | Both exist separately: a per-phone limiter (any number) and an account lock (existing accounts) | Keeps responses identical for unknown and known numbers |
| Staff password reset (not specified) | By a super admin (`credentials/reset` → new activation), never by SMS | Staff accounts are high privilege; SMS (SIM swap) is weaker than in-person handover |
| freezed/json_serializable for DTOs (06) | Small hand-written `fromJson` with strict type checks | About 5 DTOs so far; code generation would add a build step for little gain. Revisit when API models grow (Phase 5+). |
| TOTP library | RFC 6238 implemented in about 60 lines and verified against the RFC test vectors | Avoids a dependency for a small, well-specified algorithm |
| `POST /me/close`, push-token endpoint listed under `me` (04) | Not built | Depend on later phases (see §9.6) |

## 11. Remaining risks

| Risk | Note |
|---|---|
| SIM swap | Step-up SMS and password reset rely on phone possession. Mitigations planned for later phases: 24 h cooling-off on payout-method changes, security notifications once the worker exists, and the session list. |
| Network-retry grace (2 min) | A stolen previous token is usable within 2 minutes of a rotation. It is then caught at the legitimate client's next refresh. This is a deliberate trade-off for unreliable networks. |
| Per-request database lookup | One indexed query per authenticated request; fine at pilot scale (about 50 req/s). Measure in Phase 21. |
| SMS cost abuse (SMS pumping) | Per-phone, per-IP and daily limits exist. Budget alarms need the real provider and metrics (Phase 23). |
| Common-password list | Covers the NCSC top 100k, filtered to 10+ characters (9,113 entries); not a full breached-password corpus. A k-anonymity breach check would need an external service [EXTERNAL, privacy review]. |
| Ephemeral JWT key in development | Access tokens become invalid when the dev API restarts. Clients just refresh. Deployed environments require a configured key. |

## 12. Next step

Waiting for your approval before starting Phase 4 (identity verification). Fayda/eSignet has not been started.

## 13. Git history (reconstructed after the fact)

The repository had no commits until Phase 3 was finished. The history was then built from the files as they exist today, without changing any of them except this section.

- The first commit, `chore: establish pre-phase-3 repository baseline`, contains 190 files: the 189 that Phase 3 did not touch, plus `backend/prisma/migrations/migration_lock.toml`, whose three lines are fixed by the database provider. It is not an exact snapshot of Phase 2.
- 30 Phase 2 files were modified during Phase 3, and their Phase 2 versions were not saved anywhere. They are not reconstructed. Each one appears once, in its final form, in the Phase 3 commit its changes belong to.
- Every file is committed whole, so every committed file version is one that really exists. Intermediate commits do not build or pass tests on their own; the final commit does.
