# Architecture — Addis Ababa Owner/Driver Vehicle Platform

Status: **PROPOSAL, awaiting approval.** No application code exists yet.

## Repository inspection (2026-11-17)

- The workspace holds only `kiroween_hacka_transportation/` with 27 prompt files (`00`–`25`, `README.txt`). There is no source code, no git repository, no lockfiles and no CI config.
- Local toolchain detected: Node 22.16, npm 11.5, Flutter 3.47.7 / Dart 3.13.5, Docker 29.1 + Compose v2.40, PostgreSQL 18.3 client, git 2.49.
- Conclusion: greenfield. Nothing to migrate or preserve except the prompt files.

## Documents

| # | File | Covers (brief item) |
|---|------|---------------------|
| 1 | [01-requirements-actors-journeys.md](01-requirements-actors-journeys.md) | Product requirements, system context, actors, permission matrix, user journeys |
| 2 | [02-domain-model-and-rules.md](02-domain-model-and-rules.md) | Domain model, state machines, business rules |
| 3 | [03-database-schema.md](03-database-schema.md) | PostgreSQL schema, constraints, indexes, concurrency guarantees |
| 4 | [04-api-architecture.md](04-api-architecture.md) | REST boundaries, conventions, error format, idempotency |
| 5 | [05-backend-architecture.md](05-backend-architecture.md) | Framework/ORM choices, module structure, jobs, observability |
| 6 | [06-flutter-architecture.md](06-flutter-architecture.md) | Mobile structure, state, networking, offline, localization |
| 7 | [07-security-architecture.md](07-security-architecture.md) | AuthN, AuthZ, file storage, threat model |
| 8 | [08-identity-and-verification.md](08-identity-and-verification.md) | Fayda/eSignet identity, driver/owner/vehicle verification |
| 9 | [09-ledger-payments-payouts.md](09-ledger-payments-payouts.md) | Ledger, commission, payment providers, payouts, reconciliation |
| 10 | [10-notifications-disputes-audit.md](10-notifications-disputes-audit.md) | Notifications, chat/support, disputes, audit |
| 11 | [11-operations-testing-deployment.md](11-operations-testing-deployment.md) | Scalability, failure scenarios, testing, deployment |
| 12 | [12-ethiopia-assumptions-risks.md](12-ethiopia-assumptions-risks.md) | Ethiopian context, assumptions, legal/regulatory review items |
| 13 | [13-implementation-plan.md](13-implementation-plan.md) | Phased, dependency-ordered roadmap |

## Labels used throughout

- **[IMPL]** will be implemented and tested in this repository.
- **[ABSTRACTION]** an interface plus a development adapter; production needs an external integration.
- **[EXTERNAL]** depends on a third party (credentials, contract, sandbox) we do not have.
- **[ASSUMPTION]** a product decision taken by default; can be changed.
- **[LEGAL]** must be reviewed by an Ethiopian legal/regulatory professional before production.

## Key decisions (summary)

| Decision | Choice | Main reason |
|---|---|---|
| Overall shape | Modular monolith (API process + worker process, same codebase) | Expected scale fits one Postgres; module boundaries keep a later split possible |
| Backend framework | NestJS (Express adapter), strict TypeScript | DI, guards/interceptors for cross-cutting auth/validation, first-class OpenAPI, testing module |
| ORM | Prisma, plus hand-written SQL in migrations and `$queryRaw` tagged templates for locking | Type-safe client and migration history; SQL used where Prisma cannot express exclusion constraints, triggers, `FOR UPDATE` |
| Database | PostgreSQL 16+ | Exclusion constraints, partial unique indexes, `SKIP LOCKED`, `tstzrange` |
| Background work | Transactional outbox table in Postgres + worker using `FOR UPDATE SKIP LOCKED` | Events are committed atomically with business writes; no second queue system to keep consistent |
| Redis | Yes, limited to distributed rate-limit counters and short-lived caches | Rate limits must hold across API instances; nothing financial depends on Redis |
| Object storage | S3-compatible API (MinIO locally) | Private buckets, server-side encryption, short-lived signed GET URLs |
| Money | `BIGINT` minor units (santim), explicit `currency`, double-entry append-only ledger | No floats, auditable, corrections by compensating entries |
| Identity | `IdentityProvider` abstraction; Fayda via eSignet OIDC adapter (backend-only); dev adapter disabled in production | Matches official eSignet relying-party model without inventing endpoints |
| Payments | `PaymentProvider` / `PayoutProvider` abstraction; signed dev sandbox adapter only | No Ethiopian provider docs/credentials available yet |
| Admin UI | Separate Flutter web app (`admin/`) talking to `/api/v1/admin/*`, staff accounts require TOTP MFA | Keeps admin code out of the driver/owner APK |

## Decisions needed from you before Phase 2

These change the schema or ledger, so I need answers (or approval of the default) first. Details are in the referenced docs.

1. **Commercial model** ([09](09-ledger-payments-payouts.md#1-commercial-model)). Default: the driver pays the owner a fixed periodic rent (daily/weekly) through the platform, and the platform deducts a commission from the owner's share. Revenue share on trip income is modelled but deferred, because the platform cannot observe trip income from street taxi work or other ride-hailing apps.
2. **Trip tracking scope** ([02](02-domain-model-and-rules.md#310-activity-records)). Default: no continuous GPS. The platform records handover check-in/check-out (odometer, photos, one optional location fix) and optional driver-reported activity summaries.
3. **Dual roles** ([01](01-requirements-actors-journeys.md#3-actors)). Default: one customer account may hold both a driver profile and an owner profile, but can never apply for its own vehicle. Staff accounts are separate and cannot hold customer roles.
4. **Identity fallback** ([08](08-identity-and-verification.md#6-fallback)). Default: until NIDP onboarding is complete, staging uses the dev adapter and production verification is blocked. A manual document-review path for people without Fayda is designed but switched off pending [LEGAL] review.
5. **Admin console timing** ([13](13-implementation-plan.md)). Default: a minimal admin web app ships with driver verification (Phase 5), because officers need it to review documents.
6. **Repository setup**. Default: `git init`, move the prompt folder to `/ai-prompts` (as its README suggests), and lay out `backend/`, `mobile/`, `admin/`, `infra/`, `docs/`.
