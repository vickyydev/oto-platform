# Connecting the real payment gateway: the plan

**State, 18 November 2026: a plan only.** The owner asked for it on his
decisions page on 18 November, after answering the choices of `PLAN.md` in
this folder. `PLAN.md` stays as it was; this file replaces its plan for the
new shape. Nothing is built, switched or paid before his go. Secrets are typed
by the owner himself into the hosting dashboard; nobody else sees or records
one. Setting NAMES only appear here.

## What the owner said, and how we read it

His answers: the credentials have arrived from 2C2P (the SCB payment
gateway); no rehearsal on the gateway's test system; PromptPay QR at the till;
1 baht; on staging with the real credentials; he pays with his own phone; the
money goes back by a refund from the till, with "additional approvals by
manager and permissions for refunding from till"; and "connect real gateway
and plan for it".

**Our reading, for him to correct.** He no longer wants a one-hour test that
is then removed. He wants the real 2C2P gateway connected. The first proof is
one real 1 baht PromptPay QR on a staging till, paid by him and given back by
a refund from the till. Refunds from the till must be guarded by a manager's
approval and by a permission. There is no rehearsal on the gateway's test
system.

**In short.** Most of what he asked for is already built. Connecting is a
matter of settings he types himself. Reception can already open a refund but
only a manager can make it. Three things need his choice: what stays connected
on staging after the proof (the pretend gateway that staging's payment proofs
use cannot run beside the real one); whether he has the second key pair a refund
through the gateway needs (the merchant id and secret key alone are not
enough); and whether he wants more control on refunds than today's rule.
Section 7 lists eight decisions.

Marks: **[code]** read in the code on 18 November (checkout at `d751e2b10`);
**[notes]** from project notes; **[unknown]** only a real run or 2C2P can
answer.

## 1. What "connected" means on each system

### How the gateway is chosen [code]

- One choice per api service, made once at start-up. `PGW_PROVIDER` set to
  `2c2p` with both `PGW_MERCHANT_ID` and `PGW_SECRET_KEY` filled in means the
  real gateway. Anything else means the built-in pretend gateway (the
  simulator) on staging, and a refusal to start on production.
  (`apps/api/src/env.ts:1029-1068`, `:1168-1176`)
- `PGW_ENV` picks the gateway's test system (`sandbox`) or its live system
  (`production`). That word has nothing to do with our own staging and
  production: staging connects to the live system by setting it to
  `production`. (`packages/payments-2c2p/src/config.ts:16-29`)
- Switching back needs only `PGW_PROVIDER` set to `simulator`: the simulator
  then runs even with the real merchant settings still stored.
  (`apps/api/src/env.ts:1044-1051`)

### What one station decides [code]

- Each selling station has a QR setting in Console > Devices: "The payment
  gateway, on the customer display", "The QR terminal above" or "Not taken
  here". Unset means the QR terminal. Only a station set to the payment
  gateway sends its QR to the gateway.
  (`apps/console/src/components/devices/StationDrawer.tsx:503-514`,
  `packages/shared/src/station-readiness.ts:5-9`,
  `apps/api/src/services/payments/routing.ts:105-130`)
- A station set to the QR terminal uses its box's terminal. On staging that is
  the virtual box's pretend terminal [notes: go-live `PROGRESS.md`, settings
  section], so such a till keeps pretend QR payments whatever the gateway is.
- The real or pretend choice itself is NOT per station or per park. It is the
  whole api service. The booking site, the deposit link the inbox sends
  before a birthday booking (SCRUM-987) and the party deposit link asked from
  the HR app (SCRUM-825) have no station: they always use the service's
  gateway. (`apps/api/src/services/payments/gateway.ts:353-376`;
  callers in `booking-checkout.ts`, `party-deposit.ts`,
  `inbox/prebooking.ts`)

### Staging, once the real gateway is chosen [code]

- The Console's pretend payment panel is refused ("This deployment is
  configured for the real gateway"). The pretend pay or fail page for
  bookings and deposit links answers "not found".
  (`gateway.ts:2726-2730`, `:2858-2868`)
- Every QR at a till set to the payment gateway is real money. Every booking
  site checkout and every deposit link is a real 2C2P page.
- The platform keeps asking the gateway about every QR still waiting,
  pretend ones made before the switch included; the real gateway answers "not
  found" and they close. Harmless. (`gateway.ts:2231-2355`)
- A refund of a sale paid earlier through the simulator is sent to the real
  gateway, refused, and recorded as cash handed back. Harmless on staging, but
  confusing to whoever reads it. (`apps/api/src/services/refunds.ts:139-146`,
  `:840-900`)
- "Reset demo data" deletes every payment record, real ones included
  (`apps/api/src/services/demo-reset.ts:113`, `:372-373`). The day's invoice
  counter then starts again, and 2C2P refuses an invoice number it has
  already seen, so the next QR at that till that day would be refused and an
  alert raised (`gateway.ts:255-286`, `:758-774`).
- Real payments taken on staging land in the merchant's reports and payout,
  told apart by staging's invoice prefix `PGW_INVOICE_PREFIX` (`SBX` in
  `render.yaml:641-644`; the dashboard value is what runs [notes]).

### Switching back [code]

- A real QR still waiting when staging switches back is asked of the
  simulator, answered "not found" and closed. If the guest then pays, the
  money reaches the merchant and no sale records it. So the switch is made
  only when Console > Integrations lists no QR waiting.
- A real payment refunded from the till AFTER switching back goes to the
  simulator, is refused, and is recorded as cash handed back. Real payments
  are refunded while still connected, or in the gateway's portal.

### The options for staging

| Option | Supported today | What it costs |
| --- | --- | --- |
| A. Connected for each real check, then back to the simulator | Yes | One setting and a restart each way, typed by the owner. Staging's pretend flows are untouched between checks |
| B. Connected permanently, only one till set to the payment gateway, the others on the pretend terminal | Yes | The pretend panel and the pretend booking and deposit pages are gone for everyone; any booking or deposit tested on staging is real money; "Reset demo data" deletes real records; everyone testing on staging must be told |
| C. Connected permanently, every till on the payment gateway | Yes | As B, and every till QR on staging is real money |
| D. Pretend and real side by side, chosen per till or per park | No, needs building | Medium build: the gateway chosen per payment instead of per service; asking, refunds and the gateway's messages routed by the payment's own gateway; the status page showing both. Pretend money code then lives beside real money |
| E. A second staging (its own api, database, till and Console) connected, the current staging left pretend | The code, yes; the hosting, no | Paid services and a database, their own data and addresses, set-up work |
| F. Staging stays pretend; production is connected when its till goes live | Yes | The first real proof moves to production after SCRUM-925 (production's set-up before its till goes live), not staging as the owner chose |

### Production [code, notes]

- Its start-up check refuses to start when the simulator would run. It only
  checks that the merchant id and secret key are filled in, so placeholders
  pass, and the status reads "2C2P" with nothing missing although no QR could
  be made. Only a real QR proves production's settings. (`env.ts:1168-1176`)
- Today it holds placeholders in `PGW_PROVIDER`, `PGW_MERCHANT_ID` and
  `PGW_SECRET_KEY`; every other setting was copied from staging key by key
  [notes: `docs/progress/plans/go-live/PROGRESS.md`, "What the code required"
  item 1 and "Settings that differ from staging"]. So `PGW_ENV` and
  `PGW_INVOICE_PREFIX` probably hold staging's values [unknown until read].
  At connection: `PGW_ENV` to `production`; `PGW_INVOICE_PREFIX` empty, as
  `render.yaml:641-644` says for production, and in any case different from
  staging's; `PGW_BACKEND_RETURN_URL` to production's own api address
  followed by `/webhooks/2c2p/payment`; the refund key pair.
- SCRUM-925 (production's set-up before its till goes live) already lists
  what production needs: the real merchant details, the virtual box role
  (or a real box), `OTOAPP_DIRECTORY_KEY`, the till's own configuration
  (packages, prices, tax) and a storage bucket of its own [notes]. No till
  station exists there yet, so no till QR can be taken.
- Production has no Console (`VITE_CONSOLE_URL` not set [notes]). The same
  status can be read from the api with an administrator's session at
  `GET /webhooks/2c2p/simulator`, which despite its name is the status read
  (`apps/api/src/routes/webhooks.ts:153-166`).
- Once production is real, the HR app's party deposit request and the inbox
  deposit link would also take real money there, because they use the same
  gateway [code]; whether either is reachable on production today [unknown].

### One merchant or two [code, unknown]

- 2C2P's invoice numbers must be unique per merchant. Staging's prefix keeps
  staging's numbers apart from production's, as long as the two prefixes
  differ (`gateway.ts:192-286`).
- We send our message address with every payment request
  (`packages/payments-2c2p/src/twoc2p.ts:132-152`). If 2C2P instead uses one
  address registered in its portal per merchant, only one of the two systems
  would receive the gateway's messages; the other would still close payments
  by asking the gateway itself, a little later [unknown which 2C2P does].

## 2. The settings

### First: what the credentials are

- **The code speaks to 2C2P's Payment API only** [code: two providers exist,
  `2c2p` and `simulator`]. That needs a merchant id (a short code) and a
  secret key (a long string of letters and digits).
- If what arrived is instead an "API key" and "API secret" from SCB's own
  developer portal, those belong to SCB's direct interface, which was kept as
  the second choice and never built [notes:
  `docs/architecture/PAYMENT_GATEWAY.md` section 6].
- Live or test: a merchant from 2C2P's test system works only on the test
  system. The welcome message or the portal he signs in to tells which (test
  portal at demo2.2c2p.com, live portal at client.2c2p.com; both marked
  uncertain in `PAYMENT_GATEWAY.md`). The dry check in section 5 shows it too:
  a test merchant on the live system gives no QR.
- The refund key pair is separate; section 3 says how to tell whether he has
  it.

### By name, who and in what order

All on the staging api service (`oto-api-staging`), typed by the owner in
the hosting dashboard. Never in a chat, a file or a ticket.

| Setting | What it is | Value |
| --- | --- | --- |
| `PGW_MERCHANT_ID` | The merchant id | From 2C2P; the owner types it |
| `PGW_SECRET_KEY` | The secret key; it signs and checks every payment message | From 2C2P; the owner types it |
| `PGW_BACKEND_RETURN_URL` | The message address (not a secret) | `https://oto-api-staging.onrender.com/webhooks/2c2p/payment` [notes: `docs/progress/DEPLOYMENT_STAGING.md`; code: `routes/webhooks.ts:80-81`, `app.ts:553`] |
| `PGW_ENV` | Which 2C2P system | `production` (the gateway's live system) |
| `PGW_PROVIDER` | Real or pretend | `2c2p` |
| `PGW_MAINT_PRIVATE_KEY` | Our private half of the refund key pair | Only if he has it (section 3) |
| `PGW_MAINT_2C2P_PUBLIC_KEY` | 2C2P's public half of the refund key pair | Only if he has it (section 3) |

Left empty: `PGW_WEBHOOK_SECRET` (a noise filter, not security; set wrongly
it silently refuses every gateway message), `PGW_BASE_URL` and
`PGW_MAINT_BASE_URL` (the live addresses follow from `PGW_ENV`). Left as they
are, and read before the day: `PGW_QR_CHANNEL_CODE` (`PPQR`), `PGW_QR_TYPE`
(`RAW`), `PGW_CURRENCY_CODE` (`THB`), `PGW_PAYMENT_EXPIRY_MIN` (`20`),
`PGW_INVOICE_PREFIX` (not empty). `PAYMENTS_SIMULATOR` may stay on; it does
nothing while the real gateway is chosen. (`render.yaml:597-676`,
`env.ts:546-645`)

The order:

1. We check Console > Integrations shows the simulator and no QR waiting.
2. The owner types all the values above in one save, so the service
   restarts once. If they go in one at a time, `PGW_PROVIDER` goes last; and
   if it goes in early, staging quietly keeps the simulator until both
   merchant settings are in, which is safe [code].
3. Each key is pasted whole, with its line breaks and its BEGIN and END lines.
   The code reads them exactly as typed and has no setting for a key password
   [code: `env.ts:641-645`, no conversion in `loadEnv`].

### The message address

- It is sent with every payment request [code]. Empty still works: payments
  then close only by our own asking.
- Whether 2C2P also wants it registered or allowed in its portal is
  [unknown]; the note in `render.yaml:617-622` says it must match what is
  registered there. The owner asks 2C2P and registers it if so.

### How the result is checked without seeing a value

- Console > Integrations shows: which gateway (2C2P or simulator), which 2C2P
  system, the NAMES of missing settings, whether the message address is set
  (yes or no), whether a message filter is set, whether the refund key pair is
  set (yes or no), the QR channel, and the QRs still waiting. Never a value.
  (`gateway.ts:2608-2685`)
- The api's start-up log says "payment gateway: 2C2P, production, channel
  PPQR." with names only (`gateway.ts:168-177`).
- These show presence only. A wrong secret, a wrong merchant id or a badly
  pasted key all read as set. The dry check proves the merchant id and the
  secret; only a refund proves the key pair.

## 3. Refund from the till through the gateway

### What happens today [code]

- Where: History on the counter till, or on the phone till: the whole sale,
  chosen items or a typed amount, with a reason every time. Online only. The
  station needs a code prefix, because the refund gets its own number from
  the station's refund series. (`apps/pos/src/components/history/SaleDetail.tsx`,
  `RefundModal.tsx`, `apps/pos/src/components/mobile/history/MobileRefundFlow.tsx`,
  `refunds.ts:425-437`)
- Who: section 4.
- Where the money goes: wallet first, then the tenders that took it, newest
  first, then cash for any rest. A QR paid through the gateway goes back
  through the gateway, whole or part. (`packages/shared/src/refund.ts:184-255`)
- The refund is saved first, in one step: its number, the sale marked
  refunded, stock back, bands cancelled, the audit row. Only then does the
  platform call the gateway's refund interface, which has its own address and
  its own key pair. (`apps/api/src/routes/sales.ts:1160-1181`)
- Same calendar day in the park's timezone: it asks for a void. Another day:
  it asks for a refund. If the gateway answers code 4121 (the other kind was
  needed) it tries the other once. (`refunds.ts:840-900`)
- Success: History says the money was "refunded through the payment
  gateway", with "Voided at the gateway" or "Refunded at the gateway"; the
  audit log has `refund.gateway_refunded`; End of Day takes it off the
  PromptPay line.
- Refused or unreachable: History says "the gateway refused the refund" and
  tells staff to "hand it back in cash"; the audit log has
  `refund.gateway_refused`; End of Day
  counts it as cash out of the drawer (`apps/api/src/services/end-of-day.ts:161-171`).
  The refund and the sale's refunded state stand either way.
- Never sent twice: a refused refund is final and there is no retry button. If
  the service stops between saving and calling, the refund stays "refund sent
  to the payment gateway" for a person to finish; nothing resends it.

### What it needs: the refund key pair

- `PGW_MAINT_PRIVATE_KEY` and `PGW_MAINT_2C2P_PUBLIC_KEY`, both. Not
  `PGW_SECRET_KEY`: refunds use a different lock and key from payments.
  (`packages/payments-2c2p/src/maintenance.ts:17-50`)
- What the pair is, in plain words. There are two pairs. The park's own pair
  is made by the park: the private half goes only into the dashboard, the
  public half is given to 2C2P. 2C2P's pair is made by 2C2P: it keeps the
  private half and gives the park its public half. So the dashboard holds the
  park's private half and 2C2P's public half. Where the park's public half is
  uploaded, and how 2C2P's is obtained, is not in 2C2P's public documents; it
  comes from 2C2P's onboarding [notes: `PAYMENT_GATEWAY.md` sections 2.2 and
  5].
- How the owner can tell whether "the credentials" include it:
  - A merchant id and a secret key alone are NOT the pair.
  - The pair looks like blocks of text that start with a line such as
    `-----BEGIN PRIVATE KEY-----` (the park's half) and
    `-----BEGIN PUBLIC KEY-----` or `-----BEGIN CERTIFICATE-----` (2C2P's
    half). Nothing like that means he does not have it.
  - Only 2C2P's half: the park's pair still has to be made, and its public
    half uploaded to 2C2P.
  - A private key file that 2C2P's portal made for him: that is the park's
    half.
  - A key protected by a password, or a `.pfx` or `.p12` file, must be turned
    into a plain key first [code: no password setting].
  - Whether the code accepts 2C2P's half when it comes as a certificate
    rather than a plain public key has never been tried [unknown].
- Who makes the park's pair: the owner, on his own laptop, with one command we
  give him, or 2C2P's portal if it offers one. The private half never leaves
  his hands except into the dashboard.
- Whether 2C2P lets staging and production share one pair [unknown]; the
  gateway notes planned a separate production pair.

### When the pair is missing or wrong [code]

- Missing either half: Integrations shows the refund keys as not set, and
  every refund of a gateway QR is recorded as cash handed back, with the words
  "no maintenance key pair is configured". (`twoc2p.ts:283-293`)
- Present but wrong (a wrong half, broken line breaks, not uploaded at 2C2P):
  Integrations still shows them as set, and the first refund fails and is
  recorded as cash handed back ("The gateway could not be reached" or the
  gateway's refusal). Nothing checks the pair before the first refund.
  (`refunds.ts:912-928`)
- A small addition could check the pair with no money: a refund request for an
  invoice that does not exist, where a clean "not found" answer proves both
  halves. It is not built.

### Other facts that matter for the proof

- A payment held for a person (wrong amount, missing or wrong currency, paid
  after it expired) is not counted as taken, so the till cannot refund it. Its
  money goes back through the gateway's portal. (`gateway.ts:1500-1559`,
  `packages/shared/src/payments.ts:188-206`, `refunds.ts:250-297`)
- A void is possible only on the same day, before the channel's cut-off;
  2C2P's table names 21:00 Bangkok for QR. Later it must be a refund of a
  settled payment [notes: `PAYMENT_GATEWAY.md` section 2.7].
- Whether a PromptPay QR can be voided or refunded through this interface at
  all is not confirmed by 2C2P [notes: `PAYMENT_GATEWAY.md` section 2.7,
  "UNCERTAIN"]. The first till refund answers it.

## 4. Manager approval and permissions for refunds

### What is already there [code]

- Two permissions. "Request a refund for a sale" (`pos:refund:create`) is held
  by reception, branch managers and the administrators. "Approve refunds and
  voids after payment" (`pos:refund:approve`) is held by branch managers,
  operator administrators and platform administrators; not by reception or
  staff. (`packages/shared/src/permissions.ts:487-502`, `:513-560`;
  `packages/shared/src/permission-words.ts:89-91`)
- Reception sees the Refund button and can fill in the dialog. Pressing it is
  refused unless the person signed in also holds the approval permission at
  that park: the till says "A refund needs a manager's approval" and asks for
  a manager to make it. (`SaleDetail.tsx:996`, `routes/sales.ts:1142-1158`)
- So approval is the manager's own action. One person, a manager signed in at
  a till, makes the refund. There is no second step and no second person, and
  reception's attempt is not recorded on the refund. The refund keeps
  separate "made by" and "approved by" fields, but today both are the
  manager; History names the manager and adds "manager approval".
  (`refunds.ts:477-478`, `SaleDetail.tsx:614-619`)
- What is recorded: the refund's own number, amount, kind, reason (required),
  note, items, and how each part of the money went back and how it ended; the
  audit rows `sale.refund` (with the approver) and
  `refund.gateway_refunded` or `refund.gateway_refused`, in the Console audit
  log; the History "Refund history" card; End of Day.
  (`refunds.ts:463-485`, `:714-753`)
- The approval is checked at the sale's own park: a manager whose role covers
  one park cannot refund a sale made at another.
- Offline: no refund. The till keeps a "refund requested" note on that device
  only, for a manager later. (`apps/pos/src/lib/refundRequests.ts`)
- Who holds the approval can be seen in Console > Roles and scopes, under
  "Permission holders" (`apps/console/e2e/roles.spec.ts` shows the page).
- There is no amount limit, no daily limit and no separate permission for
  money going back to a bank instead of cash.

### One exception [code]

When a child is picked up from drop-off or nanny care with prepaid food
unused, and the park's setting for unused prepaid food is "refund" (the
default), the platform refunds the unused amount against the child's sale by
itself, with no manager: the staff member releasing the child needs only the
release permission. The code says "the branch's seeded policy IS the
approval". If that sale was paid by a gateway QR, the money goes back through
the gateway. A manager can set the park's setting to "forfeit" instead.
(`apps/api/src/services/release.ts:649-694`,
`apps/api/src/routes/release.ts:199-204`,
`packages/shared/src/supervision.ts:257-277`,
`apps/api/src/routes/checkin.ts:614-629`)

### What could be added

Today's rule is the default. None of these is built. Small means one change in
one place with its tests; medium means a few places and a new screen; large
means a new flow with its own screens and states.

| Addition | What it does | Size |
| --- | --- | --- |
| A permission just for money back through the gateway | Only people the owner names can send money back to a customer's bank; other managers can still refund cash sales | Small |
| Two people | The refund waits on the platform until a different manager approves it on their own screen; the record names both | Medium to large |
| Two people above an amount | Below the amount, today's rule; above it, a second manager or the owner | Medium to large |
| A daily ceiling | A total per park, or per person, of money back through the gateway each day; above it, refused until an administrator approves | Small to medium |
| The child pickup refund | Cash only, never through the gateway; or a manager needed; or the park set to "forfeit" (no build) | Small, or none |
| A message to the owner | On every refund through the gateway, or on every refused one, using the existing alert path | Small |

## 5. The first real payment, step by step

The owner's shape: 1 baht, PromptPay QR, a staging till, he pays with his own
phone, a manager refunds it from the till the same day.

### Before the day

The owner:

1. Checks the credentials are 2C2P's live merchant id and secret key
   (section 2).
2. Asks 2C2P: is PromptPay QR switched on for the merchant; must the message
   address be registered in the portal (and registers it if so); must our
   server's addresses be allowed; is 1 baht accepted; can a PromptPay QR be
   voided the same day through the refund interface, and until what hour;
   where to upload the park's public key, and for 2C2P's public key.
3. Gets the refund key pair ready, or chooses another order (decision 3).
4. Picks a quiet weekday hour ending well before 21:00 Bangkok, and gives the
   go.

We, after the go:

1. Read Console > Devices: pick one staging till, set its QR to "The payment
   gateway, on the customer display", check it has a code prefix. Read which
   other staging tills send QR to the gateway today [unknown] and set them
   to the QR terminal, so no other QR becomes real money.
2. Add one item, "ZZ TEST real payment", at 1 baht, at that park.
3. Check a reception account and a branch manager account exist on staging
   for that park.
4. Tell everyone using staging: no payment tests and no "Reset demo data"
   during the window.
5. Send the owner the setting names and the message address.

### On the day

1. **We** check Integrations: the simulator, no QR waiting.
2. **The owner** types the settings in one save (section 2). The service
   restarts.
3. **We** check Integrations: 2C2P, the live system, no missing names,
   message address set, refund keys set (if the pair is ready), channel PPQR,
   nothing waiting.
4. **Dry check, no money.** Ring up the ZZ TEST item, press QR. A real code
   appears on the customer display. Nobody scans it. Press Cancel. If no code
   appears, the till says the gateway "would not show a QR" (with a code) or
   "could not be reached"; we read the gateway's answer in the platform's run
   record (`adapter:2c2p.create_qr`) and stop. Nothing was charged. If the
   answer is that the amount is too small, the item moves to 10 baht and the
   dry check is repeated, as `PLAN.md` said.
5. **The real payment.** Ring up the item again, press QR. The owner scans it
   with his bank app and pays 1 baht.
6. **Checks, within minutes.** The till shows the sale paid and closed with a
   receipt number. The payment record shows it paid through the gateway, with
   our invoice number (starting with staging's prefix) and 2C2P's reference.
   The audit log has `payment.settled` and says whether the gateway's message
   or our own asking settled it. The Console Failures page shows no refused
   gateway message and no "needs a person" alert. Today's End of Day shows 1
   baht on the PromptPay line. The 2C2P portal shows the same invoice and
   amount. The owner's bank app shows the debit.
7. **Refund from the till, the same day, within minutes.**
   - First, reception, signed in at that till, opens the sale in History,
     presses Refund, whole sale, reason "ZZ TEST real payment proof".
     Expected: the refusal "A refund needs a manager's approval".
   - Then the manager signs in at the same till and makes the same refund.
     Expected: the Refund history card shows the refund number, the money
     "refunded through the payment gateway" with "Voided at the gateway", and
     the manager's name with "manager approval"; the audit log has
     `sale.refund` and `refund.gateway_refunded`; the PromptPay line on End
     of Day goes back down; the portal shows the payment voided; the bank
     app shows the 1 baht back, when the gateway and the bank send it.
8. **After.** Staging stays connected or goes back, by decision 1. Going back
   only when Integrations lists no QR waiting; then one pretend QR to prove
   the simulator is back. The result goes on SCRUM-709 (what the park must
   obtain before real QR payments can be taken), setting names only.

### Stop rules

- **No QR at the dry check:** stop. Nothing was charged. The owner checks
  with 2C2P. Staging can go back to the simulator meanwhile.
- **The payment is held for a person** (Failures page: "A gateway payment
  does not match the sale", "A gateway payment is in another currency" or "A
  QR was paid after it expired"): nobody confirms anything. The sale stays
  open and the till cannot refund it. The owner reverses it in the portal; we
  write down why. If the reason is that the gateway's answer carries no
  currency, every real payment would be held the same way, and a change to
  the code is needed before real customers (with its own plan).
- **The till refund comes back refused** (History tells staff to "hand it
  back in cash"): nobody hands out cash. We note the gateway's code. The owner reverses the payment
  in the portal, or keeps the 1 baht. Staging's End of Day then shows 1 baht
  of cash out that never left a drawer; that is staging only.
- **A QR still waiting:** the gateway setting is never switched while
  Integrations lists one.

### What only a real run can answer [unknown]

- Whether the live gateway's answer for PromptPay carries the currency (if
  not, every real payment is held for a person).
- Whether the live system takes the QR call unsigned, as the test system did
  in October.
- Whether the message address must be registered in the portal, and whether
  the gateway's messages arrive at it.
- Whether 1 baht is accepted, and whether PromptPay QR is on for the
  merchant with the channel code `PPQR`.
- Whether the live gateway accepts calls only from registered server
  addresses.
- Whether a PromptPay QR can be voided through the refund interface the same
  day, until what hour, and what code a refusal gives.
- Whether the refund key pair is right; nothing tests it before the first
  refund.
- Whether cancelling a QR at the gateway works, or the code just runs out.
- Which timezone the gateway reads our QR expiry in (the code sends Bangkok
  time and notes this as unconfirmed, `config.ts:114-130`).
- How long the money takes to come back, and the fee on 1 baht.

## 6. What this proof does not prove

- Production: its settings, its message address, its till, its box and its
  own check of the gateway (SCRUM-925, production's set-up before its till
  goes live).
- Card at the counter through the terminals, and the terminals' own QR.
- The booking site, the deposit links, the party balance, the BEO additional
  bill and the phone till hand-over with real money: the same gateway code
  underneath, not run with real money.
- Any refund other than one whole same-day void: a next-day refund, a part
  refund, a refund after 21:00, the child pickup refund.
- Real-money edge cases: paid late, a wrong amount, expiry, paid after
  cancel, the gateway unreachable.
- Settlement: the gateway's daily file, the payout to the bank, fees, and
  matching them to End of Day.
- Any new approval rule chosen in section 7: each needs building and its own
  proof.
- A busy day, and an internet outage at the counter (a gateway QR cannot be
  taken offline).

## 7. Decisions for the owner

The first option of each is today's behaviour or the smallest change, and is
the default unless he picks another.

1. **After the first proof, what stays connected on staging?**
   - (a) Staging goes back to the pretend gateway after the proof, and after
     each later real check; production is connected when its till goes live
     (SCRUM-925, production's set-up before its till goes live). Default and
     recommended, because every staging proof of bookings, deposits and
     party bills relies on the pretend payments. Costs: one setting and a
     restart each way.
   - (b) Staging stays connected, with only the one proof till sending QR to
     the gateway. Costs: the pretend panel and the pretend booking and
     deposit pages are gone on staging for everyone; any booking or deposit
     tested there is real money; "Reset demo data" deletes real records.
   - (c) Staging stays connected, every till on the gateway. Costs: as (b),
     and every QR on staging is real money.
   - (d) Build a choice per till or per park, pretend and real side by side.
     Costs: a medium build first, and pretend money code beside real money.
2. **When staging is back on the pretend gateway, are the real settings kept
   there?**
   - (a) Deleted after each real check and typed again next time. Costs: the
     owner's time at each check.
   - (b) Kept stored, with only the switch set to pretend. Costs: the live
     secret stays in staging's settings for anyone with access to that
     dashboard.
3. **The refund key pair and the order of the proof.**
   - (a) Wait until the pair is in, then pay and refund from the till the
     same day. Costs: the proof waits for the pair; it proves the same-day
     void.
   - (b) Pay now; refund from the till on a later day, once the pair is in.
     Costs: the 1 baht stays with the merchant meanwhile; it proves the later
     refund, not the void.
   - (c) Pay now; reverse it in the gateway's portal; prove the till refund
     on a later real payment. Costs: a second real payment later.
4. **Who may send money back through the gateway from the till?**
   - (a) Today's rule: reception may open a refund; only a manager or an
     administrator at that park can make it, alone, named on the record.
     Costs: nothing to build.
   - (b) A separate permission just for money back through the gateway,
     given only to people he names. Costs: a small build, then he assigns it.
   - (c) Two people: a refund waits until a second, different manager
     approves it on their own screen. Costs: a medium to large build.
   - (d) Two people only above an amount he sets. Costs: as (c), plus the
     amount setting.
5. **A daily limit on money back through the gateway?**
   - (a) None, as today. Costs: nothing.
   - (b) A total per park per day; above it, refused until an administrator
     approves. Costs: a small to medium build.
   - (c) A total per person per day. Costs: a small to medium build.
6. **The automatic refund at a child's pickup (unused prepaid food, no
   manager).**
   - (a) Leave it: the park's setting is the approval, and the money goes
     back the way it was paid. Costs: nothing.
   - (b) Always give it back in cash, never through the gateway. Costs: a
     small build.
   - (c) Make it need a manager like any other refund. Costs: a small build,
     and pickups wait for a manager.
   - (d) Set the park's setting to "forfeit": nothing is refunded at pickup.
     Costs: no build; families lose unused prepaid food.
7. **Who presses Refund on the day?**
   - (a) A branch manager account on staging, after reception is shown the
     refusal. Costs: one manager free at that hour; it proves the rule as
     staff will meet it.
   - (b) The owner himself, with his administrator account. Costs: it proves
     the refund, not the manager rule.
8. **One 2C2P merchant for staging and production, or two?**
   - (a) One merchant. Costs: staging's real payments appear in the park's
     reports and payout, told apart by staging's invoice prefix; if 2C2P
     takes the message address from its portal, only one system gets the
     gateway's messages.
   - (b) Ask 2C2P for a separate merchant for staging. Costs: the owner's
     time with 2C2P, and any fee it charges; staging's money is kept apart.
