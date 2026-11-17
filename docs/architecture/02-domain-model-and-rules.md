# 02 — Domain Model, State Machines, Business Rules

## 1. Bounded contexts (backend modules)

| Context | Aggregates / entities | Owns |
|---|---|---|
| Accounts & Auth | User, Credential, Session, Device, OtpChallenge, StaffMfa | Login, tokens, account status |
| Identity | IdentityVerification, VerificationSession | Who the person is (separate from login) |
| Documents | Document (metadata), file objects | Private upload/storage/access for all contexts |
| Drivers | DriverProfile, DriverLicense, DriverDocument links | Driver eligibility |
| Owners | OwnerProfile, OwnerDocument links | Owner eligibility |
| Vehicles | Vehicle, VehicleDocument links, VehicleReview | Vehicle eligibility |
| Marketplace | Listing | What is offered and on what terms |
| Applications | Application | Driver requests |
| Agreements | Agreement, AgreementVersion, AgreementAcceptance | Contract terms |
| Assignments | Assignment, Handover, ActivityReport | Who has the vehicle, when |
| Ledger | LedgerAccount, JournalEntry, JournalLine, CommissionRule | Money truth |
| Payments | Charge, Payment, PaymentProviderEvent | Collecting money |
| Payouts | PayoutMethod, Payout, PayoutBatch | Paying money out |
| Notifications | Notification, PushToken, OutboxEvent | Telling people |
| Messaging & Support | Conversation, Message, SupportTicket | Talking |
| Trust | Rating, Dispute, DisputeEvidence | Feedback and conflict |
| Audit | AuditLog | Who did what |
| Admin | StaffRole assignments, SystemConfig | Operating the platform |

Modules communicate through exported service interfaces and domain events written to the outbox. No module reads another module's tables directly through Prisma outside its own repository layer.

## 2. Core entities (conceptual)

```
User 1─0..1 DriverProfile 1─* DriverLicense
User 1─0..1 OwnerProfile  1─* Vehicle 1─* Listing 1─* Application
User 1─* IdentityVerification
Application 1─0..1 Agreement 1─* AgreementVersion 1─* AgreementAcceptance
Agreement 1─0..1 Assignment 1─* Handover
Assignment 1─* Charge 1─* Payment
JournalEntry 1─* JournalLine *─1 LedgerAccount
OwnerProfile/DriverProfile 1─* PayoutMethod; LedgerAccount(owner payable) ─ Payout
Document (*) referenced by DriverLicense, OwnerProfile, Vehicle, Handover, DisputeEvidence
```

Entities deliberately **not** created: separate `VehicleAvailability` table (availability is a computed property of vehicle status + listing + assignments; listing windows cover owner-specified availability), separate `Review` table (review text is a nullable column on `Rating`), `Transaction` as a separate concept from `JournalEntry` (a journal entry *is* the transaction).

## 3. State machines

All transitions run in a service method that (1) loads the row `FOR UPDATE`, (2) checks the transition table, (3) checks actor permission and business rule guards, (4) writes the new state with optimistic `version` increment, (5) writes an audit row and outbox event in the same DB transaction. Transition tables are plain data in code and unit-tested exhaustively.

### 3.1 User account status
```
PENDING_PHONE ─otp verified─▶ ACTIVE ─staff─▶ SUSPENDED ─staff─▶ ACTIVE
ACTIVE ─too many failed logins─▶ LOCKED ─timeout / reset─▶ ACTIVE
ACTIVE|SUSPENDED ─user request + checks─▶ CLOSED (terminal; PII scheduled for minimization)
```

### 3.2 Identity verification (per brief)
```
UNVERIFIED ─start─▶ PENDING ─provider success─▶ VERIFIED
PENDING ─provider failure / mismatch─▶ REJECTED ─retry─▶ PENDING
PENDING ─session timeout (15 min)─▶ UNVERIFIED (session marked EXPIRED)
VERIFIED ─validity period ends─▶ EXPIRED ─start─▶ PENDING
VERIFIED ─staff / risk signal─▶ REVERIFICATION_REQUIRED ─start─▶ PENDING
any non-terminal ─staff─▶ SUSPENDED ─staff─▶ previous state or REVERIFICATION_REQUIRED
```
The user's *current* identity status is a column on `users` derived from the latest verification; each attempt is a separate `identity_verifications` row.

### 3.3 Review workflow (driver licence/documents, vehicle)
Shared generic machine, per brief:
```
DRAFT ─owner/driver submit─▶ SUBMITTED ─officer claims─▶ UNDER_REVIEW
UNDER_REVIEW ─approve─▶ APPROVED      UNDER_REVIEW ─reject(reason)─▶ REJECTED ─edit─▶ DRAFT
APPROVED ─required doc expires (job)─▶ EXPIRED ─resubmit─▶ SUBMITTED
APPROVED ─staff─▶ SUSPENDED ─staff─▶ APPROVED
Vehicle only: any non-active ─owner─▶ ARCHIVED (blocked while assigned)
```
Editing material fields (plate, VIN, ownership doc) of an `APPROVED` vehicle forces it back to `SUBMITTED`.

### 3.4 Owner verification
`UNVERIFIED → PENDING → VERIFIED | REJECTED`, plus `SUSPENDED`, `EXPIRED`, `REVERIFICATION_REQUIRED`. Requires identity `VERIFIED`; organization owners additionally need approved TIN/business licence documents.

### 3.5 Driver eligibility (derived, not user-settable)
`eligible = account ACTIVE ∧ identity VERIFIED ∧ ≥1 licence APPROVED and not expired with a category matching the vehicle type ∧ required driver documents APPROVED ∧ driver profile not SUSPENDED`.
Stored as a cached column `eligibility_status` (`INELIGIBLE | ELIGIBLE | SUSPENDED`) recomputed on every relevant event and by a nightly job; marketplace and application code always re-evaluate inside the transaction rather than trusting the cache.

### 3.6 Listing
```
DRAFT ─publish (vehicle eligible)─▶ PUBLISHED ─owner─▶ PAUSED ─owner─▶ PUBLISHED
PUBLISHED ─application accepted─▶ RESERVED ─agreement activated─▶ ASSIGNED
RESERVED ─agreement rejected/expired─▶ PUBLISHED
ASSIGNED ─assignment ended─▶ PUBLISHED or CLOSED (owner choice)
any ─vehicle ineligible (job/event)─▶ SUSPENDED ─vehicle eligible again─▶ PAUSED
any non-ASSIGNED ─owner─▶ CLOSED
```

### 3.7 Application (per brief)
```
PENDING ─owner accept─▶ ACCEPTED ─agreement generated─▶ AGREEMENT_REQUIRED
AGREEMENT_REQUIRED ─agreement activated─▶ ACTIVE ─assignment completed─▶ COMPLETED
PENDING ─owner reject / listing filled─▶ REJECTED
PENDING|ACCEPTED|AGREEMENT_REQUIRED ─driver cancel─▶ CANCELLED
PENDING ─72h no response (job)─▶ EXPIRED
AGREEMENT_REQUIRED ─agreement not accepted in 48h─▶ EXPIRED
ACTIVE ─dispute opened─▶ DISPUTED ─dispute closed─▶ previous
```
`ACCEPTED` exists only inside the accept transaction in practice; it is kept because the brief requires it and it gives a clear audit trail.

### 3.8 Agreement (per brief)
```
DRAFT ─system finalizes v1─▶ PENDING_ACCEPTANCE
PENDING_ACCEPTANCE ─both parties accept same version─▶ ACCEPTED
PENDING_ACCEPTANCE ─either party proposes change─▶ new version, acceptances reset
ACCEPTED ─start date reached + handover─▶ ACTIVE
ACTIVE ─end date─▶ EXPIRED
ACCEPTED|ACTIVE ─party/staff terminate(reason)─▶ TERMINATED
ACTIVE ─dispute─▶ DISPUTED ─resolved─▶ ACTIVE|TERMINATED
```
Accepted versions are immutable (DB trigger rejects UPDATE on accepted `agreement_versions`).

### 3.9 Assignment
`SCHEDULED → ACTIVE → ENDING (return initiated) → COMPLETED`, `SCHEDULED → CANCELLED`, `ACTIVE → TERMINATED`, `ACTIVE ↔ DISPUTED`.

### 3.10 Activity records
**[ASSUMPTION]** The platform does not dispatch trips. "Trip/activity" in the brief is modelled as:
- `Handover` (CHECK_OUT to driver / CHECK_IN to owner): odometer, fuel level, photos, notes, optional single GPS fix, both-party confirmation.
- `ActivityReport` (optional, driver-reported per period: km, hours, income) used for owner insight and future revenue-share. States `STARTED → COMPLETED | CANCELLED | DISPUTED` are supported on reports if the business later needs per-trip records.
No continuous location tracking (privacy, battery, data cost). Revisit only with a concrete product need and [LEGAL] review.

### 3.11 Charge, payment, payout
- Charge: `SCHEDULED → DUE → PAID | OVERDUE → PAID | WAIVED | WRITTEN_OFF`.
- Payment (per brief): `PENDING → PROCESSING → SUCCEEDED | FAILED | CANCELLED | EXPIRED`; `SUCCEEDED → REVERSED`.
- Payout (per brief): `PENDING → PROCESSING → COMPLETED | FAILED`; `PENDING|FAILED ↔ HELD`; `FAILED → PENDING (retry, new attempt)`; `COMPLETED → REVERSED`.

### 3.12 Dispute, support ticket
- Dispute: `OPEN → UNDER_REVIEW → WAITING_FOR_INFORMATION ↔ UNDER_REVIEW → RESOLVED | REJECTED | ESCALATED → … → CLOSED`.
- Ticket: `OPEN → IN_PROGRESS ↔ WAITING_FOR_USER → RESOLVED → CLOSED` (auto-close 7 days after RESOLVED).

## 4. Business rules

Numbered so tests can reference them.

**Accounts**
- BR-ACC-1 One account per normalized phone number. Email optional, unique if present.
- BR-ACC-2 Staff accounts cannot create driver/owner profiles; customer accounts cannot hold staff roles.
- BR-ACC-3 Suspended or locked accounts cannot perform state-changing actions except support tickets and dispute replies.

**Identity**
- BR-ID-1 Identity status can only be changed by the identity service on provider results or by an officer action with reason. No API accepts a client-supplied status.
- BR-ID-2 One national identity (hashed subject identifier) can be linked to only one active account. A second account presenting the same identity is rejected and flagged.
- BR-ID-3 Verified identity validity period is configurable (default 24 months) [ASSUMPTION].

**Drivers**
- BR-DRV-1 Only eligible drivers can see listing details pages with apply actions, apply, accept agreements, or start assignments. Browsing summaries is allowed for verified-identity drivers so they can see what exists [ASSUMPTION].
- BR-DRV-2 A driver may hold at most one ACTIVE or SCHEDULED assignment at a time [ASSUMPTION].
- BR-DRV-3 A driver may have at most 5 PENDING applications at once (anti-spam, configurable).
- BR-DRV-4 Licence expiry within 30 days triggers warnings; expiry makes the driver INELIGIBLE and flags any active assignment to support (assignment is not auto-terminated; humans decide) [ASSUMPTION].

**Owners & vehicles**
- BR-VEH-1 Only VERIFIED owners can submit vehicles for review.
- BR-VEH-2 Plate number (normalized) and VIN are unique among non-archived vehicles.
- BR-VEH-3 A vehicle is marketplace-eligible only if: vehicle APPROVED, all required documents APPROVED and unexpired, owner VERIFIED and not suspended, owner account ACTIVE.
- BR-VEH-4 The owner cannot approve their own vehicle (enforced structurally: approval requires `vehicle.verify`, which only staff have).

**Marketplace & applications**
- BR-APP-1 Applications only for PUBLISHED listings.
- BR-APP-2 One non-terminal application per (driver, listing). Retries with the same idempotency key return the original.
- BR-APP-3 A user cannot apply to a listing whose vehicle they own.
- BR-APP-4 Accepting an application locks the listing row; only one application per listing may be in ACCEPTED/AGREEMENT_REQUIRED/ACTIVE (partial unique index). Remaining PENDING applications are rejected with `LISTING_FILLED` in the same transaction.
- BR-APP-5 Eligibility of driver and vehicle is re-checked inside the accept transaction.

**Agreements & assignments**
- BR-AGR-1 Agreement terms are copied from the listing and the commission rule *effective at generation time*; later listing/commission changes do not affect it.
- BR-AGR-2 Acceptance is bound to a version hash (SHA-256 of canonical terms JSON). Accepting a stale version fails with 409.
- BR-AGR-3 A vehicle cannot have overlapping SCHEDULED/ACTIVE/ENDING assignments (Postgres exclusion constraint on `tstzrange`).
- BR-AGR-4 Assignment start requires agreement ACCEPTED, driver eligible, vehicle eligible at that moment.
- BR-AGR-5 Termination requires a reason code; financial consequences (pro-rata rent, deposit) are posted as ledger entries, never by editing charges.

**Money**
- BR-FIN-1 All amounts are `BIGINT` santim (1 ETB = 100 santim) with a `currency` column; only `ETB` enabled.
- BR-FIN-2 Every journal entry balances: Σ debits = Σ credits per currency (DB-enforced via deferred constraint trigger).
- BR-FIN-3 Journal entries and lines are never updated or deleted (trigger). Corrections are reversal entries referencing the original.
- BR-FIN-4 Commission comes from a versioned `commission_rules` row referenced by the agreement. Rounding: commission rounded half-up to the santim; the owner share is `gross − commission − fees` so the remainder never disappears.
- BR-FIN-5 Only provider-confirmed (webhook or server-side status query) payments post to the ledger.
- BR-FIN-6 Payout amount ≤ available balance of the payee's payable account at the moment of creation (row lock on account), and the amount is moved to an "in-transit" account when the payout is created.
- BR-FIN-7 Minimum payout amount and payout schedule are configurable (default weekly, min 100 ETB) [ASSUMPTION].

**Trust**
- BR-RAT-1 One rating per (assignment, rater). Only parties of a COMPLETED or TERMINATED assignment, within 14 days.
- BR-DSP-1 Disputes can only reference resources where the initiator is a party.
- BR-DSP-2 An open dispute on an assignment puts pending payouts derived from it on HOLD [ASSUMPTION].
- BR-MSG-1 A conversation exists only for an application, agreement, ticket or dispute; participants are fixed by that relationship.
