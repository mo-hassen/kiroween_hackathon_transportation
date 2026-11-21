# Phase 7 Report: Vehicle Registration and Verification

Status labels: PASS, FAIL, BLOCKED, NOT RUN. `[IMPL]` marks implemented behavior,
`[ASSUMPTION]` a choice the architecture does not make.

## 0. Read this first

- **The Phase 7 prompt was cut off after §23 (the audit event list).** The testing, quality-gate,
  report and Git sections did not arrive. I applied the Phase 6 pattern for them: tests at every
  layer, the same quality gates, this report, logical commits, no push, no `phase-07-complete`
  tag, stop for review. Please check this report against the missing sections.
- The prompt names the repo `kiroween_transportation_platform`. The real folder is
  `kiro_hackathon_transportation_platform`. The prompt's doc names `09-notifications-and-messaging`
  and `10-observability-and-audit` do not exist; the real files are
  `09-ledger-payments-payouts.md` and `10-notifications-disputes-audit.md`.
- **The Android device test was not run** (NOT RUN, section 15). Everything else passed.

## 1. Summary

A VERIFIED owner registers vehicles, attaches four documents and five photos, and submits. A
verification officer claims the case, inspects the evidence through 60-second URLs, and approves,
rejects, suspends or reinstates. Owner verification, vehicle verification and marketplace
availability stay separate: an approved vehicle is verified, not listed.

Done: backend module, two migrations, admin console area, mobile "My vehicles", tests, docs.
Not done on purpose: listings, applications, agreements, payments, notifications delivery, driver
assignment, `operational_status`.

## 2. Data model [IMPL]

Migrations `20261120090000_vehicle_enum_values` (enum values, separate because PostgreSQL cannot
use a new value in the same transaction) and `20261120090100_vehicle_verification`.

| Table | Purpose |
|---|---|
| `vehicles` | Details, status, claim and decision columns, `version`, `archived_at` |
| `vehicle_documents` | One row per `(vehicle_id, slot)`; `document_id` UNIQUE; insurance/inspection end date |
| `vehicle_review_events` | Append-only history (trigger) |

- Types: SEDAN, HATCHBACK, SUV, MINIBUS, PICKUP, THREE_WHEELER, OTHER. Transmission (MANUAL,
  AUTOMATIC) and fuel (PETROL, DIESEL, ELECTRIC, HYBRID, OTHER) are `[ASSUMPTION]`: 03 names the
  columns without values.
- Status: 02 §3.3 plus ARCHIVED. The transition table is in `vehicle-rules.ts` and in the trigger
  `vehicles_guard`; an integration test walks all 56 pairs.
- Ownership: the owner comes from the principal and never changes (trigger). Transfer attempts are
  400 (unknown field) or refused by the trigger.
- One active vehicle per plate and per VIN: nullable `plate_key` / `vin_key` columns with plain
  unique indexes, set while active and NULL once archived (CHECKs tie them to `archived_at`).
  Prisma cannot express partial unique indexes.
- Plate: stored in clear (public identifier; the architecture lists no confidentiality need). No
  Ethiopian plate format is assumed `[ASSUMPTION]`: three parts of 1–12 letters (any script) or
  digits, NFKC upper-case, joined with `-` so parts never merge.
- VIN and engine number: AES-256-GCM with row-bound associated data; keyed HMAC (`vin` purpose)
  for VIN uniqueness; last four characters for masking. Permissive formats `[ASSUMPTION]`
  (VIN 5–25, engine 3–30 letters and digits).
- Text fields reject control, format (zero-width, bidi), private-use and unassigned characters.

## 3. Rules [IMPL]

- Create and every write need a VERIFIED owner on an ACTIVE account with a VERIFIED identity
  (409 `OWNER_PROFILE_REQUIRED` / `OWNER_NOT_VERIFIED`; database trigger on insert). Reads of own
  vehicles are always allowed. Uploads with vehicle purposes need the same.
- Editable: DRAFT, REJECTED, EXPIRED (an edit returns the vehicle to DRAFT). APPROVED: colour,
  seats, transmission and fuel change freely; make, model, year, type, plate, VIN, engine number
  or any evidence change sends it to SUBMITTED in the same transaction (checklist re-validated).
- Submission blockers come from the server: `GET /vehicles/{id}/status`, and 422
  `VEHICLE_SUBMISSION_INCOMPLETE` with codes (`PHOTO_FRONT_MISSING`, `INSURANCE_EXPIRED`,
  `OWNER_NOT_VERIFIED`, ...). Everything is re-checked inside the submit transaction.
- Required evidence: registration, ownership proof (registration in the owner's name, or an
  authorization letter), insurance, inspection, photos front/back/left/right/plate. The interior
  photo is optional. Insurance and inspection need an end date (not in the past, at most 10 years
  ahead, Addis Ababa date).
- Eligibility is computed, never stored: APPROVED, evidence in date, owner VERIFIED, account
  ACTIVE, identity VERIFIED. A suspended or expired vehicle is not eligible (BR-VEH-3).
- Expiry: lazily on owner reads and officer actions, and in bulk by `npm run vehicles:refresh`.
  **No scheduler is deployed**, so a vehicle nobody reads stays APPROVED in the table until the CLI
  runs (its eligibility is still computed correctly on every read). Reminders are Phase 15.

## 4. API (under `/api/v1`) [IMPL]

Owner (customers only; staff get 404): `POST/GET /vehicles`, `GET/PATCH /vehicles/{id}`
(If-Match), `PUT /vehicles/{id}/evidence/{slot}`, `GET /vehicles/{id}/status`,
`POST /vehicles/{id}/submit` (Idempotency-Key), `POST /vehicles/{id}/archive`.

Officer (`vehicles.verify`, VERIFICATION_OFFICER only; other staff 403, customers 404):
`GET /admin/vehicle-verifications` (+ `/counts`, `/{id}`), `POST …/{id}/claim`, `/release`,
`/approve`, `/reject`, `/suspend`, `/reinstate` (decisions need Idempotency-Key),
`GET …/{id}/documents/{documentId}/url?reason=`.

Everything is in OpenAPI. Another owner's vehicle, document or photo is 404, identical to a
missing one (tested).

## 5. Review workflow [IMPL]

- Claim: SUBMITTED to UNDER_REVIEW with a 30-minute claim; one conditional update, so two
  officers cannot hold a case. Expired claims can be taken over; release re-queues.
- Approve needs four confirmations (details match, owner matches registration, documents legible,
  photos match) and re-checks owner, account, identity and evidence in the transaction.
- Reject reasons: BLURRY, EXPIRED, NOT_OWNER, INCOMPLETE, VEHICLE_DETAILS_MISMATCH,
  INVALID_DOCUMENT, SUSPECTED_FRAUD, OTHER. Suspend reasons: SUSPECTED_FRAUD, SAFETY_CONCERN,
  NOT_OWNER, OTHER, with an internal note of at least 10 characters (never shown to the owner).
  A rejection note is plain text shown to the owner.
- Four-eyes only where the architecture asks (08 §7): a SUSPECTED_FRAUD suspension is lifted by a
  different officer (service and trigger). Normal approval is one officer.
- Full VIN and engine number are shown only to the claim holder, audited as
  `vehicle.identifiers_viewed` (field names only). Evidence URLs need the claim while the case is
  open, a reason, and are audited twice (`document.viewed_by_staff` and
  `vehicle.photo_viewed` / `vehicle.document_viewed`).

## 6. Audit, outbox and notifications [IMPL]

Audit actions: `vehicle.created`, `updated` (field names only), `submitted`, `document_attached`,
`photo_attached`, `case_viewed`, `identifiers_viewed`, `document_viewed`, `photo_viewed`,
`review_claimed`, `review_released`, `approved`, `rejected`, `suspended`, `reinstated`, `expired`,
`archived`, `duplicate_plate_detected`, `duplicate_vin_detected`. Outbox events for created,
submitted, approved, rejected, suspended, reinstated, expired. In-app notifications
(`notif.vehicle.*`, deep link `/vehicles`, codes only). Delivery is Phase 15. The
`ReviewReasonCode` enum gained `VEHICLE_DETAILS_MISMATCH` and `INVALID_DOCUMENT`.

## 7. Admin web [IMPL]

"Vehicles" navigation and dashboard section (only with `vehicles.verify`), queue (status, type,
search, paging, claim/release), case screen (details, owner, ten evidence slots with a reason
prompt before every open, history, approval blockers), decision dialogs. English and Amharic.

## 8. Mobile [IMPL]

"My vehicles" (account menu): list with statuses, owner gate, details form (client checks mirror
the API), ten evidence slots with camera or gallery, upload progress, retry without re-picking
(reuses `DocumentUploadJob`), date picker for insurance/inspection, progress bar with a screen
reader label, review and submit with one Idempotency-Key per visit, archive with confirmation.
Rejection reason and note, expiry and suspension guidance. English and Amharic. VIN and engine
number are only typed and never displayed back (masked VIN only). Route guard now matches
`/vehicles/<uuid>[/edit|/review]`.

## 9. Security review

- Ownership from the principal; no ownership transfer; cross-owner access is 404 (tests for
  GET, PATCH, evidence, submit, archive, document download).
- A photo of vehicle A cannot be evidence for vehicle B, for the same or another owner: API
  (409/404) and database (`document_id` UNIQUE plus guard trigger). Tested at both layers.
- Images only (policy and DB CHECK); photos 5 MB, documents 10 MB; scanner fails closed (Phase 5).
- No VIN or engine number in responses (masked), audit, outbox, or logs (tested in e2e and in
  the container).
- The VIN is encrypted although the architecture stores it in clear (deviation, section 13).
- Rate limit: the Phase 5 limit of 30 upload intents per user per hour applies. A vehicle needs
  nine, so about three complete vehicles per hour. Left as the architecture says.

## 10. Tests and exact counts

| Suite | Count | Result |
|---|---|---|
| Backend unit | 329 (+39) | PASS |
| Backend integration | 453 (+72) and 2 opt-in skipped | PASS |
| Mobile | 222 (+22) | PASS |
| Admin | 44 (+10) | PASS |
| Shared Dart | 62 | PASS |
| **Total** | **1110** (Phase 6: 967) | PASS |

New backend tests: `vehicle-rules.spec.ts` (39), `vehicle-db-constraints.spec.ts` (18),
`vehicles.e2e.spec.ts` (36), 18 matrix rows (the matrix test still checks every protected route
has a row). One Phase 5 test used `VEHICLE_PHOTO` as its "unknown purpose"; it now uses
`VEHICLE_HOLOGRAM`.

## 11. Coverage (lines)

vehicles 99.07%, owners 96.5%, drivers 95.3%, auth 97.5%, identity 95.63%. All above the 90% gate.
CI gained a vehicles coverage step.

## 12. Build and quality gates

| Gate | Result |
|---|---|
| Prettier, ESLint, `tsc`, `prisma validate`, drift | PASS |
| `npm audit` (production) | PASS (0 vulnerabilities) |
| `dart format`, `flutter analyze --fatal-infos` (mobile, admin, shared) | PASS |
| Android APK (debug) | PASS |
| Admin web release build | PASS |
| Docker rebuild with ClamAV | PASS |
| Container smoke test (`phase7-smoke.mjs`, every check) | PASS |
| Gitleaks, working tree and history | PASS (no leaks) |

The container test covered: prerequisites, validation, duplicates, IDOR including photo A to
vehicle B, ClamAV uploads, idempotent submit and approve, claims, VIN visibility, 60-second URLs,
fraud suspension and the different-officer reinstatement, material change to SUBMITTED, insurance
expiry, archive, no VIN in audit, outbox, database or logs.

## 13. Architecture deviations

| Deviation | Reason |
|---|---|
| `vehicles.owner_profile_id`, not `owner_user_id` | 03 uses the profile; the user is derived |
| `vehicle_review_events` instead of `vehicle_reviews` | Same pattern as drivers and owners |
| `plate_key` / `vin_key` columns | Prisma cannot express partial unique indexes |
| VIN and engine number encrypted | Defense in depth; 03 stores them in clear |
| `PUT /vehicles/{id}/evidence/{slot}` instead of `POST …/documents` | A slot model with replace semantics |
| Permission `vehicles.verify` reused | Already granted to VERIFICATION_OFFICER; no new permission |
| `operational_status` not created | Marketplace availability is a later phase |

## 14. Assumptions and limitations

- Transmission and fuel values, plate/VIN/engine formats, evidence slot list and the 10-year
  limit on certificate end dates are `[ASSUMPTION]`.
- No scheduler (section 3). Owner or identity changes do not alter a vehicle's stored status; its
  computed eligibility changes.
- No upload deletion endpoint; replaced documents stay stored (Phase 5 limitation).
- Insurance validity is what the owner types; officers compare it with the certificate.
- Officer notes and plates are plain text; nothing is rendered as markup.

## 15. Android device test: NOT RUN

The phone was not used in this phase. Reason: the Phase 6 test showed the system photo picker
exposes the personal library, and I did not want to touch the phone without your say-so. The APK
builds. To run it: connect the phone, `adb reverse tcp:3000 tcp:3000` and `tcp:58333 tcp:58333`,
install `mobile/build/app/outputs/flutter-apk/app-debug.apk`, sign in as a verified owner and walk
through My vehicles with the test images in `/sdcard/Pictures`.

## 16. Git

Logical commits on `main`, no push, no `phase-07-complete` tag. `phase4.txt` was not touched.
