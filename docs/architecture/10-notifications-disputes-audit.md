# 10 — Notifications, Messaging, Disputes, Audit

## 1. Notifications

**Pipeline**: business transaction writes `outbox_events` → worker dispatcher reads with `SKIP LOCKED` → `NotificationPolicy` maps event → recipients + template keys → insert `notifications` with `dedupe_key = {event_id}:{recipient}` (unique, so replays create nothing) → push delivery job → SMS only for a small set of critical events.

| Channel | Use | Provider |
|---|---|---|
| In-app | Every event (system of record for the notification list) | [IMPL] |
| Push | Most events; payload contains only `notificationId`, a generic localized title and deep link. No names, amounts, plate numbers or document data. App fetches details after opening. | `PushProvider` → FCM adapter [EXTERNAL credentials], noop in dev |
| SMS | OTP, payout method changed, account suspended, session reuse detected, assignment start/end reminders [ASSUMPTION] | `SmsProvider` [EXTERNAL]; dev adapter logs masked number + template id |
| Email | Not in MVP (low email usage among target users [ASSUMPTION]); staff only | — |

Templates are keys (`notif.application.accepted.title`) rendered server-side for SMS/push in the user's `preferred_locale` (en/am) and client-side in the app from `params`. Push failures mark `push_status = FAILED` and retry ×3; invalid tokens are revoked. Users control push categories except security/financial ones.

Events (initial set): identity verified/rejected/expiring, document approved/rejected/expiring, vehicle approved/rejected/suspended, application received/accepted/rejected/expired, agreement ready/accepted/declined/terminated, assignment scheduled/started/ending soon/completed, charge due/overdue/paid, payment failed, payout sent/completed/failed/held, dispute opened/updated/resolved, ticket reply, new message.

## 2. Messaging and support

- Conversations are created by the system for an application (owner ↔ applicant), an agreement (owner ↔ driver), a support ticket (user ↔ support) or a dispute (parties + support). Participants are fixed on creation; membership checked on every read/send.
- Messages: text only in MVP, ≤ 2,000 chars, 30/min per user, `client_message_id` for idempotent resend from the offline outbox in the app. Attachments only through the documents module (dispute evidence), not free chat uploads.
- Phone numbers are not shown between parties until an agreement is ACCEPTED [ASSUMPTION — protects drivers and owners from off-platform contact harvesting].
- Delivery: polling with `?after=cursor` every 10 s on an open conversation, push for background. WebSockets deferred until measured need.
- Support tickets per brief states; SLA timestamps (`first_response_at`, `resolved_at`); assignment to staff; all staff actions audited.

## 3. Disputes

- Created by a party on an agreement, assignment, charge, payment or payout where they are a party (BR-DSP-1); one open dispute per (subject, initiator).
- Opening a dispute on an assignment/charge holds related unpaid payouts (BR-DSP-2) and moves the application/agreement to `DISPUTED` where the state machine allows.
- Evidence: documents with purpose `DISPUTE_EVIDENCE`, visible to dispute parties and support; never public.
- `dispute_events` table records every status change and note (who, when, from→to).
- Resolution codes: `NO_ACTION`, `REFUND_DRIVER`, `PAY_OWNER_FROM_DEPOSIT`, `PARTIAL_SPLIT`, `TERMINATE_AGREEMENT`, `SUSPEND_PARTY`, `OTHER`. Financial resolutions are proposed by support and posted by finance as compensating entries; the dispute row references the journal entry. History is never edited.
- Escalation to super admin; closure after resolution acknowledgement or 7 days.

## 4. Ratings and reviews

One rating per party per completed/terminated assignment within 14 days; 1–5 score + optional text; ratings are revealed when both parties rate or the window closes (reduces retaliation) [ASSUMPTION]. Support can hide abusive text (`moderation_status`), not change scores. Aggregates updated transactionally on `driver_profiles`/`owner_profiles`.

## 5. Audit

**What is audited**: authentication events (login success/failure, refresh reuse, logout, lockout, password reset), session revocation, identity verification transitions and staff views of identity data, document submissions/reviews/views by staff, every state transition of vehicles, listings, applications, agreements, assignments, all financial events, payout holds/releases, adjustments, commission rule changes, role grants, config changes, suspensions, dispute and ticket actions.

**Record**: actor (user/staff/system/provider), action, target type/id, request ID, IP, user agent, reason, whitelisted field diff (e.g. `status: SUBMITTED → APPROVED`). Never: passwords, tokens, OTPs, document contents, full licence/TIN numbers, provider payloads.

**Integrity**: written in the same DB transaction as the change (no change without audit). Append-only (trigger), monthly partitions, SHA-256 hash chain (`hash = H(prev_hash ‖ canonical row)`) with daily anchoring of the latest hash to an external log store, so tampering by someone with DB access is detectable. DB role used by the API has `INSERT`/`SELECT` only on `audit_logs`.

**Access**: super admin full; other staff scoped (finance → finance actions; officers → their own decisions; support → case-linked). Retention: [LEGAL], default proposal 7 years for financial, 2 years for others.

**Security logging vs audit**: application logs (pino) are for operations and short retention; audit logs are for accountability and long retention.
