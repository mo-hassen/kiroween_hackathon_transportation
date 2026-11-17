# 07 — Security Architecture

## 1. Authentication

| Item | Design |
|---|---|
| Identifier | Ethiopian mobile number (E.164). Email optional. |
| Phone proof | 6-digit OTP, hashed (SHA-256 + server pepper), 5 min expiry, 5 attempts, rate-limited per phone and IP. Delivered via `SmsProvider` [EXTERNAL]. |
| Password | argon2id (m=19 MiB, t=2, p=1 per OWASP), min length 10, breached/common list check, no composition rules. |
| Access token | JWT, EdDSA (Ed25519) or ES256, 15 min, claims: `sub`, `sid`, `typ` (customer/staff), `roles` (staff only), `iat`, `exp`, `jti`. Verified on every request; `sid` checked against revoked-session cache (Redis, falls back to DB). |
| Refresh token | Opaque 256-bit random, stored hashed. Rotated on every use. Reuse of a previous token revokes the whole family (theft detection) and notifies the user. 30-day absolute lifetime; staff 12 h. |
| Logout | Revokes session; access token dies within ≤15 min, immediately if `sid` revocation cache hit. |
| Lockout | Exponential backoff per account after 5 failures; generic "invalid credentials" message; same response timing for unknown phones (dummy hash compare). |
| Enumeration | `POST /auth/otp` and password reset always return 202 with the same body. Registration of an existing phone sends a "you already have an account" SMS instead of revealing it in the API. |
| Staff | Separate login endpoint, password + TOTP mandatory, optional IP allow-list, 12 h session, re-auth (step-up) for finance approvals and role changes. |
| Mobile storage | Refresh token in `flutter_secure_storage` (Keystore). No tokens in logs, SharedPreferences or deep links. Screens with documents set `FLAG_SECURE`. |

## 2. Authorization

Three layers, all on the backend:

1. **Authentication guard** (global, opt-out only with `@Public()`; a test enumerates all routes and fails if a route is public without being on an allow-list).
2. **Permission guard**: `@RequirePermission('vehicle.verify')`. Permissions are code-defined constants; role → permission map is code, not DB (reviewable in PRs). Customer capabilities (`driver.*`, `owner.*`) derive from having the profile and its state.
3. **Resource policy**: each service loads the resource scoped by the caller (`WHERE id = $1 AND owner_profile_id = $2`) or calls `policy.assertCanView(actor, resource)`. Unrelated resources return 404. Policies are pure functions with table-driven tests per role.

Authorization tests: for every endpoint, a generated matrix test runs (anonymous, other customer, driver, owner, each staff role) and asserts the expected status. IDOR tests use two seeded users and swap IDs on every resource route.

## 3. Input & injection

- Prisma parameterized queries; raw SQL only via tagged `$queryRaw`; ESLint bans `$queryRawUnsafe`/`$executeRawUnsafe`.
- DTO whitelist validation; explicit response mappers (no mass assignment / over-exposure).
- Free text (messages, reviews, notes) stored raw, length-limited, rendered as plain text in Flutter (no HTML rendering). Admin web escapes by default.
- No server-side fetch of user-supplied URLs (no SSRF surface). Provider base URLs come from config only.

## 4. File and document security

1. Client requests an upload intent: `POST /documents { purpose, mimeType, sizeBytes, sha256 }`.
2. Server checks purpose is allowed for the caller, MIME in allow-list (`image/jpeg`, `image/png`, `image/webp`, `application/pdf`), size ≤ 10 MB (photos ≤ 5 MB), generates key `docs/{yyyy}/{mm}/{uuidv7}` (no user-controlled path), returns a presigned PUT URL valid 5 min with `Content-Type` and `Content-Length` conditions.
3. Client uploads directly to storage. `POST /documents/{id}/complete` → server HEADs the object, verifies size and SHA-256, reads magic bytes to confirm type, strips EXIF (location) from images by re-encoding in the worker, and runs a malware-scan hook (`FileScanner` interface; ClamAV adapter in Docker for dev/staging [ASSUMPTION]). Only then `AVAILABLE`.
4. Bucket is private, server-side encryption on, no public ACLs, CORS limited to PUT from app origin where needed.
5. Reads: `GET /documents/{id}/url` checks policy, returns a GET URL valid 60 s with `Content-Disposition: attachment` for PDFs. Every staff access writes an audit row.
6. Retention: rejected/superseded documents deleted after a configurable period [LEGAL].

## 5. Webhooks
See 09 §6. Summary: dedicated route without JWT, HMAC/signature verification per provider docs on the **raw body**, timestamp tolerance, event-ID dedupe table, server-side status re-query before acting, all in an audited inbox.

## 6. Transport, headers, secrets

- TLS everywhere (terminated at reverse proxy, HSTS). Android `network_security_config` disallows cleartext in staging/prod builds. Certificate pinning considered later (risk of bricking clients on rotation).
- Helmet headers; CORS allow-list (admin origin only).
- Secrets via environment injected from a secret manager in staging/prod; `.env` only for local dev, `.env*` in `.gitignore`; gitleaks in CI. Flutter builds contain only the API base URL and public flags.
- Field encryption keys separate from DB credentials; rotation supported by key ID prefix on ciphertext.

## 7. Abuse controls

Rate limits (04), application caps (BR-DRV-3), message length/rate limits, review moderation flag, OTP SMS budget alarms (SMS pumping fraud), device/installation IDs to correlate abuse.

## 8. Threat model (STRIDE summary)

| Asset | Threat | Control |
|---|---|---|
| Accounts | Credential stuffing, brute force | Rate limits, lockout, breached-password check, OTP for new devices [ASSUMPTION: step-up OTP on new device login] |
| Sessions | Token theft | Short access TTL, rotation + reuse detection, Keystore storage, device list with remote revoke |
| Identity data | Forged verification, data leak | Server-side OIDC exchange, state/nonce/PKCE, ID token signature check against provider JWKS, no client-settable status, encrypted minimal claims, access logging |
| Documents | IDOR, malicious files, public exposure | Random keys, policy checks, private bucket, short URLs, type/magic checks, scanning, EXIF strip |
| Vehicle allocation | Race to obtain same vehicle | Row locks, partial unique index, exclusion constraint |
| Money | Fake payment success, duplicate webhook, double payout, insider tampering | Provider confirmation only, inbox dedupe, idempotency keys, balance locks, append-only ledger with triggers, four-eyes adjustments, audit hash chain |
| Admin | Privilege escalation | Separate staff accounts, MFA, code-defined permissions, role changes by super admin only with audit, no self-grant (`granted_by <> user_id`) |
| Location | Privacy violation | No continuous tracking; single fixes rounded for listings; EXIF stripped |
| Logs | Sensitive leakage | pino redaction + tests, no payload logging for providers |
| Deep links | Hijacking | App Links with `assetlinks.json` verification, whitelist parsing, no secrets in links |
| Availability | DoS, SMS cost abuse | Rate limits, request size limits (1 MB JSON), SMS budget alarms, reverse-proxy limits |

Security verification per phase: authz matrix tests, IDOR tests, validation fuzz tests on DTOs, dependency audit (`npm audit`, `osv-scanner` for Dart), gitleaks, and the full audit in Phase 19.
