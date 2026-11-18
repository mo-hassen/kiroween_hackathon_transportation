# Phase 4 Report: Identity Verification (Fayda / eSignet boundary)

Date: 2026-11-18
Scope: Phase 4 only (`docs/architecture/13-implementation-plan.md`, row 4). Phase 5 has not started.
Status: **implemented, awaiting human review.** Phase 4 is not approved and has no completion tag.

Labels: **[IMPL]** implemented and tested here. **[ABSTRACTION]** a boundary that is implemented, but whose real counterpart is not connected. **[EXTERNAL]** needs a third party. **[ASSUMPTION]** a decision made without confirmation. **[LEGAL]** needs legal review.

## 1. Executive summary

Customers can verify their identity through a provider boundary. The full flow is implemented and tested with a **development provider** that returns synthetic people: start (with consent), browser authentication with state, nonce and PKCE, callback, server-side code exchange, validation, same-device confirmation, account linking, expiry, cancellation, and verification-officer actions. **[IMPL]**

The **Fayda/eSignet adapter** is a standard OIDC relying-party client built from the OIDC specifications and NIDP's published VeriFayda 2 guide. It is tested only against a simulated OIDC server with signed test tokens. **Real Fayda verification is not operational**: it needs NIDP relying-party onboarding (client id, registered redirect URI, signing key) and legal clearance. **[ABSTRACTION → EXTERNAL][LEGAL]** Deployed environments default to `IDENTITY_PROVIDER=disabled` and answer `503 IDENTITY_UNAVAILABLE`. They refuse to start with the dev adapter.

A security review in this session found a real weakness, **cross-device consent phishing**. Before the fix, a provider link forwarded to another person would have bound that person's identity to the sender's account. It is now mitigated: the callback no longer links an identity by itself (§12). Some residual risk remains and must be accepted or reduced before production.

Tests: **692 automated tests pass** (Phase 3 baseline: 506). Infrastructure: a freshly built API image runs all four migrations and passes the development smoke test. The **Android APK build is BLOCKED** (Gradle download, §19), and the **Android device deep-link test was NOT RUN** (no device connected, §15).

## 2. Scope

| In scope (done) | Out of scope (not done) |
|---|---|
| `IdentityProvider` abstraction, dev adapter, eSignet adapter, disabled adapter | Real NIDP onboarding and production credentials [EXTERNAL] |
| Attempt and account state machines, enforced in code and in database triggers | Manual document-review fallback (`provider = MANUAL`, designed in 08 §6, disabled pending [LEGAL]) |
| Start, callback, same-device confirmation, status, cancel, retry, expiry | Notification delivery (events are queued in the outbox; delivery is Phase 15) |
| Identity linking (BR-ID-2), duplicate flagging, non-enumerating errors | Admin web UI (Phase 5). The officer endpoints are tested through the API |
| Verification-officer view, require re-verification, suspend | Use of the verified name for licence matching (Phase 5) |
| Flutter consent, status, pending, success, rejection, retry and return screens; en/am | Verified https App Link for production (needs a domain) [EXTERNAL] |

## 3. Backend implementation

- **Module `src/modules/identity/`** [IMPL]:
  - `identity-state.ts`: transition tables, outcome codes and the mapping from outcomes to client reasons.
  - `identity-transitions.ts`: the only code that writes identity state.
  - `identity-verification.service.ts`: start, status, cancel.
  - `identity-callback.service.ts`: callback, validation, held result, confirmation, linking.
  - `identity-expiry.service.ts`: lazy and bulk expiry.
  - `identity-admin.service.ts`: officer actions.
  - Controllers and DTOs.
- **Providers `src/providers/identity/`**:
  - `identity-provider.ts`: abstract class, typed errors, PKCE helper and the callback-error mapping.
  - `dev-identity.provider.ts` and `dev-identity.controller.ts`: the dev adapter and its consent page.
  - `esignet-identity.provider.ts`: the OIDC client.
  - `identity-provider.module.ts`: selects the adapter from config and fails closed.
- **CLI** `src/cli/identity-expire.ts` (`npm run identity:expire`): a bulk expiry sweep for a scheduler. [IMPL]. No scheduler is deployed yet.
- **Changed Phase 2/3 files**:
  - `env.schema.ts`, `app-config.ts`: identity configuration and production rules.
  - `problem-details.ts`: 4 new error codes.
  - `secret-hasher.ts`: the `identity` HMAC purpose.
  - `logger.options.ts`: 6 more redacted keys.
  - `app.module.ts`: module wiring.
  - `schema.prisma`.
  - The public-route and authorization-matrix tests.
  - `.env.example`, `docker-compose.yml`, `ci.yml` (identity coverage gate), `package.json` (2 scripts).

  No Phase 2/3 behaviour was changed. The full Phase 3 test suite still passes.

## 4. Identity provider abstraction [IMPL / ABSTRACTION]

The domain depends only on `IdentityProvider`:

| Member | Purpose |
|---|---|
| `code`, `slug`, `available` | Stored provider code; callback path `/identity/callback/<slug>`; fail-closed flag |
| `prepare(signal)` | Load what an attempt needs (eSignet: discovery document) before creating it |
| `authorizationUrl(request)` | Browser URL. State, nonce and PKCE challenge are **generated by the service**, not by the adapter |
| `exchange({code, codeVerifier, redirectUri, signal})` | Server-side code exchange. Returns `ProviderIdentity` (subject, nonce, acr, name, birth date, claim names) |
| `classifyCallbackError(error)` | Maps the provider's `error` value to DECLINED, EXPIRED or FAILED. Unknown values map to FAILED |

Failures are a typed `IdentityProviderError`: `TIMEOUT`, `UNAVAILABLE`, `INVALID_RESPONSE`, `INVALID_GRANT`, `INSUFFICIENT_ASSURANCE` or `MISCONFIGURED`. Its `detail` field is a fixed operator text. It never contains provider messages, codes or tokens. The service bounds every exchange with an abort signal and a timer (`IDENTITY_PROVIDER_TIMEOUT_MS`, default 15 s), so a provider that ignores the abort signal still cannot hang the request. The service also re-validates every adapter result itself: nonce (constant-time), subject format and length, name, birth date (a real date, not in the future) and assurance length. A faulty adapter therefore cannot weaken these checks.

## 5. Development identity provider [IMPL, development/test only]

- It serves a local consent page at `GET /api/v1/dev/identity/authorize` with a red **"TEST IDENTITY PROVIDER. This is not Fayda."** banner.
- The page offers three synthetic people ("Approve as …") and six simulations:
  - decline;
  - provider error;
  - provider session timeout;
  - provider never answers;
  - invalid signature;
  - token for another session (nonce mismatch).
- It behaves like an OIDC provider:
  - it checks `client_id`, `response_type=code` and `S256`;
  - it only redirects to the configured callback, so it is not an open redirector;
  - it issues a one-time code bound to the PKCE challenge and the redirect URI (60 s TTL);
  - it uses eSignet's callback error values.
- The page has its own strict CSP: no scripts, and no `upgrade-insecure-requests`, so it works on `http://10.0.2.2` from the emulator.
- It is mounted only when `IDENTITY_PROVIDER=dev` in a non-deployed environment. The handler re-checks both conditions, and config validation rejects `dev` in staging and production.
- Codes are kept in process memory only.

## 6. Fayda/eSignet adapter and external boundary [ABSTRACTION → EXTERNAL]

Sources:
- OpenID Connect Core 1.0 and Discovery 1.0.
- RFC 7636 (PKCE), RFC 7523 (JWT client authentication) and RFC 9700 (OAuth security BCP).
- The **VeriFayda 2 (eSignet) Relying Party Integration Documentation** on NIDP's Confluence, read 2026-11-17.

No Fayda-specific URL is hard-coded. Every endpoint comes from `<issuer>/.well-known/openid-configuration`.

What the adapter does:
1. **Discovery.** The document is cached for 1 h. Its `issuer` must equal the configured issuer exactly. All endpoints must be https when the issuer is https. If the provider lists `code_challenge_methods_supported`, it must include `S256`.
2. **Authorization request.** It sends `response_type=code`, the configured scopes (must include `openid`), state, nonce, PKCE S256, `ui_locales`, `claims_locales`, optional `acr_values`, and a `claims` parameter that requests the configured claims as essential (default `name`, `birthdate`).
3. **Token request.** It authenticates with `private_key_jwt`: an RS256 client assertion with iss = sub = client_id, aud = token endpoint, a 120 s lifetime and a new `jti` each time. It sends the PKCE verifier. Redirects are refused (`redirect: 'error'`) and responses are capped at 256 KB.
4. **ID token.** It checks the RS256 signature against the provider's JWKS, plus `iss`, `aud`, `exp`/`iat` (60 s clock tolerance) and that `sub`, `iat`, `exp` and `nonce` are present. If `IDENTITY_ESIGNET_ACCEPTED_ACR` is set, `acr` must be one of those values.
5. **User information.** Only a signed JWT (JWS) is accepted; unsigned JSON is refused. An encrypted JWT (JWE, RSA-OAEP-256) is decrypted with the configured key, then verified. `sub` must equal the ID token's `sub`. `iss` and `aud` are checked when present. Language-tagged claims (`name#en`) are understood. The birth date must be `YYYY-MM-DD` or `YYYY/MM/DD`.
6. **JWKS.** The keys are cached for 10 min and refetched once on an unknown `kid`, at most every 30 s (provider key rotation).
7. **Error mapping.** Token-endpoint errors are mapped as in the guide's §3.2: `invalid_grant` becomes INVALID_GRANT; client errors become MISCONFIGURED; 5xx becomes UNAVAILABLE.

What production needs, all **[EXTERNAL]**, plus **[LEGAL]** for the last item:

| Item | Variable | Notes |
|---|---|---|
| Issuer URL (sandbox and production) | `IDENTITY_ESIGNET_ISSUER` | From NIDP. Must be https |
| Client id | `IDENTITY_ESIGNET_CLIENT_ID` | From NIDP onboarding |
| Signing key matching the registered partner certificate | `IDENTITY_ESIGNET_CLIENT_PRIVATE_KEY` | Base64 of the RSA JWK (≥ 2048 bit). From a secret manager, never the repo or the app |
| Encryption key, if the client receives JWE user information | `IDENTITY_ESIGNET_USERINFO_PRIVATE_KEY` | Optional |
| Registered redirect URI | `PUBLIC_API_BASE_URL` → `<origin>/api/v1/identity/callback/fayda` | Must match exactly |
| Permitted scopes, claims, `acr` values | `IDENTITY_ESIGNET_SCOPES/CLAIMS/ACR_VALUES/ACCEPTED_ACR` | Whether `name` and `birthdate` are permitted for this purpose is unconfirmed |
| Verified Android App Link domain | `IDENTITY_APP_RETURN_URL` (https) | `assetlinks.json` on the app domain |
| Permission to use eKYC for this purpose; data residency | — | L-1 and the Personal Data Protection Proclamation 1321/2024 [LEGAL] |

**Not verified:**
- that NIDP onboards private companies for this purpose;
- the real claim names, formats and assurance values;
- whether `acr` values such as `mosip:idp:acr:biometrics` (taken from the guide) apply to this client;
- PAR/DPoP support. These are not used: the guide does not require them.

The adapter has **not** been run against eSignet's own mock stack. The implementation plan allowed "unit-tested with signed test tokens" as the alternative, and that is what was done.

## 7. Identity verification state machine [IMPL]

**Attempt** (`identity_verifications.status`); each attempt is a row:

```
PENDING ─▶ VERIFIED | REJECTED | FAILED | EXPIRED | CANCELLED | SUPERSEDED
VERIFIED ─▶ EXPIRED | REVERIFICATION_REQUIRED | SUSPENDED
REVERIFICATION_REQUIRED ─▶ SUSPENDED | SUPERSEDED
SUSPENDED ─▶ REVERIFICATION_REQUIRED
REJECTED, FAILED, EXPIRED, CANCELLED, SUPERSEDED: terminal
```

**Account** (`users.identity_status`, values from 02 §3.2):

```
UNVERIFIED ─▶ PENDING
PENDING ─▶ VERIFIED | REJECTED | (status before the attempt)
VERIFIED ─▶ EXPIRED | REVERIFICATION_REQUIRED | SUSPENDED
REJECTED | EXPIRED ─▶ PENDING
REVERIFICATION_REQUIRED ─▶ PENDING | SUSPENDED
SUSPENDED ─▶ REVERIFICATION_REQUIRED
```

- **Results stick, non-results restore.** VERIFIED and REJECTED set the account status. FAILED, EXPIRED and CANCELLED restore the status stored on the attempt (`previous_identity_status`).
- **One writer.** Only `IdentityTransitions` changes state. It works inside the caller's transaction, after `SELECT … FOR UPDATE` on the user row, and writes the audit row and outbox event in the same transaction.
- **Database enforcement.** Triggers enforce the same transition tables. A unit test parses the migration SQL and fails if the tables differ from the code. The database also refuses `users.identity_status = VERIFIED` unless a VERIFIED attempt exists for the bound subject.
- **Starting again.** A new start from PENDING supersedes the open attempt (lost tab, expired link). VERIFIED and SUSPENDED accounts cannot start; the server decides this and returns it as `canStart`.

## 8. Identity subject/account linking [IMPL]

- The subject is stored only as `HMAC-SHA256(identity key, "<provider>:<sub>")`. The key is derived from `HASHING_PEPPER` with HKDF and the purpose `identity`. No raw national ID number, FAN or FIN is requested or stored.
- **BR-ID-2.** `users.identity_subject_hmac` is UNIQUE and can be set only once (trigger). A partial unique index also allows only one VERIFIED attempt per subject.
- **First link.** If another account holds the subject, the attempt is REJECTED with `IDENTITY_ALREADY_LINKED`. An `identity.duplicate_detected` audit row and outbox event are written, so verification officers can see which account holds the identity.
- **Re-verification.** It must present the subject already bound to the account; otherwise the attempt is REJECTED with `IDENTITY_MISMATCH` and flagged the same way.
- **Concurrency.** Two accounts finishing with the same new identity at the same moment are serialized by the unique index: exactly one wins, and the loser is recorded as a rejection (tested).
- **Non-enumerating responses.** The client sees `REJECTED` / `VERIFICATION_REJECTED` for every rejection: duplicate, mismatch and low assurance alike. Tests compare the duplicate and mismatch responses field by field.
- **No unlinking or replacement.** A binding can only be suspended or sent for re-verification by an officer. Replacing a binding is deferred: it needs a four-eyes rule.

## 9. Database schema and migrations [IMPL]

New migrations; earlier migrations are unchanged:

1. **`20261117180000_identity`**:
   - enums `IdentityProviderCode` (`DEV`, `FAYDA_ESIGNET`) and `IdentityVerificationStatus`;
   - `users.identity_subject_hmac` (unique);
   - table `identity_verifications`;
   - partial unique indexes: one PENDING attempt per user; one current (VERIFIED, SUSPENDED or REVERIFICATION_REQUIRED) attempt per user; one VERIFIED attempt per subject;
   - partial indexes for the expiry sweeps;
   - CHECKs: hex formats; secrets only while PENDING; a verified attempt has its encrypted claims and `valid_until`; an outcome code for every non-trivial status; staff accounts have no customer identity;
   - triggers: transition tables, immutable identifying columns, a single-use callback marker, the subject bound once, and "VERIFIED needs a verified attempt".
2. **`20261118090000_identity_confirmation`** (the security fix in §12):
   - `initiated_session_id` (FK to sessions, immutable), `pending_result_enc`, `confirmation_hash`, `confirmation_expires_at`;
   - CHECKs: a held result only while PENDING; the result, token and expiry exist together; a result only after the callback; the token stored as SHA-256 hex only.

Stored per attempt (data minimization, 08 §5):
- the provider;
- the SHA-256 of the state;
- AES-256-GCM state, nonce and PKCE verifier, **erased when the attempt leaves PENDING**;
- the subject HMAC;
- AES-GCM `{fullName, dateOfBirth}` (only for verified attempts; removed from superseded ones);
- the assurance level, timestamps and outcome code.

Never stored: photos, biometrics, address, phone from the provider, raw ID numbers, ID/access tokens, the confirmation token. Gender is not requested; the [ASSUMPTION] in 08 §5 is resolved by dropping it.

Validation:
- `prisma validate` passes; `db:drift` reports "No difference detected".
- All four migrations apply from zero (integration global setup).
- The four migrations applied to the dev database inside the new `migrate` container.
- 15 raw-SQL constraint tests.

## 10. API endpoints (under `/api/v1`)

| Method and path | Who | Notes |
|---|---|---|
| `POST /identity/verifications` | customer | Body `{consent: true, locale?}`. **Idempotency-Key required.** Returns the attempt and `authorizationUrl` (null once the attempt has ended). Rate limit 10 per hour per user |
| `GET /identity/verifications/current` | customer | `identityStatus`, `canStart`, the own verified name (VERIFIED only), validity, latest attempt with a coarse `reason` |
| `GET /identity/verifications/{id}` | customer, own | Another user's attempt or an unknown id: 404 |
| `POST /identity/verifications/{id}/confirm` | customer, own, **initiating session only** | Body `{confirmation}`. Same-device confirmation (§12). Rate limit 10 per 15 min |
| `POST /identity/verifications/{id}/cancel` | customer, own | Repeating it is harmless; other states: 409 `INVALID_STATE_TRANSITION` |
| `GET /identity/callback/{provider}` | public (browser) | 303 to the app link. Rate limit 60 per 15 min per IP |
| `GET /admin/identity-verifications/{id}?reason=` | `identity.review` | Verified claims and the conflicting account. **Every view is audited with the reason** (10–500 characters) |
| `POST /admin/identity-verifications/{id}/require-reverification` | `identity.review` | `{reason}` |
| `POST /admin/identity-verifications/{id}/suspend` | `identity.review` | `{reason}`. Closes an open attempt |
| `GET /dev/identity/authorize[/decision]` | public, **dev only** | Not mounted outside development and test |

New error codes:
- `IDENTITY_UNAVAILABLE` (503);
- `IDENTITY_VERIFICATION_NOT_ALLOWED` (409);
- `INVALID_STATE_TRANSITION` (409);
- `IDENTITY_CONFIRMATION_INVALID` (400; the same response for every confirmation problem).

Request DTOs have no status, provider or result fields. Unknown fields are rejected (tested with `status`, `identityStatus`, `provider` and `verifiedName`).

## 11. Authentication and authorization [IMPL]

- **Customer routes.** They need a valid session (the Phase 3 guard). They are customer-only: staff get 404, because staff accounts have no customer identity (database CHECK). Ownership checks return 404, never 403. Authentication is separate from identity: an `UNVERIFIED` account can sign in (08 §2).
- **Officer routes.** They are `@AdminArea` and need `identity.review`, which only `VERIFICATION_OFFICER` holds. Customers get 404; other staff, including super admins, get 403.
- **Authorization matrix.** Each of the 8 protected identity routes is called by 7 actors and the status codes are asserted. The matrix fails if any protected route lacks a row. The public-route allow-list now has the callback and the two dev routes.

## 12. Security controls and the cross-device consent phishing review

### 12.1 Controls

| Control | Where |
|---|---|
| State: 256-bit random, stored as SHA-256 for lookup, claimed **atomically and once** (`UPDATE … WHERE callback_received_at IS NULL RETURNING`). Replays are ignored and audited (`identity.callback_replayed`) | callback service |
| Nonce: 256-bit, checked by the adapter **and** again by the service (constant-time) | adapter, `validateProviderIdentity` |
| PKCE S256 with a 64-character verifier, never sent to the client; secrets AES-GCM encrypted with row-bound associated data | start, adapter |
| 15-minute session; callback after expiry → EXPIRED; lazy and bulk expiry | expiry service |
| Code exchange, token validation and claim mapping only on the server; tokens discarded after use | adapter |
| **Same-device confirmation** bound to the initiating session (§12.2) | callback service, `/confirm` |
| No client-settable status anywhere (BR-ID-1); database triggers as a second line | DTOs, triggers |
| The return link carries only the attempt id and the one-time confirmation token: never a code, OAuth token or claim. Request logs record the path without the query | callback, `logger.options.ts` |
| Logs: attempt id, provider and error kind only. `codeVerifier`, `nonce`, `state`, `clientAssertion`, `fullName` and `dateOfBirth` are added to the redaction list | services |
| Rate limits on start, confirm and callback; idempotent start | policy |
| Generic, non-enumerating rejection reasons | `clientReason` |
| Production config: dev adapter rejected; https issuer, public URL and App Link required; key format and size validated; keys never echoed in errors | `env.schema.ts` |
| Browser: Custom Tab or system browser, never a WebView; https only (http only in development builds) | Flutter `SystemBrowserLauncher` |

### 12.2 Threat model: cross-device identity consent phishing

The relevant guidance:
- **RFC 9700 §2.1** covers CSRF, code injection and mix-up. State, PKCE and nonce address those: they bind the authorization response to the client session that sent the request.
- **draft-ietf-oauth-cross-device-security** describes *consent phishing*: an attacker starts a flow and persuades a victim to authenticate and approve it. The draft notes that this works even with strong authentication, because the attacker never needs the victim's credentials.
- The **VeriFayda 2 guide** offers no transaction-binding or initiating-device confirmation feature beyond standard OIDC, and none is assumed here.

| Item | Analysis |
|---|---|
| **Threat** | The attacker gets *someone else's* national identity bound to the attacker's account by tricking that person into completing the attacker's verification |
| **Attacker capabilities and prerequisites** | A customer account (free; needs a phone number). The ability to send a link to the victim (SMS, chat, a fake "verify for a job/prize" message). The victim has Fayda and completes the provider's authentication (OTP or biometrics) and consent |
| **Affected assets** | Identity binding (BR-ID-2); the trust that owners place in a "verified" driver (risk S-2: vehicle theft); the victim's ability to verify their own account later |
| **Attack scenario** | 1. The attacker calls `POST /identity/verifications` and receives `authorizationUrl`. 2. The attacker forwards it. 3. The victim opens it, authenticates at Fayda, and consents; the provider's screen names the platform, not the account. 4. The provider redirects the victim's browser to our callback with a valid code and state |
| **Potential impact before the fix** | The callback alone completed the attempt: the victim's identity became bound to the attacker's account (VERIFIED, with the victim's name). The victim could no longer verify their own account (`IDENTITY_ALREADY_LINKED`). A fraudulent driver would appear verified as a real person. **Severity: high** |
| **Why existing protections did not stop it** | State, nonce and PKCE prove that the response belongs to *the attempt*. They do not prove that *the person who authenticated is the account holder*. The attacker's own attempt is legitimate at the protocol level. The callback is an unauthenticated browser request, so on its own it cannot establish who completed it |
| **Mitigation implemented** | **Same-device confirmation.** 1. The attempt records the session that started it (`initiated_session_id`, immutable). 2. The callback validates the result as before but **does not link**. It stores the result encrypted with a 10-minute window and redirects the *completing browser* to `kiroweenmobility://app/identity/return?verification=<id>&confirmation=<token>`; the 256-bit token is stored only as SHA-256. 3. Only `POST /identity/verifications/{id}/confirm`, from the **same account and the same session that started the attempt**, with the token, links the identity. 4. A forwarded link puts the token on the victim's device: the attacker's session lacks the token, and the victim's app is a different account (404). The result expires as `CONFIRMATION_EXPIRED` and is erased, and the victim's identity stays free. 5. Every failed confirmation is audited with its cause (`WRONG_TOKEN`, `OTHER_SESSION`, `EXPIRED`, `NO_RESULT`). The client always gets the same 400 |
| **Why not a browser-session cookie** | The attempt is started by the app over the API, not by the browser, so there is no browser session to bind. A "launch" URL that sets a cookie can be forwarded just like the authorization URL; the victim's browser would receive the cookie. Binding to the *initiating app session* is the property that matters |
| **Additional user-facing control** | The consent card and the pending screen say: "Finish on the same phone and in the same app where you started. A link sent to you by someone else will not verify your account." (en and am) |
| **Tests** | `identity-confirmation.e2e.spec.ts` (10 tests): the provider step alone links nothing; the attacker cannot confirm without the token (repeated guesses fail and are audited); the victim's app gets 404; an unconfirmed result expires and is erased, after which the victim verifies their own account with the same identity; a second session of the same account is refused (`OTHER_SESSION`); expiry; confirming before a result; idempotent re-confirmation; the token is never stored or logged; input and access checks. Plus a matrix row, DB-constraint tests for the new columns, Flutter tests for the return screen, and a container smoke test (§20) |
| **Remaining weaknesses** | (a) **Victim cooperation.** A determined attacker could persuade the victim to also copy and send the final return link (token), then confirm from the attacker's session within 10 minutes. This needs extra steps: in a Custom Tab the redirect to an app scheme is not displayed as a copyable URL. (b) **Custom-scheme hijacking.** Another app on the *victim's* device that registers `kiroweenmobility://` could capture the token; production must use a verified https App Link (§15). (c) **Coerced or shared devices.** A person standing next to the victim, or using the victim's phone, is not addressed by any OIDC flow. (d) **Provider-side context.** Showing "you are verifying account +2519…" on the Fayda consent screen would need eSignet features not confirmed for this client [EXTERNAL] |
| **Compensating controls** | Rate limits; the duplicate flag (a victim who later registers raises `identity.duplicate_detected` for officers); BR-ID-2 lets officers suspend the attacker's binding; Phase 5 licence review compares the verified name with the licence held by the driver in person [ASSUMPTION]; full audit trail |
| **Residual risk** | **Low to medium**, down from high. **Release recommendation:** not blocking by itself for a pilot, provided that (1) production uses a verified https App Link, (2) a support process exists for disputed bindings (officer suspend and re-verify), and (3) the duplicate-detected events are monitored. Reassess when the real Fayda consent screen and its available claims are known; if eSignet offers transaction context or initiating-device binding, add it |

## 13. Audit and outbox integration [IMPL]

Audit actions, written in the same transaction as the change:
- `identity.verification_started` (consent and locale);
- `identity.result_received` (claim names only);
- `identity.verification_verified` (provider, acr, claim **names**, validity);
- `identity.linked`;
- `identity.verification_rejected`, `_failed`, `_expired`, `_cancelled`, `_superseded`;
- `identity.duplicate_detected`;
- `identity.callback_replayed`;
- `identity.confirmation_rejected` (cause only);
- `identity.details_viewed` (officer, with reason);
- `identity.reverification_required`, `identity.suspended` (with reason).

Outbox events (identifiers only): `identity.verified`, `identity.rejected`, `identity.expired`, `identity.duplicate_detected`, `identity.reverification_required`, `identity.suspended`.

Tests assert that audit rows and logs contain no subject, name, code, state or token.

## 14. Flutter identity-verification experience [IMPL]

- `features/identity/`, wired into `IdentityApi` / `HttpIdentityApi` (Dio, idempotency key), `IdentityFlow` and `identityOverviewProvider` (Riverpod).
- **Account screen.** An "Identity verification" tile shows the current status.
- **Identity screen.** It renders the server's state and nothing else:
  - not verified: introduction plus a consent card with a checkbox; the button stays disabled until consent;
  - pending: "Continue in browser" (when started in this run), "Check status" and cancel with confirmation;
  - verified: name and validity;
  - rejected: generic text plus retry;
  - failed: provider outage or generic text, plus retry;
  - expired: retry;
  - re-verification required;
  - suspended: no actions;
  - unknown future status;
  - loading, error with retry, offline.
- **Refresh.** On app resume, pull-to-refresh, "Check status", after every action, and after the return link.
- **Retries.** The idempotency key is reused only after a connectivity failure, so a lost response does not create a second attempt.
- **Not in Flutter.** No status is decided in Flutter, and the server's `canStart` is used as-is. The router guard is UX only.

## 15. Browser launch and Android deep link

- **Browser** [IMPL]:
  - `SystemBrowserLauncher` asks `supportsLaunchMode(inAppBrowserView)` and uses a Custom Tab if one is available, otherwise the external browser app.
  - The source of `url_launcher_android` 6.3.35 was inspected. It **falls back to its own WebView** when an in-app browser view is requested and no Custom Tabs browser exists. The launcher therefore never requests that mode blindly, and never uses `inAppWebView`. Tested.
  - Only https URLs are opened; http only in development builds.
  - `AndroidManifest.xml` adds the `<queries>` entries required on Android 11 and later (Custom Tabs service, https VIEW).
- **Return link** [IMPL]:
  - `kiroweenmobility://app/identity/return` is an intent filter on `MainActivity` (VIEW, DEFAULT, BROWSABLE, scheme, host `app`, path prefix).
  - GoRouter route `/identity/return` opens `IdentityReturnScreen`. It validates `verification` (UUID) and `confirmation` (43 base64url characters), sends the token in the POST body (never in a URL), then shows the status screen. Any other link only opens the status screen. A failed confirmation shows "could not be completed here" and never shows a verified state.
  - **Cold start.** If the link launches the app while the session is still restoring, splash carries the link in `next` and resumes it after sign-in. Only the identity return route can be resumed, so `next` is not an open redirect. Signed out, the link is dropped.
  - An unfinished browser flow leaves the account PENDING and the UI shows "in progress" (tested).
- **Verification performed.**
  - Widget and router tests: return-link confirmation, malformed links, rejection handling, cold-start resume, splash `next` restrictions, guard behaviour.
  - Server side: the container smoke test confirmed the exact return link format.
- **NOT RUN: an Android device or emulator test.**
  - A phone (`R5CX22MAH4H`) appeared in `adb devices` once at the start of this session and was gone at every later check. No emulator is configured.
  - No APK could be built (§19).
  - The real browser-return experience on Android is therefore **not manually verified**.
- **Production requirement [EXTERNAL].** The return URL must become a verified https Android App Link: `IDENTITY_APP_RETURN_URL=https://<app domain>/identity/return`, `assetlinks.json` with the release signing-certificate fingerprint, and `android:autoVerify="true"`. Production config already refuses a non-https return URL with the eSignet adapter. iOS universal links are not configured (Android first).

## 16. English and Amharic localization [IMPL]

41 new messages in each of `app_en.arb` and `app_am.arb`. They cover:
- titles, consent, actions and every status;
- each last-attempt outcome, plus errors;
- return and confirmation messages, and the anti-phishing hint.

The Amharic texts are my translations and **need native-speaker review**, as in Phase 3. Tests render the screen in Amharic.

## 17. Automated tests and exact results

Final run, 2026-11-18. Each suite was counted once; coverage reruns are not added to the totals.

| Suite | Phase 3 | Phase 4 | Added |
|---|---|---|---|
| Backend unit (`npm test`) | 156 | **226** | +70 |
| Backend integration and HTTP (`npm run test:integration`) | 166 | **240** | +74 |
| Shared Dart (`dart test`) | 62 | **62** | 0 |
| Flutter (`flutter test`) | 122 | **164** | +42 |
| **Total** | **506** | **692** | **+186** |

New Phase 4 test files:
- `identity-state.spec` (transition tables against the SQL, every pair, reasons, dates);
- `identity-validation.spec`;
- `dev-identity.provider.spec`;
- `esignet-identity.provider.spec` (31 cases against a simulated OIDC server, including wrong issuer, wrong audience, expired token, foreign key, missing nonce, low acr, userinfo `sub` mismatch, unsigned userinfo, JWE, invalid_grant, invalid_client, 5xx, hang/timeout, discovery issuer mismatch and code reuse);
- the identity cases in `app-config.spec`;
- `identity-verification.e2e` (32), `identity-confirmation.e2e` (10), `identity-config-modes.e2e` (disabled provider, provider timeout, eSignet wired end to end, provider unreachable);
- `identity-db-constraints` (15);
- the matrix and public-route updates;
- Flutter `identity_data_test` and `identity_screen_test`.

Coverage of the required cases:

| Required case | Covered by |
|---|---|
| Successful verification | e2e |
| Failed, expired | e2e |
| Invalid transition | e2e and unit (every pair) |
| Duplicate subject | e2e, including concurrency |
| Linking | e2e |
| Authorization and IDOR | e2e and matrix |
| Replayed callback | e2e, including 4 concurrent copies |
| Invalid provider response | e2e and adapter unit tests |
| Timeout | e2e and adapter unit tests |
| Idempotent retry | e2e |
| Audit, outbox | e2e |
| Production config rejecting the dev adapter | unit |
| Enumeration resistance | e2e |
| Consent phishing | confirmation e2e |
| Flutter: rendering, loading/error/success, retry, localization, routes, API errors, browser mode | widget and unit tests |

## 18. Code coverage

| Scope | Lines | Statements | Branches | Functions | Gate |
|---|---|---|---|---|---|
| Identity (`src/modules/identity`, `src/providers/identity`) | **95.63%** (658/688) | 92.57% | 83.69% | 96.4% | ≥ 90% lines: PASS |
| Auth (unchanged scope) | **97.5%** (743/762) | 94.57% | 84.23% | 97.86% | ≥ 90% lines: PASS |

`npm run test:coverage:identity` was added to CI.

## 19. Build and deployment verification

| Check | Result |
|---|---|
| `npm run build` | PASS |
| `prisma validate`, `db:drift` | PASS ("No difference detected") |
| API Docker image build (`docker compose build migrate api`) | **PASS** (see §20) |
| `flutter build apk --debug` | **BLOCKED** |

Why the APK build is blocked:
- The Gradle wrapper must download `gradle-9.3.1-all.zip`. The download progressed at about **0.8 MB per minute** (about 28 MB of about 220 MB after 30 minutes); the same stall happened in Phases 2 and 3.
- An offline attempt with the locally installed Gradle 9.2.1 failed because the Flutter Gradle plugin's dependencies (e.g. `org.gradle.kotlin.kotlin-dsl` 6.4.1) are not cached either. The APK has never been built on this machine.
- I did not change the project's Gradle version to work around it.
- The download was left running.
- CI's release-APK job is the next place this can be verified.

## 20. Docker verification

- **Earlier failure.**
  - The build log ended with `npm error code EAI_AGAIN … getaddrinfo EAI_AGAIN registry.npmjs.org`, then a network error during `npm ci --omit=dev`.
  - Diagnosis: Docker Desktop uses its internal proxy (`http.docker.internal:3128`, no credentials). No npm proxy or `.npmrc` is configured, and the registry is the default.
  - In this session, DNS resolution and an HTTPS fetch of `registry.npmjs.org` from a `node:22-bookworm-slim` container both worked (HTTP 200 in 779 ms). The failure was transient network or DNS trouble in the build VM.
  - Docker Desktop had also stopped (host restart); it was started again. No volumes were deleted.
- **Rebuild.** `docker compose -p kiroween-mobility build migrate api` exit 0, with no dependency changes and the normal build cache.
- **New image in use.** The running `api` container uses image `sha256:43b873c1e125…`, which is the image just built (created 2026-11-18T06:51Z). The container contains `dist/modules/identity/identity-callback.service.js` and `dist/cli/identity-expire.js`.
- **Migrations.** The `migrate` container applied the migrations. `_prisma_migrations` lists `foundation`, `auth`, `identity`, `identity_confirmation`.
- **Health.** postgres, redis, storage and api are all `healthy`. `GET /api/v1/health/ready` returns `{"status":"ok","checks":{"database":"up","redis":"up","storage":"up"}}`.
- **Development smoke test** against the container (`IDENTITY_PROVIDER=dev`; the browser steps were done with curl):
  1. Normal flow: start PENDING; consent page; approve; callback 303 to `kiroweenmobility://app/identity/return?verification=<id>&confirmation=<token>`. The status stays **PENDING before confirmation**; confirm returns 200 VERIFIED; status VERIFIED; a repeated confirm returns 200 VERIFIED.
  2. Forwarded link: the attacker's guessed token gets 400 `IDENTITY_CONFIRMATION_INVALID`; the attacker stays PENDING.
  3. One step was inconclusive. The "victim presents the real token" step returned 401 instead of the expected 404. The script could not create the victim account: repeated smoke runs had used up the Phase 3 per-IP limit for code sends (20 per hour). A follow-up `POST /auth/otp` returned `429` with `Retry-After: 2684`. The victim's request was therefore unauthenticated. I did not flush the Redis counters to get around the limit. The same case returns 404 in the automated tests (`identity-confirmation.e2e.spec.ts`), which ran against a real database and Redis.
- **Side effect.** The first smoke run against the dev database was REJECTED because the default synthetic person had already been linked by yesterday's smoke test. This is correct behaviour (BR-ID-2); later runs used unique synthetic subjects.

## 21. Git commits

Phase 4 is committed on `main` after the 62 Phase 3 commits, which are unchanged. The `phase-03-complete` tag still points to `f709f3b`. The commit list and hashes are in the final response of this session. There is no Phase 4 tag.

## 22. Architecture deviations

| Architecture said | Implemented | Reason |
|---|---|---|
| Callback sets VERIFIED or REJECTED directly (08 §4) | The callback holds the result; the initiating app session confirms with a one-time token | Cross-device consent phishing (§12.2) |
| Attempt statuses `PENDING, VERIFIED, REJECTED, EXPIRED, SUSPENDED, REVERIFICATION_REQUIRED` (03) | Adds `FAILED`, `CANCELLED`, `SUPERSEDED` | Technical failure ≠ rejection (retry text, non-enumeration); user cancellation; a replaced attempt. Account statuses are exactly those of 02 §3.2 |
| `PENDING ─timeout─▶ UNVERIFIED` (02 §3.2) | The account returns to *its status before the attempt* | Otherwise an EXPIRED or REJECTED account would become UNVERIFIED by abandoning a retry |
| `UNIQUE(subject_hmac) WHERE status='VERIFIED'` only | Also `users.identity_subject_hmac` UNIQUE, set once | The binding must survive the attempt expiring (renewal must be the same person) |
| Name, DOB, gender (08 §5, gender [ASSUMPTION]) | Name and DOB only | Data minimization; gender not needed |
| `claims_hash` column (03) | Not stored; claim *names* go to the audit row | A hash of a few low-entropy claims could be brute-forced |
| State/nonce/PKCE stored hashed or encrypted (08 §4) | The state is a SHA-256 lookup key; all three are encrypted together and erased after use | Same intent; also allows rebuilding the URL for idempotent replays without plaintext |
| eSignet tested against the eSignet mock stack if it runs locally | Tested against a simulated OIDC server | The plan allowed this alternative |
| `flutter_custom_tabs` (06) | `url_launcher` with Custom Tabs detection | An official flutter.dev package; same behaviour; avoids its WebView fallback |
| Staging shows a "TEST IDENTITY" banner | Staging cannot run the dev adapter at all; the banner is on the dev consent page | Stricter |
| `POST …/require-reverification` and `/suspend` | Plus a reason-audited `GET` and suspension closing an open attempt | 01 §4 "staff access … logged with a reason" |

## 23. Assumptions

- Verified identity is valid for 24 months (BR-ID-3; `IDENTITY_VALIDITY_MONTHS`).
- `name` and `birthdate` are the claims needed and permitted; claims come in English (`claims_locales=en`).
- A 10-minute confirmation window and a 15-minute session are enough on Ethiopian mobile networks.
- One verified identity per person, ever, across account types (customers only).
- The officer licence comparison (Phase 5) uses the verified name.

## 24. Known limitations

1. **No real Fayda verification.** It is not tested against real eSignet or its mock stack. [EXTERNAL]
2. **APK not built and the Android return flow not tested on a device** (§15, §19).
3. **No scheduler** runs `identity:expire`. Expiry happens lazily on every read or change by the account. 30, 7 and 1 day reminders are deferred to Phase 15.
4. **No unlinking or replacement of a bound identity.** Officers can only suspend or require re-verification.
5. **Session binding.** Signing out (or a revoked session) between starting at the provider and returning makes that attempt unconfirmable. It expires and the user starts again.
6. **No admin web UI** (Phase 5). The officer endpoints are tested through the API.
7. **Amharic texts** need native review.
8. **The dev database** contains smoke-test accounts and bound synthetic identities.

## 25. Security risks

| Risk | Note |
|---|---|
| Consent phishing residual | §12.2: low to medium; needs a verified App Link in production |
| Custom-scheme interception in development builds | Any app can register `kiroweenmobility://`. Acceptable for development only |
| Officer access to verified names | Audited with a reason; least privilege (`identity.review` only). Bulk-access alerting is a Phase 18 item |
| Pepper or key compromise | The subject HMAC and the encrypted claims depend on `HASHING_PEPPER` and `FIELD_ENCRYPTION_KEYS`. Key rotation for HMAC values is not designed (rotating would break BR-ID-2 lookups) |
| Provider misconfiguration | Fails closed (MISCONFIGURED → FAILED attempt, 503 at start); never falls back to the dev adapter |
| Unconfirmed results | Held encrypted for at most 10 minutes, then erased |

## 26. External dependencies

- **NIDP relying-party onboarding** (L-1), with a sandbox and a production issuer, client id, registered redirect URI, signing key or certificate, and permitted scopes, claims and acr values. **[EXTERNAL][LEGAL]**
- **Legal review** of eKYC use and personal-data handling (Proclamation 1321/2024, data residency). **[LEGAL]**
- **App domain** for a verified Android App Link. **[EXTERNAL]**
- **Reliable network access** for Gradle downloads, to build the APK on this machine. **[EXTERNAL / environment]**
- **A secret manager** for the signing and encryption keys. **[EXTERNAL]**

## 27. Phase 4 quality-gate result

| Gate | Result |
|---|---|
| Backend Prettier, ESLint, `tsc` | PASS |
| Backend build | PASS |
| `prisma validate`, `db:drift`, migrations from zero | PASS |
| Backend unit 226, integration 240 | PASS |
| Coverage: auth 97.5%, identity 95.63% lines (≥ 90%) | PASS |
| `npm audit --omit=dev --audit-level=high` (0 vulnerabilities) | PASS |
| Flutter format, `flutter analyze --fatal-infos`, `flutter test` (164) | PASS |
| Shared Dart format, analyze, test (62) | PASS |
| Gitleaks working tree and Git history (62 commits before the Phase 4 commits) | PASS (no leaks) |
| Docker image build, container migrations, postgres/redis/storage/api health, readiness | PASS |
| Container smoke test of the identity flow | PASS, with one inconclusive script step (§20) |
| Android APK build | **BLOCKED** (Gradle download) |
| Android device or emulator deep-link test | **NOT RUN** (no device or emulator connected) |
| eSignet against real NIDP | **BLOCKED** [EXTERNAL] |
| `osv-scanner` for Dart dependencies | **NOT RUN** (tool not installed) |

**Overall: Phase 4 passes every gate that can run here.** The Android build and device tests are blocked by the environment, not by known defects. They do not invalidate the backend or the Flutter logic, but the browser-return experience on a real phone must be checked before release.

## 28. Recommended next step

1. Human review of this report, especially §12.2 (the consent-phishing residual and release recommendation) and §22 (deviations).
2. On a machine with working Gradle downloads, run `flutter build apk --debug --dart-define-from-file=config/development.json` and a device test:
   - start → approve on the dev page (with `PUBLIC_API_BASE_URL` reachable from the phone) → return to the app → VERIFIED;
   - cancel at the provider → back in the app → "cancelled";
   - kill the app before returning → cold start → link resumed.
3. Start NIDP onboarding (L-1) and the legal review.
4. Then Phase 5 (documents, driver verification, minimal admin web), only after approval.
