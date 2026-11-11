# SCRUM-825 — staging proof: a party's deposit asked from the BEO through the family's chat

**When:** 11 November 2026, 17:36–17:52 Bangkok (10:36:04Z–10:51:50Z).
**Result:** the request, the payment and the confirmation **worked on the simulated gateway**. **One gap holds the
ticket:** the payment link the assistant posts has **no host** on this deployment, so it does not open from the
chat as posted (the setting `PGW_BACKEND_RETURN_URL` is not set on `oto-api-staging`). The status was left as it was.

## The deploys

| Service | Live when the run began | Live when it ended |
|---|---|---|
| oto-api-staging | `dep-dbq46qmgekts73akmddg` at **e01476a1** (live 10:33:22Z) | `dep-dbq4d03rjlhs73b7cdp0` at bfd04cd2 (live 10:46:21Z) |
| oto-app-staging | `dep-dbq46qoae00c73d95u20` at **e01476a1** (live 10:32:11Z) | the same |
| oto-inbox-staging | `dep-dbq46r9srm7s739fa220` at **e01476a1** (live 10:29:54Z) | `dep-dbq4ci6k1f9s73dj4u30` at 70cb96d6 (live 10:42:00Z) |

The run began 2 min 40 s after the last switch-over. The api and the inbox were redeployed during the run by other
landings; both later commits contain e01476a1 and change nothing of the deposit (`display.ts`, the inbox composer,
tests). Steps A–C on the first party ran on the api at e01476a1; the second party and the till's quote reading on
the api at bfd04cd2.

## Prerequisites (names only; presence and length, never a value)

| Service | Name | State |
|---|---|---|
| oto-api-staging | `PGW_PROVIDER` | set (9 chars) — the simulated gateway |
| oto-api-staging | `PGW_BACKEND_RETURN_URL` | **absent** |
| oto-api-staging | `PGW_FRONTEND_RETURN_URL` | absent |
| oto-api-staging | `PGW_MERCHANT_ID`, `PGW_SECRET_KEY` | **absent** |
| oto-api-staging | `PGW_ENV`, `PGW_BASE_URL`, `PGW_WEBHOOK_SECRET`, `PGW_QR_CHANNEL_CODE`, `PGW_CURRENCY_CODE` | absent (defaults) |
| oto-api-staging | `PARTY_DEPOSIT_LINK_VALIDITY_MIN`, `PARTY_DEPOSIT_REMINDER_MIN`, `PARTY_DEPOSIT_HANDOVER_MIN` | absent (defaults: 3 days, 24 h, 24 h) |
| oto-app-staging | `PLATFORM_API_URL` | set (36 chars) |
| oto-app-staging | `OTOAPP_PROVISION_KEY` | set (64 chars) |
| oto-app-staging | `OTOAPP_PUBLIC_ORIGIN` | set (36 chars) |

What the absent names block:

- **`PGW_BACKEND_RETURN_URL`** — on the simulated gateway the link is this api's own path
  (`/webhooks/2c2p/hosted/<attempt id>`); the code puts the host of this setting in front of it and, with the
  setting absent, posts the bare path. A family cannot open that from WhatsApp. To pay, the proof put the api's
  own address in front of the path by hand (declared in `receipt.json`, `C_pay.pay.opened`).
- **`PGW_MERCHANT_ID` and `PGW_SECRET_KEY`** (with `PGW_PROVIDER` naming 2C2P) — 2C2P's real sandbox page and its QR
  were not shown. Everything below is on the simulated page ("Simulated payment page — no real money moves").

No setting was changed.

## How

One headless Chromium (Playwright) drove the inbox's and the app's own screens; every write was a button of theirs,
except the clean-up and one declared edit (below). The staging administrator signed in through the launcher and was
handed into the inbox and into the OTO App. Two fresh ZZ TEST simulator numbers wrote into **Demo WhatsApp · Central
Floresta** with the hint *Birthdays & Events*. The payment page was opened in a separate browser context with no
session, as the family would. Names, initials, phone-like numbers, the payment link and the invoice number are
covered in every picture; the conversation list is masked. `receipt.json` keeps a link's host and shape only.

## The steps

### A. A ZZ TEST family, Book Date, Create BEO — worked

- "ZZ TEST 825 family": "Hi! A birthday party for ZZ Test Child turning 7, 12 kids and 4 adults, Saturday 28 November
  at 2pm (ZZ TEST 825)" (simulator 200, processed). The assistant: "Thank you so much! Our birthday manager will be
  with you shortly." and a hand-over.
- Book Date read the whole chat: 28 Nov 2026, 14:00, Central Floresta, 12 kids, 4 adults, ZZ Test Child, 7. The party
  "ZZ Test Child's 7th Birthday" was booked tentative, once.
  *Note:* the response the harness read for the press was **409 EVENT_ALREADY_BOOKED**, while the thread already
  carried its "date booked" pill and one event. On the second thread the press was watched request by request: one
  POST, 200. Not explained; nothing was booked twice (two ZZ TEST events made in the run, one per thread).
- Create BEO: `POST …/open-beo` 200, the app hand-off 200, the BEO editor open on the party. There was no review to
  approve: AI Fill answered 409 "no message from the team in this conversation names the date, the time and the
  party details yet" (SCRUM-827's subject; this thread has no team confirmation).

### B. Request deposit — worked; the link has no host

- Billing section, the panel **Deposit from the family's chat**: "No deposit asked yet…", *Deposit to ask*,
  *Request deposit*, *Send the menu choice link* → `825-02-billing-panel-before.png`, `825-03-amount-typed.png`.
- 3000 typed, **Request deposit** pressed: `POST /api/events/:eventId/beo/deposit-request` **200**, not a replay;
  the request `requested`, 300000 satang THB, the line's delivery `sent`, valid until 14 Nov 17:40 (3 days).
  The panel: badge **Requested**, "Deposit requested · ฿3,000 — The payment link is in the family's chat, valid
  until 14 Nov, 17:40", *The payment link*, **Resend**, **Cancel request** → `825-04-deposit-requested.png`.
- The thread: the assistant's ONE line "To confirm your party on Saturday 28 November 2026 we kindly ask for a
  deposit of ฿3,000. You can pay it securely here: ‹link› (valid until 14 Nov, 17:40). Your booking is confirmed as
  soon as the deposit arrives 🎈", the pill **Deposit requested ฿3,000**, the chip "Event: 28 Nov 2026 at Central
  Floresta · Deposit requested ฿3,000" → `825-05-thread-deposit-requested.png`.
- **The link's host: none.** The link is `/webhooks/2c2p/hosted/<attempt id>` — a path, not an address.

### C. Pay — worked on the simulated page (opened with the api's address put in front by hand)

- The page (host `oto-api-staging.onrender.com`, 200): "Simulated payment page — no real money moves. The real one
  is 2C2P's. ฿3,000 · OTO Park party deposit 2026-11-28 · PPQR, CC", **Pay** / **Fail** → `825-06-payment-page.png`.
- **Pay** pressed: 200; the browser returned to `/public/parties/deposit/return`: "Thank you — your deposit is being
  confirmed. You will get a message in the chat as soon as it is in." → `825-07-after-pay-return.png`.
- Read back 9 s later through the app (`GET /api/events/:eventId/beo/deposit-request`): **paid** at 10:42:34Z,
  deposit before 0, **after 300000 satang**, write-back **synced**. The event (`GET /api/admin/events/:id`):
  prepayment **3000**, dated **2026-11-11**.
- The thread: "Thank you! We have received your deposit of ฿3,000 — your party on Saturday 28 November 2026 is
  confirmed. See you then! 🎉", the pill **Deposit paid ฿3,000**, the chip "… · Deposit paid ฿3,000" →
  `825-08-thread-deposit-paid.png`.
- The Billing section after a fresh load: badge **Paid**, "Deposit paid · ฿3,000 — Paid 11 Nov, 17:42 through the
  chat. The deposit figure is updated here and at the till." → `825-09-billing-deposit-paid.png`.
- **The till's own reading.** As booked, the till had no quote for this party ("The package names no price for a
  child beyond its included count": 12 children on a package of 10). After the payment the ZZ TEST party was set to
  10 children through the app's own event route (`PATCH /api/admin/events/:id` 200; the deposit untouched). Then
  `GET /api/events/:eventId/beo/till-billing`: a quote, total 1090000, **deposit 300000**, balance 790000 satang; the
  panel **From the till**: Expected total ฿10,900 · **Deposit paid ฿3,000** · Outstanding ฿7,900 →
  `825-14-from-the-till-deposit.png`.

*For a decision (seen in `825-09`):* the app's own **Financial Summary** below the panel still reads "Deposit Paid: 0"
and no date after the payment. This party has no billing row of the app's own yet (`GET …/beo/billing` answers
null), and the deposit is copied into that module only where a row exists (SCRUM-813's rule). The party's one deposit
(the event's prepayment, the till's reading) is ฿3,000.

### D. Replay, Resend, Cancel, the menu link

- **A second press of Pay:** the page now reads "This payment is paid." and offers no Pay; a second POST of pay
  answered 200 and changed nothing — one "Deposit paid" pill, one confirmation line, the deposit still 300000.
  (A second press on the simulated page, not a gateway redelivery; redelivery is covered by tests.)
- **A second party** ("ZZ TEST 825 second family", Sunday 29 November, 11:00, 10 kids, 3 adults; Book date one POST
  200; Create BEO as above). Request deposit 2500 → 200, `requested`.
  **Resend** → 200: the same line a second time and the pill **Deposit requested ฿2,500 · resent** →
  `825-10-second-party-resent.png`, `825-11-second-thread-resent.png`.
  **Cancel request** → 200, `cancelled` (staff): the panel "Request cancelled · ฿2,500 — Withdrawn from the BEO.
  Press Request deposit to ask again."; the pill **Deposit request cancelled by ‹the person› · ฿2,500**; nothing said
  to the family; the chip back to "Event: 29 Nov 2026 at Central Floresta" → `825-12-second-party-cancelled.png`,
  `825-13-second-thread-cancelled.png`.
- **Send the menu choice link** → **409 NO_MENU_LINK**, in the panel: "This party has no menu choice link yet.
  Generate the parent link in the BEO's set menu first." (no set menu on the party) → `825-15-menu-link-refused.png`.

### E. Clean-up and sign-out

- The second party: no open request left (cancelled above); archived (`POST /api/admin/events/:id/archive` 200, read
  back archived), its thread marked handled (200, read back handled).
- **The first party was left as it is.** At 10:48:50Z a deposit request of **฿5,000** appeared on it, with its own
  line and pill. No step of this run made it (this run's one press there was ฿3,000 at 10:40:53Z). Other proofs
  were running on staging at the time. It was not pressed and not cancelled; the party "ZZ Test Child's 7th
  Birthday" (28 Nov) is still live with that request open, and its thread is not marked handled. The paid ฿3,000 is
  untouched (the last read: history paid 300000 + requested 500000; the till's deposit 300000).
- Every session signed out (inbox, app, launcher: 200; read back 401). The driver stopped through its /STOP.

## Not shown, and why

- The reminder and the hand-over: 24 h + 24 h by default and no setting was changed — covered by
  `apps/api/test/party-deposit.test.ts`.
- The link running out: not waited for — covered by tests.
- 2C2P's real sandbox page and QR: the deployment runs the simulated gateway.
- The menu line being posted and "menu choices received": no parent link on the parties — covered by tests.
- A gateway redelivery of the paid notification; the birthday manager's bell; the Quote PDF, Party Details and the
  Day-of view; the till's Settle preview on a till screen (the till's reading was taken through "From the till").

## Files

`receipt.json` (every status, figure and read-back), `825-02` … `825-15` (fourteen pictures; there is no `825-01`).
