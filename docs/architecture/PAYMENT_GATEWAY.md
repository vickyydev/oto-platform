# Payment gateway — 2C2P (SCB-acquired) for QR and online payments

_Written 2026-09-20 from the public 2C2P documentation; sandbox first,
production by configuration._

**Decision.** Owner direction 2026-09-20 (`docs/briefs/OWNER_DIRECTION.md`,
"Payments") and `docs/briefs/PROJECT_CONTEXT.md` §7.2: the park's payment
gateway is **2C2P**, with **SCB as the acquiring bank** behind the merchant
account. The owner first called it "the SCB payment gateway" and then pointed
at `developer.2c2p.com`; both statements are consistent. QR payments in
Sprint 2 are **real, through the 2C2P sandbox**, not mocked. The **SCB
Developer Portal direct API** (PromptPay QR 30, deeplink) is kept as an
**alternative provider**, added as a second `QrPayment` implementation only if
the park holds such an application — see section 6 and
`docs/architecture/research/2026-09-20-scb-direct-api-research.md`.

**Confidentiality.** No credential of the park's appears in this document.
Section 2.2 names 2C2P's own **public demo** merchant IDs, which are printed
openly on `https://developer.2c2p.com/docs/sandbox` for anyone to use without
registering; their secret keys are shown only as fingerprints here (copy them
from that page into `.env`), so no key material of any kind lives in this
repository. The park's own
sandbox and production credentials are never committed — they live in the
deployment's secret store under the `PGW_*` names in section 4.

Every fact in section 2 carries its source URL. Where the public
documentation is silent the item is marked **UNCERTAIN** and must be settled
by a sandbox test or by 2C2P support before go-live. Nothing has been
invented. Note that 2C2P serves a markdown copy of every documentation page
by appending `.md` to its URL, and publishes a full index at
`https://developer.2c2p.com/llms.txt` — useful for any later agent.

---

## 1. What we use 2C2P for, and what we do not

| Use | Surface | Product |
|---|---|---|
| Thai QR on the customer display, at the till | POS station display | Payment Token → Do Payment on the PromptPay QR channel, backend notification + Payment Inquiry |
| Online booking checkout | Booking site `/book` | Redirect API (hosted payment page), same backend notification |
| "Did it really get paid?" | API service and jobs | Payment Inquiry / Transaction Status |
| Refunds and voids of gateway payments | Console, refund flow | Payment Maintenance (Payment Action API) |
| Daily settlement figures | Console, end-of-day | Reconciliation CSV over SFTP, merchant portal reports |

What 2C2P is **not** used for:

- **Card present.** Cards at the counter go through the EDC terminals over
  their own 4G, driven by the box through the GHL LinkPOS and Digio Direct
  ECR dialects (`docs/architecture/DEVICE_INVENTORY.md`). No card data ever
  reaches our software, and no card-present sale goes through the gateway.
- **Offline.** The box cannot reach 2C2P when the internet is down. The till
  then falls back to the **PAX terminal's own QR** (Digio `A3`/`A18`, on the
  terminal's 4G) or to cash, and the sale records the tender accordingly.
  A 2C2P QR can never be minted offline: minting is a server call.
- **Wallets in person.** TrueMoney, LINE Pay and the rest at the counter go
  through the PAX terminal, not the display, unless the park later chooses
  the gateway's wallet channels.

---

## 2. API facts

### 2.1 Products, versions and endpoints

Current version is **Payment 4.3**; the changelog's newest entry is
"[ 4.3.0 ] September 2025".
Source: `https://developer.2c2p.com/llms.txt`.

| Environment | Host | Source |
|---|---|---|
| Sandbox (Payment API) | `https://sandbox-pgw.2c2p.com` | [URLs & Environment](https://developer.2c2p.com/docs/reference-environment-guide) |
| Production (Payment API) | `https://pgw.2c2p.com` | same |
| Sandbox hosted payment UI | `https://sandbox-pgw-ui.2c2p.com/payment/4.3/` (returned as `webPaymentUrl`) | [How to integrate](https://developer.2c2p.com/docs/redirect-api-integrate-with-payment) |
| Sandbox (Payment Action / maintenance) | `https://demo2.2c2p.com/PaymentAction/2.0/action` | [URLs & Environment](https://developer.2c2p.com/docs/reference-environment-guide) |
| Production (Payment Action / maintenance) | `https://t.2c2p.com/PaymentAction/2.0/action` | same |
| Merchant portal, sandbox | `https://demo2.2c2p.com/My2C2P/client/2.0/Login` | search result, not a docs page — **UNCERTAIN**, confirm with 2C2P |
| Merchant portal, production | `https://client.2c2p.com/2.0/Login` (`my.2c2p.com`) | same |

Endpoints, all `POST` under `{host}/payment/4.3/`:

| Path | Product | Used by us |
|---|---|---|
| `paymentToken` | Payment Token — mints the token every flow starts from | Yes, both flows |
| `payment` | Do Payment — the direct/"Payment UI" flow; submits the chosen channel | Yes, till QR |
| `paymentOption` | Payment Option — lists the channels the merchant has enabled | Once, to confirm the QR channel code |
| `paymentoptiondetails` | Payment Option Details — detail for one group/category | No |
| `paymentInquiry` | Payment Inquiry — authoritative status by `invoiceNo` | Yes, poller and reconciliation |
| `transactionstatus` | Transaction Status Inquiry — status by `paymentToken`, SDK-oriented | Optional; `paymentInquiry` is enough |
| `canceltransaction` | Cancel an ongoing/pending transaction | Yes, on staff cancel — QR support **UNCERTAIN** |
| `paymentsimulate` | Sandbox-only simulation endpoint (see 2.9) | Perhaps; undocumented |

The **Redirect API** (2C2P's hosted payment page) and the **Direct API**
(we build the UI, 2C2P returns QR/redirect data) are two front ends over the
same token: Redirect = Payment Token then send the browser to
`webPaymentUrl`; Direct = Payment Token, optional Payment Option, then Do
Payment.
Sources: [Redirect API — how to
integrate](https://developer.2c2p.com/docs/redirect-api-integrate-with-payment),
[Direct API — QR
payment](https://developer.2c2p.com/docs/direct-api-method-qr-payment),
[Scan QR flow](https://developer.2c2p.com/docs/direct-api-flow-scan-qr).

**Backend notification** (server-to-server, to `backendReturnUrl`) and
**frontend return** (browser, to `frontendReturnUrl`) are both configured per
token; see 2.5 and 2.8.

**SDKs and sample code.** 2C2P ships mobile SDKs (Android/iOS PGW SDK, PGW UI
SDK, Flutter, React Native, SecurePay, SoftPOS), a Web SDK drop-in UI, and
WooCommerce/Shopify plugins. **There is no official Node.js or TypeScript
server SDK.** The server side is a plain HTTPS POST carrying one JWT, so none
is needed; community references are `TrustNetPK/2c2p-payments-node` and
`pangaunn/node-2c2p` (third-party, unaudited — read, do not depend on).
Source: `https://developer.2c2p.com/llms.txt`.

### 2.2 Security and the JWT envelope

- Every request and response body is `{"payload": "<jwt>"}`. The JWT header
  is `{"alg":"HS256","typ":"JWT"}` and the claims are the request fields.
  The merchant signs with its **Secret Key** using HMAC SHA-256; 2C2P signs
  its response the same way, so the response signature must be **verified**
  before the claims are read.
  Source: [JWT](https://developer.2c2p.com/docs/json-web-tokens-jwt),
  [Payment Token](https://developer.2c2p.com/docs/api-payment-token).
- **Payment Maintenance is different**: the Payment Action API uses
  **JWE (RSA-OAEP + A256GCM)** with a **JWS PS256** signature, i.e. an RSA key
  pair exchanged with 2C2P, not the HS256 secret.
  Source: [Refund](https://developer.2c2p.com/docs/payment-maintenance-refund-guide).
  Where the merchant's public key is uploaded, and how 2C2P's public key is
  obtained, is **not printed on the public docs** — **UNCERTAIN**; it comes
  from 2C2P onboarding/support.
- What must be verified on a backend notification, in our own order (the
  docs only require decoding): JWT signature under our secret; `merchantID`
  equals ours; `invoiceNo` is one we issued; `amount` and `currencyCode`
  match the attempt; `respCode`; then, before anything is released, a
  Payment Inquiry on the same `invoiceNo`.
- **Public sandbox demo credentials.** `https://developer.2c2p.com/docs/sandbox`
  prints eight demo merchants "available for the following locations ...
  without registering an account". The Thailand row is the one we would use
  for a first smoke test:

  | Country | Currency | Merchant ID | Secret (SHA) key |
  |---|---|---|---|
  | Thailand | THB / 764 | `JT04` | `CD22…38E2` (64 hex chars; copy from the docs page, not from here) |
  | Singapore | SGD / 702 | `JT01` | `ECC4…F2D9` (64 hex chars; copy from the docs page, not from here) |

  These are 2C2P's own public demo values, printed on the public
  documentation. They prove the wire format; they will **not** have the
  park's channels, return URLs or QR acquiring behind them, so the real
  sandbox merchant is still needed (section 5).

### 2.3 Payment Token request and response

`POST {host}/payment/4.3/paymentToken`. Fields as printed in [Payment Token
Request
Parameters](https://developer.2c2p.com/docs/api-payment-token-request-parameter)
(M mandatory, O optional, C conditional):

| Field | Type/len | M/O | Notes |
|---|---|---|---|
| `merchantID` | AN 25 | M | registered with 2C2P |
| `invoiceNo` | AN 50 | M | unique merchant order number. "Limited to ... **20 alphanumeric for QR payments**" |
| `description` | C 250 | M | product detail; HTML-encode specials, "avoid using unnecessary special characters" |
| `amount` | D (12,5) | M | e.g. `2500.90000`; decimals per ISO 4217 |
| `currencyCode` | A 3 | M | "3 alphabetical values as specified in ISO 4217" — i.e. **`THB`**, not the numeric `764`. The numeric 764 is the ISO number shown in the demo-account table and used by the legacy 3.x API. Correction to the working assumption |
| `paymentChannel` | array AN 1-6 | O | e.g. `["CC","IPP","APM","QR"]`; empty means all channels |
| `agentChannel` | array AN 1-6 | O | e.g. `["WEBPAY","ATM","OVERTHECOUNTER"]` |
| `request3DS` | A 1 | O | `Y` enable (default), `F` force, `N` disable |
| `tokenize` | B | O | show the store-card box; SDK UI |
| `frontendReturnUrl` | NT | O | browser return after payment |
| `backendReturnUrl` | NT | O | server notification after payment |
| `userDefined1`..`5` | C 150 each | O | merchant's own data |
| `paymentExpiry` | C 19 | O | `yyyy-MM-dd HH:mm:ss`; **default 20 minutes** |
| `idempotencyID` | C 100 | O | "used to recognize subsequent retries of the same request" |
| `nonceStr` | C 32 | O | random string |
| `locale` | C 10 | O | payment page and API response localisation |
| `promotionCode` | AN 20 | O | |
| `paymentRouteID` | C 255 | O | routing rules |
| `statementDescriptor` | AN 20 | O | 5-20 chars, avoid `<>\ ' " *` |
| `protocolVersion` | AN 10 | O | 3DS protocol, default `2.1.0` |
| `schemeReturnUrl` + `appBundleID` | C 512 / C 255 | O / C | native app return |

Response: `webPaymentUrl`, `paymentToken`, `respCode`, `respDesc`; proceed
only when `respCode` is `0000`.
Source: [Payment Token](https://developer.2c2p.com/docs/api-payment-token).

### 2.4 Do Payment for a Thai QR

`POST {host}/payment/4.3/payment`. Request
([Do Payment Request
Parameters](https://developer.2c2p.com/docs/api-do-payment-request-parameter)):

| Field | Type/len | M/O | Notes |
|---|---|---|---|
| `paymentToken` | C 255 | M | from Payment Token |
| `locale` | C 10 | O | ISO 639 |
| `responseReturnUrl` | C 255 | O | third-party return; the payment token is appended |
| `clientID` | C 255 | O | SDK client identity |
| `payment.code.channelCode` | AN 10 | M | from the channel matrix |
| `payment.code.agentCode` | C 10 | C | |
| `payment.code.agentChannelCode` | C 10 | C | |
| `payment.data.qrType` | C 255 | O | **"QR data format: ALL, RAW, BASE64, or URL"** |
| `payment.data.name` / `.email` / `.mobileNo` | C 50 / 150 / 255 | C / C / O | customer fields |
| `payment.data.paymentExpiry` | C 19 | O | `yyyy-MM-dd HH:mm:ss` |

**Channel codes, Thailand** ([Payment
Channels](https://developer.2c2p.com/docs/reference-payment-channels)):

| Code | Method |
|---|---|
| `PPQR` | **Prompt Pay QR** — the one we want |
| `GPTHQR` | GrabPay TH QR |
| `SHPQR` | AirPay QR (ShopeePay QR) |
| `TRUEMONEYQR` | True Money QR |
| `VEMVQR`, `MCEMVQR`, `UPIEMVQR`, `ALQR` | card-scheme and Alipay QR (from the Direct API QR examples) |

`THQR` ("Thai QR"), `QRC`, `CSQR` and `SGQR` appear in the **Payment Option**
response as **category/group codes**, not as Do Payment channel codes
([Payment Option](https://developer.2c2p.com/docs/api-payment-option)).
PROJECT_CONTEXT §7.2 assumed channel `THQR`; **the channel code to send is
`PPQR`**, and the value is confirmed against the live merchant by calling
Payment Option once — hence `PGW_QR_CHANNEL_CODE` is configuration, not a
constant.

Response ([Do Payment Response
Parameters](https://developer.2c2p.com/docs/api-do-payment-response-parameter)):

| Field | Type/len | Notes |
|---|---|---|
| `respCode` / `respDesc` | C 4 / C 255 | `1005` = "Pending for user scan QR." |
| `channelCode` | AN 6 | echo |
| `type` | A 6 | "Data type. For QR = QR data type" — the examples show `URL` |
| `data` | C 5000 | the thing to display: a URL endpoint/deeplink, or the QR code |
| `expiryTimer` | N 10 | "Expiry timer count down in **milliseconds**. For payment flow 1005 only" |
| `expiryDescription` | C 255 | for flow 1005 only |
| `extras.qrData` | C 5000 | **"QR data based on the qrType requested"** |
| `extras.barcodeData` | C 5000 | |
| `extras.referenceNo` | C 255 | payment-slip reference |
| `extras.paymentExpiry` | C 19 | `yyyy-MM-dd HH:mm:ss`, APM payments |
| `invoiceNo` | AN 50 | "Only returned when respCode is 2000" |
| `fallbackData` | C 255 | flow 1004 only |

Documented example (Alipay QR, sandbox):

```
{"type":"URL",
 "data":"https://pgw-static-sandbox.s3.amazonaws.com/images/qr/3241886.png",
 "channelCode":"ALQR","respCode":"1005",
 "respDesc":"Pending for user scan QR."}
```

**Is the raw EMVCo string available? Yes.** Setting
`payment.data.qrType` to `RAW` (or `ALL`) returns the QR content in
`extras.qrData`, and the SDK guide says of `QRTypeCode.Raw`: "Build QR image
by using raw string".
Source: [QR Payment (SDK)](https://developer.2c2p.com/docs/sdk-method-qr-payment).
That matters for us: the customer display renders the QR itself from the raw
payload, so the display needs no outbound internet and no image fetch, and a
blocked S3 host cannot break a sale. Minting still requires the API call.

**How long is the QR valid?** By `paymentExpiry` — default **20 minutes** if
not sent — and `expiryTimer` tells the display how many milliseconds are
left. Whether the acquirer also enforces expiry at the payer's bank is
**UNCERTAIN**; test by paying after expiry in the sandbox (that is exactly
the "late payment" case we handle anyway).

Payment-flow response codes ([Payment Flow
Codes](https://developer.2c2p.com/docs/response-code-payment-flow)):

| Code | Flow | Merchant action |
|---|---|---|
| 1000 | load redirect URL in iframe/webview | close on RESULT URL |
| 1001 | full redirection | redirect |
| 1002 | scheme URL / deeplink | redirect, then query status |
| 1003 | payslip | display, mark PENDING |
| 1004 | external app scheme (mobile) | redirect, await callback |
| **1005** | **display generated QR and wait for the customer to scan/pay** | **display QR and loop the status query** |
| 2000 | transaction completed | await backend notification, or Payment Inquiry |
| other | failed/rejected | Payment Inquiry, then show the result |

### 2.5 Backend notification

2C2P POSTs server-to-server to `backendReturnUrl` with the same
`{"payload":"<jwt>"}` envelope, HS256 under our secret.
Source: [Payment Response
(Backend)](https://developer.2c2p.com/docs/api-payment-response-backend).

Fields, as printed in [Payment Response Back End
Parameters](https://developer.2c2p.com/docs/api-payment-response-back-end-parameter):

| Field | Type/len | M/O | Description |
|---|---|---|---|
| `merchantID` | C 25 | M | merchant ID |
| `childMerchantID` | C 25 | C | sub-account of `merchantID` |
| `invoiceNo` | AN 50 | M | our order number |
| `amount` | D (12,5) | M | transaction amount |
| `currencyCode` | A 3 | M | ISO 4217 alphabetic |
| `transactionDateTime` | N 14 | M | `yyyyMMddHHmmss` |
| `agentCode` | AN 30 | M | "the agent who process the payment" |
| `channelCode` | AN 30 | M | channel code |
| `approvalCode` | C 6 | C | card transactions only |
| `referenceNo` | AN 50 | M | reference from the card host / invoice number for APM |
| `tranRef` | AN 255 | O | "Issued by System. Trace transactions in the Routing System" |
| `accountNo` | N 19 | M | **masked** card number (first 6, last 4) |
| `paymentID` | C 255 | M | e.g. `ccpp_12345678`, for referencing later payments |
| `cardType`, `issuerCountry`, `issuerBank`, `eci` | — | C | card only |
| `installmentPeriod`, `interestType`, `interestRate`, `installmentMerchantAbsorbRate` | — | C | IPP |
| `recurringUniqueID`, `recurringSequenceNo` | — | C | RPP |
| `fxAmount`, `fxRate`, `fxCurrencyCode` | — | C | MCP |
| `userDefined1`..`5` | C 150 | O | our own data, echoed |
| `acquirerReferenceNo`, `acquirerMerchantId` | C 50 | O | acquirer side |
| `acquirerResponseCode` | N 2 | O | ISO 8583 from the acquirer |
| `idempotencyID` | C 100 | O | echo |
| `paymentScheme` | C 30 | C | |
| `schemePaymentID` | C 255 | C | |
| `respCode` / `respDesc` | C 4 / C 255 | M | `0000` = successful |

**Field-name corrections to the working assumptions.** The v4.3 backend
payload has **no** `paidAgent`, `paidChannel` or `cardNo`. The equivalents
are `agentCode`, `channelCode` and `accountNo` (already masked). `paidAgent`
and `paidChannel` belong to the legacy 3.x response and must not appear in
our types.

**What we must return.** The documentation does not state a required
response body — **UNCERTAIN**. Practice across integrations (e.g. the Drupal
`commerce_2c2p` issue "Always respond to 2c2p notification request") is to
always answer **HTTP 200** quickly and never throw; `respCode` **9999
"Request to merchant backend has failed"** exists in the payment response-code
table, so 2C2P does record a failed delivery.
Source: [Payment Response
Codes](https://developer.2c2p.com/docs/response-code-payment).

**Retries and duplicates.** No retry schedule is published — **UNCERTAIN**.
Assume redelivery and duplicates, and make the endpoint idempotent. The
`Scan QR` flow diagram ends with "2C2P sends backend response to merchant"
(step 14), so a QR payment does produce a notification.

**Reconciling to our sale.** `invoiceNo` is the join key: one invoice number
per payment attempt (section 3), stored on the attempt, echoed in the
notification, in Payment Inquiry and in the settlement file. `tranRef` and
`paymentID` are 2C2P's own identifiers, stored alongside for support cases
and for deduplication.

### 2.6 Payment Inquiry

`POST {host}/payment/4.3/paymentInquiry`, same JWT envelope. The documented
example carries `merchantID`, `invoiceNo`, `locale`; the page also notes a
`paymentToken` form of the payload. The response is the same field set as the
backend notification (`merchantID`, `invoiceNo`, `amount`, `currencyCode`,
`transactionDateTime`, `agentCode`, `channelCode`, `approvalCode`,
`referenceNo`, `tranRef` (AN 28 here), `accountNo`, `paymentID`,
`userDefined1`..`5`, `respCode`, `respDesc`, and the card/IPP/RPP/FX
conditionals).
Sources: [Payment
Inquiry](https://developer.2c2p.com/docs/api-payment-inquiry), [Payment
Inquiry Response
Parameters](https://developer.2c2p.com/docs/api-payment-inquiry-response-parameter).

Response codes we act on (full table at [Payment Response
Codes](https://developer.2c2p.com/docs/response-code-payment)):

| Code | Meaning | Our reading |
|---|---|---|
| `0000` | Successful | paid |
| `0001` | Transaction is pending | keep polling |
| `0003` | Transaction is cancelled | cancelled |
| `0004` | Soft-declined, resubmit after 3DS | cards only |
| `1005` | (flow) pending for user scan QR | QR on display, keep polling |
| `2000` | (flow) transaction completed | read the result |
| `2001` | Transaction in progress | keep polling |
| `2002` | Transaction not found | our invoice never reached 2C2P |
| `2003` | Payment / Inquiry failed | alert |
| `4110` | Settled | settled |
| `4120` / `4121` / `4122` | Refunded / refund rejected / refund failed | refund outcomes |
| `4130` | Chargeback | alert |
| `5005` | Duplicated Invoice | our invoice number was reused — bug |
| `5009` / `9020` | Payment Expired | expire the attempt |
| `5015` / `5016` | Customer paid more / less than the transaction amount | amount mismatch, manual handling |
| `5017` | Paid Expired | late payment after expiry |
| `9015` | Existing Invoice Number | invoice reuse on token creation |
| `9041` | Payment token already used | re-mint a token |
| `9042` | Hash value mismatch | signing bug |
| `9057`-`9060` | Payment options / channel invalid, unauthorised, unconfigured | the QR channel is not enabled on the merchant |
| `9900` | Unable to decrypt the payload | signing/envelope bug |
| `9999` | Request to merchant backend has failed | our webhook did not answer |
| `0999` / `5998` / `999x` | System / internal / downstream errors | retry, then alert |

### 2.7 Payment Maintenance — refund, void, settle

The Payment **Action** API 2.0 (`.../PaymentAction/2.0/action`, hosts in 2.1)
covers: payment inquiry, **void/cancel**, **settle/capture**, **refund**,
refund status inquiry, card tokenisation, RPP maintenance, IPP inquiry and
FX rate inquiry.
Source: [Payment Maintenance — how it
works](https://developer.2c2p.com/docs/payment-maintenance-how-it-works).

- Request fields: `version` (4.3), `timestamp` (`ddmmyyhhmmss`),
  `merchantID`, `invoiceNo`, `actionAmount`, `processType` — **`R` refund**,
  **`V` void**. The settle/capture `processType` letter is not printed on the
  pages read — **UNCERTAIN**.
- Response: `respCode` (`00` = success), `respDesc`, `processType`,
  `invoiceNo`, `amount`, `status`, `approvalCode`, `referenceNo`,
  `refundReferenceNo`, `transactionDateTime`, `maskedPan`, `eci`,
  `paymentScheme`, `userDefined1`..`5`.
- Security: **JWE RSA-OAEP + A256GCM, JWS PS256** — a different key pair from
  the HS256 secret.
- Windows: a **void** "must be sent on the same day as the transaction
  authorisation, and before the acquirer's cut-off time"; a **refund** is
  only possible for **settled** transactions, and "the total refund value
  must not exceed the value of the original settled transaction";
  unsettled pre-authorisations "are automatically voided" after commonly
  7 days. Asynchronous refunds return REFUND_PENDING and are resolved by the
  Refund Status Inquiry API or a `notifyURL` callback.
- Partial refunds are supported through `actionAmount` (the constraint is on
  the total, not on a single call).

Status codes ([Payment Maintenance Status
Codes](https://developer.2c2p.com/docs/response-code-payment-maintenance-status-code)):
`A` approved, `AP` approval pending, `AE` approved after expired (APM),
`AL`/`AM` approved with less/more amount (APM), `PF` payment failed,
`AR` authentication rejected, `FF` fraud rule rejected, `IP` invalid
promotion, `ROE` routing rejected, `RP` refund pending, `RF` refund
confirmed, `RFF` refund failed, `RR`/`RR1`/`RR2`/`RR3` refund rejected
(insufficient balance / invalid bank information / bank account mismatch),
`RS` ready for settlement, `S` settled, `T` credit adjustment, `V`
voided/cancelled, `VP` void pending, `EX` payment expired, `CTS`/`CTF`
tokenisation success/failure, `PPC`/`PFC` payment partially/fully captured.

The presence of `AE`, `AL`, `AM`, `RR1`-`RR3` shows APM (non-card) payments
are within the maintenance API's world. **Whether a PromptPay QR payment is
refundable through it, and on what timing, is UNCERTAIN** — the guides are
written around cards. This must be answered by 2C2P before we promise
in-app QR refunds; the fallback is a manual bank transfer recorded against
the sale, which is how the SCB direct route would have to work anyway.

Thai acquirer cut-off times, Asia/Bangkok ([Payment Channels Cut-Off
Time](https://developer.2c2p.com/docs/reference-payment-channels-cut-off-time)):
EMVQR **21:00**, Siam Commercial Bank 22:00, Bangkok Bank 23:10, Kasikorn
Bank 21:00, Krungthai Card 21:30, Bank of Ayudhya 20:00, LinePay 23:59,
TrueMoney 23:59, 123 TH 23:59, 2C2P MC Acquiring 21:00. A void is only
possible before the channel's cut-off on the same day; after that it is a
refund.

### 2.8 Redirect API for the booking site

1. Payment Token with `frontendReturnUrl`, `backendReturnUrl`, and
   `paymentChannel` restricted to what the booking page should offer.
2. Validate `respCode == "0000"`.
3. Send the browser to `webPaymentUrl` (2C2P's hosted page; PCI stays with
   2C2P).
4. 2C2P POSTs the **backend notification** — the authoritative event.
5. The browser comes back to `frontendReturnUrl`. The frontend return is a
   form POST whose field **`paymentResponse`** is a base64url JWT carrying
   only `invoiceNo`, `channelCode`, `respCode`, `respDesc`, `locale`, with
   `respDesc` such as "Transaction is completed, please do payment inquiry
   request for full payment information." It is a display hint, never proof.
6. Payment Inquiry for the full picture.

Sources: [How to
integrate](https://developer.2c2p.com/docs/redirect-api-integrate-with-payment),
[Payment Response
(Frontend)](https://developer.2c2p.com/docs/api-payment-response-frontend).

Channels available in Thailand
([Payment Channels](https://developer.2c2p.com/docs/reference-payment-channels)):
cards (`CC`), installments (`IPP`, across Thai banks incl. BBL, UOB, KTC,
SCB, BAY, AEON, Amex), internet/mobile banking (`WEBPAY`, code `123`, SCB,
Bangkok Bank, Kasikorn and others), QR (`PPQR`, `GPTHQR`, `SHPQR`,
`TRUEMONEYQR`, card-scheme QR), wallets (`TRUEMONEY`, `LINE` = LINE Pay,
`ALIPAY`, `WECHAT`/`WCMINI`/`WCAPP`, `SHPPAY` = ShopeePay, `PAOTANG`,
`LAZADAPAY`), BNPL (`TRUEPAYNEXT`).

3-D Secure: `request3DS` = `Y` (default) / `F` force / `N` disable;
`protocolVersion` defaults to `2.1.0`; `respCode 0004` means soft-declined,
resubmit after 3DS authentication.

### 2.9 Sandbox behaviour

- **Getting in.** The public demo merchants (2.2) need no registration. The
  park's own sandbox merchant comes from 2C2P — "you can receive a demo
  Merchant ID and credentials from the 2C2P team" — and is managed in the
  demo merchant portal (2.1).
  Source: [Sandbox Setup](https://developer.2c2p.com/docs/sandbox-setup).
- **Test cards** ([Sandbox Setup](https://developer.2c2p.com/docs/sandbox-setup),
  [Test cards & accounts](https://developer.2c2p.com/docs/reference-testing-information),
  [Thailand](https://developer.2c2p.com/docs/reference-test-information-th)):
  Visa `4111111111111111` (CVV 123, OTP 123456), Mastercard
  `5555555555554444` (CVV 123, OTP 123456), Amex `378282246310005` /
  `374340095639074` (CVV 1234), JCB `3562808775869340`, UnionPay
  `6250947000000014`, rejected card `4444333322221111`; Thai IPP cards per
  bank (BBL, UOB, KTC, SCB, BAY, TBANK, KFC, CFC), expiry 12/30, CVV 234,
  OTP 123456.
- **How a QR payment is simulated: not documented. UNCERTAIN, and the one
  real gap.** The Thailand test page carries card and IPP cards only and
  says nothing about PromptPay, Thai QR, TrueMoney, LINE Pay or internet
  banking. What the docs do describe is the polling loop: the response is
  `1005` "Pending for user scan QR", and "merchants must have a looping
  function that checks the Transaction Status API ... a transaction will be
  displayed as pending until the customer has completed the payment". There
  is a **sandbox-only endpoint `POST https://sandbox-pgw.2c2p.com/payment/4.3/
  paymentsimulate`** whose OpenAPI schema is just `{ "payload": string }`,
  with no documented fields
  ([reference](https://developer.2c2p.com/reference/post_payment-4-3-paymentsimulate)).
  Three possibilities remain, in the order we should test them: (a)
  `paymentsimulate` accepts a JWT naming the `paymentToken`/`invoiceNo` and
  an outcome; (b) the sandbox QR image resolves to a payable sandbox page;
  (c) the demo merchant portal has a "mark as paid" action. **Ask 2C2P and
  test in the first sandbox session.** Our own gateway simulator (section 3)
  keeps CI and demos independent of the answer.
- **Backend notifications from the sandbox to a public HTTPS URL**: the flow
  diagram includes the backend response and `backendReturnUrl` is a
  per-token field rather than a portal setting, so a public staging HTTPS URL
  should receive them; whether the sandbox actually delivers, and whether
  the URL must be whitelisted in the portal, is **UNCERTAIN** — verify in the
  first session. The API is deployed on a public staging domain
  (`docs/architecture/DEPLOYMENT_TOPOLOGY.md`), so no tunnel is needed.
- **Sandbox limits**: none published — **UNCERTAIN**.

### 2.10 Constraints to encode in validation

| Item | Rule | Source |
|---|---|---|
| `invoiceNo` length | AN 50 in general, **20 alphanumeric for QR payments**; 12 numerals for APM Myanmar | Payment Token request parameters |
| `invoiceNo` uniqueness | must be unique for the merchant: `5005` "Duplicated Invoice", `9015` "Existing Invoice Number" | Payment response codes |
| `invoiceNo` characters | "AN" = alphanumeric; no documented separator set. We restrict to `A-Z0-9` to be safe — **UNCERTAIN** whether `-` or `_` are accepted | — |
| `amount` | Decimal(12,5), e.g. `2500.90000`; decimals per ISO 4217 | Payment Token request parameters |
| `currencyCode` | 3 **alphabetic** ISO 4217 — `THB` | same |
| `paymentExpiry` | `yyyy-MM-dd HH:mm:ss`, default 20 minutes | same |
| `userDefined1`..`5` | C 150 each | same |
| `description` | C 250, HTML-encoded, avoid special characters | same |
| `nonceStr` | C 32 | same |
| `idempotencyID` | C 100 | same |
| `statementDescriptor` | AN 20, 5-20 characters, avoid `<>\ ' " *` | same |
| `expiryTimer` | milliseconds, flow 1005 only | Do Payment response parameters |

### 2.11 Settlement and reconciliation

- **Reconciliation reports** are pushed daily over **SFTP**: "automatically
  generated and delivered to your designated SFTP server daily", "before
  4:00AM GMT+7", no request needed. Connection in the docs: `52.76.184.174`
  port 22, `/input` for pickup, `/output` for drop; credentials via an SFTP
  setup form and 2C2P support.
- **File name**:
  `Reconcile2c2p_B_v2.4_MID_CURRENCY_yyyy-MM-dd_HHmmss_[suffix].csv`; CSV with
  header records (`TYPE_TABLE = H`, merchant bank details and totals) and
  detail records (`TYPE_TABLE = D`, "transaction-level data for each payment,
  refund, or chargeback"). Separate field definitions exist for IPP and
  non-IPP.
  Source: [Reconciliation
  Reports](https://developer.2c2p.com/docs/batch-services-reconcile-report-info).
- Which detail column carries our `invoiceNo` is **UNCERTAIN** from the
  overview page; the non-IPP field definition page
  (`batch-services-reconcile-report-non-ipp`) settles it when we have a real
  file.
- Settlement **timing** for PromptPay QR is not published by 2C2P —
  **UNCERTAIN**; the channel cut-off table (2.7) gives the daily boundary
  (EMVQR 21:00 Asia/Bangkok), and the payout day comes from the park's
  merchant agreement with 2C2P/SCB.
- The merchant portal also shows transactions and reports interactively
  (`my.2c2p.com`); there is no documented JSON reconciliation API beyond
  Payment Inquiry per invoice.

---

## 3. Our integration design

### 3.1 Shape

One package, `packages/payments-2c2p`, implementing the `QrPayment` contract
from `packages/contracts` (`docs/progress/SPRINT_2_PLAN.md`, design decision
"QR payments are real, through the 2C2P sandbox"). Nothing outside the
package knows 2C2P exists: the sale service asks `QrPayment` for a QR and is
told when it is paid.

```
QrPayment
  createQr({ attemptId, invoiceNo, amountSatang, description,
             expiryMinutes, userDefined })  -> { qrPayload?, qrImageUrl?,
                                                 expiresAt, providerRef }
  inquire({ invoiceNo })                    -> { state, raw }
  cancel({ invoiceNo })                     -> ok | unsupported
  refund({ invoiceNo, amountSatang })       -> { state, providerRefundRef }
```

Implementations: `TwoC2PQrPayment` (real, when `PGW_PROVIDER=2c2p` and the
credentials are present) and `SimulatorQrPayment` (default). Both speak the
same shapes so nothing downstream branches.

Internally the 2C2P client does: sign HS256 → POST `{payload}` → verify the
response JWT → decode → map `respCode` to our states. Money crosses the
boundary as integer satang and is formatted to `D(12,5)` only at the wire.

### 3.2 Payment attempt lifecycle

`payment_attempt` (method `qr`, provider `2c2p`) moves:

```
created ──► qr_shown ──┬──► paid ──► refunded
                       ├──► expired ──► late_paid ──► refunded
                       └──► cancelled ──► late_paid ──► refunded
```

| State | Entered when | 2C2P signal |
|---|---|---|
| `created` | Payment Token minted | token `respCode 0000` |
| `qr_shown` | Do Payment returned the QR and the display is showing it | `respCode 1005`, `expiryTimer` |
| `paid` | notification or inquiry says paid, amount and currency match | `respCode 0000` |
| `expired` | `expiresAt` passed and inquiry does not say paid | `5009` / `9020` / status `EX` |
| `cancelled` | staff cancelled the tender; we call `canceltransaction` | `0003`, or unsupported |
| `late_paid` | a paid signal arrives for an `expired` or `cancelled` attempt | `0000`, or `5017` "Paid Expired" |
| `refunded` | Payment Maintenance refund confirmed | status `RF`, `respCode 4120` |

Amount mismatches (`5015` paid more, `5016` paid less) never mark a sale
paid: they raise an alert and wait for a person.

### 3.3 invoiceNo — one per attempt

`invoiceNo` is **per payment attempt**, never per sale: a re-shown or
re-priced QR is a new attempt with a new invoice number, because 2C2P refuses
a reused one (`5005`, `9015`). Proposed format, inside the 20-character QR
limit and `A-Z0-9` only:

```
[PREFIX]  STATION   YYMMDD   SEQ
 ≤5       3         6        6      = ≤ 20
  ""      T01       260920   000147   ->  T01260920000147   (15)
 "SBX"    T01       260920   000147   ->  SBXT01260920000147 (18)
```

- `PREFIX` is `PGW_INVOICE_PREFIX`, empty in production and set in sandbox so
  test invoices can never collide with real ones.
- `STATION` is the station code (`station.code`, upper alphanumeric, 3).
- `YYMMDD` is the **branch business date** (Asia/Bangkok), so the number is
  readable on a settlement line and unique across days.
- `SEQ` is a per-station, per-day counter from the database, zero-padded to 6.
- The generator lives in the package, is unit-tested for length, charset and
  uniqueness, and stores the value on `payment_attempt.provider_invoice_no`
  with a unique index.

### 3.4 Backend notification endpoint

`POST /webhooks/2c2p/payment` on the API (path may carry
`PGW_WEBHOOK_SECRET` as a segment for cheap filtering of internet noise).
It is unauthenticated by session and must be fast:

1. Read `{"payload": "<jwt>"}`. **Verify the HS256 signature** with
   `PGW_SECRET_KEY`. A bad or missing signature is logged and answered 200
   (never a detail of why) and processed no further.
2. Check `merchantID == PGW_MERCHANT_ID`.
3. Write an **`ops_run`** record with the raw envelope, the decoded claims,
   source IP, headers and the matching outcome — the audit trail for any
   dispute.
4. **Idempotency key `(invoiceNo, tranRef)`** (falling back to
   `(invoiceNo, paymentID)` when `tranRef` is absent) with a unique index.
   A duplicate delivery finds the row, does nothing, and answers 200.
5. Match `invoiceNo` to `payment_attempt`. No match → `unmatched_payment`,
   alert on Failures, answer 200.
6. Compare `amount` (to satang) and `currencyCode` against the attempt.
   Mismatch → alert, do not mark paid.
7. On `respCode 0000`, **inside one database transaction**: mark the attempt
   `paid`, record `tranRef`, `paymentID`, `approvalCode`, `channelCode`,
   `agentCode`, `transactionDateTime`, and settle the sale through the sale
   service (the same `withTx` path a cash tender uses), with the audit row in
   the same transaction.
8. Answer **HTTP 200** within a second. Never let an internal failure turn
   into a non-200: queue the work and acknowledge.
9. Push the new state to the till and the customer display.

We treat the notification as a **trigger**, not as truth: before anything is
released (bands printed, booking confirmed) a Payment Inquiry on the same
`invoiceNo` must agree. That is our rule, not 2C2P's, and it costs one call.

### 3.5 Inquiry poller

- Runs while an attempt is `qr_shown`: every `PGW_INQUIRY_INTERVAL_S`
  (default 3 s) for the first two minutes, then every 10 s, jittered.
- Stops on a terminal state, or 60 s after `expiresAt`.
- A sweeper job (`job:payments.pending`) re-inquires every attempt still
  unresolved up to `PGW_INQUIRY_MAX_MIN` (default 30) after creation, and
  again at end of day; anything still unresolved is flagged on the Failures
  screen, consistent with the terminal-payment rule that no sale with an
  unknown outcome is left silent.
- The poller and the webhook write through the same idempotent
  "mark paid" service, so whichever arrives first wins and the second is a
  no-op.

### 3.6 On the display

The display renders the QR **itself** from `extras.qrData` (requested with
`qrType: "RAW"`), falling back to the `data` image URL only if the raw
payload is absent. It shows the amount, a countdown driven by `expiryTimer`
/ `expiresAt`, and the branch's language. On expiry it stops showing the QR,
tells the customer the code expired, and offers the till a new attempt. The
display never calls 2C2P and never holds the secret.

### 3.7 Cancel, late payment and duplicates

- **Cancel**: staff cancel the tender → attempt `cancelled`, display cleared,
  `canceltransaction` called best-effort (support for QR is UNCERTAIN; a
  failure there is logged, not surfaced).
- **Late payment**: a paid signal for an `expired` or `cancelled` attempt
  sets `late_paid`, **alerts the branch manager**, and offers two actions —
  apply to the sale if it is still open, or **refund** through Payment
  Maintenance. Where the sale is already closed and settled by another
  tender, the default path is an automatic refund request plus an alert, and
  a manual bank transfer with a recorded reference if the gateway cannot
  refund that channel.
- **Duplicates**: unique index on `(invoiceNo, tranRef)`; unique index on
  `provider_invoice_no`; the sale is marked paid exactly once because the
  transition is guarded inside the sale transaction.

### 3.8 What is logged, and what never is

Logged, per request, with the request id: `invoiceNo`, attempt id, sale id,
`tranRef`, `paymentID`, `channelCode`, `agentCode`, `respCode`/`respDesc`,
amount in satang, latency, retry count, the environment, and for webhooks the
raw envelope and source IP.

**Never logged**: `PGW_SECRET_KEY`, `PGW_MAINT_PRIVATE_KEY`, any full card
number (we never receive one — `accountNo` arrives masked and is stored
masked), and the customer's personal fields beyond what the sale already
holds. The admin console shows **presence flags only** for the `PGW_*`
values, never their contents.

### 3.9 The gateway simulator

When `PGW_PROVIDER=simulator`, or when `PGW_MERCHANT_ID`/`PGW_SECRET_KEY`
are absent, `SimulatorQrPayment` answers with the **same shapes**: a
`1005`-style pending response, a locally generated EMVCo-shaped payload, an
`expiryTimer`, and a real-looking `tranRef`. The Console's simulator panel
offers **"customer paid"**, **"late payment"**, **"decline"** and
**"expire"**, each of which posts a synthetic notification to
`/webhooks/2c2p/payment` signed with the configured secret, so the production
code path is exercised end to end. CI, demos and offline development never
need the sandbox; the sandbox is used for the real-QR acceptance runs.

### 3.10 Booking site

The booking site uses the **Redirect API** with the same package: quote
server-side, mint a Payment Token with `frontendReturnUrl` (a "checking your
payment" page) and the same `backendReturnUrl`, send the browser to
`webPaymentUrl`, and confirm the booking only on the backend notification
plus a Payment Inquiry — never on the browser's return. The booking's
`payment_attempt` uses the same invoice format with the station segment
replaced by a `WEB` code. A failed or expired payment leaves the booking
unconfirmed and releases the held capacity.

### 3.11 Settlement export and reconciliation

The daily 2C2P reconciliation CSV (2.11) is imported — by SFTP pull once
credentials exist, by manual upload in the Console before that — into
`settlement_batch` / `settlement_line`. Lines match attempts by
**`invoiceNo`**, cross-checked against `tranRef`/`paymentID`; anything
unmatched in either direction appears on the end-of-day reconciliation screen
beside the card-terminal batches, with the ฿1 tolerance rule already used for
cash. A 2C2P settlement fixture shaped like the real file lives in the test
suite so the importer is testable before the park's first real file exists.

---

## 4. Environment variables

API server only. None of these ever reach a Pi box or a browser. The admin
console shows presence, never values.

| Variable | Meaning |
|---|---|
| `PGW_PROVIDER` | `2c2p` or `simulator` — which `QrPayment` implementation is active |
| `PGW_ENV` | `sandbox` or `production` — selects defaults and marks every record |
| `PGW_BASE_URL` | Payment API host, e.g. `https://sandbox-pgw.2c2p.com`; defaults from `PGW_ENV` |
| `PGW_MERCHANT_ID` | merchant ID issued by 2C2P (`merchantID` in every payload) |
| `PGW_SECRET_KEY` | merchant Secret Key used to sign and verify HS256 JWTs |
| `PGW_CURRENCY_CODE` | ISO 4217 alphabetic currency sent as `currencyCode`; `THB` |
| `PGW_BACKEND_RETURN_URL` | public HTTPS URL 2C2P notifies, e.g. `https://api.<domain>/webhooks/2c2p/payment` |
| `PGW_FRONTEND_RETURN_URL` | browser return for the booking site's hosted-page flow |
| `PGW_WEBHOOK_SECRET` | random path/query token on the webhook URL; cheap filter, not authentication (the JWT signature is) |
| `PGW_QR_CHANNEL_CODE` | Do Payment channel code for the till QR; `PPQR` for PromptPay |
| `PGW_QR_TYPE` | `RAW`, `URL`, `BASE64` or `ALL` — which QR representation to request; `RAW` so the display renders locally |
| `PGW_PAYMENT_EXPIRY_MIN` | minutes until the QR expires, written into `paymentExpiry`; 2C2P's default is 20 |
| `PGW_INVOICE_PREFIX` | optional prefix on `invoiceNo` (≤ 5 chars) keeping sandbox invoices apart from production |
| `PGW_INQUIRY_INTERVAL_S` | seconds between Payment Inquiry calls while a QR is displayed (3) |
| `PGW_INQUIRY_MAX_MIN` | minutes after which an unresolved attempt stops being polled and is flagged (30) |
| `PGW_MAINT_BASE_URL` | Payment Action host for refunds/voids — a different host from `PGW_BASE_URL` (`https://demo2.2c2p.com` / `https://t.2c2p.com`) |
| `PGW_MAINT_PRIVATE_KEY` | our RSA private key (PEM) for JWE decryption and JWS PS256 signing of maintenance calls |
| `PGW_MAINT_2C2P_PUBLIC_KEY` | 2C2P's RSA public key (PEM) used to encrypt maintenance requests and verify their signatures |

`PGW_*` replaces the `2C2P_*` names used in earlier drafts. A missing
`PGW_MERCHANT_ID` or `PGW_SECRET_KEY` silently selects the simulator and says
so in the startup log and on the Console's integrations screen.

---

## 5. Configuration the owner must supply

Sandbox, to get the first real QR on a display:

- [ ] **Sandbox merchant ID and Secret Key** for the park, from 2C2P (request
      a demo merchant through the park's 2C2P contact, or the merchant
      portal). For a first wire test only, the public demo pair
      `JT04` / `CD22…38E2` (section 2.2) works with no account.
- [ ] **PromptPay QR enabled** on that sandbox merchant, and confirmation of
      the Do Payment **channel code** (`PPQR` expected) — we verify with one
      Payment Option call.
- [ ] **Return URLs**: the staging API's `https://.../webhooks/2c2p/payment`
      and the booking site's return page, registered/whitelisted in the
      merchant portal if 2C2P requires it.
- [ ] **How a sandbox QR is marked paid** — the one open question (2.9).
      Ask 2C2P: is `paymentsimulate` available to us, is there a portal
      action, or is a sandbox payer app expected?
- [ ] **Maintenance key pair**: generate our RSA key pair, upload the public
      key where 2C2P directs, and receive 2C2P's public key. Needed only for
      refunds and voids, so it can follow the first QR.
- [ ] Merchant portal logins for whoever will check transactions.

Production, at go-live:

- [ ] **Production merchant ID and Secret Key**, with the PromptPay QR channel
      (and any wallet channels the booking site should offer) enabled by 2C2P
      and SCB.
- [ ] Production return URLs registered against the production merchant.
- [ ] Production maintenance key pair (separate from sandbox).
- [ ] **SFTP credentials** for the daily reconciliation file (2C2P's SFTP
      setup form), or a decision to download the report from the portal.
- [ ] Confirmation from 2C2P of: whether PromptPay QR can be refunded through
      Payment Maintenance and within what window; the settlement day for QR;
      the fee schedule for PromptPay QR; backend-notification retry
      behaviour.
- [ ] The switch itself is `PGW_ENV`, `PGW_BASE_URL`, the credentials and the
      registered URLs. No code changes.

---

## 6. Alternative provider — SCB Developer Portal direct API

Summarised from
`docs/architecture/research/2026-09-20-scb-direct-api-research.md`, which
holds the full detail and its own sources. Added as a **second `QrPayment`
provider only if the park holds an SCB Developer Portal application**; it
never replaces 2C2P.

- **Portal and keys.** Sign up at `https://developer.scb`; each account may
  hold up to 2 applications, each with an **API Key** and **API Secret**.
  The application page also carries the sandbox **Biller ID**, the
  **Reference 3 prefix**, Merchant/Terminal ID for card QR, test customers
  with PINs, and the **Payment Confirmation Endpoint** (the webhook URL).
- **Auth.** `POST /v1/oauth/token`, client credentials, body
  `{applicationKey, applicationSecret}`, headers `resourceOwnerId` (the API
  key) and `requestUId`; access token valid 30 minutes. Sandbox base
  `https://api-sandbox.partners.scb/partners/sandbox/`.
- **QR 30 create.** `POST /v1/payment/qrcode/create` (`qrType: "PP"`, or
  `"CS"`/`"PPCS"` for card-scheme QR) returns `qrRawData` and a render URL;
  `POST /v2/payment/qrcode/create` adds `numberOfTimes` and `expiryDate`, so
  v2 is the only way to a single-use, expiring PromptPay QR. References
  `ref1`/`ref2`/`ref3` (A-Z0-9, 20) carry our identifiers; `ref3` must use the
  SCB-assigned prefix for the webhook to route to us.
- **Payment confirmation.** SCB POSTs to the registered endpoint when a QR is
  paid; the webhook carries **no signature**, so it must be verified with
  `GET /v1/payment/billpayment/inquiry` before anything is released. Up to
  three retries; respond `{"resCode":"00", ...}` quickly.
- **Deeplink.** `POST /v3/deeplink/transactions` opens SCB EASY for bill
  payment, card or installments; status via `GET /v2/transactions/{id}`
  (`statusCode` 1 = PAID). Useful only to SCB EASY customers.
- **Sandbox.** Payment is simulated with the **SCB EASY Simulator app**
  (Android/iOS via Firebase App Distribution): log in by scanning the
  portal's QR, use a pre-generated customer PIN, scan our QR, confirm — and
  SCB then posts a real webhook to our public HTTPS URL. Rate limit 5 TPS per
  API per app.
- **The gaps.** **No usable public refund or void API** for QR 30 or QR CS —
  refunds would be manual bank transfers. **No reconciliation export API**;
  reports come from SCB Business Net / the merchant portal, with a date-range
  bill-payment search as a partial substitute.
- **What the owner would need**: an SCB developer account and application,
  the production Biller ID (Tag 30, juristic person) and ref3 prefix, a
  registered payment-confirmation URL, possibly a client certificate, and
  SCB's business onboarding (service request, UAT/PVT, fee schedule with a
  possible development-support fee).
- **Why it stays second**: 2C2P covers refunds, settlement files, cards,
  wallets and the hosted booking page in one contract; SCB direct covers
  PromptPay only and leaves refunds manual. It is worth adding only if the
  park already holds the application, or if 2C2P's QR fees justify moving
  in-person QR to the bank.

---

## 7. Sources

2C2P public documentation (every page also available as markdown by
appending `.md`; index at `https://developer.2c2p.com/llms.txt`):

- Redirect API, how to integrate —
  https://developer.2c2p.com/docs/redirect-api-integrate-with-payment
- Payment Token — https://developer.2c2p.com/docs/api-payment-token
- Payment Token request parameters —
  https://developer.2c2p.com/docs/api-payment-token-request-parameter
- Do Payment — https://developer.2c2p.com/docs/api-do-payment
- Do Payment request parameters —
  https://developer.2c2p.com/docs/api-do-payment-request-parameter
- Do Payment response parameters —
  https://developer.2c2p.com/docs/api-do-payment-response-parameter
- Direct API, QR payment —
  https://developer.2c2p.com/docs/direct-api-method-qr-payment
- Direct API, Scan QR flow —
  https://developer.2c2p.com/docs/direct-api-flow-scan-qr
- QR payment (SDK) — https://developer.2c2p.com/docs/sdk-method-qr-payment
- Payment Option — https://developer.2c2p.com/docs/api-payment-option
- Payment Inquiry — https://developer.2c2p.com/docs/api-payment-inquiry
- Payment Inquiry response parameters —
  https://developer.2c2p.com/docs/api-payment-inquiry-response-parameter
- Payment Response (Backend) —
  https://developer.2c2p.com/docs/api-payment-response-backend
- Payment Response backend parameters —
  https://developer.2c2p.com/docs/api-payment-response-back-end-parameter
- Payment Response (Frontend) —
  https://developer.2c2p.com/docs/api-payment-response-frontend
- JWT — https://developer.2c2p.com/docs/json-web-tokens-jwt
- Payment response codes —
  https://developer.2c2p.com/docs/response-code-payment
- Payment flow codes —
  https://developer.2c2p.com/docs/response-code-payment-flow
- Payment maintenance status codes —
  https://developer.2c2p.com/docs/response-code-payment-maintenance-status-code
- Payment maintenance, how it works —
  https://developer.2c2p.com/docs/payment-maintenance-how-it-works
- Refund — https://developer.2c2p.com/docs/payment-maintenance-refund-guide
- Void — https://developer.2c2p.com/docs/payment-maintenance-void-guide
- URLs & environment —
  https://developer.2c2p.com/docs/reference-environment-guide
- Sandbox (demo merchant credentials) —
  https://developer.2c2p.com/docs/sandbox
- Sandbox setup — https://developer.2c2p.com/docs/sandbox-setup
- Test cards and accounts —
  https://developer.2c2p.com/docs/reference-testing-information
- Test information, Thailand —
  https://developer.2c2p.com/docs/reference-test-information-th
- Payment channels —
  https://developer.2c2p.com/docs/reference-payment-channels
- Payment channels cut-off time —
  https://developer.2c2p.com/docs/reference-payment-channels-cut-off-time
- Reconciliation reports —
  https://developer.2c2p.com/docs/batch-services-reconcile-report-info
- Payment simulate (sandbox-only endpoint reference) —
  https://developer.2c2p.com/reference/post_payment-4-3-paymentsimulate

Third party, used only for corroboration and marked as such in the text:

- API Evangelist profile of the 2C2P PGW API —
  https://github.com/api-evangelist/2c2p
- Community Node helpers (unaudited) —
  https://github.com/TrustNetPK/2c2p-payments-node ,
  https://github.com/pangaunn/node-2c2p
- Drupal `commerce_2c2p` issue "Always respond to 2c2p notification request" —
  https://www.drupal.org/project/commerce_2c2p/issues/3343420

Internal:

- `docs/briefs/OWNER_DIRECTION.md` (2026-09-20, "Payments")
- `docs/briefs/PROJECT_CONTEXT.md` §7.2
- `docs/progress/SPRINT_2_PLAN.md` — S2-10a, S2-12, S2-15a, and the design
  decision "QR payments are real, through the 2C2P sandbox"
- `docs/architecture/research/2026-09-20-scb-direct-api-research.md`
- `docs/architecture/DEVICE_INVENTORY.md` — the EDC terminals and the offline
  PAX QR fallback
