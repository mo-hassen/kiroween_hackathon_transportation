# 01 — Product Requirements, Actors, Permissions, Journeys

## 1. Product requirements

### Problem
In Addis Ababa many vehicle owners (individuals, families, small fleet companies) want their vehicle used commercially but lack a trusted driver. Many licensed drivers lack a vehicle. Today these arrangements happen informally, with no identity assurance, no written terms, no payment record and no recourse when something goes wrong.

### Product goal
A mobile platform where a **verified owner** lists a **verified vehicle**, a **verified, eligible driver** applies for it, both parties accept a **versioned agreement**, the platform records the **assignment**, collects or records **payments**, splits them through an **auditable ledger**, pays out, and provides **disputes and support**.

### Functional requirements (MVP = phases 2–14)

| ID | Requirement |
|---|---|
| FR-1 | Users register with an Ethiopian mobile number (+251 9x / 7x) and password; phone ownership is proven by OTP. |
| FR-2 | Users verify identity through an identity provider (Fayda via eSignet in production). Identity status is separate from login. |
| FR-3 | Drivers submit driving-licence details and required documents; verification officers approve or reject. |
| FR-4 | Owners (individual or organization) complete owner verification. |
| FR-5 | Verified owners register vehicles with registration, ownership, insurance documents and photos; officers verify. |
| FR-6 | Owners publish verified vehicles with terms (rent amount, period, deposit, allowed use, sub-city). |
| FR-7 | Eligible drivers browse, filter and view listings with pagination. |
| FR-8 | Drivers apply for a listing; owners accept or reject. Only one application per listing can be accepted at a time. |
| FR-9 | Acceptance generates an agreement from the listing terms and current commission rule; both parties accept the exact version. |
| FR-10 | Agreement activation creates the vehicle assignment; a vehicle can never have two overlapping active assignments. |
| FR-11 | Handover check-in/check-out records (odometer, photos, condition notes). |
| FR-12 | Rent charges are generated per period, paid through a payment provider, and recorded in a double-entry ledger with commission. |
| FR-13 | Owners and drivers see balances, statements and payout history; payouts run through a payout provider. |
| FR-14 | In-app notifications for every state change relevant to a user; push where available. |
| FR-15 | Disputes linked to an agreement/assignment/transaction, with evidence and staff resolution. |
| FR-16 | Support tickets; chat only between parties with an existing application or agreement. |
| FR-17 | Ratings after a completed assignment, one per party per assignment. |
| FR-18 | Staff console for verification, operations, finance and audit, with least-privilege roles. |

### Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Every authorization decision is made on the backend. |
| NFR-2 | Money stored as integer minor units with explicit currency. Ledger is append-only. |
| NFR-3 | All mutating endpoints that a mobile client may retry accept an `Idempotency-Key`. |
| NFR-4 | API p95 < 300 ms for reads at pilot scale; list responses paginated and compact (< 50 KB typical). |
| NFR-5 | Mobile app usable on Android 8+ with 2 GB RAM, on 3G-class links, with offline read-only views of the user's own data. |
| NFR-6 | English and Amharic UI; no hard-coded user-facing strings. |
| NFR-7 | No raw biometrics stored; identity data minimized and access-logged. |
| NFR-8 | Audit trail for every security-, verification- and finance-relevant action. |
| NFR-9 | RPO ≤ 15 minutes, RTO ≤ 4 hours for production (see 11). |

### Out of scope for MVP
Ride-hailing dispatch, passenger app, live vehicle tracking, in-app maps navigation, insurance underwriting, credit/financing, iOS-specific features (the Flutter app will build for iOS but Android is the release target).

## 2. System context

```
                         ┌───────────────────────────┐
  Driver / Owner ───────▶│ Flutter mobile app (APK)  │
  (Android-first)        └────────────┬──────────────┘
                                      │ HTTPS, JWT
  Staff ──▶ Admin web app (Flutter web, MFA) ──┐
                                      ▼        ▼
                         ┌───────────────────────────┐
                         │  API (NestJS, /api/v1)    │──▶ Redis (rate limits, cache)
                         │  Worker (same codebase)   │──▶ PostgreSQL (system of record)
                         └──┬──────┬──────┬──────┬───┘──▶ S3-compatible object storage (private)
                            │      │      │      │
              ┌─────────────┘      │      │      └──────────────┐
              ▼                    ▼      ▼                     ▼
  Identity provider       Payment / payout      SMS provider          Push (FCM)
  [EXTERNAL] Fayda via    provider [EXTERNAL]   [EXTERNAL]            [EXTERNAL]
  eSignet OIDC            e.g. Telebirr, Chapa,
                          bank — not chosen
```

Every external box sits behind an interface in the backend with a development adapter (see 05, 08, 09, 10).

## 3. Actors

| Actor | Description | Account type |
|---|---|---|
| Visitor | Not logged in. Can register, log in, read public info pages. | none |
| Customer (base) | Logged-in user with verified phone. Can manage own account, start identity verification. | customer |
| Driver | Customer with a `DriverProfile`. | customer |
| Owner | Customer with an `OwnerProfile` (type `INDIVIDUAL` or `ORGANIZATION`). | customer |
| Support agent (`SUPPORT`) | Handles tickets, disputes (non-financial), can view case-relevant records. | staff |
| Verification officer (`VERIFICATION_OFFICER`) | Reviews identity fallbacks, driver, owner and vehicle documents. | staff |
| Finance officer (`FINANCE`) | Views ledger, payments, payouts; holds/releases/retries payouts; posts approved adjustments. | staff |
| Super administrator (`SUPER_ADMIN`) | Manages staff accounts, roles, commission rules, system config. Cannot approve own actions where four-eyes applies. | staff |
| System | Worker jobs, webhooks, schedulers. Acts under a named system principal in audit logs. | system |

**[ASSUMPTION] Dual roles.** A customer may be both driver and owner. Rule BR-APP-3 forbids applying to one's own listing. Staff accounts are separate identities and cannot hold customer profiles, which prevents an officer from verifying themselves.

## 4. Permission matrix

Legend: **O** = own resources only, **P** = resources where the user is a party (agreement/assignment/conversation), **A** = all, **—** = denied. Staff access to sensitive data (identity details, documents) is logged with a reason.

| Capability | Driver | Owner | Support | Verif. officer | Finance | Super admin |
|---|---|---|---|---|---|---|
| View/edit own account, sessions, devices | O | O | O | O | O | O |
| Start identity verification | O | O | — | — | — | — |
| View identity verification status | O | O | A (status only) | A | — | A (status only) |
| View identity verified claims (name, DOB) | O | O | — | A (logged) | — | — |
| Submit driver docs / licence | O | — | — | — | — | — |
| Submit owner docs | — | O | — | — | — | — |
| Create/edit vehicle (draft) | — | O | — | — | — | — |
| View vehicle documents | — | O | A (case-linked, logged) | A (logged) | — | — |
| Approve/reject identity fallback, driver, owner, vehicle | — | — | — | A (never own; staff have no customer profile) | — | — |
| Suspend/reinstate user or vehicle | — | — | A (with reason) | A (verification-related) | — | A |
| Publish/pause listing | — | O | — | — | — | — |
| Browse marketplace | eligible only | — | A | A | — | A |
| Apply for listing | eligible only | — | — | — | — | — |
| Accept/reject application | — | O (own listing) | — | — | — | — |
| View application | O | O (own listing) | A | — | — | A |
| View driver profile summary | O | applicants to own listing (limited fields) | A | A | — | A |
| Accept agreement | P | P | — | — | — | — |
| Terminate agreement | P (per rules) | P (per rules) | A (with reason) | — | — | A |
| Record handover check-in/out | P | P | — | — | — | — |
| Pay a charge | P (driver) | — | — | — | — | — |
| View own balances/statements | O | O | — | — | A | — |
| View ledger, payments, payouts (all) | — | — | — | — | A | read |
| Hold/release/retry payout | — | — | — | — | A | — |
| Post ledger adjustment | — | — | — | — | propose | approve (four-eyes) |
| Manage commission rules | — | — | — | — | propose | approve (four-eyes) |
| Create dispute | P | P | on behalf | — | — | — |
| Resolve dispute (non-financial) | — | — | A | — | — | A |
| Resolve dispute with money movement | — | — | propose | — | approve + post | — |
| Support tickets | O | O | A | — | — | A |
| Chat | P | P | joins on ticket/dispute | — | — | — |
| Rate counterparty | P (completed assignment) | P (completed assignment) | — | — | — | — |
| View audit log | — | — | case-scoped | own decisions | finance-scoped | A |
| Manage staff accounts and roles | — | — | — | — | — | A |

Permissions are implemented as named permission strings (e.g. `vehicle.verify`, `payout.hold`) mapped to roles in code, checked by a guard, plus resource-level policy functions for O/P checks (see 07).

## 5. User journeys

### J1 Registration and login
1. Enter phone (`09…`, `07…` or `+2519…`), normalized to E.164 `+2519XXXXXXXX`.
2. Backend sends OTP via `SmsProvider` (dev adapter logs a masked hint only; the code is available through a dev-only endpoint disabled in production).
3. Verify OTP, set password (min 10 chars, checked against a breached-password list stored locally).
4. Receive access token (15 min) + refresh token (rotating, 30 days).
5. Choose "I want to drive", "I own a vehicle", or both.

### J2 Identity verification
1. Intro and consent screen (what is shared, why, retention).
2. App calls `POST /identity/verifications` → backend returns an authorization URL (with state, nonce, PKCE, all stored server-side).
3. App opens it in the system browser / Custom Tab (not a WebView). User authenticates on Fayda/eSignet screens.
4. eSignet redirects to the backend callback (HTTPS App Link). Backend exchanges the code server-side, validates tokens, fetches consented claims, stores the minimal result, and redirects to the app deep link with only the verification ID.
5. App polls `GET /identity/verifications/{id}` → `VERIFIED` / `REJECTED`.

### J3 Driver onboarding
Identity verified → enter licence number, category, issue/expiry → upload licence front/back → submit → officer reviews → `APPROVED` → driver becomes `ELIGIBLE`. Rejection returns a reason code and free-text note; driver resubmits.

### J4 Owner onboarding and vehicle registration
Identity verified → owner profile (individual, or organization with TIN and business licence documents) → officer approves owner → add vehicle draft (make, model, year, type, plate, colour, seats) → upload registration ("libre"), proof of ownership, insurance, annual inspection, photos → submit → officer verifies → `APPROVED`.

### J5 Listing and marketplace
Owner creates a listing for an approved vehicle (rent amount and period, deposit, minimum term, pickup sub-city and landmark, allowed use). Eligible drivers browse with filters (vehicle type, sub-city, price range, transmission, fuel) and sort (newest, price).

### J6 Application to assignment
Driver applies (optional message) → owner sees applicant summary (first name, rating, licence category, years licensed, completed assignments; never national ID data) → owner accepts one application → listing becomes `RESERVED`, other pending applications become `REJECTED` with reason `LISTING_FILLED` → agreement generated → both accept → at start time (or on owner-recorded handover) assignment becomes `ACTIVE`, vehicle `ASSIGNED`.

### J7 Operation and payment
Each period the system creates a rent charge → driver pays through the payment provider (or, [ASSUMPTION], the owner records a cash payment which the driver confirms, flagged as off-platform and not settled through the platform ledger) → provider webhook confirms → ledger posts the split → owner balance grows → payout schedule pays the owner.

### J8 End of assignment
Owner or driver initiates return → check-out handover with odometer and photos → both confirm → assignment `COMPLETED`, vehicle back to `AVAILABLE` → deposit release or claim → ratings unlocked.

### J9 Dispute
Either party opens a dispute on an agreement, assignment, charge or payout, attaches evidence → support triages → may request info → resolution; any money movement is posted by finance as compensating ledger entries.

### J10 Staff
Officer logs in to admin web (password + TOTP) → queue of pending reviews ordered by age → opens a case (document viewed through short-lived URLs, access logged) → approve/reject with reason → audit entry.
