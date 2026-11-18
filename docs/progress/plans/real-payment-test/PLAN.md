# One real payment test: the plan

**State, 18 November 2026: a plan only.** The owner asked for it on
18 November ("prepare the plan"). Nothing is built, switched or paid before
his go. Six choices are his (section 3); each has a default. Secrets are typed
by the owner himself into the hosting dashboard; nobody else sees or records
one. Setting NAMES only appear here.

**In short.** Every payment proof so far used the pretend gateway (the
staging payment simulator). This plan takes one real PromptPay QR payment of
10 baht at a staging till, paid from the owner's own phone, checks it in every
place it should appear, reverses it the same day, and puts staging back as it
was.

**Recommendation.** Skip a separate round on the gateway's test system and go
straight to one real QR on staging, starting that session with one QR shown
and cancelled (no money moves) to prove the settings. Two reasons: the
gateway's test system cannot pay a PromptPay QR at all (found in October), so
it cannot rehearse this path; and with real settings the code fails safely (a
wrong key means no QR appears; if the gateway's message never arrives the
platform asks the gateway itself; a wrong amount is held for a person and the
sale is not closed).

Marks: **[code]** read in the code on 18 November; **[notes]** from project
notes; **[unknown]** only a real run or the gateway can answer.

## 1. What the code says

**How the gateway is chosen [code].** Two providers exist: 2C2P and the
built-in simulator. `PGW_PROVIDER` picks one; 2C2P is used only when it is
named and both `PGW_MERCHANT_ID` and `PGW_SECRET_KEY` are filled in, otherwise
the simulator runs (on staging quietly, with a line in the log and on
Console > Integrations; on production the api refuses to start). `PGW_ENV`
picks the gateway's test or live system; nothing ties that to staging or
production. The choice is made once, at start-up. Once the real gateway is
chosen the simulator's buttons are refused and its pages answer "not found",
so `PAYMENTS_SIMULATOR` need not change for the test.
(`apps/api/src/env.ts`, `packages/payments-2c2p/src/config.ts`,
`apps/api/src/services/payments/gateway.ts`, `apps/api/src/routes/webhooks.ts`)

**What one real payment needs [code].** On the api service only:

- Required: `PGW_PROVIDER`, `PGW_ENV`, `PGW_MERCHANT_ID`, `PGW_SECRET_KEY`.
- Needed in practice: `PGW_BACKEND_RETURN_URL`, the address the gateway posts
  its "payment made" message to: the api's public address followed by
  `/webhooks/2c2p/payment`. Empty means only our own asking confirms payments.
- Leave empty for the test: `PGW_WEBHOOK_SECRET` (a noise filter, not
  security; set wrongly it silently refuses every gateway message while
  payments still close through our own asking).
- Only for a refund through the gateway: `PGW_MAINT_PRIVATE_KEY` and
  `PGW_MAINT_2C2P_PUBLIC_KEY`, a key pair exchanged with the gateway. Without
  the pair every refund through the gateway fails.
- Everything sent and received is signed with `PGW_SECRET_KEY` and checked.
  The gateway's message is only a trigger: the platform asks the gateway about
  the invoice itself and settles only if that answer agrees.

**The payment kinds [code unless marked].**

| Kind | Confirmed by | Money back |
| --- | --- | --- |
| PromptPay QR at the counter till and the phone till (only on a station whose QR is routed to the gateway) | The gateway's message and our own asking, whichever is first | Unpaid: Cancel. Paid: a manager's refund from History asks the gateway to void (same day) or refund; if refused or the refund keys are missing, the till records cash handed back |
| Card at the till | The card terminal, through the box; not the gateway | A terminal void, otherwise cash. Not part of this test |
| Deposit link before a birthday booking (inbox, SCRUM-987) | Both | **No refund route in the platform**: a deposit has no sale. Money goes back outside the platform |
| Party deposit link after booking (HR app, SCRUM-825) | Both | Kept as the party's; back outside the platform |
| Party balance and BEO additional bill at the till (SCRUM-732, SCRUM-990) | As the till QR | Through the party's settlement refund; whether a QR goes back through the gateway was not traced [unknown] |
| Booking site checkout | Both | Not traced [unknown] |
| Booth | Takes no money | - |

**Staging and production [code, notes].** Production's start-up check looks
only at the provider and the two credentials. Production today holds
placeholders in them, has no till set-up and so cannot take a till QR or a
deposit link yet. Staging can be pointed at the gateway's test system or at
the live merchant; nothing refuses either.

**What the simulator hides.**

- A wrong key shows at once and safely: no QR, nothing charged. [code]
- A broken message address stays hidden, because our own asking still closes
  the sale. The Console audit entry "payment settled" names which route
  settled it. [code]
- Amounts travel as fixed baht-and-satang text; a different or unreadable
  amount, a currency other than THB, or a payment after our expiry or a cancel
  is held for a person and does not close the sale. [code]
- After switching back to the simulator, a real payment still waiting would be
  answered "not found" and closed: the test must be finished before staging is
  switched back. [code]
- Only a real run or the gateway can answer [unknown]: whether its answer for
  PromptPay carries the currency (if not, every real payment would be held for
  a person); whether the live system wants the QR call signed; whether our
  message address must be registered in its portal first; whether and until
  what hour a PromptPay payment can be voided or refunded (its documents name
  21:00 Bangkok for same-day QR voids); its minimum amount, fees and how long
  money takes to come back; whether PromptPay QR is switched on for the park's
  merchant.

## 2. The plan

### Before the day

The owner:

- gets from the gateway: the live merchant id and secret key, a login to its
  merchant portal, confirmation that PromptPay QR is on, whether our message
  address must be registered (and registers it if so), and whether a PromptPay
  payment can be voided or refunded in the portal;
- picks a quiet weekday hour ending well before 21:00 Bangkok;
- gives the go.

We, after the go:

- confirm one staging till station sends QR to the gateway and has a code
  prefix;
- add one item, "ZZ TEST real payment", at the chosen price;
- send the owner the setting names and the one message address to paste (the
  address is not a secret).

### The real payment (staging, live merchant, about one hour)

Staging, because production has no till yet and stays untouched.

1. **The owner, in the hosting dashboard, on the staging api service:** sets
   `PGW_PROVIDER` and `PGW_ENV` for the gateway's live system; enters
   `PGW_MERCHANT_ID`, `PGW_SECRET_KEY` and `PGW_BACKEND_RETURN_URL`; leaves
   `PGW_WEBHOOK_SECRET` empty; adds the two refund keys only if choice 6 is
   "refund from the till"; saves. The service restarts.
2. **We** check Console > Integrations: the gateway on its live system, no
   missing setting, the message address set. That page shows names and yes/no
   only.
3. **Dry check, no money:** ring up the ZZ TEST item, press QR, see a real
   code, press Cancel. This proves the key, the merchant id and that PromptPay
   is on.
4. **The real payment:** ring up the item again, press QR; the owner scans it
   with his bank app and pays.
5. **Checks, within minutes:** the till shows the sale paid and closed with a
   receipt number; the payment record shows paid by the gateway with our
   invoice number and its reference; the Console audit log has "payment
   settled" for that invoice and names the route; the Console Failures page
   has no refused gateway message; today's End of Day on staging includes the
   amount on the PromptPay line; the gateway's portal shows the same invoice
   and amount; the owner's bank app shows the debit. **Stop rule:** if the
   payment is held for a person, nobody presses Confirm; we write down why and
   go to the reversal.
6. **Reversal, the same day** (choice 6). Default: the owner voids or refunds
   it in the gateway's portal and nothing is pressed in the till (a till
   refund without the refund keys would record cash handed back). Otherwise a
   manager refunds the sale in History and we check it reads "Voided at the
   gateway" or "Refunded at the gateway" and the PromptPay line comes back
   down. Either way the portal shows the payment reversed and the bank shows
   the money back; how long that takes is the gateway's and the bank's.
7. **Staging back as it was:** we confirm no real QR is still waiting; the
   owner deletes `PGW_MERCHANT_ID`, `PGW_SECRET_KEY`,
   `PGW_BACKEND_RETURN_URL` and any refund keys and sets `PGW_PROVIDER` and
   `PGW_ENV` back to the staging values recorded in `render.yaml`; we check
   Console > Integrations shows the simulator again and take one pretend QR.
   Test records keep their ZZ TEST names. The result goes on SCRUM-709 (what
   the park must obtain before real QR payments can be taken), setting names
   only.

During that hour the simulator is off on staging, so no other staging payment
test runs, and nobody presses "Reset demo data".

### Optional rehearsal (only if choice 1 says so)

The same steps with a gateway test merchant and `PGW_ENV` on its test system.
A QR can be shown and cancelled there but not paid; to see money move, a
deposit link from a ZZ TEST inbox thread is paid with the gateway's published
test card. Staging is put back the same way.

## 3. The owner's choices (default first)

1. **Rehearse on the gateway's test system first?** No: start the real session
   with one QR shown and cancelled (default). / Yes: a short round with a test
   card first; needs a test login.
2. **Which payment path?** PromptPay QR at the till (default). / A deposit
   link from the inbox (it has no refund route in the platform). / Card on the
   gateway's page.
3. **Amount?** 10 baht (default). / 1 baht. / 20 baht.
4. **Where?** Staging, with the live merchant settings for one hour
   (default). / Production, after the till goes live there (SCRUM-925).
5. **Who pays?** The owner, with his own phone and bank app (default). / A
   staff member.
6. **How is it reversed?** Void or refund in the gateway's portal the same day
   (default). / Refund from the till through the gateway: needs the refund key
   pair, and also proves the platform's own refund path. / Not reversed: it
   arrives in the merchant account less the gateway's fee.

## 4. What one test does not prove

- Card at the counter through the terminals, and the terminal's own QR.
- The deposit links, the booking site, the party balance, the BEO additional
  bill and the phone till's hand-over: the same gateway code underneath, but
  not run with real money unless chosen in choice 2.
- Refunds on any other path; deposits have no refund path in the platform.
- Real-money edge cases: paid late, wrong amount, expiry, paid after cancel.
- Settlement: the gateway's daily file, the payout to the bank and fees.
- Production's own gateway settings and message address (SCRUM-925).
- Busy-day load, internet outages and offline selling.
