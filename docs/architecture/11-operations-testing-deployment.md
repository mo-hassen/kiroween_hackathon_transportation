# 11 — Scalability, Failure Scenarios, Testing, Deployment

## 1. Scalability requirements

Pilot sizing assumption [ASSUMPTION]: 5,000 drivers, 1,500 owners, 2,000 vehicles, 1,000 active assignments, ~2,000 payments/day, peak 50 req/s. Year-2 target 10×.

- One PostgreSQL primary (+ streaming replica for backups and read-only admin reports) handles this comfortably; all hot queries are index-backed and paginated.
- API is stateless → horizontal scaling behind a load balancer. Worker scales by instance count (SKIP LOCKED) with schedulers guarded by advisory locks.
- Marketplace query: composite index `(status, pickup_sub_city, vehicle_type, rent_amount_minor)` + keyset pagination; no `OFFSET` on customer endpoints; `EXPLAIN` checked in Phase 21.
- Connection pooling: Prisma pool sized per instance (`connection_limit`), PgBouncer in transaction mode when instance count grows.
- Caching: `/meta/config` and marketplace first page per filter in Redis for 30 s. No caching of anything user-specific or financial.
- Audit and notifications tables partitioned by month; outbox processed rows purged after 14 days.
- Modular monolith: split candidates if needed later are notifications and the webhook inbox; no microservices now.

## 2. Failure scenarios

| Scenario | Behaviour |
|---|---|
| Mobile loses network mid-apply | Idempotency key reused on retry → one application. UI shows "checking…" then real state. |
| Mobile loses network mid-payment | No auto retry; app polls payment by ID when back online; server polls provider. |
| Provider webhook never arrives | Worker polls `queryPayment`; expiry after window; finance review queue for unknowns. |
| Duplicate / replayed webhook | Inbox unique constraint; second event is no-op. |
| Provider down | `createPayment` fails fast (timeout 15 s) → payment `FAILED` with `PROVIDER_UNAVAILABLE`; user can retry with a new payment. Circuit breaker opens after N failures and the pay button shows a maintenance message. |
| Identity provider down | Verification session errors → `UNVERIFIED` with retry message; no fallback auto-verification. |
| SMS provider down | OTP failure message; rate-limit budget not consumed; alert. |
| Redis down | Rate limiting falls back to a stricter in-memory limiter per instance; session revocation check falls back to DB. Nothing financial affected. |
| Object storage down | Uploads fail with retry; reads show placeholder; verification queue unaffected otherwise. |
| DB failover | API returns 503 on readiness; clients retry GETs; mutations idempotent. |
| Worker crash mid-job | Transaction rolls back; job lease expires; another worker picks it up. External calls made before crash are reconciled by status query using our IDs. |
| Concurrent accept of same listing | One succeeds; other gets 409 `LISTING_NOT_AVAILABLE`. |
| Document expires during assignment | Eligibility recomputed; listing suspended; support alerted; assignment continues pending human decision (BR-DRV-4). |
| Clock skew on phone | Server time authoritative; the app never sends timestamps that decide business logic. |
| GPS unavailable / denied / poor accuracy | Location optional everywhere; handover proceeds without fix; accuracy > 100 m stored as "approximate". |
| Map tiles fail | Sub-city + landmark text are primary; map is decorative. |
| Old app version | `/meta/config` returns `minSupportedVersion`; app shows forced-update screen. |

## 3. Testing strategy

| Layer | Tooling | Scope |
|---|---|---|
| Backend unit | Jest | Pure domain: state transition tables, allocation math, phone normalization, eligibility rules, policy functions |
| Property | fast-check | Money allocation, ledger balance after random op sequences |
| Integration / repository | Jest + Testcontainers (real Postgres 16 + Redis) | Constraints (exclusion, partial unique, triggers), locking, migrations up from zero |
| API / e2e | Supertest against Nest app + Testcontainers | Every endpoint: success, validation, auth, error format |
| Authorization | Generated matrix per route × actor | Status codes per permission matrix; IDOR swap tests |
| Concurrency | Parallel transactions in integration tests | Concurrent accept, payout, webhook duplicates |
| Security | Custom suites + `npm audit`, osv-scanner, gitleaks, Semgrep rules | Log redaction, public-route allow-list, raw-SQL ban, rate limits, upload validation |
| Flutter unit/state | `flutter_test`, Riverpod overrides, mocktail | Notifiers, interceptors, formatters |
| Widget / golden | `flutter_test` | 5 UI states per screen, en/am, text scale 2.0 |
| Navigation | GoRouter tests | Redirect matrix by session state |
| Mobile e2e | `integration_test` on Android emulator against docker backend | Register → verify (dev) → browse → apply → accept → agreement → pay (dev sandbox) |
| Contract | OpenAPI diff in CI | Breaking-change detection |

Quality gate per phase: `prettier --check`, `eslint`, `tsc --noEmit`, backend tests, `prisma migrate deploy` on a clean DB, `dart format --set-exit-if-changed`, `flutter analyze`, `flutter test`, `docker compose up` health check. Coverage target: 90% lines on ledger/payments/auth/authorization modules, 75% overall.

## 4. Deployment architecture

```
                 Internet
                    │ TLS
          ┌─────────▼──────────┐
          │ Reverse proxy / LB │  (Caddy or Nginx; rate limits; body size; TLS)
          └───┬────────────┬───┘
              │            │ admin.<domain> (IP allow-list optional)
      ┌───────▼──┐   ┌─────▼─────┐
      │ api ×N   │   │ admin web │ (static files)
      └───┬──────┘   └───────────┘
          │ private network
  ┌───────┼───────────┬─────────────┬──────────────┐
  ▼       ▼           ▼             ▼              ▼
worker  PostgreSQL   Redis     Object storage   Metrics/logs
×M      (primary +   (private) (private bucket) (Prometheus/Loki or
        replica,                                 hosted equivalent)
        PITR backups)
```

- Environments: `development` (docker compose: postgres, redis, minio, clamav, api, worker), `staging` (dev adapters allowed only with banner; separate secrets), `production` (dev adapters rejected by config).
- Images: multi-stage Dockerfile, Node 22 slim/distroless, non-root user, `npm ci --omit=dev`, healthcheck. Migrations run as a separate one-shot job before rollout (`prisma migrate deploy`), backward-compatible (expand → migrate → contract).
- CI (GitHub Actions layout, portable): lint/format → typecheck → unit → integration (services) → build images → Flutter analyze/test → build APK (release signing secrets only in CI secret store) → security scans → OpenAPI diff.
- Backups: continuous WAL archiving + daily base backups (PITR, RPO ≤ 15 min), 30-day retention, monthly restore drill; object storage versioning enabled.
- Hosting location: **[LEGAL]** data residency for personal and identity data (Ethiopia's Personal Data Protection Proclamation No. 1321/2024 — confirm requirements) may require in-country hosting (e.g. Ethio Telecom or local data centres). Architecture is cloud-agnostic (containers + Postgres + S3-compatible storage) to allow that.
- Android release: Play App Signing, R8 shrinking, `network_security_config` no cleartext, flavors with only public config, App Links `assetlinks.json` hosted on the API domain.
