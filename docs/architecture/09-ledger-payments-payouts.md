# 09 — Financial Ledger, Payments, Payouts

## 1. Commercial model

**[ASSUMPTION — needs your confirmation]** MVP model is **fixed rent**:
- The listing sets rent per period (e.g. 1,500 ETB/day) and an optional refundable deposit.
- The driver keeps whatever they earn operating the vehicle (taxi, ride-hailing on other apps, delivery). The platform cannot observe that income, so it does not split it.
- The platform charges a **commission on rent**, deducted from the owner's share, according to a versioned commission rule.
- "Driver earnings" on the platform therefore means: deposit refunds, any revenue-share payouts (future), and driver-reported income summaries (informational, not ledger).

A **revenue-share** model (driver reports or a partner reports gross trip income; split owner/driver/platform) is supported by the ledger design (`DRIVER_PAYABLE` accounts, `REVENUE_SHARE` entry type) but not built in MVP, because trustworthy income data does not exist without a dispatch integration.

**[LEGAL — high priority]** If the platform collects money from drivers and later pays owners, it is holding customer funds. In Ethiopia this may require a National Bank of Ethiopia payment-instrument/operator licence or operating through a licensed provider's escrow/split-payment product. The architecture supports both "platform collects then pays out" and "provider splits at source" (then the ledger records the split as reported by the provider). This decision must be made with legal counsel before production.

## 2. Representation

- `bigint` santim (1 ETB = 100 santim). TypeScript uses `bigint` for amounts in the ledger module (Prisma maps `BigInt`); JSON serializes as integer number when ≤ 2^53 (validated), Dart uses `int`.
- Currency always stored next to the amount; arithmetic between different currencies throws.
- Percentages as integer **basis points** (1000 bps = 10%).
- Rounding: `commission = (gross * bps + 5000) / 10000` (integer half-up). `ownerShare = gross − commission − ownerBorneFees`. Allocation is computed by one pure function, property-tested so that `Σ allocations == gross` for every input.

## 3. Chart of accounts

| Account (code pattern) | Type | Normal balance | Meaning |
|---|---|---|---|
| `provider:{p}:clearing` | Asset | Debit | Money held at payment provider on our behalf |
| `owner:{id}:payable` | Liability | Credit | Owed to owner, available for payout |
| `driver:{id}:payable` | Liability | Credit | Owed to driver (deposit refunds, future revenue share) |
| `assignment:{id}:deposit` | Liability | Credit | Deposit held for an assignment |
| `payouts:in_transit:{p}` | Liability | Credit | Sent to provider for payout, not yet confirmed |
| `platform:commission` | Revenue | Credit | Platform income |
| `platform:provider_fees` | Expense | Debit | Fees charged by providers |
| `platform:adjustments` | Expense | Debit | Goodwill/write-offs approved by finance |
| `suspense:{p}` | Liability | Credit | Money received that cannot be matched to a charge |

Accounts are created lazily in the same transaction as the first entry (`INSERT … ON CONFLICT DO NOTHING`).

## 4. Postings (examples)

Rent 1,000.00 ETB, commission 10%, provider fee 1.5% borne by platform [ASSUMPTION]:

| Event | Debit | Credit |
|---|---|---|
| Payment confirmed | provider clearing 985.00 · provider fees 15.00 | owner payable 900.00 · platform commission 100.00 |
| Deposit 2,000 paid | provider clearing 2,000.00 | assignment deposit 2,000.00 |
| Deposit released | assignment deposit 2,000.00 | driver payable 2,000.00 |
| Deposit claim 500 (dispute resolution) | assignment deposit 500.00 | owner payable 500.00 |
| Payout created 900 | owner payable 900.00 | payouts in transit 900.00 |
| Payout completed | payouts in transit 900.00 | provider clearing 900.00 |
| Payout failed | payouts in transit 900.00 | owner payable 900.00 |
| Refund to driver | owner payable X (and/or platform commission X) | provider clearing X — via `REVERSAL`/`REFUND` entry referencing original |

Invariants (tested in unit, property and integration tests; checked nightly by a job that alerts on violation):
1. Each journal entry: Σ debits = Σ credits (DB constraint trigger).
2. For each confirmed payment: `gross = ownerShare + commission + ownerBorneFees` and the entry's lines equal that allocation.
3. `ledger_accounts.balance_minor` = Σ lines for that account (nightly recomputation).
4. Payable accounts never negative (trigger; `allow_negative` only for suspense/clearing).
5. Σ of all asset balances = Σ liability + revenue − expense balances (trial balance).
6. A payment, payout or provider event produces at most one posting of each type (`journal_entries.idempotency_key` = `payment:{id}:confirmed`, `payout:{id}:completed`, etc.).

Immutability: triggers reject UPDATE/DELETE on `journal_entries` and `journal_lines`. Corrections are new entries with `reverses_entry_id` (unique, so an entry can be reversed once). Manual adjustments: finance proposes, a second finance or super-admin approves (different user enforced), entry posted on approval, both recorded in audit.

## 5. Payment provider abstraction

```ts
interface PaymentProvider {
  readonly id: string;                                   // 'DEV_SANDBOX', later e.g. 'TELEBIRR'
  readonly capabilities: { checkoutRedirect: boolean; ussdPush: boolean; refunds: boolean; queryStatus: boolean };
  createPayment(req: { paymentId: string; amount: Money; payerPhone: string; description: string;
                       returnUrl: string; idempotencyKey: string }): Promise<CreatePaymentResult>;
  // CreatePaymentResult: { providerReference, instruction: { kind: 'REDIRECT', url } | { kind: 'USSD_PUSH', message } }
  queryPayment(providerReference: string): Promise<ProviderPaymentStatus>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<VerifiedProviderEvent>; // throws on bad signature
  refund?(req: { providerReference: string; amount: Money; idempotencyKey: string }): Promise<RefundResult>;
}
interface PayoutProvider {
  readonly id: string;
  initiatePayout(req: { payoutId: string; amount: Money; destination: PayoutDestination; idempotencyKey: string }): Promise<{ providerReference: string; status: 'ACCEPTED'|'REJECTED' }>;
  queryPayout(providerReference: string): Promise<ProviderPayoutStatus>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): Promise<VerifiedProviderEvent>;
}
```

Adapters:
- **Dev sandbox** [IMPL, non-production]: in-process fake provider with its own HMAC-signed webhooks sent by the worker after a configurable delay, plus controls to simulate success, failure, timeout, duplicate and out-of-order webhooks. Used by automated tests. Rejected by config in production.
- **Ethiopian providers** [EXTERNAL, not integrated]: candidates to evaluate are Telebirr (Ethio Telecom), M-Pesa Ethiopia (Safaricom), CBE Birr, and aggregators such as Chapa. No endpoints, field names or signature schemes are assumed; each adapter is written only from official docs and tested against the provider's sandbox with real credentials.

## 6. Payment flow and webhook handling

1. Driver taps Pay on a DUE charge → `POST /charges/{id}/payments` with `Idempotency-Key`. Server creates `payments` row `PENDING` (partial unique index blocks a second live payment), calls `createPayment`, stores `provider_reference`, status `PROCESSING`, returns the instruction.
2. App opens checkout / shows "approve on your phone" and then **polls `GET /payments/{id}`**. The app never reports success.
3. Webhook `POST /webhooks/payments/{provider}`:
   - Read raw body (≤ 64 KB), verify signature/auth per provider, check timestamp tolerance if provided. Failure → 401, logged with redacted metadata.
   - Insert into `provider_events` with `UNIQUE (provider, provider_event_id)`; conflict → return 200 (duplicate, already handled).
   - Return 200 quickly; processing happens in the worker from the inbox.
4. Worker: lock payment row; **re-query provider status** (`queryPayment`) when supported, so a forged-but-validly-signed or stale event cannot move money alone; check amount and currency equal the payment; mismatch → payment `FAILED`, money to `suspense`, finance alert. Valid success → payment `SUCCEEDED`, charge `PAID`, journal posting, outbox notification — one transaction.
5. Late/out-of-order events: state machine ignores transitions that are not allowed (e.g. `FAILED` after `SUCCEEDED` is logged and flagged, not applied); `REVERSED` after `SUCCEEDED` posts a reversal entry.
6. Missing webhook: worker polls `PROCESSING` payments with backoff (1, 5, 15, 60 min) and expires them after the provider's documented window.

Never retried blindly: `createPayment` is called at most once per payment row. If the call times out, the payment stays `PROCESSING` with unknown reference handling via `queryPayment` by our `paymentId` (if supported) or marked `NEEDS_REVIEW` for finance.

## 7. Charges

The worker generates charges per active assignment per period (`UNIQUE (assignment_id, kind, period_start)`), marks them `DUE` at period start and `OVERDUE` after a grace period (default 24 h) [ASSUMPTION]. Late fees, if any, are configured per agreement version — off by default. Overdue charges notify both parties; they do not auto-terminate the assignment.

## 8. Payouts

- Payee registers a payout method (mobile wallet number or bank account; stored encrypted, last-4 shown). Changes to payout method trigger an SMS notification and a 24 h cooling-off before use (anti account-takeover) [ASSUMPTION].
- Weekly batch (worker, advisory lock): for each payee with available balance ≥ minimum, in one transaction lock the payable account `FOR UPDATE`, create `payouts` row (`idempotency_key = payout:{payee}:{batchDate}`), post owner payable → in transit.
- Initiation step (separate transaction): call `initiatePayout` with the payout ID as idempotency key; status `PROCESSING`.
- Confirmation by webhook or `queryPayout`: `COMPLETED` posts in-transit → clearing; `FAILED` posts in-transit → payable and allows retry (new attempt number, same payout row, same provider idempotency semantics only if the provider documents them; otherwise a new payout row after the failure is confirmed).
- `HELD`: finance or an open dispute (BR-DSP-2) blocks initiation; release returns to `PENDING`.
- The mobile app shows status from the server only.

## 9. Reconciliation

Daily job per provider (when the provider offers statements/settlement reports): import report → `reconciliation_items` comparing provider reference, amount, status, date with internal payments/payouts → categories `MATCHED`, `MISSING_INTERNAL`, `MISSING_PROVIDER`, `AMOUNT_MISMATCH`, `STATUS_MISMATCH` → finance queue. Resolution is always via new entries (e.g. suspense → owner payable), never edits. Until a provider is integrated, reconciliation runs against the dev sandbox's statement endpoint in tests.

## 10. What users see

- Owner: gross rent collected, commission, fees, net payable, pending payouts, payout history, per-agreement statement.
- Driver: charges due/paid/overdue, deposit held/released, payouts (refunds), driver-reported income summary (clearly labelled "self-reported").
- All figures come from ledger queries (`/wallet`, `/wallet/statement`), not recomputed on the client.

## 11. Tests (Phase 12–14 gate)

Allocation property tests; trial-balance after randomized operation sequences; duplicate webhook ×N concurrent → one posting; webhook before create-payment response returns; amount mismatch; reversal; double-payout under 20 concurrent batch runs → one payout; payout failure then retry; provider timeout; trigger rejects UPDATE/DELETE; unbalanced entry rejected; authorization of all finance endpoints by role.
