# 05 — Backend Architecture

## Framework choice: NestJS

Compared on what this project needs most: enforced cross-cutting security, testability, OpenAPI.

| Option | Pros | Cons |
|---|---|---|
| **NestJS** (chosen) | DI container makes provider abstractions (identity, payment, SMS, storage) swappable per environment; guards/interceptors/pipes give one place for auth, validation, idempotency, request IDs; `@nestjs/swagger`; `@nestjs/testing`; widely known | Heavier, decorator-heavy; needs discipline to avoid "god services" |
| Fastify + plugins | Faster, lighter | Every cross-cutting concern assembled by hand; easier to miss a guard on one route |
| Express | Familiar | Same as above, plus weaker typing |

NestJS runs on the Express adapter (more mature middleware ecosystem: helmet, pino-http). Raw throughput is not a constraint at pilot scale.

## ORM choice: Prisma

| Option | Pros | Cons |
|---|---|---|
| **Prisma** (chosen) | Generated types from schema, migration history, readable queries, `$transaction` with isolation levels, `$queryRaw` tagged templates are parameterized | Cannot model exclusion constraints/triggers/partial indexes in schema file; no native `SELECT … FOR UPDATE` in query builder |
| Drizzle | SQL-close, partial index support | Younger migration tooling; team familiarity lower |
| TypeORM | Decorators fit Nest | Historic correctness issues in migrations and transactions |

Mitigation for Prisma gaps: SQL constraints are written into migration files by hand; row locks use `tx.$queryRaw\`SELECT id FROM listings WHERE id = ${id} FOR UPDATE\`` (tagged template, parameterized). `$queryRawUnsafe` is banned by lint rule.

## Process model

One codebase, two entry points:
- `api` — HTTP server, stateless, horizontally scalable.
- `worker` — outbox dispatcher, schedulers (charge generation, expiry jobs, document expiry, payout batches, reconciliation, status polling of pending payments), notification delivery.

Background jobs use **Postgres** (`outbox_events`, `jobs` with `FOR UPDATE SKIP LOCKED`) instead of BullMQ/Redis queues: events are committed atomically with business data, and losing Redis never loses work. Schedulers use a Postgres advisory lock so only one worker instance runs each schedule. Revisit (BullMQ) only if job throughput exceeds what one Postgres comfortably handles.

## Module layout

```
backend/
  src/
    main.api.ts, main.worker.ts
    app.module.ts, worker.module.ts
    config/                 # zod-validated env schema; app refuses to start on invalid config
    common/
      http/                 # problem-details filter, response envelope, request-id middleware
      auth/                 # JwtAuthGuard, PermissionsGuard, @CurrentUser, @RequirePermission
      validation/           # global ValidationPipe, custom validators (EthiopianPhone, Uuid)
      idempotency/          # interceptor + repository
      pagination/           # signed cursor codec
      crypto/               # field encryption, HMAC, hashing
      logging/              # pino config, redaction paths
      state-machine/        # generic transition helper
    infrastructure/
      prisma/               # PrismaService, transaction helper with retry on serialization failure
      redis/
      storage/              # ObjectStorage interface + S3 adapter
      outbox/               # writer + dispatcher
    modules/
      auth/  users/  identity/  documents/  drivers/  owners/  vehicles/
      marketplace/  applications/  agreements/  assignments/
      ledger/  payments/  payouts/  notifications/  messaging/  support/
      ratings/  disputes/  audit/  admin/  health/  meta/
    providers/              # external integration boundary, each with interface + adapters
      identity/   { identity-provider.ts, esignet.adapter.ts, dev.adapter.ts }
      payment/    { payment-provider.ts, dev-sandbox.adapter.ts }
      payout/     { payout-provider.ts, dev-sandbox.adapter.ts }
      sms/        { sms-provider.ts, dev-log.adapter.ts }
      push/       { push-provider.ts, fcm.adapter.ts, noop.adapter.ts }
  prisma/ schema.prisma, migrations/, seed.ts
  test/ unit/, integration/, e2e/, security/, helpers/
```

Each module: `*.controller.ts` (HTTP only), `*.service.ts` (use cases + transactions), `*.repository.ts` (Prisma access), `*.policy.ts` (resource authorization), `dto/`, `domain/` (state machine tables, pure rule functions), `*.spec.ts`. Files kept under ~300 lines; split use cases into separate services when a service grows.

Dependency rule: controllers → services → (repositories, policies, other modules' exported services, provider interfaces). Domain functions are pure and have no Nest/Prisma imports.

Provider adapters are bound by config (`IDENTITY_PROVIDER=dev|esignet`). In `NODE_ENV=production` the config schema **rejects** any `dev` adapter, so a fake provider cannot be deployed to production by mistake.

## Cross-cutting

- **Validation**: global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`; env via zod.
- **Errors**: domain errors (`DomainError(code, httpStatus)`) mapped by one exception filter to problem details; unknown errors → 500 with `requestId`, logged with stack, reported to error tracker hook.
- **Logging**: pino JSON, fields `requestId, userId, route, status, durationMs`. Redaction paths: `authorization`, `cookie`, `password`, `refreshToken`, `otp`, `code`, `*.token`, `*Secret`, `accountRef`, `licenseNumber`, `tin`, provider payloads. A unit test asserts redaction.
- **Request ID**: accepted from `X-Request-Id` if it matches `^[A-Za-z0-9-]{8,64}$`, otherwise generated; propagated to outbox events and provider calls.
- **Security headers**: helmet (HSTS, no-sniff, frame-deny, strict CSP for the docs page); CORS allow-list from env (mobile apps do not need CORS; only admin web origin allowed).
- **Health**: `/health/live` (process), `/health/ready` (DB, Redis, storage reachable).
- **Metrics**: `prom-client` `/metrics` on an internal port (HTTP latency, job lag, outbox backlog, webhook failures, payout failures).
- **Error tracking**: `ErrorReporter` interface; Sentry-compatible adapter optional; noop by default.
- **Transactions**: `withTransaction(fn, { isolation })` helper; default READ COMMITTED + explicit row locks; financial posting uses SERIALIZABLE with bounded retry on `40001`.
