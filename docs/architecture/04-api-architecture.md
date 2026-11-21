# 04 — API Architecture

## Conventions

- Base path `/api/v1`. Breaking changes go to `/api/v2`; additive changes stay in v1.
- JSON, `camelCase` fields, ISO-8601 UTC timestamps, money as `{ "amountMinor": 150000, "currency": "ETB" }` (integer, never a float or formatted string).
- Auth: `Authorization: Bearer <access JWT>`. Refresh token only sent to `/auth/refresh` and `/auth/logout` in the body.
- Every response carries `X-Request-Id` (generated if the client did not send a valid one).
- OpenAPI 3.1 generated from NestJS decorators at `/api/docs` (disabled or behind staff auth in production); JSON spec exported in CI and used to generate the Dart client models.

### Success envelope
```json
{ "data": { ... } }
{ "data": [ ... ], "page": { "nextCursor": "eyJ...", "limit": 20 } }
```

### Error format (RFC 9457 problem details)
```json
{
  "type": "https://errors.<domain>/listing-not-available",
  "title": "Listing is no longer available",
  "status": 409,
  "code": "LISTING_NOT_AVAILABLE",
  "requestId": "01J…",
  "errors": [ { "field": "rentAmountMinor", "code": "MIN_VALUE" } ]
}
```
`code` is a stable machine code the app maps to a localized message. Internal details (SQL, stack traces, provider messages) are never returned. 404 is returned instead of 403 for resources the caller has no relationship with (prevents ID probing).

### Pagination, filtering, sorting
- Cursor pagination (`?limit=20&cursor=…`), max `limit` 50. Cursor is an opaque, signed (HMAC) encoding of the sort key + id, so it cannot be tampered with to read other scopes.
- Filters are explicit whitelisted query params per endpoint (`?subCity=BOLE&vehicleType=SEDAN&minRent=…`). Sorting via `?sort=published_at:desc|rent:asc` from a whitelist.
- Admin list endpoints may use offset pagination with total counts (small data sets, staff UX).

### Idempotency
`Idempotency-Key` header (UUID) is **required** on: register, apply, accept/reject application, accept agreement, create payment, create payout, post adjustment, create dispute, send message. Stored in `idempotency_records` with a request hash; same key + same body → cached response; same key + different body → 422 `IDEMPOTENCY_KEY_REUSED`; concurrent in-flight → 409 `REQUEST_IN_PROGRESS`.

### Concurrency
Mutable resources return `version`; update endpoints require `If-Match: <version>` (or `version` in body) → 409 `VERSION_CONFLICT` on mismatch.

### Rate limits (Redis, sliding window)
| Scope | Limit |
|---|---|
| OTP send per phone | 3 / 15 min, 10 / day |
| OTP send per IP | 20 / hour |
| Login per phone | 5 / 15 min then lock with backoff |
| Login per IP | 30 / 15 min |
| Authenticated default per user | 120 / min |
| Uploads per user | 30 / hour |
| Webhooks per provider | 600 / min, IP allow-list where provider publishes ranges |

429 responses include `Retry-After`.

## Endpoint boundaries

Customer API (mobile). Paths abbreviated; all under `/api/v1`.

| Module | Endpoints |
|---|---|
| auth | `POST /auth/otp` · `POST /auth/register` · `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `POST /auth/password/reset/request` · `POST /auth/password/reset/confirm` |
| me | `GET/PATCH /me` · `GET /me/sessions` · `DELETE /me/sessions/{id}` · `POST /me/devices/push-token` · `POST /me/close` |
| identity | `POST /identity/verifications` (returns authorization URL) · `GET /identity/verifications/current` · `GET /identity/verifications/{id}` · `POST /identity/verifications/{id}/confirm` (same-session confirmation, Phase 4) · `POST /identity/verifications/{id}/cancel` · `GET /identity/callback/{provider}` (browser redirect target, not called by app) |
| documents | `POST /documents` (create upload intent → presigned PUT URL, constraints) · `GET /documents` · `GET /documents/{id}` · `POST /documents/{id}/complete` · `GET /documents/{id}/url` (short-lived GET URL) · `DELETE /documents/{id}` (only DRAFT; not implemented in Phase 5) |
| drivers | `POST /drivers/me` · `GET/PATCH /drivers/me` · `POST /drivers/me/licenses` · `PATCH /drivers/me/licenses/{id}` · `PUT /drivers/me/licenses/{id}/documents/{front\|back}` (Phase 5) · `POST /drivers/me/licenses/{id}/submit` · `GET /drivers/me/eligibility` |
| owners | `POST /owners/me` · `GET/PATCH /owners/me` (If-Match) · `GET /owners/me/status` · `PUT /owners/me/documents/{tin\|business-license\|representative-letter}` · `POST /owners/me/submit` (Idempotency-Key) (Phase 6) |
| vehicles | `POST /vehicles` · `GET /vehicles` (mine) · `GET/PATCH /vehicles/{id}` (If-Match) · `PUT /vehicles/{id}/evidence/{slot}` (Phase 7, replaces `POST …/documents`) · `GET /vehicles/{id}/status` · `POST /vehicles/{id}/submit` (Idempotency-Key) · `POST /vehicles/{id}/archive` |
| listings (owner) | `POST /listings` · `GET /listings/mine` · `GET/PATCH /listings/{id}` · `POST /listings/{id}/publish` · `/pause` · `/close` |
| marketplace (driver) | `GET /marketplace/listings` · `GET /marketplace/listings/{id}` |
| applications | `POST /marketplace/listings/{id}/applications` · `GET /applications/mine` · `GET /listings/{id}/applications` (owner) · `GET /applications/{id}` · `POST /applications/{id}/accept` · `/reject` · `/cancel` |
| agreements | `GET /agreements` · `GET /agreements/{id}` · `GET /agreements/{id}/versions/{n}` · `POST /agreements/{id}/versions/{n}/accept` · `/decline` · `POST /agreements/{id}/terminate` |
| assignments | `GET /assignments` · `GET /assignments/{id}` · `POST /assignments/{id}/handovers` · `POST /assignments/{id}/handovers/{kind}/confirm` · `POST /assignments/{id}/return` · `POST /assignments/{id}/activity-reports` |
| payments | `GET /charges` · `GET /charges/{id}` · `POST /charges/{id}/payments` (returns provider checkout instruction) · `GET /payments/{id}` |
| earnings/payouts | `GET /wallet` (balances) · `GET /wallet/statement` · `GET/POST /payout-methods` · `GET /payouts` · `GET /payouts/{id}` |
| webhooks | `POST /webhooks/payments/{provider}` · `POST /webhooks/payouts/{provider}` (no JWT; signature-authenticated) |
| notifications | `GET /notifications` · `POST /notifications/{id}/read` · `POST /notifications/read-all` · `GET /notifications/unread-count` |
| conversations | `GET /conversations` · `GET /conversations/{id}/messages` · `POST /conversations/{id}/messages` |
| support | `POST /support/tickets` · `GET /support/tickets` · `GET /support/tickets/{id}` · `POST /support/tickets/{id}/replies` |
| ratings | `POST /assignments/{id}/ratings` · `GET /users/{id}/ratings` |
| disputes | `POST /disputes` · `GET /disputes` · `GET /disputes/{id}` · `POST /disputes/{id}/evidence` · `POST /disputes/{id}/messages` |
| meta | `GET /meta/config` (sub-cities, vehicle types, min app version, feature flags) · `GET /health/live` · `GET /health/ready` |

Admin API (`/api/v1/admin/*`, staff tokens only, separate guard; customer tokens get 404):

| Area | Endpoints |
|---|---|
| reviews | `GET /admin/review-queue?type=` · `POST /admin/reviews/{type}/{id}/claim` · `/approve` · `/reject`. Phase 5 implements the driver queue as `GET /admin/driver-verifications` (+ `/counts`, `/{id}`) · `POST …/{id}/claim` · `/release` · `/approve` · `/reject` · `/suspend` · `/reinstate` · `GET …/{id}/documents/{documentId}/url?reason=` (permission `drivers.review`). Phase 6 adds `/admin/owner-verifications` (+ `/counts`, `/{id}`) · `POST …/{id}/claim` · `/release` · `/approve` (individual) · `/first-approval` · `/second-approval` (organization, different officer) · `/reject` · `/suspend` · `/reinstate` (decisions need `Idempotency-Key`) · `GET …/{id}/documents/{documentId}/url?reason=` (permission `owners.review`). Phase 7 adds `/admin/vehicle-verifications` (+ `/counts`, `/{id}`) · `POST …/{id}/claim` · `/release` · `/approve` · `/reject` · `/suspend` · `/reinstate` (decisions need `Idempotency-Key`) · `GET …/{id}/documents/{documentId}/url?reason=` (permission `vehicles.verify`) |
| identity | `GET /admin/identity-verifications/{id}` (logged) · `POST …/require-reverification` · `/suspend` |
| users | `GET /admin/users` · `GET /admin/users/{id}` · `POST /admin/users/{id}/suspend` · `/reinstate` |
| vehicles/listings | `POST /admin/vehicles/{id}/suspend` · `/reinstate` · `GET /admin/assignments` |
| finance | `GET /admin/ledger/accounts` · `GET /admin/ledger/entries` · `GET /admin/payments` · `GET /admin/payouts` · `POST /admin/payouts/{id}/hold` · `/release` · `/retry` · `POST /admin/adjustments` (propose) · `POST /admin/adjustments/{id}/approve` · `POST /admin/reconciliation-runs` · `GET /admin/reconciliation-runs/{id}` |
| config | `GET/POST /admin/commission-rules` · `POST /admin/commission-rules/{id}/approve` · `GET/PUT /admin/config/{key}` |
| support/disputes | `GET /admin/tickets` · `POST /admin/tickets/{id}/assign` · `GET /admin/disputes` · `POST /admin/disputes/{id}/transition` |
| staff | `GET/POST /admin/staff` · `POST /admin/staff/{id}/roles` · `DELETE /admin/staff/{id}/roles/{role}` |
| audit | `GET /admin/audit-logs` |

## DTO and mass-assignment rules
- Each endpoint has its own request DTO class validated with `class-validator` (`whitelist: true, forbidNonWhitelisted: true`). Server-controlled fields (`status`, `ownerId`, `verified*`, `amount` of a charge, `role`) never appear in request DTOs.
- Response DTOs are explicit mappers; Prisma entities are never serialized directly, so new DB columns cannot leak.
- IDs in paths are validated as UUIDs before any DB access.
