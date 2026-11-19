# Phase 5 Report: Documents, Driver Verification and Minimal Admin Web

Date: 2026-11-19
Scope: Phase 5 only (`docs/architecture/13-implementation-plan.md`, row 5). Phase 6 has not started.
Status: **implemented, awaiting human review.** Phase 5 is not approved and has no completion tag.

Labels: **[IMPL]** implemented and tested here. **[ABSTRACTION]** a boundary that is implemented, but whose real counterpart is not connected. **[EXTERNAL]** needs a third party. **[ASSUMPTION]** a decision made without confirmation. **[LEGAL]** needs legal review.

## 1. Executive summary

Customers can become drivers: create a driver profile, enter their licence details, upload photos of the front and back, and submit them for review. Verification officers review the case in a new Flutter Web staff console and approve, reject, suspend or reinstate. The driver's eligibility follows from the decision. **[IMPL]**

Uploads never pass through the API. The app PUTs the file to a presigned storage URL, then asks the API to complete it. The API checks the size and SHA-256 and detects the type from magic bytes. It re-encodes images without any metadata and scans the original bytes. Only then does it store the copy that can be downloaded, under a key the client never sees. Downloads are 60-second URLs with `Cache-Control: private, no-store`. **[IMPL]**

Malware scanning sits behind a `FileScanner` abstraction with three adapters:
- **ClamAV** (clamd over TCP) works and was tested against a real clamd 1.4 container. The EICAR test file is reported as infected. **[IMPL]**
- **`dev`** detects only the EICAR test file. **It is not malware protection.** It is the compose default so the stack starts without ClamAV, and staging and production refuse to start with it.
- **`disabled`** fails closed and is the default in deployed environments.

No production scanning service is chosen or operated yet. **[EXTERNAL]**

Licence numbers are stored with AES-256-GCM encryption and an HMAC for duplicate detection. Only officers see the full number, and every case view is audited. **[IMPL]**

Tests: **885 automated tests pass** (Phase 4 baseline: 692, +193), and 2 opt-in ClamAV tests passed separately. The **debug APK was built for the first time on this machine** (the Gradle download that blocked Phases 2–4 has completed). A **device test was NOT RUN** because no phone was attached.

## 2. Scope

| In scope (done) | Out of scope (not done) |
|---|---|
| Documents module: intent, presigned PUT, completion, validation, EXIF strip, scan hook, 60-second download | Document deletion endpoint (`DELETE /documents/{id}`); upload of other document purposes (owner, vehicle) |
| `FileScanner` abstraction: ClamAV, dev (EICAR only), disabled | A chosen production scanning service and its operation [EXTERNAL] |
| Driver profile, one licence per profile, licence photos (front/back) | Several licences per driver; matching licence categories to vehicle classes (Phase 7) |
| Review states, claims, approve/reject/suspend/reinstate, reason codes, history | Four-eyes approval for reinstating a suspension for fraud (08 §7 [ASSUMPTION]) |
| Driver eligibility (cached), licence expiry by Addis Ababa date, nightly CLI | A deployed scheduler; 30/7/1-day expiry reminders (Phase 15) |
| Minimal admin web: staff login with TOTP, dashboard, queue, case detail, decisions | Other admin areas (users, finance, configuration) |
| Mobile driver onboarding: intro, profile, licence form, photo upload, review, status; en/am | Push or SMS delivery of decisions (Phase 15). Phase 5 writes in-app rows and outbox events only |
| Thin in-app notification rows and outbox events | The notification list API and UI (Phase 15) |

## 3. Backend implementation

- **`src/modules/documents/`** [IMPL]:
  - `document-policy.ts`: per-purpose rules (account type, MIME types, 10 MB), URL lifetimes, rate limits and storage key formats.
  - `file-inspection.ts`: magic-byte detection, image re-encoding with `sharp` and PDF checks.
  - `documents.service.ts`, `documents.controller.ts`, DTOs.
- **`src/modules/drivers/`** [IMPL]:
  - `driver-rules.ts`: the transition table, editable statuses, claim TTL, Addis date, licence number and category normalization, eligibility and submission rules. These are pure functions, tested exhaustively.
  - `drivers.service.ts`: the driver's own profile and licence.
  - `driver-review.service.ts`: the officer queue and decisions.
  - `driver-eligibility.service.ts`: the only writer of `driver_profiles.eligibility_status`.
  - Two controllers (driver and admin) and DTOs.
- **`src/providers/scanner/`**: `FileScanner` and its adapters, plus the module that selects one from config.
- **`src/common/notifications/notification.service.ts`**: in-app notification rows, written in the same transaction as the change.
- **`src/cli/drivers-refresh.ts`** (`npm run drivers:refresh`): the nightly expiry and eligibility sweep.
- **Changed earlier files**:
  - `env.schema.ts`, `app-config.ts`: scanner, ClamAV, `STORAGE_PUBLIC_ENDPOINT` and `STORAGE_SSE` settings and their production rules.
  - `object-storage.ts`: presigned PUT/GET, bounded read, write with SSE, delete.
  - `problem-details.ts`: 9 new error codes.
  - `secret-hasher.ts`: the `license` HMAC purpose.
  - `permissions.ts`: `drivers.review`.
  - `me.dto.ts`/`me.service.ts`: `/me` returns `permissions`, for navigation only.
  - `app.module.ts`, `common.module.ts`, `package.json` (2 scripts, 2 dependencies), `.env.example`, `infra/docker-compose.yml`, `ci.yml`.

  No Phase 2–4 behaviour was changed, and all earlier tests still pass.
- **Dependencies added:**
  - `sharp` 0.35.5 (Apache-2.0; bundles libvips, LGPL-3.0, as a separate shared library).
  - `@aws-sdk/s3-request-presigner` 3.1170.0 (Apache-2.0).

  `sharp` was first installed at 0.34.5 because the 0.35 download failed on this network. `npm audit` then reported 1 high advisory (bundled libvips, libheif and librsvg CVEs). The package was upgraded to 0.35.5 in this session, and `npm audit --omit=dev` now reports 0 vulnerabilities.

## 4. Documents module and upload flow [IMPL]

1. `POST /documents` with `{purpose, mimeType, sizeBytes, sha256}`. The server checks the purpose policy and limits, creates a `PENDING_UPLOAD` row with a server-chosen key `incoming/{uuid}`, and returns a presigned PUT. The URL lasts 5 minutes, and `Content-Type` and `Content-Length` are signed.
2. The client PUTs the bytes directly to storage. The API never receives file bodies (JSON body limit unchanged).
3. `POST /documents/{id}/complete`:
   - Claims the row (`UPLOADED`/`PENDING_UPLOAD` → `PROCESSING`, with a single conditional update). A claim older than 2 minutes can be taken over.
   - HEADs and reads the object with a size bound.
   - Verifies the size and SHA-256, inspects and re-encodes the file, and scans the original bytes.
   - On success, writes the sanitized copy to `documents/{yyyy}/{mm}/{uuid}` with the configured SSE, deletes the incoming object and marks the row `AVAILABLE`.
4. `GET /documents/{id}/url`: a 60-second GET with `ResponseCacheControl: private, no-store, max-age=0` and a fixed download file name. Only the owner can use it; staff use the audited admin route (§11).

Statuses: `PENDING_UPLOAD → UPLOADED → PROCESSING → AVAILABLE | INVALID | INFECTED`, plus `DELETED`. A scanner outage returns the row to `UPLOADED` (retryable, `503 DOCUMENT_SCAN_UNAVAILABLE`). `INVALID` and `INFECTED` are terminal and carry a failure code (`UPLOAD_EXPIRED, SIZE_MISMATCH, TOO_LARGE, CHECKSUM_MISMATCH, UNSUPPORTED_TYPE, TYPE_MISMATCH, MALFORMED_FILE, ACTIVE_CONTENT, IMAGE_TOO_LARGE, MALWARE_DETECTED`).

The downloadable copy is a different object from the uploaded one. Re-uploading to the incoming URL after completion (the 5-minute URL may still be valid) therefore cannot change what officers see; a test covers this.

Limits: 10 MB per document (`DRIVER_LICENSE_FRONT`, `DRIVER_LICENSE_BACK`). Only JPEG, PNG, WebP and PDF are accepted. Rate limits: 30 intents and 60 completions per user per hour, 60 downloads per user per minute. The brief's 5 MB photo limit applies to profile and vehicle photos, which arrive in later phases. Licence images are documents, so they get 10 MB. [ASSUMPTION]

## 5. File validation, EXIF stripping and PDF checks [IMPL]

- **Type** comes from magic bytes only. The declared MIME type must match the detected one (`TYPE_MISMATCH` otherwise). File names and extensions are never used.
- **Images** (JPEG, PNG, WebP) are decoded and re-encoded with `sharp`:
  - All metadata (EXIF including GPS, XMP, ICC, comments) is dropped, after applying the EXIF orientation.
  - The longest side is capped at 4096 px.
  - `limitInputPixels` is 50 MP, to stop decompression bombs (`IMAGE_TOO_LARGE`).
  - Bytes appended after the image data do not survive re-encoding.

  The container smoke test confirmed that a JPEG with GPS EXIF is stored without EXIF (§24).
- **PDFs** are not re-encoded. A heuristic rejects active-content markers (`/JavaScript /JS /Launch /EmbeddedFile /OpenAction /AA /RichMedia /XFA /SubmitForm /ImportData`) and requires a `%PDF-` header and a `%%EOF` trailer. **This is not a PDF sanitizer.** Obfuscated objects (for example in compressed object streams) can evade it. [ASSUMPTION] The mobile app only uploads photos. PDFs are accepted for staff or desktop uploads, and officers open them in a new browser tab, which uses the browser's sandboxed PDF viewer.

## 6. File scanning [IMPL / ABSTRACTION]

| Adapter | Behaviour | Allowed in |
|---|---|---|
| `clamav` | clamd `zINSTREAM` over TCP, chunked; `stream: OK` → clean, `… FOUND` → infected; connection error, timeout or an unparseable reply → unavailable | all environments |
| `dev` (`dev-eicar-only`) | Reports **only** the EICAR test string as infected; everything else is "clean". **Not malware protection** | development, test |
| `disabled` | Every scan fails as unavailable, so nothing becomes `AVAILABLE` | all (default outside development) |

- The scan runs on the **original** bytes, before sanitizing. A detection marks the row `INFECTED` and writes the audit row `document.malware_detected`. Nothing is stored for download.
- `FILE_SCANNER=clamav` requires `CLAMAV_HOST`. `FILE_SCANNER=dev` is refused in staging and production (unit test).
- `infra/docker-compose.yml` has an optional `clamav` service (`clamav/clamav:1.4`, profile `scanner`, published on `127.0.0.1:53310`). The Docker stack in §24 ran with `FILE_SCANNER=clamav`.
- Found while verifying: an EICAR string appended to a real JPEG passed ClamAV as clean. By the EICAR convention, the test string is only detected at the start of a file. This shows what a signature scan does and does not do; it is not a defect of the adapter. The stored copy is re-encoded, so the appended bytes are not kept. Real malware detection depends on ClamAV signatures and is not claimed beyond that.

## 7. Object storage and encryption [IMPL]

- The bucket is private. Unsigned or tampered requests are refused (e2e test and container smoke test: unsigned GET → 403).
- Presigned URLs are signed for the host clients use (`STORAGE_PUBLIC_ENDPOINT`, default `STORAGE_ENDPOINT`), with a separate presigner client. Server-side reads and writes use the internal endpoint.
- `STORAGE_SSE` = `none | AES256 | aws:kms` (+ `STORAGE_SSE_KMS_KEY_ID`). It must not be `none` outside development; the API refuses to start otherwise. The local SeaweedFS stack uses `none`. Whether the production provider supports SSE is checked in Phase 23. [EXTERNAL]
- Storage keys are generated by the server and constrained by CHECK constraints (`incoming/{uuid}`, `documents/{yyyy}/{mm}/{uuid}`).

## 8. Driver profile and licence [IMPL]

- **Driver profile** (`POST/GET/PATCH /drivers/me`, customers only):
  - Driver-editable fields: years licensed (0–60), bio (≤ 500 characters, plain text) and home sub-city (one of the 11 Addis Ababa sub-cities).
  - Updates use `If-Match`.
  - Eligibility, suspension and review fields are never accepted from the client: unknown fields are rejected with 400, and a test covers this.
- **Licence** (`POST /drivers/me/licenses`, `PATCH …/{id}` with `If-Match`): licence number, categories, issue and expiry dates, issuing authority.
  - Rules: issue date not in the future, expiry after issue, licence not already expired by Addis Ababa date.
  - One licence per profile in Phase 5 (`driver_profile_id` UNIQUE).
- **Categories** are free codes as printed (`^[A-Z0-9][A-Z0-9-]{0,9}$`, 1–10 distinct codes). **No official category list is invented or enforced** [LEGAL] (L-4 in 12). Matching categories to vehicles is Phase 7.
- **Photos**: `PUT /drivers/me/licenses/{id}/documents/{front|back}` with `{documentId}`. The document must be the caller's own, `AVAILABLE`, of the matching purpose and not linked to another licence (code and trigger).
- **Editing**: details and photos can change only in `DRAFT`, `REJECTED` and `EXPIRED`. Editing or attaching a photo reopens the licence to `DRAFT`.
- **Submission**: `POST …/submit` requires an `Idempotency-Key`, identity `VERIFIED`, an `ACTIVE` account, valid dates, and both photos `AVAILABLE` and not part of an earlier decision. Photos from a decided review must be replaced. Problems come back as `422 DRIVER_SUBMISSION_INCOMPLETE` with codes (`IDENTITY_NOT_VERIFIED`, `FRONT_DOCUMENT_MISSING`, …).

## 9. Licence number protection [IMPL]

- Normalized before storage: upper case, with spaces, hyphens, slashes and dots removed, then 4–20 letters and digits.
- `license_number_enc`: AES-256-GCM with the Phase 3 field-encryption keys and AAD `driver_licenses.license_number_enc:{id}`. A ciphertext copied to another row does not decrypt.
- `license_number_hmac`: HMAC-SHA-256 with the pepper and the purpose `license`. It is UNIQUE, so the same licence cannot be used by two accounts. A duplicate returns `409 LICENSE_NUMBER_IN_USE` and writes the audit row `driver.duplicate_license_detected`, without revealing the other account.
- `license_number_last4` is kept for masked display (`••••3456`). The driver's API never returns the full number. The officer case view returns it and is audited (`driver.case_viewed`).
- `licenseNumber` was already a redacted log key (Phase 2). A test confirms that the number does not appear in logs or audit rows.

## 10. Review state machine [IMPL]

| From | To |
|---|---|
| DRAFT | SUBMITTED |
| SUBMITTED | UNDER_REVIEW (claim) |
| UNDER_REVIEW | SUBMITTED (release) · UNDER_REVIEW (takeover of an expired claim) · APPROVED · REJECTED |
| REJECTED | DRAFT (edit or new photo) |
| APPROVED | EXPIRED · SUSPENDED |
| SUSPENDED | APPROVED (reinstate) · EXPIRED |
| EXPIRED | DRAFT |

The same table is in `driver-rules.ts` (`REVIEW_TRANSITIONS`) and in the `driver_licenses_guard` trigger. A unit test checks every pair against the table, and an integration test checks that the database refuses every pair outside it. The trigger also:
- requires the claimer and decider to be an **active `VERIFICATION_OFFICER` who is not the driver**;
- freezes the licence details outside `DRAFT`;
- keeps the decision fields consistent (reason codes on reject and suspend).

Document review statuses follow the licence (`SUBMITTED` on submit, `APPROVED`/`REJECTED` on decision).

## 11. Review queue, claims and officer decisions [IMPL]

- **Queue**: `GET /admin/driver-verifications`, with status filter, search (name contains, or exact phone), `page`, and `limit` ≤ 50, plus `GET …/counts`. Draft cases are never shown to officers.
- **Claims**: `POST …/claim` is a single conditional update. It succeeds for `SUBMITTED`, or for `UNDER_REVIEW` whose claim is older than 30 minutes (takeover, recorded in history). Two officers cannot hold one case (`409 REVIEW_CLAIMED_BY_OTHER`, concurrency test). `POST …/release` returns the case to `SUBMITTED`.
- **Case view**: `GET …/{id}` returns the licence details, full number, verified name from Phase 4, identity status, photos, history and decision. Each view writes `driver.case_viewed`.
- **Documents**: `GET …/{id}/documents/{documentId}/url?reason=` (10–500 characters) returns a 60-second URL and writes `document.viewed_by_staff` with the reason. It is allowed only for the officer holding the claim, or for decided cases.
- **Approve** requires `identityMatches`, `documentsLegible` and `detailsMatch`, all `true`. It re-checks at decision time that identity is VERIFIED, the account is ACTIVE, the licence is not expired and both photos are AVAILABLE (`422` otherwise, with a test for an identity suspended after submission).
- **Reject** requires a reason code (`BLURRY, MISMATCH_NAME, EXPIRED, NOT_OWNER, INCOMPLETE, INVALID_LICENSE_DETAILS, SUSPECTED_FRAUD, OTHER`). The optional note is shown to the driver as plain text.
- **Suspend** (APPROVED only) requires a code (`SUSPECTED_FRAUD, SAFETY_CONCERN, NOT_OWNER, OTHER`) and an internal note of at least 10 characters. The note is never shown to the driver.
- **Reinstate** (SUSPENDED only) requires a note of at least 10 characters.
- Concurrent decisions by the claim holder produce exactly one decision (test).
- `driver_review_events` is an append-only history (trigger), with actor, from/to status, reason and note.

## 12. Driver eligibility and expiry [IMPL]

- `driver_profiles.eligibility_status` (`INELIGIBLE | ELIGIBLE | SUSPENDED`) is a cache with a single writer, `DriverEligibilityService.refresh`.
- It is `ELIGIBLE` only if the account is ACTIVE, identity is VERIFIED, the licence is APPROVED and not expired, and both photos are approved. A suspension gives `SUSPENDED`.
- `GET /drivers/me/eligibility` returns the status and **blockers** (`ACCOUNT_NOT_ACTIVE, IDENTITY_NOT_VERIFIED, LICENSE_MISSING, LICENSE_NOT_APPROVED, LICENSE_EXPIRED, DOCUMENTS_NOT_APPROVED, DRIVER_SUSPENDED`).
- **Expiry** uses the Addis Ababa date (UTC+3). A licence expires on its `expires_on` date.
  - Lazy: every `GET /drivers/me` refreshes first.
  - Bulk: `npm run drivers:refresh` (`sweep`) expires due licences and refreshes affected profiles. It is meant to run nightly (08 §7: 02:00 Addis time). No scheduler is deployed yet.
  - A test simulates a future date.
- Changes write `driver.eligibility_changed` (audit and outbox). Later phases (assignments) read the cached status.

## 13. Database schema and migration [IMPL]

One new migration, `20261118150000_documents_drivers`. No earlier migration was modified.
- **Enums**: `DocumentPurpose`, `DocumentUploadStatus`, `ReviewStatus`, `DriverEligibility`, `AddisSubCity` (11), `ReviewReasonCode`.
- **Tables**: `documents`, `driver_profiles`, `driver_licenses`, `driver_license_documents` (PK `driver_license_id + purpose`, `document_id` UNIQUE), `driver_review_events`, `notifications`.
- **Constraints**: 25 CHECK constraints, for example:
  - key formats, MIME list and size ≤ 10 MB;
  - `AVAILABLE` requires the storage key, MIME type, stored hash and scan engine;
  - failed rows carry a failure code;
  - licence dates, the categories format, the HMAC format and the claim shape;
  - suspension needs a reason.

  UNIQUE constraints cover `upload_key`, `storage_key`, `user_id` (profile), `driver_profile_id` (licence), `license_number_hmac`, `document_id`, and `(recipient, dedupe_key)` on notifications.
- **Indexes**:
  - partial index `documents_unfinished_idx` (cleanup of abandoned uploads);
  - `documents_approved_expiry_idx`;
  - queue index `(review_status, submitted_at)`;
  - history and notification indexes.
- **Triggers**:
  - `documents_guard`: immutable owner, purpose, keys and declared facts; terminal statuses stay terminal; review only after `AVAILABLE`.
  - `driver_profiles_guard`.
  - `driver_licenses_guard` (§10).
  - `driver_license_documents_guard`: own document, matching purpose.
  - `driver_review_events_append_only`.
- Verified: `prisma validate`, `db:drift` ("No difference detected"), all migrations applied from zero by the integration suite and by the `migrate` container.

## 14. API endpoints (under `/api/v1`)

| Area | Endpoints |
|---|---|
| Documents (customer) | `POST /documents` · `GET /documents` · `GET /documents/{id}` · `POST /documents/{id}/complete` · `GET /documents/{id}/url` |
| Driver (customer) | `POST /drivers/me` · `GET /drivers/me` · `PATCH /drivers/me` (If-Match) · `GET /drivers/me/eligibility` · `POST /drivers/me/licenses` · `PATCH /drivers/me/licenses/{id}` (If-Match) · `PUT /drivers/me/licenses/{id}/documents/{front\|back}` · `POST /drivers/me/licenses/{id}/submit` (Idempotency-Key) |
| Officer (`drivers.review`) | `GET /admin/driver-verifications` · `GET …/counts` · `GET …/{id}` · `POST …/{id}/claim` · `…/release` · `…/approve` · `…/reject` · `…/suspend` · `…/reinstate` · `GET …/{id}/documents/{documentId}/url?reason=` |
| Me | `GET /me` now includes `permissions` |

New error codes: `DRIVER_PROFILE_REQUIRED, UPLOAD_NOT_FOUND, DOCUMENT_PROCESSING, DOCUMENT_SCAN_UNAVAILABLE, DOCUMENT_NOT_AVAILABLE, LICENSE_NUMBER_IN_USE, DRIVER_SUBMISSION_INCOMPLETE, REVIEW_CLAIMED_BY_OTHER, REVIEW_CLAIM_REQUIRED`. OpenAPI documents all routes.

## 15. Authentication, authorization and the permission model [IMPL]

- A new permission, `drivers.review`, is granted to **`VERIFICATION_OFFICER` only**. `SUPER_ADMIN`, `SUPPORT` and `FINANCE` do not get it, and get `403` on every officer route. This is the least-privilege rule from the brief: super administrators assign roles but do not review.
- Customer tokens get `404` on admin routes, and anonymous requests get `401` (matrix test and container check).
- Staff tokens have no customer document or driver routes.
- `PHASE5_ROWS` in `authorization-matrix.e2e.spec.ts` covers all 21 new routes for anonymous, customer, other customer, each staff role and the officer.
- IDOR: another user gets `404` for document metadata, completion, download, licences and submission.
- The database also refuses a driver, or a staff member who is not an active officer, as claimer or decider (trigger). A bug in the service therefore cannot let a driver approve themselves.

## 16. Audit, outbox and in-app notifications [IMPL]

- **Audit actions**:
  - Documents: `document.upload_initiated`, `document.upload_completed`, `document.validation_failed`, `document.malware_detected`, `document.scan_unavailable`, `document.viewed_by_staff` (with reason).
  - Driver: `driver.profile_created`, `driver.profile_updated`, `driver.license_saved`, `driver.license_document_attached`, `driver.verification_submitted`, `driver.duplicate_license_detected`, `driver.eligibility_changed`, `driver.license_expired`.
  - Officer: `driver.case_viewed`, `driver.review_claimed`, `driver.review_released`, `driver.approved`, `driver.rejected`, `driver.suspended`, `driver.reinstated`.
- **Outbox events** (delivery is Phase 15): `document.available`, `document.rejected`, `driver.profile_created`, `driver.verification_submitted`, `driver.approved`, `driver.rejected`, `driver.suspended`, `driver.reinstated`, `driver.eligibility_changed`, `driver.license_expired`.
- **In-app notifications**: rows in `notifications`, written in the decision's transaction.
  - They contain template keys (`notif.driver.approved.title`, …; the key format is a CHECK constraint) and parameters with identifiers and codes only. Names, licence numbers and document data are never written; this is enforced by the code that writes them, not by the database.
  - `(recipient, dedupe_key)` is UNIQUE, so a replay creates nothing.
  - There is no list API or UI yet (Phase 15).

## 17. Security controls and threat review

| Threat | Control |
|---|---|
| IDOR on documents and licences | Ownership in every query (404); trigger on links; e2e tests |
| Tampering with an uploaded file after checks | Downloads come only from a separate, server-written copy; e2e test |
| Wrong type or polyglot files | Magic-byte detection, declared-type match, image re-encoding |
| Image metadata leaking location | All metadata stripped; verified in e2e and in the container |
| Decompression bombs | 50 MP input limit, 4096 px output, 10 MB size limit signed into the URL |
| Malicious PDF | Active-content heuristic only [ASSUMPTION]; opened in the browser's PDF viewer |
| Malware | ClamAV adapter; fails closed when unavailable; `dev` refused when deployed |
| Officer self-approval or a non-officer decision | Permission check plus database trigger |
| Two officers deciding at once | Single-statement claim; decision requires the active claim; concurrency tests |
| Officer browsing documents | Claim holder only, reason required, audited, 60-second URL, `no-store` |
| Duplicate licence across accounts | HMAC UNIQUE, audited, without revealing the other account |
| Stale facts at approval time | Re-checked in the approval transaction |
| Client setting eligibility | Unknown fields rejected; single server writer |
| Staff tokens stolen from browser storage | Admin keeps tokens in memory only; TOTP on every login |
| Cross-origin calls to the API | CORS allows only `CORS_ALLOWED_ORIGINS` (container check: unknown origin refused) |
| Officer notes as markup | Plain `Text` rendering in both apps; tests use HTML-like notes |

## 18. Admin web console [IMPL]

`admin/` (Flutter Web, `kiroween_admin`) uses Riverpod 3, GoRouter and Dio, and has 105 en/am messages.
- **Login**: phone, password and a 6-digit TOTP code (Phase 3 staff login). The code and password fields are cleared after every attempt, and customer accounts are refused.
- **Session**:
  - Access and refresh tokens are kept **in memory only** (`TokenHolder`). Nothing is written to localStorage, sessionStorage, IndexedDB or cookies, so a reload signs the officer out.
  - The installation id is random per page load.
  - One refresh runs at a time; a second 401 ends the session.
- **Routing**: the guard sends signed-out users to `/login`, and staff without `drivers.review` to a no-permission screen. The API checks again on every call.
- **Screens**:
  - Dashboard: counts per status.
  - Queue: status filter, search, pagination, claim and release.
  - Case detail: driver, licence, documents and history.
  - Decision dialogs:
    - approve: three required checks;
    - reject: reason code and optional note for the driver;
    - suspend: reason code and an internal note of at least 10 characters;
    - reinstate: note.
- **Documents**: a reason dialog (≥ 10 characters) comes first, then the 60-second URL. Images open in a dialog as an `<img>` element, so the storage origin needs no CORS rule. PDFs open in a new tab. Nothing is preloaded.
- **Security headers**:
  - `index.html` sets `noindex` and `no-referrer`.
  - A Content-Security-Policy and HSTS must be set by the hosting server [EXTERNAL]. Flutter's CanvasKit renderer needs `wasm-unsafe-eval`, which a meta tag cannot scope well.
- **Builds**: `flutter build web` PASS with both the development and the production example configs. The production config requires https.
- CI has a new `admin` job.

## 19. Mobile driver experience [IMPL]

`mobile/lib/features/driver/` adds the routes `/driver`, `/driver/profile`, `/driver/license`, `/driver/license/photos` and `/driver/license/review`. The entry point is in the account screen.
- **Hub**: eligibility with blockers, an identity banner linking to Phase 4 verification, the profile, and the licence status (number shown masked).
  - Rejected: the reason and the officer note as plain text.
  - Under review: no edit actions.
  - Approved, suspended (with reason) and expired are each shown.
- **Forms**: client-side rules mirror the API (number normalization, categories, dates). Server field errors map to the right field. A duplicate number is explained without detail. Editing re-sends the number, because the API never returns it.
- **Photos**:
  - Picked from the system camera or gallery (`image_picker`: max 2400 px, JPEG quality 85, `requestFullMetadata: false`, no storage permission).
  - Checked: magic bytes and 10 MB on the device.
  - Uploaded: SHA-256 (`crypto`), intent, then a PUT with progress through a **separate Dio client without the Authorization header**, then completion and attach.
  - Resumable: a failed step resumes where it stopped (a scanner outage repeats only the check; `UPLOAD_NOT_FOUND` re-sends the bytes). Refused files ask for a new photo.
- **Review**: a summary and an explicit "this is my own licence" checkbox. One Idempotency-Key per visit, reused on retry (test).
- Dependencies added from the offline cache: `image_picker` 1.2.1 (BSD-3) and `crypto` 3.0.8 (BSD-3).

## 20. English and Amharic localization [IMPL]

- Mobile: +111 messages, covering sub-city names, reason codes, blockers, upload errors and statuses.
- Admin: 105 messages.
- Every message has an Amharic translation. The existing "no hard-coded strings" test covers the new screens (it caught a hard-coded bullet character, which is fixed). The Amharic texts were written by the developer and **need native-speaker review**. [ASSUMPTION]
- Sub-city names use their common Amharic spellings.
- The reason `SUSPECTED_FRAUD` is shown to drivers in neutral wording ("The documents could not be accepted").

## 21. Automated tests and exact results

Final run, 2026-11-19. Each suite is counted once; coverage reruns are not added.

| Suite | Phase 4 | Phase 5 | Added |
|---|---|---|---|
| Backend unit (`npm test`) | 226 | **278** | +52 |
| Backend integration and HTTP (`npm run test:integration`) | 240 | **338** (+2 skipped) | +98 |
| Shared Dart (`dart test`) | 62 | **62** | 0 |
| Flutter mobile (`flutter test`) | 164 | **187** | +23 |
| Flutter admin (`flutter test`, new) | 0 | **20** | +20 |
| **Total** | **692** | **885** | **+193** |

The 2 skipped tests are `test/integration/clamav.spec.ts`, which runs only with `CLAMAV_TEST_HOST`. Against the compose clamd it **passed 2/2**: EICAR infected, licence JPEG clean.

New test files:
- Backend unit:
  - `driver-rules.spec` (23): every transition pair, dates, normalization, eligibility and submission rules;
  - `file-inspection.spec` (17): magic bytes, EXIF and GPS removal, mismatch, malformed, PDF markers;
  - `file-scanner.spec` (8): a fake clamd covering clean, infected, garbage, silent/timeout and connection refused, plus the dev and disabled adapters and config selection;
  - 4 new `app-config.spec` cases.
- Backend integration:
  - `documents.e2e` (17), `drivers.e2e` (28), `driver-db-constraints` (14);
  - 39 new authorization-matrix cases from `PHASE5_ROWS`;
  - `clamav.spec` (opt-in).
- Mobile: `driver_data_test` (models, rules, HTTP shapes, uploader headers, upload job resume rules) and `driver_screens_test`.
- Admin: `core_test` (config, redirect rule, session), `http_api_test` (request shapes, problem codes, 401 refresh and expiry) and `screens_test` (login, no-permission, queue, claim, approve/reject/suspend dialogs, document reason, conflicts).

| Required case | Covered by |
|---|---|
| IDOR on documents and licences | e2e |
| Invalid transitions | unit (every pair), e2e, DB trigger tests |
| Expired licence | e2e (simulated date), unit, form validation |
| Suspended driver | e2e (suspend → SUSPENDED, reinstate → ELIGIBLE), mobile screen test |
| Upload validation (type, size, hash, magic bytes, EXIF) | unit, e2e, container smoke |
| Malware and scanner outage | e2e (dev scanner), unit (fake clamd), opt-in real clamd, container outage test |
| Concurrent claims and decisions | e2e |
| Duplicate licence number | e2e |
| Permissions (officer only) | matrix, e2e, admin screen test |
| Idempotent submission | e2e, mobile screen test |

## 22. Code coverage

| Scope | Lines | Statements | Branches | Functions | Gate |
|---|---|---|---|---|---|
| Documents, drivers, scanner (new) | **94.98%** (606/638) | 92.57% | 84.87% | 97.77% | ≥ 90% lines: PASS |
| Auth (unchanged scope) | **97.5%** (743/762) | 94.57% | 84.23% | 97.86% | PASS |
| Identity (unchanged scope) | **95.63%** (658/688) | 92.57% | 83.88% | 96.4% | PASS |

`npm run test:coverage:drivers` was added to CI.

## 23. Build verification

| Check | Result |
|---|---|
| `npm run build`, `tsc --noEmit`, ESLint, Prettier | PASS |
| `prisma validate`, `db:drift` | PASS |
| `flutter build web` (admin, development and production example configs) | PASS |
| `flutter build apk --debug --dart-define-from-file=config/development.json` | **PASS**: `app-debug.apk` (209 MB debug build), first successful APK build on this machine |
| Release APK | NOT RUN (CI builds it; signing is Phase 23) |
| Device or emulator test | **NOT RUN**: no device attached (`adb devices` empty) |

## 24. Docker and container verification

- **Rebuild.** `docker compose -p kiroween-mobility --profile scanner up -d --build migrate api` exited 0, with `FILE_SCANNER=clamav`. It was rebuilt again after the sharp upgrade.
- **Running image.** The running `api` container uses image `sha256:51cb1751e715…`, built about 3 minutes before the check. It reports `sharp` 0.35.5, `FILE_SCANNER=clamav` and `STORAGE_PUBLIC_ENDPOINT=http://localhost:58333`, and its health is `healthy`. Readiness: `{"status":"ok","checks":{"database":"up","redis":"up","storage":"up"}}`.
- **Migrations.** `_prisma_migrations` lists `20261118150000_documents_drivers` as the latest.
- **ClamAV.** The `clamav/clamav:1.4` image pulled successfully this time (the earlier attempt failed on Docker DNS). clamd started with the bundled signatures.
- **Smoke test** against the container (script, real HTTP and storage):
  1. register → driver profile → upload intent → direct PUT to `localhost:58333` (200) → complete → `AVAILABLE`, scan engine `clamav`;
  2. the source JPEG had GPS EXIF; the stored copy has **no EXIF**;
  3. download 200 with `Cache-Control: private, no-store, max-age=0`;
  4. unsigned GET of the incoming key → 403;
  5. EICAR declared as PDF → `INVALID / UNSUPPORTED_TYPE`;
  6. EICAR appended to a JPEG → clean (see §6), and the stored copy is the re-encoded image;
  7. **scanner outage**: with clamd stopped, completion → `503 DOCUMENT_SCAN_UNAVAILABLE`, status `UPLOADED`; with clamd started again, the same document → `AVAILABLE`;
  8. CORS preflight from `http://localhost:8080` allowed; from another origin refused;
  9. admin queue: anonymous 401, customer 404.
- **Not done in the container:** the officer flow (it needs a TOTP-activated officer account). The officer flow is covered by the e2e suite against real PostgreSQL, Redis and SeaweedFS.
- **Side effect:** the dev database now contains smoke-test customers, driver profiles and documents.

## 25. Git commits

Phase 5 is committed on `main` in logical groups after `8a88027` (`phase-04-complete`). Earlier history was not rewritten, and no earlier migration was changed. The commit list and hashes are in the final response of this session. There is no `phase-05-complete` tag, and nothing was pushed.

## 26. Architecture deviations

| Architecture said | Implemented | Reason |
|---|---|---|
| Document statuses include `SCAN_FAILED` (03) | `INVALID`, `INFECTED`, and a scanner outage returns to `UPLOADED` | A file problem, a detected threat and a temporary outage need different handling (terminal vs retryable) |
| Generic `/admin/review-queue?type=` and `/admin/reviews/{type}/{id}/…` (04) | `/admin/driver-verifications/…` | Only one review type exists in Phase 5; a generic queue can wrap it when owner and vehicle reviews arrive |
| `DELETE /documents/{id}` (only DRAFT) | Not implemented | Not needed by the flow; abandoned uploads are found through `documents_unfinished_idx` (cleanup job not yet written) |
| Checklist configurable in `system_config` (08 §7) | Fixed in code (front + back) | No configuration module exists yet |
| Daily expiry job at 02:00 | CLI `drivers:refresh` plus lazy refresh | No scheduler is deployed yet |
| Four-eyes for reinstating a fraud suspension [ASSUMPTION] | A single officer with a mandatory note, audited | Needs a second-approver workflow; listed in §28 |
| Officer may serve uploaded objects | The served object is a server-written sanitized copy | Prevents tampering and strips metadata |
| SUPER_ADMIN as a superset role | SUPER_ADMIN does not get `drivers.review` | Least privilege, as required by the Phase 5 brief |

## 27. Assumptions

- Licence images count as documents (10 MB). The 5 MB photo limit applies to later photo types.
- One licence per driver at a time.
- Category codes are stored as printed, without an official list.
- 30-minute claims; a 2-minute processing takeover; 60-second download URLs; 5-minute upload URLs.
- The licence expiry date counts as expired on that date (Addis Ababa time).
- A suspension reason code may be shown to the driver; the internal note is never shown.
- The PDF heuristic is acceptable until a sanitizer or conversion service is chosen.
- Amharic texts are acceptable until native review.

## 28. Known limitations

1. **No production malware scanning service** is chosen or operated. The dev scanner is EICAR-only. [EXTERNAL]
2. **PDFs are not sanitized.** The heuristic can be evaded.
3. **No scheduler** runs `drivers:refresh` or cleans abandoned `PENDING_UPLOAD` objects (incoming objects without completion stay in storage until a cleanup job exists).
4. **No four-eyes reinstatement** and no bulk-access alerting on officer document views (Phase 18).
5. **No device test** of the photo flow. The camera and gallery paths are tested with fakes only.
6. **No notification list or delivery** (Phase 15). Drivers see decisions by opening the driver screen.
7. **Admin**: a page reload signs the officer out (by design). There is no officer account management UI. CSP and HSTS must be set by the host.
8. **Amharic texts** need native review.
9. **One licence per profile.** Renewal reuses the licence through `EXPIRED → DRAFT`. There is no history of earlier licence numbers beyond the audit log.

## 29. Security risks

| Risk | Note |
|---|---|
| Malware in accepted files | Only as good as the scanner; fails closed without one; images are re-encoded, PDFs are not |
| Officer insider access | Full licence numbers and images are visible to officers; every view is audited with a reason; least privilege |
| Licence forgery | Manual visual review only; no government verification API is known [EXTERNAL] |
| Storage misconfiguration | A public bucket would expose files; checked by e2e and the container smoke test; SSE required outside development |
| Key and pepper compromise | Licence numbers depend on `FIELD_ENCRYPTION_KEYS` and `HASHING_PEPPER`; HMAC rotation is not designed |
| Presigned URL leakage | 60-second lifetime, `no-store`, `no-referrer` in the admin console |
| sharp/libvips vulnerabilities | Native image decoding of untrusted input; keep `sharp` current (`npm audit` is in CI) |

## 30. External and legal dependencies

- **Production malware scanning** (managed ClamAV or a commercial scanner) and its signature updates. **[EXTERNAL]**
- **Object storage with SSE** in production (Phase 23). **[EXTERNAL]**
- **Official licence category list** and **legal basis** for storing licence images and numbers (Proclamation 1321/2024, retention). **[LEGAL]**
- **Government licence verification API** (Federal Transport Authority or the Addis Ababa Road & Transport Bureau). None is known to exist publicly; the review is manual. **[EXTERNAL]**
- **Native Amharic review.** **[EXTERNAL]**
- **An Android device** for the photo and upload test. **[EXTERNAL / environment]**

## 31. Phase 5 quality-gate result and recommended next step

| Gate | Result |
|---|---|
| Backend Prettier, ESLint, `tsc`, build | PASS |
| `prisma validate`, `db:drift`, migrations from zero | PASS |
| Backend unit 278, integration 338 (+2 opt-in, passed separately) | PASS |
| Coverage: drivers 94.98%, auth 97.5%, identity 95.63% lines (≥ 90%) | PASS |
| `npm audit --omit=dev --audit-level=high` | PASS (0 vulnerabilities, after upgrading sharp to 0.35.5) |
| Mobile format, analyze `--fatal-infos`, test (187) | PASS |
| Admin format, analyze `--fatal-infos`, test (20), web build | PASS |
| Shared Dart format, analyze, test (62) | PASS |
| Gitleaks working tree and Git history (76 commits before the Phase 5 commits) | PASS (no leaks) |
| Docker image build, migrations, health, readiness | PASS |
| Container smoke test (upload, EXIF, download headers, private bucket, ClamAV, outage, CORS, admin 404) | PASS |
| Debug APK build | PASS |
| Device or emulator test | **NOT RUN** (no device) |
| Officer flow against the container | NOT RUN (covered by e2e) |
| `osv-scanner` for Dart dependencies | NOT RUN (tool not installed) |

**Overall: Phase 5 passes every gate that can run here.** The device test is the open item.

Recommended next steps:
1. Human review of this report, especially §6 (scanner honesty), §5 (PDF heuristic), §15 (SUPER_ADMIN cannot review) and §26 (deviations).
2. Device test, with `adb reverse tcp:3000 tcp:3000` and `adb reverse tcp:58333 tcp:58333`, using a build with `API_BASE_URL=http://localhost:3000`:
   - create profile → licence → camera photo front and back → submit;
   - officer approves in the admin console → the driver screen shows "You can drive".
3. Choose the production scanning approach and decide on PDFs (accept with the heuristic, convert to images, or refuse).
4. Then Phase 6, only after approval.
