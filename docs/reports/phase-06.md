# Phase 6 Report: Owner Verification

Date: 2026-11-21
Scope: Phase 6 only (`docs/architecture/13-implementation-plan.md`, row 6: owner profiles (individual/organization), owner verification and review). Phase 7 (vehicles) has not started.
Status: **implemented, awaiting human review.** Phase 6 is not approved and has no completion tag.

Labels: **[IMPL]** implemented and tested here. **[ABSTRACTION]** a boundary that is implemented, but whose real counterpart is not connected. **[EXTERNAL]** needs a third party. **[ASSUMPTION]** a decision made without confirmation. **[LEGAL]** needs legal review.

## 1. Summary

A customer can create one owner profile, either INDIVIDUAL or ORGANIZATION. Individuals need only an ACTIVE account and a VERIFIED identity. Organizations also give an organization name, a TIN, and three photos: the TIN certificate, the business licence and an authorized-representative letter. Verification officers review owners in the existing staff console. **[IMPL]**

- **Individuals** need one officer's approval.
- **Organizations** need a first approval by one officer and a second approval by a *different* active officer. The owner stays PENDING in between. This four-eyes rule is enforced in three places: the pure rules, the service, and the database (CHECK constraint plus trigger). **[IMPL][ASSUMPTION 08 §7]**

Both exit criteria are proven by automated tests:
- **Self-approval is impossible.** Staff accounts cannot hold owner profiles. The service refuses the owner as reviewer. The `owner_profiles_guard` trigger refuses the owner, and anyone who is not an active VERIFICATION_OFFICER, as claimer, first approver, verifier or decider (`owner-db-constraints`, `owners.e2e`).
- **Cross-owner document access is prevented.** Another customer gets 404 for metadata, completion, download and attach. An officer cannot open a document through a case it does not belong to. The database refuses links to another user's document (`owners.e2e`, the authorization matrix, `owner-db-constraints`, container smoke test).

Tests: **957 automated tests pass**, against a corrected Phase 5 baseline of 868 (§14). The Docker image was rebuilt, and the container smoke test ran against it with ClamAV.

## 2. Scope

| In scope (done) | Out of scope (not done) |
|---|---|
| Owner profile INDIVIDUAL/ORGANIZATION, one per user, If-Match updates | Multi-user organization management (one representative per organization) |
| TIN encryption + HMAC uniqueness, masked display | TIN format validation or government lookup [LEGAL][EXTERNAL] |
| Three organization documents through the Phase 5 pipeline (images only) | PDF owner documents (the PDF check is a heuristic, not a sanitizer) |
| State machine of 02 §3.4, review claims, history | Vehicles, listings, applications (Phase 7+) |
| Four-eyes for organizations; four-eyes reinstatement after a fraud suspension | Notification delivery (Phase 15). Phase 6 writes rows and outbox events only |
| Officer queue, counts, detail, audited document URLs, decisions | Other admin areas |
| Admin console owner area; mobile owner onboarding (en/am) | A deployed scheduler for `owners:refresh` |

## 3. Owner profile data model [IMPL]

`owner_profiles` (03 "owner_profiles", extended):

| Column | Notes |
|---|---|
| `user_id` UNIQUE FK | customers only (trigger) |
| `owner_type` | `INDIVIDUAL` \| `ORGANIZATION` |
| `organization_name` | 2–200 characters, no control characters; required for ORGANIZATION and NULL for INDIVIDUAL (`owner_profiles_type_shape_chk`) |
| `tin_enc` / `tin_hmac` (UNIQUE) / `tin_last4` | §6 |
| `verification_status` | `UNVERIFIED, PENDING, VERIFIED, REJECTED, SUSPENDED, EXPIRED, REVERIFICATION_REQUIRED`, exactly as 02 §3.4 |
| `submitted_at` | set on submission |
| `claimed_by`, `claim_expires_at` | review bookkeeping, valid only while PENDING; not a status |
| `first_approved_by/_at/_note` | organizations only; the first of two approvals |
| `verified_by`, `verified_at` | the approval that made the owner VERIFIED |
| `decided_by/_at`, `decision_reason_code`, `decision_note` | the last decision; a reason is required for REJECTED and SUSPENDED |
| `version` | `If-Match` |

Also new:
- `owner_documents`: PK `(owner_profile_id, purpose)`; `document_id` is UNIQUE, so a document can be linked to only one profile.
- `owner_review_events`: the append-only history.

## 4. Verification workflows

**State machine** (`OWNER_TRANSITIONS` in `owner-rules.ts`, which is identical to the trigger table; a unit test parses the migration and compares them):

| From | To |
|---|---|
| UNVERIFIED | PENDING (submit) |
| PENDING | VERIFIED (approval) · REJECTED |
| REJECTED | PENDING (resubmit) |
| VERIFIED | SUSPENDED · EXPIRED · REVERIFICATION_REQUIRED |
| SUSPENDED | VERIFIED (reinstate) · REVERIFICATION_REQUIRED |
| EXPIRED | PENDING |
| REVERIFICATION_REQUIRED | PENDING |

**Editing.** Details and documents are editable only in UNVERIFIED, REJECTED, EXPIRED and REVERIFICATION_REQUIRED. The owner type can change only in UNVERIFIED and REJECTED: the "controlled revision" happens through a rejection. Switching to INDIVIDUAL clears the organization data and its document links. The trigger freezes details while a profile is PENDING, VERIFIED or SUSPENDED.

**Submission** (`POST /owners/me/submit`, Idempotency-Key required). It first applies any due identity expiry. It then requires an ACTIVE account and a VERIFIED identity. Organizations also need a name, a TIN, and all three documents AVAILABLE and never part of an earlier decision. Problems come back as `422 OWNER_SUBMISSION_INCOMPLETE` with codes. Each submission starts a clean case: earlier approvals and decisions do not carry over.

**Individual approval** (`/approve`). The officer must hold the claim and confirm `identityConfirmed: true`. Account, identity and documents are re-checked inside the transaction.

**Organization approval** [ASSUMPTION 08 §7, four-eyes]:
1. `/first-approval`: officer A holds the claim and confirms four checks (representative identity, legible documents, matching name and TIN, authorization letter). The facts are re-checked, `first_approved_by` is recorded, and the claim is released. The status stays PENDING.
2. Officer A can no longer claim the case or give the second approval (`409 SECOND_APPROVER_REQUIRED`). A second approval before any first approval returns `409 FIRST_APPROVAL_REQUIRED`.
3. `/second-approval`: officer B claims the case, confirms the same four checks independently, and the facts are re-checked again. The owner becomes VERIFIED and the documents become APPROVED.
4. In the database, `owner_profiles_four_eyes_chk` requires an organization's `verified_by` to be non-null and different from `first_approved_by`. The trigger accepts a first approval only from an active officer, only while PENDING, and never from the owner.

**Reject** (any officer holding the claim, at either stage). Requires a reason code (`BLURRY, MISMATCH_NAME, EXPIRED, INCOMPLETE, INVALID_ORGANIZATION_DETAILS, REPRESENTATIVE_NOT_AUTHORIZED, SUSPECTED_FRAUD, OTHER`). The optional note is shown to the owner as plain text. A rejection discards any first approval. Decided documents cannot be reused, so a resubmission needs new uploads.

**Suspend** (VERIFIED only). Requires a reason code and an internal note of at least 10 characters; the owner sees the code but never the note.

**Reinstate** (SUSPENDED → VERIFIED). Requires a note and re-checks account and identity. A `SUSPECTED_FRAUD` suspension can only be lifted by an officer other than the one who imposed it (four-eyes, 08 §7).

**Identity consequences.** A VERIFIED owner becomes EXPIRED when the identity expires, and REVERIFICATION_REQUIRED when the identity is otherwise no longer verified. `OwnerStatusService` is the only writer without an actor. It runs lazily on every owner read and review, and in bulk through `npm run owners:refresh`. No scheduler is deployed yet.

**Eligibility.** `ownerBlockers` (ACCOUNT_NOT_ACTIVE, IDENTITY_NOT_VERIFIED, OWNER_NOT_VERIFIED, OWNER_SUSPENDED) is computed on every read and never stored. A suspended owner is ineligible. Phase 7 will consume this for owner-only features.

**Concurrency and replay.** Every officer decision runs inside `IdempotencyService.execute` (keyed per officer and action) and takes the profile row lock. A retried key replays the stored answer; the same key with a different body gets 422. A concurrent second decision gets 409. Claims are a single conditional update. Tests cover parallel claims, parallel approve/reject, and parallel second approvals with a replay.

## 5. API endpoints (under `/api/v1`)

| Area | Endpoints |
|---|---|
| Customer | `POST /owners/me` (201, or 200 if it exists) · `GET /owners/me` · `PATCH /owners/me` (If-Match) · `GET /owners/me/status` · `PUT /owners/me/documents/{tin\|business-license\|representative-letter}` · `POST /owners/me/submit` (Idempotency-Key) |
| Documents | unchanged routes; new purposes `OWNER_TIN`, `OWNER_BUSINESS_LICENSE`, `OWNER_REPRESENTATIVE_LETTER` |
| Officer (`owners.review`) | `GET /admin/owner-verifications` (status, ownerType, awaitingSecondApproval, q, page, limit ≤ 50) · `GET …/counts` · `GET …/{id}` (audited) · `POST …/{id}/claim` · `…/release` · `…/approve` · `…/first-approval` · `…/second-approval` · `…/reject` · `…/suspend` · `…/reinstate` (decisions need an Idempotency-Key) · `GET …/{id}/documents/{documentId}/url?reason=` |

- New error codes: `OWNER_PROFILE_REQUIRED, TIN_IN_USE, OWNER_SUBMISSION_INCOMPLETE, FIRST_APPROVAL_REQUIRED, SECOND_APPROVER_REQUIRED`.
- Unknown fields are rejected (400 `UNKNOWN_FIELD`; tested with `verificationStatus`, `verified`, `reviewerId`, `eligibilityStatus` and `firstApprovedById`).
- List responses carry no TIN, document or phone data (test).
- All routes are in OpenAPI.

## 6. TIN protection [IMPL]

- **Normalization** [ASSUMPTION]: upper case, with spaces, hyphens, slashes and dots removed, then 4–20 letters and digits. **No official Ethiopian TIN format is assumed** [LEGAL].
- **Encryption:** `tin_enc` is AES-256-GCM with the Phase 3 field keys and AAD `owner_profiles.tin_enc:{id}`. A test shows that decrypting it with another row's AAD fails.
- **Duplicates:** `tin_hmac` is HMAC-SHA-256 with a new dedicated purpose `tin` and is UNIQUE in the database. A duplicate returns `409 TIN_IN_USE`, through both create and update, and writes the audit row `owner.duplicate_tin_detected` without the TIN. The response does not reveal the other account.
- **Display:** `tin_last4` gives masked display (`••••1234`). The full TIN is returned by no API, including the officer case detail; officers compare the masked TIN with the TIN certificate.
- **No leaks:** `tin` was already a redacted log key. Tests confirm that the TIN is absent from responses, audit rows, outbox payloads, notification rows and logs. Profile-update audits record field names only.

## 7. Document handling [IMPL]

- The Phase 5 documents module is reused unchanged: intent, presigned PUT, HEAD/size/SHA-256, magic bytes, metadata-stripping re-encode, `FileScanner` on the original bytes, a separate stored copy, 60-second URLs.
- **Per-purpose policies** add the three owner purposes as JPEG/PNG/WebP only, ≤ 10 MB. Driver policies are unchanged.
- **Database enforcement:** a new CHECK, `documents_owner_purpose_mime_chk`, also refuses non-image MIME types for owner purposes.
- **Upload intents** for owner purposes need an ORGANIZATION owner profile (`409 OWNER_PROFILE_REQUIRED`).
- **Attaching** needs the caller's own document, with the matching purpose, AVAILABLE, never part of a decision, and not linked elsewhere. The database checks the same through `owner_documents_guard` plus the UNIQUE `document_id`. The guard also refuses link changes while a case is PENDING or VERIFIED.
- **Scanner outages fail closed:** in the container smoke test, with clamd stopped, completing an owner document returned 503 and left it UPLOADED; it became AVAILABLE after clamd restarted.
- **Officer access** to a PENDING case's documents needs the active claim (`409 REVIEW_CLAIM_REQUIRED`) and a reason of 10–500 characters, audited as `document.viewed_by_staff`.

## 8. Permission model [IMPL]

- **New permission:** `owners.review`, granted to **VERIFICATION_OFFICER only**.
- **Other staff:** SUPER_ADMIN, SUPPORT and FINANCE get 403 on every officer route. Customers get 404 and anonymous callers 401.
- **Customer routes:** staff get 404; another customer gets 404 for someone else's documents.
- **Matrix coverage:** the authorization matrix has 18 new rows covering every owner route for anonymous, customer, other customer, support, verification officer, finance and super admin. Both customers in the matrix also hold driver profiles, so the owner role is tested on driver accounts too.
- **Officers and their own case:** an officer can never be the subject of an owner case (staff accounts cannot hold profiles), and the service returns 404 if an officer's own user id were ever the owner.

## 9. Admin web console [IMPL]

The existing `admin/` app has been extended:
- **Permissions:** `StaffProfile.canReviewOwners`. The router allows `/owners` only with `owners.review` and `/drivers` only with `drivers.review`; staff with neither see the no-permission screen. The navigation rail and dashboard show only the permitted areas.
- **Dashboard:** owner counts for pending individuals, pending organizations, awaiting second approval, verified, rejected and suspended. Each card opens the filtered queue.
- **Queue:** status and type filters, an "awaiting second approval" filter, search (name, organization or phone), pagination, claim and release. Badges show "Claimed by another officer", "Needs a second officer's approval" and "You gave the first approval".
- **Case detail:** representative (app name, verified identity name, identity and account status, phone), organization name, masked TIN, the three document slots (opened after a reason dialog, through 60-second URLs), approvals (first approval time and note, verified time) and history.
- **Decisions:**
  - Individual approval: one check.
  - First and second organization approvals: four checks each.
  - Reject, suspend and reinstate: reason codes and notes.

  The first approver sees no second-approval or claim action. The server's `SECOND_APPROVER_REQUIRED` and `FIRST_APPROVAL_REQUIRED` are shown as localized text. Each decision sends a fresh `Idempotency-Key` (the `ApiClient.post` gained a `headers` parameter).
- Tokens are still kept in memory only.

## 10. Mobile owner experience [IMPL]

`mobile/lib/features/owner/` adds the routes `/owner`, `/owner/details`, `/owner/documents` and `/owner/review`. The entry point is in the Account screen.
- **Flow:** intro → type choice (individual / organization, with requirement hints) → organization name and TIN (validated like the API; when editing, the stored TIN shows only as "Leave empty to keep ••••6789") → the three documents with progress, retry and refusal handling → summary with a type-specific confirmation → submission with one Idempotency-Key per visit.
- **Statuses:**
  - pending, verified, rejected (reason and note as plain text, plus the correction actions), suspended (reason, contact support), expired and re-verification required (verify identity, then resubmit);
  - submission problems listed from the server;
  - an identity banner with a link to Phase 4 verification.
- **Shared upload code:** the upload logic now lives in `features/documents/document_upload.dart` (`DocumentUploadJob`, `DocumentUploadApi`). The Phase 5 `LicenseUploadJob` delegates to it, so owners and drivers run the same resumable upload code. All Phase 5 mobile tests still pass.
- **Localization:** 52 new en/am messages.

## 11. Audit, outbox and notifications [IMPL]

- **Audit actions:**
  - Owner: `owner.profile_created`, `owner.profile_updated`, `owner.document_attached`, `owner.document_replaced`, `owner.verification_submitted`, `owner.duplicate_tin_detected`.
  - Officer: `owner.case_viewed`, `owner.review_claimed`, `owner.review_released`, `owner.first_approval_recorded`, `owner.second_approval_completed`, `owner.approved`, `owner.rejected`, `owner.suspended`, `owner.reinstated`.
  - System: `owner.verification_expired`, `owner.reverification_required`.
  - Plus the existing `document.viewed_by_staff`.
- **Outbox events:** `owner.profile_created`, `owner.verification_submitted`, `owner.first_approval_recorded`, `owner.approved`, `owner.rejected`, `owner.suspended`, `owner.reinstated`, `owner.verification_expired`, `owner.reverification_required`.
- **In-app notifications:** `notifications` rows (`notif.owner.*` keys, deep link `/owner`), written in the decision transaction. Parameters carry reason codes only; a test confirms the TIN and the organization name are absent. Delivery and the notification list are Phase 15.

## 12. Database migrations [IMPL]

There are two new migrations; no earlier migration was changed.
1. **`20261119090000_owner_enum_values`:**
   - new types `OwnerType` and `OwnerVerificationStatus`;
   - new `DocumentPurpose` values `OWNER_TIN`, `OWNER_BUSINESS_LICENSE` and `OWNER_REPRESENTATIVE_LETTER`. The architecture's enum lists `OWNER_TIN` and `OWNER_BUSINESS_LICENSE`, but the Phase 5 migration created only the driver values, so all three are added now;
   - new `ReviewReasonCode` values `INVALID_ORGANIZATION_DETAILS` and `REPRESENTATIVE_NOT_AUTHORIZED`.

   This is a separate migration because PostgreSQL cannot use a new enum value in the transaction that adds it.
2. **`20261119090100_owner_verification`:**
   - the three tables, with FKs, UNIQUE constraints (`user_id`, `tin_hmac`, `document_id`) and indexes (`(verification_status, submitted_at)`, history);
   - CHECK constraints: type shape, organization name, TIN format, notes, submitted, claim shape, first approval, verified, four-eyes, decision, and the owner-document MIME rule;
   - the function `is_active_verification_officer` (role not revoked, staff account ACTIVE);
   - the triggers `owner_profiles_guard` (customers only; start UNVERIFIED; transition table; frozen details and type; officer-only and never-the-owner reviewer columns), `owner_documents_guard` and `owner_review_events_append_only`.

Verified: `prisma validate`; `db:drift` ("No difference detected"); migration from an empty database (the integration suite resets `platform_test` and applies all migrations; the container `migrate` service applied both new ones to the dev database).

## 13. Security review

| Threat | Control | Proof |
|---|---|---|
| Owner approves themselves | Staff cannot hold profiles; service 404; trigger refuses the owner and non-officers in every reviewer column | db-constraints, e2e |
| One officer verifies an organization alone | Service rule, claim refusal for the first approver, `owner_profiles_four_eyes_chk` | unit, e2e, db |
| Officer lacking the role, or locked | `is_active_verification_officer` (role not revoked, account ACTIVE) | db |
| Concurrent or replayed decisions | Row lock, conditional updates, idempotency per officer and action | e2e concurrency |
| Stale facts at approval | Account, identity and documents re-checked in each approval transaction (both organization steps) | e2e |
| Cross-owner documents (IDOR) | Ownership in every query (404), case-document membership, trigger, UNIQUE link | e2e, matrix, db, container |
| Client-set status | Unknown fields rejected; no status fields in DTOs | e2e, container |
| TIN exposure | AES-GCM with row AAD, masked only, log redaction, absent from audit/outbox/notifications | e2e |
| TIN reuse | HMAC UNIQUE, audited, non-enumerating 409 | e2e, db, container |
| Malicious owner documents | Images only (API + DB), re-encoded, scanned; fails closed | e2e, db, container |
| Staff browsing documents | Claim holder while pending, reason required, audited, 60-second URL | e2e |
| Suspended owner keeps privileges | Eligibility computed as OWNER_SUSPENDED; no editing or submission | e2e |
| Identity lapses after verification | Owner moves to EXPIRED / REVERIFICATION_REQUIRED (lazy and nightly) | e2e |

Residual risks:
- Officers see the representative's verified name and the documents. Access is audited, but there is no bulk-access alerting yet (Phase 18).
- The review is manual, so forged paper documents are only as detectable as the officers make them. **[EXTERNAL]**
- Two colluding officers can still approve an organization. Four-eyes raises the bar but does not remove insider risk.

## 14. Tests and exact counts

Each suite is counted once. Coverage runs are not added to the totals.

**Correction of the Phase 5 baseline.** Running the integration suite on `phase-05-complete` gives **321**, not the 338 reported in `phase-05.md`. The 338 was measured while `documents.e2e` still imported `file-inspection.spec.ts`; vitest therefore also ran that file's 17 unit tests inside the integration project. The fixtures were moved to `test/helpers/document-fixtures.ts` before the Phase 5 commits, and the report was not updated. The correct Phase 5 total is **868**, not 885. No test was missing or failing; 17 were counted twice.

| Suite | Phase 5 (corrected) | Phase 6 | Added |
|---|---|---|---|
| Backend unit (`npm test`) | 278 | **290** | +12 |
| Backend integration and HTTP (`npm run test:integration`) | 321 (+2 opt-in skipped) | **374** (+2 opt-in skipped) | +53 |
| Shared Dart (`dart test`) | 62 | **62** | 0 |
| Flutter mobile | 187 | **200** | +13 |
| Flutter admin | 20 | **31** | +11 |
| **Total** | **868** | **957** | **+89** |

- The two opt-in ClamAV tests (`CLAMAV_TEST_HOST`) passed separately against the compose clamd: 2/2.
- New backend tests:
  - `owner-rules.spec` (12): every transition pair, a trigger-table comparison with the migration, editable and type-change statuses, TIN and name rules, submission and approval rules, four-eyes refusals, identity consequences, eligibility;
  - `owner-db-constraints` (13): every disallowed transition, type shape, TIN uniqueness, frozen details, reviewer restrictions (owner, customer, SUPPORT, SUPER_ADMIN, locked officer), self-approval, four-eyes, decisions, document links, images only, append-only history;
  - `owners.e2e` (22);
  - 18 new authorization-matrix rows (43 → 61).
- New mobile tests: `owner_test` (13): data parsing, TIN rule, HTTP shapes, individual and organization onboarding, validation, duplicate TIN, keeping the stored TIN, uploads with progress and scanner retry, refused file, submission problems and key reuse, rejected/verified/suspended/expired states, Amharic.
- New admin tests: `owner_screens_test` (11): permission routing, dashboard per permission, the first-approval dialog with four checks, first-approver restrictions, the second approval by another officer, the server's same-officer refusal, individual approval, the reject reason, document access by claim holder with a reason, suspend note rules, HTTP request shapes with fresh Idempotency-Keys.

## 15. Coverage

| Scope | Lines | Statements | Branches | Functions | Gate |
|---|---|---|---|---|---|
| Owners (`src/modules/owners`, new) | **96.27%** (388/403) | 93.56% | 85.9% | 96.87% | ≥ 90%: PASS |
| Documents, drivers, scanner | **95.21%** (617/648) | 92.82% | 86.11% | 97.79% | PASS |
| Auth | **97.5%** (743/762) | 94.57% | 84.23% | 97.86% | PASS |
| Identity | **95.63%** (658/688) | 92.57% | 83.88% | 96.4% | PASS |

`npm run test:coverage:owners` was added to CI. The first drivers coverage run failed: a `beforeAll` hook timed out after 60 s in `logging-and-docs.e2e` while the machine slept overnight. The rerun passed (above), and that file passes in every other run.

## 16. Build and Docker results

| Check | Result |
|---|---|
| `npm run build`, `tsc`, ESLint, Prettier | PASS |
| `npm audit --omit=dev --audit-level=high` and full audit | PASS (0 vulnerabilities), after the change below |
| Android debug APK | PASS |
| Admin `flutter build web` (development, production example) | PASS / PASS |
| Docker `--build migrate api` with `--profile scanner` | PASS. Running image `sha256:ae2328f2d7fc…`, health `healthy`, `dist/modules/owners` present, `FILE_SCANNER=clamav`, `effect` 3.22.5 |
| Migrations in the container | `20261119090000_owner_enum_values`, `20261119090100_owner_verification` applied |
| Readiness | `{"database":"up","redis":"up","storage":"up"}` |
| Gitleaks working tree and history (93 commits) | PASS (no leaks) |

**Dependency change.** A new advisory appeared after Phase 5: GHSA-7589-6fvf-x4pw, a ReDoS in `effect` ≤ 3.22.0, which `prisma@7.10.1` pulls in through `@prisma/config`. Prisma is a dev dependency (CLI and migrator), not used in request handling. I added `"overrides": { "effect": "3.22.5" }` (the latest 3.x, which is patched). As in Phase 5, npm dropped 33 platform packages from the lockfile; I merged only the `effect` entry into the previous lockfile. Prisma `validate`, `generate`, drift and all tests pass with it.

**Environment.** Windows had reserved port 56379 (Hyper-V exclusion range 56309–56408), so Redis now runs on `REDIS_HOST_PORT=46379` for this machine only. Your `.env` and the compose defaults are unchanged.

**Container smoke test** (`C:\tmp\phase6-smoke.mjs`, real HTTP and storage):
- an upload before an owner profile exists → 409 `OWNER_PROFILE_REQUIRED`;
- organization created; the response holds only the masked TIN;
- a TIN photo with GPS EXIF → AVAILABLE, scanned by `clamav`, stored without EXIF, download `private, no-store`;
- a PDF for an owner purpose → 400 `UNSUPPORTED_TYPE`; EICAR declared as JPEG → INVALID (refused by magic bytes before the scan matters);
- another owner: metadata 404, URL 404, completion 404, attach 404;
- a duplicate TIN → 409 `TIN_IN_USE`;
- a client-sent `verificationStatus` → 400 `UNKNOWN_FIELD`;
- submit → 422 with the problem codes;
- admin queue: anonymous 401, customer 404;
- ClamAV outage for an owner document → 503 and UPLOADED; after clamd restarts → AVAILABLE.

**Not run against the container:** the officer and four-eyes flow. It needs two TOTP-enrolled officer accounts, which the dev database does not have (the only staff account is a super admin whose credentials I do not hold). The flow is covered end to end by `owners.e2e` against real PostgreSQL, Redis and SeaweedFS.

## 17. Architecture deviations

| Architecture said | Implemented | Reason |
|---|---|---|
| `POST /owners/me/submit` and profile routes only (04) | Plus `GET /owners/me/status` and `PUT /owners/me/documents/{slot}` | Needed for the documents and blockers |
| Generic `/admin/reviews/{type}` (04) | `/admin/owner-verifications/...` | Same choice as Phase 5 |
| Single approval in the shared review workflow | Organizations need two approvals by different officers | 08 §7 four-eyes [ASSUMPTION] |
| `owner_profiles` columns (03) | Plus `tin_last4`, claim, first-approval, verifier and decision columns | Masked display, claims, four-eyes, audit trail |
| Document purposes `OWNER_TIN`, `OWNER_BUSINESS_LICENSE` (03) | Plus `OWNER_REPRESENTATIVE_LETTER` | 08 §7 lists the letter |
| Officers "view" documents | Organization documents are images only (no PDF) | The PDF check is a heuristic, not a sanitizer |
| Checklist in `system_config` (08 §7) | Fixed in code | No configuration module yet |
| Expiry job | CLI `owners:refresh` plus lazy refresh | No scheduler yet |

## 18. Assumptions

- Four-eyes applies to organization approval and to reinstating a `SUSPECTED_FRAUD` suspension. Rejection and suspension need one officer.
- A TIN is 4–20 letters and digits after removing separators; uniqueness is per TIN across all accounts.
- One representative account per organization.
- An owner's verification lasts as long as the representative's identity.
- Amharic texts are acceptable until native review.

## 19. External and legal dependencies

- **TIN format and verification** with the Ministry of Revenue: no API is known; the review is manual. **[EXTERNAL][LEGAL]**
- **Business licence verification** with the Ministry of Trade / Addis Ababa Trade Bureau: no API is known. **[EXTERNAL]**
- **What an authorized-representative letter must contain** to be valid. **[LEGAL]**
- **Lawful basis and retention** for TINs and organization documents (Proclamation 1321/2024) and TIN requirements for payouts (L-7). **[LEGAL]**
- **Native Amharic review.** **[EXTERNAL]**

## 20. Remaining limitations

1. The officer four-eyes flow was not run against the Docker container (§16); it is covered by end-to-end tests.
2. No scheduler runs `owners:refresh` or `drivers:refresh`.
3. No multi-user organizations and no transfer of an organization to another representative.
4. A rejection forces new uploads of all three documents, even if only one was wrong.
5. No device test of the mobile owner flow (no phone was attached during this phase).
6. Notification delivery and the notification list are Phase 15.

## 21. Quality-gate summary

| Gate | Result |
|---|---|
| Backend format, lint, typecheck, build | PASS |
| `prisma validate`, drift, migrations from empty database | PASS |
| Backend unit 290, integration 374 (+2 opt-in, passed separately) | PASS |
| Coverage: owners 96.27%, drivers 95.21%, auth 97.5%, identity 95.63% lines | PASS |
| `npm audit` (prod and full) | PASS (after the `effect` override) |
| Mobile format, analyze `--fatal-infos`, tests (200), debug APK | PASS |
| Admin format, analyze `--fatal-infos`, tests (31), web builds (dev and production) | PASS |
| Shared Dart format, analyze, tests (62) | PASS |
| Docker rebuild, migrations, health, readiness, storage and Redis | PASS |
| Owner upload, cross-owner access and ClamAV smoke tests | PASS |
| Officer four-eyes flow in the container | NOT RUN (no enrolled officers; covered by e2e) |
| Device test | NOT RUN |
| Gitleaks working tree and history | PASS |
| `osv-scanner` for Dart | NOT RUN (tool not installed) |

**Overall: Phase 6 passes every gate that could run here.** Both exit criteria are covered by automated tests at the service, HTTP and database levels.

Recommended next steps:
1. Review this report, especially §4 (the four-eyes design), §6 (TIN handling), §14 (the Phase 5 count correction) and §16 (the `effect` override).
2. Run the officer flow by hand in the staff console with two officer accounts.
3. Then Phase 7 (vehicles), only after approval.
