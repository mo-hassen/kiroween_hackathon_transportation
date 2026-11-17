# 13 — Phased Implementation Plan

Each phase ends with the quality gate (11 §3) and a written verification report in `docs/reports/phase-XX.md` listing commands run, results, and remaining risks. A phase is not started until the previous gate passes and you approve.

Dependency order: foundation → auth → identity → documents → driver/owner → vehicles → marketplace → applications → agreements/assignments → ledger → payments → payouts → notifications → messaging/support → trust → admin hardening → audits.

| Phase | Scope | Exit criteria (beyond quality gate) |
|---|---|---|
| **2 Foundation** | `git init`; monorepo layout (`backend/`, `mobile/`, `admin/`, `packages/core_shared/`, `infra/`, `docs/`, `ai-prompts/`); NestJS skeleton with config validation, logging + redaction, request ID, problem-details errors, helmet, CORS, rate-limit module, health, OpenAPI; Prisma with `users`, `sessions`, `devices`, `audit_logs`, `idempotency_records`, `outbox_events`; docker compose (postgres, redis, minio); Flutter app shell (theme, l10n en/am, router, Dio client, secure storage, `AsyncValueView` and state widgets, ETB/phone formatters); CI workflow file | `docker compose up` healthy; migrations from zero; redaction test; route public-allow-list test; Flutter widget tests for state widgets and formatters |
| **3 Authentication** | OTP (dev SMS adapter), register, login, refresh rotation + reuse detection, logout, sessions/devices, password reset, lockout, staff login + TOTP, permission guard, policy framework; Flutter login/register/OTP/session restore/expired session | Auth e2e + brute-force + enumeration + reuse tests; authz matrix harness in place |
| **4 Identity** | Identity module, `IdentityProvider`, dev adapter, eSignet adapter (built from OIDC spec + eSignet docs; tested against eSignet mock stack if it runs locally, otherwise unit-tested with signed test tokens); Flutter consent/status/retry screens, App Link return | Replay, forged-state, self-verify, cross-user tests |
| **5 Documents + Driver verification + minimal admin web** | Documents module (presigned upload, validation, scan hook, EXIF strip), driver profile/licence, review queue, admin web login + review screens | IDOR on documents, invalid transitions, expired licence, suspended driver |
| **6 Owner verification** | Owner profiles (individual/organization), review | Self-approval impossible, cross-owner doc access tests |
| **7 Vehicles** | Vehicle CRUD, documents, photos, review, expiry job | Plate uniqueness, expiry affects eligibility |
| **8 Marketplace** | Listings, eligibility query, search/filter/sort/pagination, Flutter browse/detail/owner listing management | Ineligible listings never returned (tests per rule) |
| **9 Applications** | Apply/accept/reject/cancel/expire, idempotency, concurrency | Concurrent-accept test (N parallel), duplicate request test |
| **10 Agreements** | Generation from listing + commission rule, versions, acceptance by hash, termination | Stale-version accept fails; accepted version immutable |
| **11 Assignments** | Assignment creation, exclusion constraints, handovers, activity reports, return flow | Overlap test, eligibility at start |
| **12 Ledger** | Accounts, journal, triggers, allocation, commission rules (four-eyes), statements | Invariant + property + concurrency tests |
| **13 Payments** | `PaymentProvider`, dev sandbox, charges job, webhook inbox, polling, mismatch handling | Duplicate/invalid/replayed/delayed webhook, timeout, mismatch tests |
| **14 Payouts** | Payout methods, batches, initiation, confirmation, hold/retry, reconciliation (sandbox) | Double-payout under concurrency, failure/reversal tests. **MVP feature-complete here.** |
| 15 Notifications | Outbox dispatcher, in-app list, push (FCM adapter), SMS for critical | Dedupe, unauthorized access |
| 16 Chat & support | Conversations, messages, tickets | Membership tests |
| 17 Ratings & disputes | Ratings, disputes, evidence, financial resolution via ledger | Duplicate rating, unrelated party, ledger untouched history |
| 18 Admin & ops | Full admin console, suspensions, finance views, audit browser | Per-role authz tests on every admin endpoint |
| 19 Security audit | Independent review + fixes + regression tests | Findings report by severity |
| 20–22 | QA, performance, Addis UX/localization review | Per prompt files |
| 23–25 | Infra/deployment, production readiness, release checklist | Real environment validation |

Notifications are needed earlier in a thin form: phases 5–14 write outbox events and in-app notification rows from the start; Phase 15 adds push/SMS delivery and the full UI.

## Work items that run in parallel with engineering (your side)

1. Start NIDP / Fayda relying-party enquiry (L-1).
2. Choose payment provider(s) and request sandbox credentials and official API docs (E-2, L-3).
3. Engage legal counsel on L-2 to L-10.
4. Confirm commercial model and the assumptions in 12 §2.
5. Arrange Amharic translation review.

## Proposed first step after approval

Phase 2 only. I will report back with the verification output before starting Phase 3.
