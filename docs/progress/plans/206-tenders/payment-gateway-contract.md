# SCRUM-206 / S2-10a — the 2C2P integration contract, as documented

READ-ONLY survey, no edits, no git writes. **Which copy I read:** every `docs/`
file, `.env.example` and `packages/db/src/schema/sales.ts` is unmodified in the
working tree (`git status --porcelain` on those paths is empty), so file-as-it-is
== HEAD and the line numbers below are HEAD's. `apps/api/src/services/sale.ts` **is**
being edited by another agent right now, so its citations are from
`git show HEAD:apps/api/src/services/sale.ts` and the line numbers are HEAD's (they
differ from the working tree by ~+89).

---

## 0. Bottom line

The contract is written in full and **none of it is built**.

| Thing | Documented at | On disk |
|---|---|---|
| `packages/payments-2c2p` | `docs/architecture/PAYMENT_GATEWAY.md:568`, `DEVELOPMENT_PLAN.md:284` | **absent** — `packages/` = `box-agent, config, db, print, shared, telemetry` |
| `packages/contracts` (home of `QrPayment`) | `DEVELOPMENT_PLAN.md:280` | **absent** |
| `QrPayment` / `PaymentTerminal` interfaces | `PAYMENT_GATEWAY.md:575-582`, `DEVELOPMENT_PLAN.md:280,371-373` | no hit anywhere in `apps/` or `packages/` |
| `POST /webhooks/2c2p/payment` | `PAYMENT_GATEWAY.md:641`, `SPRINT_2_PLAN.md:1749` | no route, no `2c2p` string in any `.ts`/`.tsx` |
| `PGW_*` variables | `PAYMENT_GATEWAY.md:766-784`, `DEVELOPMENT_PLAN.md:1213-1228` | **not one of them is in `.env.example`** (241 lines, no `PGW`, no `PAYMENT_PENDING_MIN`) |
| `pos.payment_attempt` | full S2-10a column list at `SPRINT_2_PLAN.md:1718-1725` | exists as the **Sprint 1 placeholder**: `packages/db/src/schema/sales.ts:878-890` — only `id, sale_id, method, amount_satang, status(default 'recorded'), payload, timestamps` |
| Payment methods admin | "prototype `PaymentMethodsSection` wired" (`SPRINT_2_PLAN.md:1770`) | panel exists on mock: `apps/pos/src/components/admin/payments/PaymentMethodsSection.tsx:5` imports `countTransactionsUsingPaymentMethod` from `@/mockApi` |
| Booking payment | S2-12 | still none: `SPRINT_2_PLAN.md:121` "Nothing: `POST /public/bookings` marks bookings paid with no payment" |

The only live code that touches the attempt row is the cash tender S2-09a left
behind — `git show HEAD:apps/api/src/services/sale.ts:1500` says in terms:
"`pos.payment_attempt` is still the Sprint 1 placeholder shape and **S2-10a owns
its columns**; what is written here is the minimum a cash tender needs and nothing
that pre-empts that ticket's design … EDC and QR attach to the same row at the
same moment (S2-10a)". The single predicate S2-10a changes is `outstandingOf`
(HEAD `sale.ts:1518`), which already sums attempts whose status is `approved`
(`TENDER_APPROVED`, HEAD `sale.ts:1507`) — confirmed by
`SPRINT_2_PROGRESS.md:1560-1561`.

**Authority order** for this ticket: `PAYMENT_GATEWAY.md` §4 is "the authority"
for the variables (`DEVELOPMENT_PLAN.md:1208`), and `PAYMENT_GATEWAY.md` as a
whole beats "any guess about payments" (`DEVELOPMENT_PLAN.md:154`).
`DEVELOPMENT_PLAN.md:1532` is explicit: **"do not re-research 2C2P"** — the
document even records that 2C2P serves a markdown copy of every page by appending
`.md` and indexes them at `https://developer.2c2p.com/llms.txt`
(`PAYMENT_GATEWAY.md:29-31`).

---

## 1. Scope — what 2C2P is and is not for

`PAYMENT_GATEWAY.md:37-57`:

- **In:** Thai QR on the customer display at the till (Payment Token → Do Payment
  on the PromptPay QR channel + backend notification + Payment Inquiry); online
  booking checkout on `/book` via the Redirect API; "did it really get paid?" via
  Payment Inquiry; refunds/voids via Payment Maintenance; daily settlement via the
  reconciliation CSV over SFTP.
- **Out — card present** (`:47-50`): cards at the counter go through the EDC
  terminals on their own 4G via GHL LinkPOS and Digio Direct ECR. "No card data
  ever reaches our software, and no card-present sale goes through the gateway."
- **Out — offline** (`:51-54`): "A 2C2P QR can never be minted offline: minting is
  a server call." The till falls back to the PAX terminal's own QR (Digio `A3`/`A18`)
  or cash.
- **Out — wallets in person** (`:55-57`): TrueMoney/LINE Pay at the counter go
  through the PAX terminal.

---

## 2. The wire contract

### 2.1 Hosts and endpoints (`PAYMENT_GATEWAY.md:65-90`)

Version **Payment 4.3** (`:65-66`). All calls `POST {host}/payment/4.3/…`.

| Environment | Host |
|---|---|
| Sandbox, Payment API | `https://sandbox-pgw.2c2p.com` (`:71`) |
| Production, Payment API | `https://pgw.2c2p.com` (`:72`) |
| Sandbox hosted UI (`webPaymentUrl`) | `https://sandbox-pgw-ui.2c2p.com/payment/4.3/` (`:73`) |
| Sandbox, Payment **Action** (maintenance) | `https://demo2.2c2p.com/PaymentAction/2.0/action` (`:74`) |
| Production, Payment Action | `https://t.2c2p.com/PaymentAction/2.0/action` (`:75`) |
| Merchant portal sandbox / prod | `https://demo2.2c2p.com/My2C2P/client/2.0/Login` — **UNCERTAIN** (`:76`) / `https://client.2c2p.com/2.0/Login` (`:77`) |

Endpoints we use (`:81-90`): `paymentToken` (both flows), `payment` (Do Payment,
till QR), `paymentOption` (**once**, to confirm the QR channel code),
`paymentInquiry` (poller + reconciliation), `canceltransaction` (staff cancel —
**QR support UNCERTAIN**), `paymentsimulate` (sandbox-only, undocumented, "perhaps").
Not used: `paymentoptiondetails`; `transactionstatus` optional
("`paymentInquiry` is enough").

Redirect API vs Direct API are "two front ends over the same token" (`:92-96`):
Redirect = token → browser to `webPaymentUrl`; Direct = token → optional Payment
Option → Do Payment. **There is no official Node/TypeScript server SDK**
(`:110-112`) — "the server side is a plain HTTPS POST carrying one JWT, so none is
needed"; the two community Node helpers are named as "read, do not depend on".

### 2.2 The JWT envelope (`PAYMENT_GATEWAY.md:117-135`)

- Every request **and** response body is `{"payload": "<jwt>"}`; header
  `{"alg":"HS256","typ":"JWT"}`; claims are the request fields; signed HMAC-SHA256
  with the merchant **Secret Key**. 2C2P signs its response the same way, so **the
  response signature must be verified before the claims are read** (`:117-123`).
- **Payment Maintenance is a different envelope**: **JWE RSA-OAEP + A256GCM with a
  JWS PS256 signature** — an RSA key pair exchanged with 2C2P, not the HS256 secret
  (`:124-127`). Where our public key is uploaded and how 2C2P's is obtained is
  **not on the public docs — UNCERTAIN, comes from 2C2P onboarding** (`:128-130`).
- **Our own verification order on a notification**, stricter than the docs
  (`:131-135`): JWT signature under our secret → `merchantID` is ours → `invoiceNo`
  is one we issued → `amount` and `currencyCode` match the attempt → `respCode` →
  **then a Payment Inquiry on the same `invoiceNo` before anything is released**.
- **Public demo merchants** (`:136-149`): `developer.2c2p.com/docs/sandbox` prints
  eight, usable without registering. Thailand is `JT04` (THB/764); Singapore `JT01`.
  The secrets are shown in the repo **only as fingerprints** (`CD22…38E2`,
  `ECC4…F2D9`) with the instruction to copy them from the docs page — no key
  material is in the repository (`PAYMENT_GATEWAY.md:17-24`). They "prove the wire
  format" but will not have the park's channels, return URLs or QR acquiring.

### 2.3 Payment Token — `POST {host}/payment/4.3/paymentToken` (`:153-184`)

Mandatory: `merchantID` (AN 25), `invoiceNo` (AN 50, **"20 alphanumeric for QR
payments"**), `description` (C 250, HTML-encode specials), `amount` (D(12,5), e.g.
`2500.90000`), `currencyCode` (**A 3 alphabetic — `THB`, not numeric 764**; this is
flagged as a "Correction to the working assumption", `:164`).

Optional ones that matter: `paymentChannel` (array), `request3DS`,
`frontendReturnUrl`, `backendReturnUrl`, `userDefined1..5` (C 150 each),
`paymentExpiry` (`yyyy-MM-dd HH:mm:ss`, **default 20 minutes**), `idempotencyID`
(C 100), `nonceStr` (C 32), `locale`, `statementDescriptor` (AN 20, 5-20 chars,
avoid `<>\ ' " *`), `protocolVersion` (default `2.1.0`).

Response: `webPaymentUrl`, `paymentToken`, `respCode`, `respDesc` — **proceed only
when `respCode` is `0000`** (`:182-183`).

### 2.4 Do Payment for a Thai QR — `POST {host}/payment/4.3/payment` (`:188-264`)

Request (`:192-203`): `paymentToken` (M), `payment.code.channelCode` (AN 10, M),
optional `payment.code.agentCode` / `agentChannelCode`, **`payment.data.qrType`**
("QR data format: ALL, RAW, BASE64, or URL"), `payment.data.name/.email/.mobileNo`,
`payment.data.paymentExpiry`, `locale`, `responseReturnUrl`, `clientID`.

**Channel code** (`:205-222`): `PPQR` = Prompt Pay QR — the one we want. Others in
Thailand: `GPTHQR`, `SHPQR`, `TRUEMONEYQR`, `VEMVQR`, `MCEMVQR`, `UPIEMVQR`, `ALQR`.
Explicit correction: `THQR`, `QRC`, `CSQR`, `SGQR` are **category/group codes in the
Payment Option response, not Do Payment channel codes**; "PROJECT_CONTEXT §7.2
assumed channel `THQR`; **the channel code to send is `PPQR`**", confirmed against
the live merchant with one Payment Option call — "hence `PGW_QR_CHANNEL_CODE` is
configuration, not a constant" (`:219-222`).

Response (`:224-240`): `respCode`/`respDesc` (**`1005` = "Pending for user scan
QR."**), `channelCode`, `type`, `data` (C 5000 — URL/deeplink or the QR),
**`expiryTimer` (N 10, milliseconds, flow 1005 only)**, `expiryDescription`,
**`extras.qrData` (C 5000, "QR data based on the qrType requested")**,
`extras.barcodeData`, `extras.referenceNo`, `extras.paymentExpiry`, `invoiceNo`
("only returned when respCode is 2000"), `fallbackData` (flow 1004 only).

**Raw EMVCo string: yes** (`:251-258`) — `qrType: RAW` (or `ALL`) returns the QR
content in `extras.qrData`; the SDK guide says of `QRTypeCode.Raw` "Build QR image
by using raw string". Why it matters, verbatim: "the customer display renders the QR
itself from the raw payload, so the display needs no outbound internet and no image
fetch, and a blocked S3 host cannot break a sale."

Flow codes (`:266-278`): 1000 iframe, 1001 full redirect, 1002 deeplink, 1003
payslip, 1004 external app, **1005 display the QR and loop the status query**, 2000
completed.

### 2.5 Backend notification (`:280-341`)

2C2P POSTs server-to-server to `backendReturnUrl` with the same
`{"payload":"<jwt>"}` HS256 envelope. Field list `:290-315`: `merchantID`,
`childMerchantID`, `invoiceNo`, `amount`, `currencyCode`, `transactionDateTime`
(`yyyyMMddHHmmss`), `agentCode`, `channelCode`, `approvalCode` (cards only),
`referenceNo`, `tranRef`, **`accountNo` — masked card number (first 6, last 4)**,
`paymentID` (e.g. `ccpp_12345678`), card/IPP/RPP/FX conditionals,
`userDefined1..5`, `acquirerReferenceNo`/`acquirerMerchantId`/`acquirerResponseCode`,
`idempotencyID`, `paymentScheme`, `schemePaymentID`, `respCode`/`respDesc`
(**`0000` = successful**).

**Field-name corrections** (`:317-322`): v4.3 has **no `paidAgent`, `paidChannel`
or `cardNo`** — those are legacy 3.x and "must not appear in our types". The
equivalents are `agentCode`, `channelCode`, `accountNo` (already masked).

What we must return (`:324-330`): the docs do not state a body — **UNCERTAIN**.
Practice is **always HTTP 200, fast, never throw**; `respCode 9999` "Request to
merchant backend has failed" exists, so 2C2P does record a failed delivery.
Retries/duplicates (`:332-336`): **no retry schedule is published — UNCERTAIN**;
"assume redelivery and duplicates, and make the endpoint idempotent". A QR payment
does produce a notification (step 14 of the Scan QR flow).

Join key (`:337-341`): **`invoiceNo`** — one per attempt, stored on the attempt,
echoed in the notification, in Payment Inquiry and in the settlement file;
`tranRef` and `paymentID` stored alongside for support and dedupe.

### 2.6 Payment Inquiry (`:345-385`)

`POST {host}/payment/4.3/paymentInquiry`, same JWT envelope; documented example
carries `merchantID`, `invoiceNo`, `locale` (a `paymentToken` form also exists).
Response is the same field set as the notification (`tranRef` is AN 28 here).

Response codes we act on (`:361-385`), the ones the ticket names:

| Code | Meaning | Our reading |
|---|---|---|
| `0000` | Successful | paid |
| `0001` | Pending | keep polling |
| `0003` | Cancelled | cancelled |
| `1005` | (flow) pending for user scan | QR shown, keep polling |
| `2000` / `2001` | completed / in progress | read result / keep polling |
| `2002` | Transaction not found | our invoice never reached 2C2P |
| `4110` / `4120` / `4121` / `4122` / `4130` | settled / refunded / refund rejected / refund failed / chargeback | |
| `5005`, `9015` | Duplicated / existing invoice number | our bug — invoice reuse |
| `5009`, `9020` | Payment expired | expire the attempt |
| `5015` / `5016` | Customer paid more / less | amount mismatch, manual handling |
| `5017` | Paid Expired | late payment after expiry |
| `9041` / `9042` / `9900` | token already used / hash mismatch / cannot decrypt | re-mint; signing bug |
| `9057`-`9060` | channel invalid/unauthorised/unconfigured | the QR channel is not enabled |
| `9999` | Request to merchant backend failed | our webhook did not answer |

### 2.7 Payment Maintenance — void and refund (`:389-441`)

Payment **Action** API 2.0 on its own host (§2.1). Request fields (`:396-398`):
`version` (4.3), `timestamp` (`ddmmyyhhmmss`), `merchantID`, `invoiceNo`,
`actionAmount`, **`processType` — `R` refund, `V` void**. The settle/capture letter
is **not printed on the pages read — UNCERTAIN** (`:398-399`).
Response (`:400-403`): `respCode` (**`00` = success**), `respDesc`, `processType`,
`invoiceNo`, `amount`, `status`, `approvalCode`, `referenceNo`, `refundReferenceNo`,
`transactionDateTime`, `maskedPan`, `eci`, `paymentScheme`, `userDefined1..5`.

Windows (`:407-412`): a **void** must be same-day, before the acquirer cut-off; a
**refund** only for **settled** transactions and never above the settled total;
unsettled pre-auths auto-void after commonly 7 days; async refunds return
REFUND_PENDING, resolved by Refund Status Inquiry or a `notifyURL` callback.
Partial refunds via `actionAmount` (`:413-414`).

Status codes (`:416-426`): `A`, `AP`, `AE`, `AL`/`AM`, `PF`, `AR`, `FF`, `IP`,
`ROE`, `RP`, **`RF` refund confirmed**, `RFF`, `RR`/`RR1`/`RR2`/`RR3`, `RS`,
`S` settled, **`V` voided/cancelled**, `VP`, `EX` expired, `CTS`/`CTF`, `PPC`/`PFC`.

**Open:** "**Whether a PromptPay QR payment is refundable through it, and on what
timing, is UNCERTAIN**" — the guides are card-centric; must be answered by 2C2P
before we promise in-app QR refunds; fallback is a manual bank transfer recorded
against the sale (`:429-433`). Note the plan already assumes the harder line for
S2-11: "Thai QR not voidable → `QrPayment.refund`" (`SPRINT_2_PLAN.md:1907`).

Cut-offs, Asia/Bangkok (`:435-441`): **EMVQR 21:00**, SCB 22:00, BBL 23:10, KBank
21:00, KTC 21:30, BAY 20:00, LinePay 23:59, TrueMoney 23:59, 123 TH 23:59, 2C2P MC
Acquiring 21:00. "A void is only possible before the channel's cut-off on the same
day; after that it is a refund."

### 2.8 Validation constraints to encode (`:520-533`)

`invoiceNo` AN 50 generally, **20 for QR**; must be unique for the merchant
(`5005`/`9015`); characters "AN" with **no documented separator set — we restrict to
`A-Z0-9` to be safe, UNCERTAIN whether `-` or `_` are accepted**. `amount`
Decimal(12,5). `currencyCode` 3 alphabetic. `paymentExpiry` `yyyy-MM-dd HH:mm:ss`,
default 20 min. `userDefined1..5` C 150. `description` C 250. `nonceStr` C 32.
`idempotencyID` C 100. `statementDescriptor` AN 20, 5-20 chars. `expiryTimer`
milliseconds, flow 1005 only.

---

## 3. Our integration design (`PAYMENT_GATEWAY.md` §3)

### 3.1 The `QrPayment` contract (`:568-590`)

One package `packages/payments-2c2p` implementing `QrPayment` from
`packages/contracts`. "**Nothing outside the package knows 2C2P exists**: the sale
service asks `QrPayment` for a QR and is told when it is paid."

```
QrPayment
  createQr({ attemptId, invoiceNo, amountSatang, description,
             expiryMinutes, userDefined })  -> { qrPayload?, qrImageUrl?,
                                                 expiresAt, providerRef }
  inquire({ invoiceNo })                    -> { state, raw }
  cancel({ invoiceNo })                     -> ok | unsupported
  refund({ invoiceNo, amountSatang })       -> { state, providerRefundRef }
```

Two implementations, same shapes so nothing downstream branches:
`TwoC2PQrPayment` (when `PGW_PROVIDER=2c2p` and credentials present) and
`SimulatorQrPayment` (default). Internals: sign HS256 → POST `{payload}` → **verify
the response JWT** → decode → map `respCode` to our states. **Money crosses the
boundary as integer satang and is formatted to D(12,5) only at the wire** (`:590`).
`DEVELOPMENT_PLAN.md:280` fixes the interface set as `create/inquire/refund`
alongside `PaymentTerminal` (`sale/void/inquire/settle`).

### 3.2 Attempt lifecycle for `method qr, provider 2c2p` (`:594-613`)

```
created ──► qr_shown ──┬──► paid ──► refunded
                       ├──► expired ──► late_paid ──► refunded
                       └──► cancelled ──► late_paid ──► refunded
```

`created` = token `0000`; `qr_shown` = Do Payment `1005` + `expiryTimer`; `paid` =
`0000` **with amount and currency matching**; `expired` = `expiresAt` passed and
inquiry not paid (`5009`/`9020`/status `EX`); `cancelled` = staff cancelled, we call
`canceltransaction` (`0003`, or unsupported); `late_paid` = a paid signal on an
expired/cancelled attempt (`0000`, or `5017`); `refunded` = maintenance confirmed
(status `RF`, `respCode 4120`).
**"Amount mismatches (`5015` paid more, `5016` paid less) never mark a sale paid:
they raise an alert and wait for a person"** (`:612-613`) — the ticket maps both to
attempt status `awaiting_staff_confirmation` (`SPRINT_2_PLAN.md:1755-1756`).

Note the two vocabularies are **not identical** and this is a real seam to reconcile
when building: §3.2's states (`created|qr_shown|paid|expired|cancelled|late_paid|
refunded`) vs the `payment_attempt.status` enum the ticket specifies
(`created|sent_to_terminal|approved|declined|cancelled|unknown|inquiring|not_found|
awaiting_staff_confirmation|awaiting_settlement`, `SPRINT_2_PLAN.md:1719-1721`),
which is shared with the card tender. Neither document maps one onto the other.

### 3.3 `invoiceNo` — one per attempt (`:616-637`)

"**`invoiceNo` is per payment attempt, never per sale**: a re-shown or re-priced QR
is a new attempt with a new invoice number, because 2C2P refuses a reused one
(`5005`, `9015`)."

```
[PREFIX]  STATION   YYMMDD   SEQ
 ≤5       3         6        6      = ≤ 20
  ""      T01       260920   000147   ->  T01260920000147   (15)
 "SBX"    T01       260920   000147   ->  SBXT01260920000147 (18)
```

`PREFIX` = `PGW_INVOICE_PREFIX`, empty in production, set in sandbox "so test
invoices can never collide with real ones". `STATION` = `station.code`, upper
alphanumeric, 3. `YYMMDD` = the **branch business date (Asia/Bangkok)**. `SEQ` =
per-station per-day counter from the database, zero-padded to 6. The generator lives
in the package, is unit-tested for length, charset and uniqueness, and the value is
stored on `payment_attempt.provider_invoice_no` **with a unique index**.
Booking site: same format with the station segment replaced by `WEB` (`:743-744`).

### 3.4 The webhook — `POST /webhooks/2c2p/payment` (`:641-670`)

Path may carry `PGW_WEBHOOK_SECRET` as a segment "for cheap filtering of internet
noise"; it is unauthenticated by session and must be fast. The nine steps, as written:

1. Read `{"payload":"<jwt>"}`; **verify HS256 with `PGW_SECRET_KEY`**. Bad or
   missing signature → logged, answered **200 (never a detail of why)**, processed
   no further.
2. Check `merchantID == PGW_MERCHANT_ID`.
3. Write an **`ops_run`** with the raw envelope, decoded claims, source IP, headers
   and the matching outcome — "the audit trail for any dispute".
4. **Idempotency key `(invoiceNo, tranRef)`**, falling back to
   `(invoiceNo, paymentID)` when `tranRef` is absent, **with a unique index**. A
   duplicate finds the row, does nothing, answers 200.
5. Match `invoiceNo` to `payment_attempt`. No match → `unmatched_payment`, alert on
   Failures, answer 200.
6. Compare `amount` (to satang) and `currencyCode`. Mismatch → alert, **do not mark
   paid**.
7. On `respCode 0000`, **inside one database transaction**: mark the attempt `paid`,
   record `tranRef`, `paymentID`, `approvalCode`, `channelCode`, `agentCode`,
   `transactionDateTime`, and settle the sale through the sale service — "the same
   `withTx` path a cash tender uses" — with the audit row in the same transaction.
8. Answer **HTTP 200 within a second. Never let an internal failure turn into a
   non-200: queue the work and acknowledge.**
9. Push the new state to the till and the customer display.

And the standing rule (`:668-670`): "We treat the notification as a **trigger**, not
as truth: before anything is released (bands printed, booking confirmed) a Payment
Inquiry on the same `invoiceNo` must agree. That is our rule, not 2C2P's, and it
costs one call."

### 3.5 The inquiry poller (`:674-684`)

While `qr_shown`: every `PGW_INQUIRY_INTERVAL_S` (**default 3 s**) for the first two
minutes, then **every 10 s, jittered**. Stops on a terminal state or **60 s after
`expiresAt`**. A sweeper `job:payments.pending` re-inquires every unresolved attempt
up to `PGW_INQUIRY_MAX_MIN` (**default 30**) after creation and again at end of day;
anything still unresolved is flagged on Failures. "The poller and the webhook write
through the same idempotent 'mark paid' service, so whichever arrives first wins and
the second is a no-op."

Two different thresholds, do not conflate: `PGW_INQUIRY_MAX_MIN` (30) stops polling;
**`PAYMENT_PENDING_MIN` (10)** is ours, not 2C2P's, and is when an attempt still in
`sent_to_terminal|unknown|inquiring` is flagged on Failures
(`DEVELOPMENT_PLAN.md:1227-1228`, `:1084`; `SPRINT_2_PLAN.md:1761-1762`).

### 3.6 On the display (`:688-693`)

The display renders the QR **itself** from `extras.qrData` (requested `qrType: RAW`),
falling back to the `data` image URL only if the raw payload is absent. It shows the
amount, a countdown driven by `expiryTimer`/`expiresAt`, and the branch's language.
On expiry it stops showing the QR, says so, and offers the till a new attempt.
"**The display never calls 2C2P and never holds the secret.**" Perf budget: display
QR render < 2 s (`SPRINT_2_PLAN.md:534`).

### 3.7 Cancel, late payment, duplicates (`:697-709`)

Cancel → attempt `cancelled`, display cleared, `canceltransaction` best-effort
(QR support UNCERTAIN; a failure is logged, not surfaced). **Late payment** →
`late_paid`, **alert the branch manager**, two actions: apply to the sale if still
open, or refund via Payment Maintenance; where the sale is closed and settled by
another tender the default is an automatic refund request plus an alert, and a manual
bank transfer with a recorded reference if the gateway cannot refund that channel.
Duplicates → unique index on `(invoiceNo, tranRef)`, unique index on
`provider_invoice_no`, and the sale's paid transition guarded inside the sale
transaction.

### 3.8 Logging (`:713-722`)

Logged with the request id: `invoiceNo`, attempt id, sale id, `tranRef`, `paymentID`,
`channelCode`, `agentCode`, `respCode`/`respDesc`, amount in satang, latency, retry
count, the environment, and for webhooks the raw envelope and source IP.
**Never logged**: `PGW_SECRET_KEY`, `PGW_MAINT_PRIVATE_KEY`, any full card number
("we never receive one — `accountNo` arrives masked and is stored masked"), and
customer personal fields beyond what the sale already holds. **The admin console
shows presence flags only for the `PGW_*` values, never their contents** (also
`SPRINT_2_PLAN.md:888`). This sits under the platform-wide rule at
`DEVELOPMENT_PLAN.md:1065` ("No PII in any log line, span, error report or stored
adapter payload — ever") and the allow-list projection for adapter payloads
(`DEVELOPMENT_PLAN.md:381-385` — TID, MID, approval code, last4, amount, status,
invoice number; the raw frame kept only by the simulator).

### 3.9 The gateway simulator — what it must do (`:726-734`)

Active when `PGW_PROVIDER=simulator`, **or when `PGW_MERCHANT_ID`/`PGW_SECRET_KEY`
are absent**. `SimulatorQrPayment` answers with **the same shapes**: a `1005`-style
pending response, a **locally generated EMVCo-shaped payload**, an `expiryTimer`, and
a **real-looking `tranRef`**.

The Console panel offers **"customer paid", "late payment", "decline", "expire"**
(`:730-732`), each of which **posts a synthetic notification to
`/webhooks/2c2p/payment` signed with the configured secret, so the production code
path is exercised end to end**. The ticket adds a fifth control, **"Suppress
webhook"** (`SPRINT_2_PLAN.md:1762-1764`), which is how the acceptance proves the
inquiry poller is a real safety net rather than decoration. The simulator must also
**honour void (`V`) and refund (`R`) through the maintenance path**
(`SPRINT_2_PLAN.md:1757-1759`). "CI, demos and offline development never need the
sandbox; the sandbox is used for the real-QR acceptance runs."

### 3.10 Booking site, Redirect API (`:445-461`, `:738-745`)

Quote server-side → Payment Token with `frontendReturnUrl` + the same
`backendReturnUrl` → browser to `webPaymentUrl` → **confirm the booking only on the
backend notification plus a Payment Inquiry, never on the browser's return**. The
frontend return is a form POST whose field **`paymentResponse`** is a base64url JWT
carrying only `invoiceNo`, `channelCode`, `respCode`, `respDesc`, `locale` — "**a
display hint, never proof**" (`:453-455`). A failed or expired payment leaves the
booking unconfirmed and releases the held capacity. That is S2-12, not this ticket
(`SPRINT_2_PLAN.md:1986-1990`).

### 3.11 Settlement (`:751-756`, `SPRINT_2_PLAN.md:2301-2306`)

Daily reconciliation CSV pushed over **SFTP** (`52.76.184.174:22`, `/input` pickup,
`/output` drop, before 04:00 GMT+7), filename
`Reconcile2c2p_B_v2.4_MID_CURRENCY_yyyy-MM-dd_HHmmss_[suffix].csv`, H/D records
(`PAYMENT_GATEWAY.md:539-549`). Imported into `settlement_batch`/`settlement_line`,
matched by `invoiceNo`, cross-checked against `tranRef`/`paymentID`; a fixture shaped
like the real file lives in the test suite. **Which detail column carries our
`invoiceNo` is UNCERTAIN** until a real file exists (`:550-553`), and **settlement
timing for PromptPay QR is not published — UNCERTAIN** (`:554-557`). That is S2-15a.

---

## 4. Environment variables

**`PAYMENT_GATEWAY.md` §4 is the authority** (`DEVELOPMENT_PLAN.md:1208`). API
server only — "None of these ever reach a Pi box or a browser"
(`PAYMENT_GATEWAY.md:762-763`, restated `DEVELOPMENT_PLAN.md:1211`).

| Variable | Meaning | Source line |
|---|---|---|
| `PGW_PROVIDER` | `2c2p` or `simulator` — which `QrPayment` is active | `PAYMENT_GATEWAY.md:767` |
| `PGW_ENV` | `sandbox` or `production`; selects defaults and marks every record | `:768` |
| `PGW_BASE_URL` | Payment API host; defaults from `PGW_ENV` | `:769` |
| `PGW_MERCHANT_ID` | merchant ID (`merchantID` in every payload) | `:770` |
| `PGW_SECRET_KEY` | Secret Key signing/verifying HS256 JWTs | `:771` |
| `PGW_CURRENCY_CODE` | `currencyCode`; `THB` | `:772` |
| `PGW_BACKEND_RETURN_URL` | public HTTPS URL 2C2P notifies, `https://api.<domain>/webhooks/2c2p/payment` | `:773` |
| `PGW_FRONTEND_RETURN_URL` | browser return for the booking hosted-page flow | `:774` |
| `PGW_WEBHOOK_SECRET` | random path/query token — **cheap filter, not authentication** | `:775` |
| `PGW_QR_CHANNEL_CODE` | Do Payment channel; `PPQR` | `:776` |
| `PGW_QR_TYPE` | `RAW`/`URL`/`BASE64`/`ALL`; **`RAW`** so the display renders locally | `:777` |
| `PGW_PAYMENT_EXPIRY_MIN` | minutes → `paymentExpiry`; 2C2P's default is 20 | `:778` |
| `PGW_INVOICE_PREFIX` | ≤ 5 chars, keeps sandbox invoices apart from production | `:779` |
| `PGW_INQUIRY_INTERVAL_S` | seconds between inquiries while a QR is displayed (3) | `:780` |
| `PGW_INQUIRY_MAX_MIN` | minutes after which an unresolved attempt stops being polled and is flagged (30) | `:781` |
| `PGW_MAINT_BASE_URL` | Payment Action host — **a different host** | `:782` |
| `PGW_MAINT_PRIVATE_KEY` | our RSA private key (PEM), JWE decrypt + JWS PS256 sign | `:783` |
| `PGW_MAINT_2C2P_PUBLIC_KEY` | 2C2P's RSA public key (PEM) | `:784` |
| `PAYMENT_PENDING_MIN` | **ours, not 2C2P's** — minutes before an unresolved attempt is flagged on Failures (10) | `DEVELOPMENT_PLAN.md:1227-1228`, `:1084` |

Two rules attached to the registry:

- `PGW_*` **replaces the `2C2P_*` names used in earlier drafts**
  (`PAYMENT_GATEWAY.md:786`) because a leading digit is not shell-safe
  (`DEVELOPMENT_PLAN.md:1209-1210`).
- **A missing `PGW_MERCHANT_ID` or `PGW_SECRET_KEY` silently selects the simulator**
  and says so **in the startup log and on the Console's Integrations page**
  (`PAYMENT_GATEWAY.md:786-788`, `DEVELOPMENT_PLAN.md:1230-1232`) — "so CI and a
  fresh checkout never need the sandbox". Note this is a *silent* selection by
  design, and it is the one place the otherwise-strict boot-refusal rule
  (`DEVELOPMENT_PLAN.md:1085-1090`, `assertProductionSafe` in
  `apps/api/src/env.ts`) is deliberately not applied.

**Gap to close in this ticket:** none of the 19 names above is in `.env.example` —
the file runs `DATABASE_URL` → `VITE_LAUNCHER_URL` with no payment section at all
(`.env.example:1-241`). CLAUDE.md §8 ("`.env.example` documents every variable") and
the plan's own justification for listing optional names — "a deployment that sets one
gets it VALIDATED at boot rather than silently ignored" (`.env.example:82-84`) —
both point at adding the block here.

---

## 5. Decided vs open

### 5.1 Decided — do not re-litigate

| Decision | Where |
|---|---|
| **2C2P is the gateway; SCB is the acquiring bank.** Owner said "the SCB payment gateway" then pointed at `developer.2c2p.com`; both are consistent | `PAYMENT_GATEWAY.md:6-11`; `DEVELOPMENT_PLAN.md:1364`; `SPRINT_2_PROGRESS.md:307-308` |
| **QR in Sprint 2 is real through the sandbox, not mocked** — when credentials exist | `PAYMENT_GATEWAY.md:10-12`; `SPRINT_2_PLAN.md:386-389` |
| **SCB Developer Portal direct API is a second `QrPayment` provider, never a replacement** — added only if the park holds such an application | `PAYMENT_GATEWAY.md:11-15`, §6 `:832-880`; `DEVELOPMENT_PLAN.md:1557-1558` |
| Channel is **`PPQR`**, configurable; `THQR` was wrong | `PAYMENT_GATEWAY.md:219-222` |
| `currencyCode` is **`THB`** (alphabetic), not 764 | `:164` |
| `qrType` is **`RAW`**, display renders locally | `:251-258`, `:777` |
| **`invoiceNo` one per attempt**, `[prefix]STATION+YYMMDD+SEQ`, ≤ 20, `A-Z0-9`, unique index | `:616-637` |
| Webhook idempotency on **`(invoiceNo, tranRef)`** | `:650-654` |
| **Inquiry must agree before anything is released** | `:668-670` |
| Money as integer satang inside, D(12,5) only at the wire | `:590` |
| Nothing outside the package knows 2C2P exists | `:571-573` |
| No Node SDK; plain HTTPS POST + one JWT | `:110-112` |
| Maintenance is a different host **and** a different crypto envelope (JWE RSA-OAEP+A256GCM / JWS PS256) | `:124-127`, `:405-406`, `:782-784` |
| Card-present never touches the gateway; offline QR is the PAX terminal's own | `:47-54` |
| **Do not re-research 2C2P** — this document is the answer | `DEVELOPMENT_PLAN.md:1532` |

### 5.2 Open — the UNCERTAIN register, verbatim from the document

| # | Question | Blocking? | Where |
|---|---|---|---|
| U1 | **How a sandbox QR is marked paid** — "not documented. UNCERTAIN, and **the one real gap**". Three candidates, in test order: (a) `POST /payment/4.3/paymentsimulate` accepts a JWT naming `paymentToken`/`invoiceNo` and an outcome (its OpenAPI schema is just `{"payload": string}`, no documented fields); (b) the sandbox QR image resolves to a payable sandbox page; (c) the demo merchant portal has a "mark as paid" action. **Ask 2C2P and test in the first sandbox session** | **No** — "our own gateway simulator keeps CI and demos independent of the answer"; the ticket says the acceptance runs on our simulator and on the sandbox's own inquiry until then | `PAYMENT_GATEWAY.md:492-508`, `:806-808`; `SPRINT_2_PLAN.md:1764-1767` |
| U2 | **Does the sandbox actually deliver backend notifications to a public HTTPS URL, and must the URL be whitelisted in the portal?** The API is on a public staging domain so no tunnel is needed | No — the poller covers it | `:509-515` |
| U3 | **Is a PromptPay QR refundable through Payment Maintenance, and in what window?** The guides are card-written | Not for S2-10a (refunds are S2-11), but must be answered before we promise in-app QR refunds; fallback is a recorded manual bank transfer | `:429-433` |
| U4 | **Does `canceltransaction` support QR?** | No — a failure is logged, not surfaced | `:89`, `:697-699` |
| U5 | **What body must a backend notification be answered with?** Not stated by the docs | No — always 200, fast, never throw | `:324-330` |
| U6 | **Backend-notification retry schedule / duplicate behaviour** — none published | No — assume redelivery, be idempotent | `:332-336` |
| U7 | **Are `-` or `_` accepted in `invoiceNo`?** "AN" with no documented separator set | No — we restrict to `A-Z0-9` | `:524` |
| U8 | **Does the acquirer also enforce expiry at the payer's bank?** Test by paying after expiry in the sandbox | No — that is the "late payment" case we handle anyway | `:260-264` |
| U9 | **The settle/capture `processType` letter** is not printed on the pages read | No — we need `V` and `R` only | `:398-399` |
| U10 | **Where the merchant's maintenance public key is uploaded and how 2C2P's is obtained** — comes from 2C2P onboarding | Not for S2-10a; needed before real refunds | `:128-130` |
| U11 | **Which reconciliation detail column carries our `invoiceNo`**; **settlement timing for PromptPay QR**; **sandbox limits** — none published | No — S2-15a, and a fixture exists | `:550-557`, `:516` |
| U12 | The sandbox **merchant portal URL** is from a search result, not a docs page | No | `:76` |

### 5.3 Open — waiting on the owner (this is the one that can stall the *real*-QR half)

**Open decision 32**: the 2C2P merchant credentials — "the sandbox merchant id and
secret (or the public demo pair for the first test), the enabled QR channel and the
return URLs, into `.env` as `PGW_*`" (`DEVELOPMENT_PLAN.md:1764-1766`). Still listed
as open at `SPRINT_2_PROGRESS.md:286-288` and as item 1 under "Waiting on the owner"
at `STATUS.md:63-66`, phrased as "**which** gateway portal the park holds — a 2C2P
sandbox merchant or an SCB Developer Portal application", credentials "never into the
repository". `SPRINT_2_PROGRESS.md:274-278` says the same.

**What this does and does not block.** It does not block building the ticket: the
simulator is the default and the acceptance criteria are written to run on it. It
blocks only the two sandbox-only claims — a *real* 2C2P QR rendered on the display,
and the Payment Option call that confirms `PPQR` against the park's own merchant.
The documented escape hatch for a first wire test is the public demo pair
`JT04` / `CD22…38E2` copied from `developer.2c2p.com/docs/sandbox`
(`PAYMENT_GATEWAY.md:796-799`), which needs no account but carries none of the park's
channels or return URLs. `SPRINT_2_PLAN.md:251` confirms production go-live after
this is "configuration only".

The full owner checklist — sandbox merchant + secret, PromptPay enabled and the
channel code confirmed, return URLs registered/whitelisted, the U1 answer, the
maintenance RSA key pair, portal logins; then for production the production merchant,
production return URLs, a separate maintenance key pair, SFTP credentials for the
reconciliation file, and confirmation of QR refundability, settlement day, fee
schedule and retry behaviour — is `PAYMENT_GATEWAY.md:792-828`.

---

## 6. Things a builder will trip over

1. **Two status vocabularies.** §3.2's QR lifecycle and the ticket's
   `payment_attempt.status` enum are different sets and nothing maps them
   (`PAYMENT_GATEWAY.md:596-610` vs `SPRINT_2_PLAN.md:1719-1721`). Decide the mapping
   explicitly — e.g. `qr_shown`→`sent_to_terminal`, `paid`→`approved`,
   `5015`/`5016`→`awaiting_staff_confirmation` (the ticket states that last one,
   `:1755-1756`) — and write it down; §1.4 of the DEVELOPMENT_PLAN is the ask-or-decide
   rule.
2. **`payment_attempt` today holds six columns** (`packages/db/src/schema/sales.ts:878-890`)
   against the ~22 the ticket names. This is a migration from `0004` onward, so
   **expand/contract** applies (`DEVELOPMENT_PLAN.md:606-612`) and it must apply twice
   from empty.
3. **`packages/contracts` does not exist yet**, so this ticket (or S2-09a's successor)
   creates it. `QrPayment` and `PaymentTerminal` both live there, interfaces only, no
   implementations (`DEVELOPMENT_PLAN.md:280`).
4. **`PAYMENT_PENDING_MIN` (10) ≠ `PGW_INQUIRY_MAX_MIN` (30).** Different jobs.
5. **The webhook must answer 200 even when it refuses the payload** — signature
   failure, merchant mismatch, unmatched invoice and amount mismatch all answer 200
   (`PAYMENT_GATEWAY.md:644-657`). A 4xx here is a bug, not a defence.
6. **`PGW_WEBHOOK_SECRET` is not authentication.** Said twice
   (`PAYMENT_GATEWAY.md:775`, `DEVELOPMENT_PLAN.md:1222-1223`). The JWT signature is.
7. **The Payment Option call is once, not per sale** (`PAYMENT_GATEWAY.md:85`), and
   its only job is to confirm `PGW_QR_CHANNEL_CODE` against the live merchant.
8. **No `paidAgent`/`paidChannel`/`cardNo` in our types** — legacy 3.x fields
   (`PAYMENT_GATEWAY.md:317-322`).
