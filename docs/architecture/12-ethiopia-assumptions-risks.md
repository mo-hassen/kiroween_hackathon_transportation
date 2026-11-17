# 12 — Ethiopian Context, Assumptions and Risks

## 1. Local design decisions

| Topic | Decision |
|---|---|
| Phone numbers | Accept `09XXXXXXXX`, `07XXXXXXXX`, `9XXXXXXXX`, `+2519…`, `+2517…`, `002519…`; normalize to E.164. `9` prefix = Ethio Telecom, `7` prefix = Safaricom Ethiopia [ASSUMPTION — validate against current numbering plan]. Validation is a single shared rule implemented and tested identically in TS and Dart. |
| Currency | ETB only, santim minor unit, display "ብር 1,500.00" (am) / "ETB 1,500.00" (en). |
| Time | `Africa/Addis_Ababa` (UTC+3). Optional Ethiopian calendar display; storage always Gregorian UTC. Note: local "Ethiopian time" (hours counted from 6 am) is common in speech; UI uses 24h/12h standard time with an optional hint [ASSUMPTION]. |
| Addresses | Sub-city (picker) + woreda (optional) + landmark text. No reliance on street addresses or postcodes. |
| Maps | Optional, never blocking. Coordinates for listings rounded to ~100 m (3 decimals) to avoid revealing an owner's home. |
| Language | English + Amharic at launch; architecture allows Afaan Oromo / Tigrinya later via ARB files. Amharic strings require native-speaker review. |
| Connectivity | Compact JSON, pagination, image compression before upload, resumable-friendly direct-to-storage uploads, offline read-only cache, no auto-retry of money operations. |
| Devices | Android-first, low-RAM targets, APK size budget < 30 MB (split per ABI). |
| Identity | Fayda via eSignet OIDC, backend only (08). |
| Payments | Mobile money dominates; provider abstraction designed for redirect and USSD-push style flows (09). Cash is common — see risk F-3. |

## 2. Assumptions (change any of these)

1. Commercial model is fixed periodic rent with commission on the owner side (09 §1).
2. No continuous GPS tracking; handover records only.
3. One customer account can be both driver and owner.
4. Phone + password login; Fayda used for verification, not login.
5. Weekly owner payouts, 100 ETB minimum, 24 h cooling-off on payout-method change.
6. Platform bears provider fees in MVP.
7. Application expires after 72 h without owner response; agreement after 48 h without acceptance.
8. A driver can hold one active assignment at a time.
9. Identity verification valid 24 months; documents valid until their stated expiry.
10. Pilot scale as in 11 §1.
11. Ratings revealed after both parties rate or the window closes.
12. Phone numbers hidden between parties until agreement acceptance.

## 3. Legal / regulatory review items [LEGAL]

Nothing below is a legal claim; each needs an Ethiopian lawyer or the named authority.

| # | Question | Why it matters |
|---|---|---|
| L-1 | Can a private company onboard as a Fayda/eSignet relying party; process, fees, permitted purposes, available claims? (NIDP) | Blocks production identity verification |
| L-2 | Personal Data Protection Proclamation No. 1321/2024: lawful basis, consent wording, data residency, retention, breach notification, data-subject rights, registration with the authority | Schema retention, hosting location, consent screen |
| L-3 | Does collecting rent and paying owners require an NBE payment licence, or must a licensed provider's escrow/split product be used? | Determines whether the platform ledger holds funds or mirrors provider splits |
| L-4 | Commercial vehicle use: which licence categories may drive which vehicle types commercially; whether privately registered vehicles may be rented for commercial driving; code/plate rules for commercial vehicles; Addis Ababa Transport Bureau requirements | Driver eligibility rules, vehicle eligibility checklist |
| L-5 | Insurance: is third-party insurance sufficient for commercial use by a non-owner driver; who must hold the policy | Vehicle document checklist |
| L-6 | Enforceability of click-through agreements and electronic acceptance (Electronic Transaction Proclamation No. 1205/2020 — confirm applicability) | Agreement acceptance records |
| L-7 | Tax: VAT/TOT on platform commission, withholding obligations on owner payouts, TIN requirements for owners | Ledger accounts for tax, payout deductions |
| L-8 | Retention period for financial and audit records | Purge jobs |
| L-9 | Manual ID document + selfie fallback: permissible? retention? | Fallback flag in 08 §6 |
| L-10 | Liability allocation in accidents, traffic fines and vehicle damage between owner, driver and platform | Agreement template, dispute resolution codes |

## 4. Risks

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| E-1 | Fayda relying-party onboarding unavailable or slow | High | Blocks production launch | Abstraction + dev adapter; begin NIDP engagement now; designed manual fallback pending L-9 |
| E-2 | No payment provider sandbox/contract in time | High | No in-app payment | Sandbox adapter for development; launch option: off-platform payment recorded but not settled (clearly labelled) |
| F-1 | Holding funds without licence (L-3) | Medium | Regulatory | Decide model before Phase 13; support provider-split mode |
| F-2 | Ledger bugs | Medium | Financial loss, trust | Append-only, DB-enforced balance, property tests, nightly invariant checks, four-eyes |
| F-3 | Cash rent bypasses platform | High | Lost commission, weaker records | Value to owners (records, disputes, verified drivers); recorded-cash option; analytics on off-platform rate |
| S-1 | Document fraud (forged libre, licences) | Medium | Unsafe drivers, theft | Officer training, reason codes, duplicate detection (licence HMAC, plate uniqueness), future registry integration |
| S-2 | Vehicle theft by a "verified" driver | Low–Medium | Severe | Identity binding (BR-ID-2), deposits, handover photos, owner-side tracker optional, police reporting process (operational) |
| S-3 | Account takeover via SIM swap | Medium | Payout redirect | Payout-method cooling-off, SMS alert, new-device step-up, session list |
| T-1 | Poor connectivity during handover/payment | High | User frustration | Offline-tolerant handover draft, idempotency, status polling |
| T-2 | Amharic text quality | Medium | Usability | Native speaker review; no machine-only translations shipped |
| T-3 | Scope size (25 phases) | High | Delays | Strict phase gates; MVP cut after Phase 14 |
| O-1 | Verification queue backlog | Medium | Slow onboarding | Queue metrics, SLA alerts, checklist UI for officers |
