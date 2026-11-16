# SCRUM-987 bounded staging proof recipe

Prepared for root execution after independent approval and named app → API → Inbox deployment. This is a simulator-only proof, not real bank or merchant acceptance. No live step in this recipe has been executed by the deposit lane.

## Bind the run before writing

- Record the full reviewed source SHA and exact live Render deployment identities for `oto-app-staging`, `oto-api-staging` and `oto-inbox-staging`. Confirm platform migration 0126 and the expected app migration head independently.
- Read the gateway selection as names/booleans only. Require simulator mode and the deployment's existing simulator safety guard. Do not add merchant credentials, change environment settings, or call a real gateway for this run. The existing simulator uses its private process key when no configured secret exists; do not print it.
- Use a fresh administrator platform session and an app session obtained through the existing launcher handoff. Keep cookies and credentials private. Record only account/session identifiers and eventual sign-out receipts.
- Choose an existing active **provider=simulator** Inbox channel from `GET /inbox/me` → `simulator.channelAccounts`. Independently read back that exact channel's operator/park/provider. It must not be the owner or Tom's Twilio WhatsApp line. Do not create or modify a real channel.
- Choose two unused fictional sender handles and names beginning `ZZ TEST 987 <run>`. Census the exact handles in the chosen operator/channel before use; require no existing contact/thread. Do not reuse a genuine conversation.
- Use one mapped active park, a future date and one start time for both proof parties. The authorized manager deliberately agrees a **฿1 test deposit** for each fixture, within the existing whole-baht amount authority. Each fixture requests its own full 100 satang. No real money is taken.

The paths below address the API origin directly. The Inbox browser's `/api` proxy prefix is not part of these API paths. Every POST uses its own HTTP Idempotency-Key; preserve the body's draft id and request id for its retries.

## First fixture: block, pay, explicitly book, replay

1. `POST /inbox/simulator/inbound` as the administrator:

   ```json
   {
     "channelAccountId": "<verified simulator channel>",
     "from": "<unused fictional digits>",
     "name": "ZZ TEST 987 <run> A",
     "text": "ZZ TEST birthday enquiry for the agreed test date and time",
     "hint": { "category": "birthdays", "language": "en", "branchId": "<own park>" }
   }
   ```

   Require exactly one `conversationIds` entry. Record its exact contact, conversation and inbound-message ids. Read conversation detail and require `event=null`. This is a simulator delivery, not a WhatsApp customer message.

2. Allocate one draft/event UUID and one request UUID. Build the ordinary Book Date body: `id`, `branchId`, `date`, `startTime`, `kids`, `adults`, `contactName`, `phone`, `childName`, `childAge`; all names start `ZZ TEST`. Before requesting anything, send it to `POST /inbox/conversations/:id/book-date`. Require 409 `DEPOSIT_REQUIRED`, unchanged `eventOrderRef`, and **zero** actual `otoapp.core_events` rows for this conversation.

3. `POST /inbox/conversations/:id/prebooking` with `{ booking: <that body>, amountSatang: 100, requestId: <preserved UUID> }`. Require `draft.state=requested`, `draft.simulator=true`, exact amount/currency/park, and a hosted simulator link. Retry the identical body and read exact platform rows: one draft, one deposit request, one original payment attempt/invoice and one request message. Require no calendar event or calendar hold.

4. Attempt Book Date again while unpaid. Require 409 `DEPOSIT_NOT_VERIFIED` and no calendar row. An extra `depositPaid` or `slipVerified` body flag must be rejected as schema-invalid, never accepted as proof.

5. Validate the returned payment URL before following it: its origin must be the staging API and its path must be `/webhooks/2c2p/hosted/<own attempt UUID>`. Require `draft.simulator=true`. Only then POST form `action=pay` to that exact simulator page. Do not follow any real-provider payment page. Read the original attempt and its settlement audit: approved by the gateway webhook/inquiry path, exact 100 satang, no manual confirmation. Record ids/status/amount/provider only; omit tokens and raw payment links.

6. `GET /inbox/conversations/:id/prebooking` must now say paid and simulator. The native dialog must say **no real bank deposit has been received**. Independently require conversation `event=null` and actual calendar count **zero**: payment must not auto-book.

7. Staff check capacity, then explicitly press Book Date or send the ordinary Book Date POST with the preserved draft/event id. Require one event and one `date_booked` pill. Read actual `otoapp.core_events` and `beo_event_billing`: each holds exactly ฿1, paid date is the original receipt's `paidAt` converted to the park timezone, and `add_ons.prebookingDeposit` binds the original draft, attempt, amount and simulator provider. The BEO request card must label it **Simulator test**.

8. Repeat Book Date with the same body and with the same HTTP key. Require the authorized replay contract, the same event id, one calendar row, one billing row, one original approved attempt and unchanged deposit. Replay must not create a receipt, second booking or second deposit credit. The existing `GET /otoapp/parties/:eventId/deposit-request` read projection must include the one eligible original receipt once in its paid history, and the app's gateway deposit floor must total ฿1 despite `current` also naming it.

## Second fixture: same slot remains allowed

Repeat the first fixture's own simulator intake, request and simulated payment with a second sender, conversation, draft id and original receipt. Keep the **same park/date/start time**. Staff review capacity and explicitly create it. Require two distinct events and exactly one ฿1 deposit on each, never one shared receipt. This proves the owner's capacity rule: no inferred exact-slot/day exclusivity.

## Evidence and exact retirement

- Capture the disabled pre-payment creation control, explicit simulator verification label, and the BEO's one test deposit through the repository's automated staging browser QA or native CUA. CUA availability is not a prerequisite for repository browser verification. Inspect each image before committing/attaching it. A backend-only card must be clearly labelled and must not be called native UI evidence.
- Bind API responses to independent database readbacks at the before-request, before-payment, after-payment/no-event, after-explicit-booking and replay checkpoints. Retain original refusals and errors honestly; do not collapse a retry into an initially green result.
- Census the exact created ids before cleanup. Archive each own event through the existing app manager route `POST /api/admin/events/:id/archive`, and independently read `is_archived=true`. Require the `ZZ TEST 987 <run>` identity, expected operator/park and exact linked conversation before any archival action.
- Archive only these two synthetic Inbox conversations in one guarded cleanup transaction, checking their exact ids, own test contact names/handles and provider=simulator first. This is a fixture retirement, not permission to clear any real Inbox thread. Preserve their payment attempts, request rows, billing/provenance and audit history; do not invent a refund or delete financial records.
- If the run stops unpaid, close only the exact own pending simulator attempt through the existing cancellation service before retiring its thread, then read back terminal unpaid status. If simulated payment succeeded but booking did not, retain the paid receipt and record the unresolved fixture explicitly; do not mark it refunded or auto-book merely for cleanup.
- Require zero active calendar events, visible synthetic conversations and queued outbound messages for the two exact fixture ids after retirement. Preserve any financial history with a receipt identifying it as simulator-only.
- Sign out the app (`POST /api/logout`) and platform (`POST /auth/sign-out`) sessions. Independently require the old cookies to return 401. Record exact own session cleanup; do not alter the owner or Tom's sessions.
- Finish with a deployment readback proving the same reviewed app/API/Inbox source remained live throughout. Root publishes inspected evidence on SCRUM-987 with explicit simulator/real-merchant limits and retains owner acceptance status.
