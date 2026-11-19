# 08 — Identity & Verification Architecture

## 1. What is known from official sources

Checked 2026-11-17:

- **id.gov.et** (National ID Program): Fayda is a 12-digit unique number, established under Proclamation 1284/2023, offering "real-time biometric authentication and eKYC". The public page does not publish a developer API.
- **docs.esignet.io** (MOSIP eSignet, the open-source OIDC provider used with MOSIP-based ID systems): relying parties integrate with standard **OpenID Connect authorization code flow**; prerequisites are a registered `client_id`, a backend-held private key for **`private_key_jwt`** client authentication, a registered redirect URI, and agreed scopes/claims. Token exchange must happen on the backend; tokens should stay on the server. Optional PAR and DPoP. Discovery via `/.well-known/openid-configuration` and `jwks.json`.

**Not verified / not assumed:** that NIDP exposes eSignet to private companies like this one, the onboarding process and fees, the production/sandbox base URLs, the exact claims available (e.g. whether a `individual_id` / FAN / FIN claim is returned), assurance levels, and whether eKYC use for this purpose is permitted. These are **[EXTERNAL]** and **[LEGAL]** items. No Fayda-specific endpoint is hard-coded; the adapter reads everything from the provider's discovery document.

## 2. Separation from authentication

Login (phone + password) answers "is this the same account holder as before?". Identity verification answers "who is this person in the national registry?". They are separate modules and tables. An account can be logged in and `UNVERIFIED`. We do **not** use Fayda as the login method initially [ASSUMPTION]; it is used once (and on re-verification) to bind a verified identity to the account.

## 3. Provider abstraction

```ts
interface IdentityProvider {
  readonly id: 'FAYDA_ESIGNET' | 'DEV';
  createAuthorizationRequest(input: { verificationId: string; redirectUri: string; locale: 'en'|'am' })
    : Promise<{ authorizationUrl: string; state: string; nonce: string; codeVerifier: string; expiresAt: Date }>;
  completeAuthorization(input: { code: string; state: string; nonce: string; codeVerifier: string; redirectUri: string })
    : Promise<VerifiedIdentityResult>;   // throws typed IdentityProviderError
}
type VerifiedIdentityResult = {
  subject: string;                 // provider's stable subject, hashed before storage
  fullName?: string; dateOfBirth?: string; gender?: string;
  assuranceLevel?: string;         // e.g. acr value returned
  rawClaimNames: string[];         // names only, for audit; values not retained beyond mapped fields
};
```

### eSignet adapter [ABSTRACTION → EXTERNAL]
- Loads discovery doc and JWKS from `IDENTITY_ESIGNET_ISSUER` (cached, refreshed on `kid` miss).
- Authorization request: `response_type=code`, `scope=openid` + configured claim scopes, `state` (256-bit), `nonce`, PKCE S256, `acr_values` from config, `ui_locales`.
- Token request with `client_assertion` signed by the backend private key (`private_key_jwt`); key loaded from secret manager, never in the repo or app.
- Validates ID token: signature (JWKS), `iss`, `aud`, `exp`, `iat` skew, `nonce`, `acr` against minimum.
- Calls userinfo only for consented claims; handles signed/encrypted userinfo if the provider returns JWT/JWE (driven by discovery metadata).
- Implemented and tested against **eSignet's own mock identity system** (documented local setup) in a later phase; this proves protocol correctness, not Fayda onboarding.

### Dev adapter [IMPL, dev/test only]
- Serves a local consent page on the API (`/dev/identity/authorize`) with "approve"/"reject"/"mismatch" buttons and returns synthetic claims. Uses the same state/nonce/PKCE path so the callback code is exercised. Config validation refuses `DEV` when `NODE_ENV=production`; staging builds show a "TEST IDENTITY" banner.

## 4. Verification session flow

```
App              API                           Identity provider
 │ POST /identity/verifications (consent=true)
 │──────────────▶ create row PENDING, state/nonce/PKCE stored hashed/encrypted, 15-min expiry
 │◀────────────── { verificationId, authorizationUrl }
 │ open Custom Tab ────────────────────────────▶ user authenticates, consents
 │                │◀──── 302 /identity/callback/fayda?code&state
 │                │ lookup by HMAC(state); reject if unknown, expired, already used
 │                │ token exchange (private_key_jwt) ─────▶
 │                │ validate ID token + nonce; userinfo ───▶
 │                │ map minimal claims; HMAC(subject); uniqueness check (BR-ID-2)
 │                │ status VERIFIED|REJECTED; users.identity_status; audit; outbox event
 │◀── 302 app link /identity/return?verification=<id>  (no code, no token, no claims)
 │ GET /identity/verifications/{id} → status
```

**Phase 4 change (same-device confirmation).** The callback does not link the identity by itself. It stores the validated result encrypted and redirects to the app link with `?verification=<id>&confirmation=<one-time token>`; the app then calls `POST /identity/verifications/{id}/confirm` from the session that started the attempt (10-minute window). A provider link forwarded to another person therefore cannot bind that person's identity to the sender's account (cross-device consent phishing). Details and residual risk: `docs/reports/phase-04.md` §12.

Replay protection: state is single-use (`callback_received_at` set in the same transaction with `WHERE callback_received_at IS NULL`); authorization codes are one-time at the provider; nonce binds the ID token to the session. Callbacks after expiry → `EXPIRED` session.

Name matching: verified full name is compared (normalized, Amharic/Latin transliteration-tolerant) against the name later found on the driving licence by the officer, not automatically [ASSUMPTION].

## 5. Data minimization

Stored: provider id, HMAC of subject (for duplicate-identity detection), verified full name (encrypted), DOB, gender (only if needed for licence matching — [ASSUMPTION] may drop), assurance level, timestamps, claims hash.
Not stored: photos, biometrics, raw national ID number, address, phone from provider, ID/access tokens (discarded after use).
The mobile app receives only status, verification date, expiry and the user's own display name.

## 6. Fallback

If a user has no Fayda or the provider is unavailable, a **manual review path** (upload of an approved ID document + selfie reviewed by an officer) is designed in the same state machine (`provider = 'MANUAL'`) but **disabled by feature flag** pending [LEGAL] review of collecting ID images. While disabled, users see "Identity verification is temporarily unavailable" and cannot obtain vehicles.

## 7. Driver, owner and vehicle verification

All three use the shared review workflow (02 §3.3) plus a verification queue:

- Submission bundles required documents per type (configurable checklist in `system_config`):
  - Driver: licence front/back, licence number, categories, issue/expiry dates.
  - Owner (individual): identity VERIFIED only. Owner (organization): TIN, business licence, authorized-representative letter.
  - Vehicle: registration document (libre), proof that the owner matches registration (or authorization letter if not), insurance certificate with expiry, annual inspection certificate with expiry, ≥ 4 photos (front, back, sides, interior optional), plate photo.
- Officers claim a case (prevents two officers on one case), view documents through 60-second URLs, compare against entered data, and record a decision with reason codes (`BLURRY`, `MISMATCH_NAME`, `EXPIRED`, `NOT_OWNER`, `SUSPECTED_FRAUD`, `OTHER`).
- **No automated government lookup** of licences or vehicle registration is assumed. Federal Transport Authority / Addis Ababa Road & Transport Bureau verification APIs are not known to exist publicly → manual review, with a `LicenseVerificationProvider` / `VehicleRegistryProvider` interface reserved for future official integration [EXTERNAL].
- Expiry job (daily, 02:00 Addis time): documents past `expires_on` → `EXPIRED`; recompute driver eligibility and vehicle marketplace eligibility; suspend affected listings; notify 30/7/1 days before.
- **Phase 5 (driver licence) as implemented.** One licence per driver profile; review states `DRAFT, SUBMITTED, UNDER_REVIEW, APPROVED, REJECTED, EXPIRED, SUSPENDED` enforced in code and by a database trigger; 30-minute claims; approval requires three explicit officer checks plus identity VERIFIED, account ACTIVE, licence not expired and both photos AVAILABLE; rejected photos must be replaced; suspension needs a reason code and an internal note. The checklist is fixed in code (no `system_config` yet), expiry runs from `npm run drivers:refresh` (no scheduler deployed) and four-eyes reinstatement is not implemented. Category codes are stored as printed and not validated against an official list [LEGAL]. Details: `docs/reports/phase-05.md`.
- Four-eyes for high-risk decisions (organization owners, re-instating a suspended-for-fraud account) [ASSUMPTION].
