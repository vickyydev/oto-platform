<!-- Research note written 2026-09-20 by a web-research pass of the SCB Developer Portal (direct PromptPay QR / deeplink APIs). Status: reference only. Decision 2026-09-20: the parks gateway is 2C2P (SCB is the acquirer), so this is the ALTERNATIVE provider, kept in case the park also holds an SCB Developer Portal application. See docs/architecture/PAYMENT_GATEWAY.md (to be written) for the 2C2P integration. -->

# SCB Developer Portal — QR / deeplink payment API research

Researched 2026-09-20 for the OTO POS (till + customer display) and the public booking site.
Every statement below carries its source. Where the public documentation is silent the item is
marked **UNCERTAIN** and must be confirmed with SCB or by a sandbox test. Field names are quoted
from the docs; nothing has been invented.

Host note: search engines index `developer.scb.co.th`, but that hostname did not resolve
(DNS `ENOTFOUND`) during this research; the identical pages are served from **`https://developer.scb`**
(same `/assets/documents/...` paths). All URLs below use `developer.scb`. Medium articles were
blocked (HTTP 403) and were read through a proxy; they are third-party and marked as such.

---

## 0. Summary of what SCB offers (and what it does not)

| Need | SCB API | Verdict |
|---|---|---|
| Dynamic PromptPay QR (Thai QR Tag 30) for an exact amount with our references | `POST /v1/payment/qrcode/create` (`qrType: "PP"`) — also `/v2/...` which adds expiry and single-use | Yes |
| Credit-card QR (QR CS, Visa/Mastercard) in the same image | `qrType: "CS"` or `"PPCS"` in the same call (needs Merchant ID + Terminal ID) | Yes, once SCB grants a QR CS merchant profile |
| Learn when paid | Payment Confirmation webhook (HTTPS POST to our registered URL) + inquiry APIs (`GET /v1/payment/billpayment/inquiry` for QR 30, `GET /v1/payment/qrcode/creditcard/{qrId}` for QR CS) | Yes |
| Booking site on mobile | SCB EASY deeplink `POST /v3/deeplink/transactions` (bill payment `BP`, credit card `CCFA`, installment `CCIPP`), status via `GET /v2/transactions/{transactionId}` | Yes (SCB EASY users only) |
| Refund / void | No usable public refund API for QR 30 or QR CS (see §7) | **No** — plan manual refunds |
| Settlement / reconciliation export | No report/export API in the Open API index; reports come from SCB Business Net / merchant portal; `POST /v3/payment/billpayment/inquiry` allows date-range searches with paging | Partial |
| Sandbox with simulated payments | Yes — SCB EASY Simulator app (Android/iOS) scans the sandbox QR / opens the sandbox deeplink and SCB posts a real webhook to our public HTTPS URL | Yes |

---

## 1. Portal and onboarding

### 1.1 Registration and applications (sandbox)

Source: Getting Started — https://developer.scb/assets/documents/documentation/basics/getting-started.html

- Sign up at https://developer.scb ("Sign Up", confirmation e-mail link valid 24 hours, then set password and security questions).
- "Each account is entitled up to 2 different apps, each with its own API key and secret."
- Apps > "Add Application" > fill in app information. "Upon successful creation, you receive the app's API key and secret and gain access to the sandbox APIs."
- Glossary (https://developer.scb/assets/documents/api-reference-index/references/glossary.html):
  - "API Key: API authorization key respective to each partner obtained from partner onboarding process."
  - "API Secret: API authorization secret obtained from partner onboarding process."
  - "Biller ID: A biller identification is a unique number assigned to a biller account to identify it throughout the course of bill payment activities."
  - "Merchant ID: ... unique number assigned to a merchant account ... credit card scheme payment activities."
  - "Terminal ID: ... unique number assigned to a merchant that related which devices from merchant."
  - "Payment Confirmation: The endpoint which will be notified when QR payment is completed."

What the application page contains (portal navigation quoted from the Sandbox page,
https://developer.scb/assets/documents/documentation/basics/developer-sandbox.html):

- "Biller Information, go to 'Apps > Select your App Name > Merchant Profile > Biller Information'" — the sandbox **Biller ID** and **Reference 3 prefix** live here.
- "Merchant information, go to 'Apps > Select your App Name > Merchant Profile > Merchant Information'" — sandbox **Merchant ID / Terminal ID** for QR CS.
- "Customer information, go to 'Apps > Select your App Name > Customer Profile > Select any Customer Name > Account'"; "PINs are available at 'Apps > Your Application > Customer Profile'" — pre-generated test payers with PINs, balances and cards.
- "Apps > Your Application > Simulator App Log in > SCB EASY Simulator App" — QR-code login for the simulator.
- "All onboarded merchants may provide a payment confirmation endpoint when creating an app." (Payment Confirmation page, §4).

Third-party corroboration (T.T. Software Solution, Thai, https://medium.com/t-t-software-solution/...scb-open-api-2d96c32c7f0e ): the Add Application form asks for application name, public description, a callback URL (used for 3-legged OAuth redirects), merchant and biller names, and the "Payment Confirmation Endpoint" (webhook URL); the app dashboard has Application (API Key/Secret), Merchant Profile (Biller Information, Merchant Information, Payment Confirmation Endpoint), Customer Profile, "Simulator login with QR code", and a Tools section that can mint a token and generate a test QR from the browser.

**Naming:** the portal's "API Key" is what the token endpoint calls `applicationKey`; "API Secret" is `applicationSecret`; and every endpoint's `resourceOwnerId` header is documented as "The system identifier, use the value of apikey". So there are only two secrets per app, not three.

### 1.2 Sandbox application vs production application

- Sandbox keys work only against `https://api-sandbox.partners.scb/partners/sandbox/...` and use the pre-populated sandbox merchant profile (Biller ID, prefix, Merchant/Terminal ID are test values, e.g. `merchantName: "TestMerchant"`, `terminalName: "Sandbox Terminal"` in responses).
- CSR page (https://developer.scb/assets/documents/api-reference-index/references/certificate-signing-request.html): "The sandbox version of the listed APIs do not require a CSR (Certificate Signing Request) whereas production APIs do." and "Partner will receive the certificate file from SCB after completing the onboarding process as agreed." The page shows the certificate being passed as a TLS client certificate (`curl -E <path-to-certificate>`).
  - **UNCERTAIN:** the QR Payment overview lists "CSR – Required (Issued by SCB for production APIs)" only under **B Scan C** (merchant scans customer); for C Scan B (our QR) it lists only "OAuth token authentication using Client Credentials". Whether production QR 30 / deeplink calls need a client certificate must be confirmed with SCB at onboarding. Design for an optional client cert (env vars below).
- Production base URL is **not printed** in the public docs. Two independent open-source clients use `https://api.partners.scb/partners/v1/...` (PHP SDK fixtures: https://github.com/COQUARD-Cyrille-Freelance/scb-payment-api/blob/145382cf519d3a801017840570693a3947d80b5c/tests/Fixtures/src/Client/initialize.php ; TypeScript client: https://github.com/colcamenterprises-collab/final-dashboard-4/blob/770d23f5c9e77e975207af482c590ce2c147cb1b/server/services/scbClient.ts ). Treat as **probable — confirm in the production credentials pack**.
- Business API T&C (https://www.scb.co.th/content/dam/scb/personal-banking/payment/for-merchant/document/7-bank-access-api-requirement.pdf , Thai): production "Security Keys" include "Client ID, Certificate ID and App ID"; keys must never be shared; the bank may charge API fees with 30 days' notice, may audit the merchant's application, and caps its liability at THB 500,000. API Service Terms (12 Feb 2021, https://www.scb.co.th/getmedia/c5158d0d-7c0a-4ae4-83c7-1fc11dd80e93/1-api-service-requirements.pdf ): the merchant bears all development cost and "agrees to cooperate ... in testing the connection".

### 1.3 Going live — business prerequisites

Sources: SCB merchant page (Thai) https://www.scb.co.th/th/personal-banking/payment/for-merchant/payment-gateway.html ; Business QR Payment https://www.scb.co.th/en/corporate-banking/business-cash-management/scb-business-collection/business-qr-payment ; Service Request form (12 Feb 2021) https://www.scb.co.th/content/dam/scb/personal-banking/payment/merchant-acquisition/document/1-service-request.pdf ; Blognone launch article https://www.blognone.com/node/109936 .

- Yes, an **SCB business account** is a prerequisite: the merchant page requires "an active savings or current account at SCB"; the service-request form §8 asks for SCB THB savings/current accounts (a receiving account and optionally a collateral account).
- Yes, a **PromptPay Biller ID (Tag 30)** is a prerequisite for QR 30 and for deeplink bill payment: the deeplink guide says "CASA payments: Apply for Biller (Tag30) status; Credit card full amount (CCFA): Apply for Merchant status" (https://developer.scb/assets/documents/documentation/pay-with-scb/payment-via-scb.html). Business QR Payment: "The technical name for the Business QR Payment is 'QR Tag30,' which is available only for a juristic person. An individual is eligible for a QR Tag29." Only Tag 30 gives per-transaction references and a reconcilable report.
- The merchant page lists "SCB QR API (programmable QR solutions)" and "SCB PayWise (deep-link bank account & installment payments)" as products under SCB Payment Gateway for merchants, with published fees: Thai QR — fee waived until 31 December B.E. 2569 (= 2026) then per Bank of Thailand announcement; QR credit card 3.20 % (retail) / 2.75 % (corporate); "System development support fee 50,000 THB per product (excluding VAT)". (Fees are out of scope but the 50k development-support fee matters for budgeting — **confirm whether it applies to the QR API**.)
- Merchant qualifications quoted by the page: registered business in Thailand, verifiable premises, company registration documents, director ID, shop photos, cancellation/return policy. (The page summary also mentioned minimum capital / 12 months registered for companies — **UNCERTAIN**, verify on the page.)
- Service Request form contents (read directly): applicant/business info, monthly volumes, §6 "SCB Payment Gateway / SCB Payment Gateway Partnership" with channel tick boxes incl. **"ThaiQR(30)"** and **"QR รับบัตรเครดิต" (QR credit card)**, §7 up to three admin users (name, e-mail, mobile, national ID — they receive username/password), §8 SCB accounts, §9 withholding-tax authorisation; bank-use box records the **MID**. There is **no** field for callback URL, IP allow-list or reference format on the public form — those are configured by SCB in the merchant profile (see §1.4).
- Process (third-party, T.T. Software article): submit the Service Request Form plus company documents to `Pgw-api@scb.co.th` (and by EMS post); SCB reviews within about ten business days; then UAT and PVT test phases before activation. The 2019 launch coverage (Blognone) says the same in spirit: sandbox is immediate, production requires business negotiation with SCB. **UNCERTAIN** (not on an SCB page) — treat as the expected shape of the process; SCB Business Call Center 0 2722 2222 or the merchant hotline 0 2777 7444 can confirm.

### 1.4 What the merchant must register with SCB

From the Payment Confirmation page (https://developer.scb/assets/documents/documentation/qr-payment/payment-confirmation.html):

- **Payment confirmation URL** — registered per entity: "QR 30 & SCB EASY App (BP): Per Biller ID and Reference 3 (Prefix)"; "QR CS, Alipay+/WeChatPay, CCFA, CCIPP: Per Merchant ID". "The URL must be of type 'https' with a valid SSL certificate. We do not support 'http' endpoints or 'https' with self-signed certificates."
- **Reference 3 prefix** — "Both QR 30 and SCB EASY App bill payment types require generation with Reference 3 (Prefix)". The prefix is what routes a payment to our webhook; SCB assigns it on the biller profile.
- **"Supporting Reference"** setting on the biller profile — one or two references (`ref2` is "Required if: Supporting Reference field under merchant profile of application is set to Two references").
- **Registered e-mail** — receives transaction details when the webhook fails three times.
- **IP allow-list** — not mentioned anywhere in the public docs. **UNCERTAIN**; ask SCB whether they filter callers by source IP in production (our API servers' egress IPs would then need to be fixed).

---

## 2. Authentication

Source: https://developer.scb/assets/documents/api-reference-index/authentication/post-oauth-token.html and https://developer.scb/assets/documents/documentation/basics/authentication.html

`POST {BASE}/v1/oauth/token` (sandbox: `https://api-sandbox.partners.scb/partners/sandbox/v1/oauth/token`) — "Client Credentials" (2-legged) grant; "typically used when an authorized server to server call is made outside the context of a user".

Headers:

| Header | Required | Doc text |
|---|---|---|
| `Content-Type` | yes | `application/json` |
| `resourceOwnerId` | yes | "The hash value of the userid, or related user identification value" — in practice **the API Key** (all other endpoints: "use the value of apikey"; every example passes `<Your API Key>`) |
| `requestUId` | yes | "A unique identifier the client can generate to track the current request call" (v2 QR doc: "32 characters long alphanumeric value"; examples use UUIDs) |
| `accept-language` | no | `EN` (default) or `TH` |

Body: `{"applicationKey": "<API Key>", "applicationSecret": "<API Secret>"}`. (`authCode`, `state`, `codeChallenge` are only for the 3-legged flow.)

Response:

```json
{
  "status": { "code": 1000, "description": "Success" },
  "data": {
    "accessToken": "34362373-66e8-4db0-80e5-0755b67e51f9",
    "tokenType": "Bearer",
    "expiresIn": 1800,
    "expiresAt": 1550133185,
    "refreshToken": "...", "refreshExpiresIn": 3600, "refreshExpiresAt": 1550134985
  }
}
```

- `refreshToken*` fields are "Returned on: authorization_code grant type with authCode" — i.e. **not** for client credentials; just request a new token.
- Lifetime: "Access Token: Valid for 30 minutes" (`expiresIn: 1800`), refresh token 60 minutes (3-legged only), auth code 1 minute.
- Errors: 401/9300 "Invalid authorization code" / "Invalid/expired temporary token", 401/9500 "Invalid apikey provided", 403/9503 "Invalid access rights".
- Caching guidance: none in the docs. Recommended: one token per (app, env) cached in the API process until `expiresAt − 60 s`, single-flight refresh, and one automatic retry on HTTP 401 / code 9300. Do not mint a token per request (sandbox limit is 5 TPS per API per app — §5).

---

## 3. QR creation

### 3.1 `POST /v1/payment/qrcode/create` (QR 30, QR CS, or both)

Source: https://developer.scb/assets/documents/api-reference-index/qr-payments/post-qrcode-create.html

"This endpoint generates QR codes following Thai QR Code standard Tag 30 (QR 30) and QR Card Scheme (QR CS) ... 'Generate QR 30 Only', 'Generate QR CS Only', or 'Generate QR 30 and QR CS together in a single QR Code.' A valid merchant profile under your application is required."

Headers: `Content-Type: application/json`, `authorization: Bearer <accessToken>`, `resourceOwnerId: <API Key>`, `requestUId: <unique>`, `accept-language: EN` (optional).

Request fields (doc wording):

| Field | Applies to | Required | Doc description |
|---|---|---|---|
| `qrType` | all | yes | "'PP': QR 30 • 'CS': QR CS • 'PPCS': QR 30 and QR CS" |
| `amount` | all | yes | "Amount of transaction with the length up to 13 characters including '.' e.g. 100, 100.00" (string) |
| `ppType` | PP/PPCS | yes | "PromptPay Type for QR 30. Value: BILLERID" |
| `ppId` | PP/PPCS | yes | "Biller ID. Partners can get on merchant profile of their application. Length: 15" |
| `ref1` | PP/PPCS | yes | "Reference number required for the relevant payment methods. Length: up to 20. Data Type: [AZ09] English capital letter and number only." |
| `ref2` | PP/PPCS | conditional | "Required if: Supporting Reference field under merchant profile of application is set to Two references. Length: up to 20. Data Type: [AZ09]" |
| `ref3` | PP/PPCS | yes | "Reference number required for the relevant payment methods to identify endpoint for receiving payment confirmation. Format: Reference 3 Prefix + (value), example: SCB1234. Length: up to 20" |
| `merchantId` | CS/PPCS | yes | "Merchant ID for QR CS." |
| `terminalId` | CS/PPCS | yes | "Terminal ID for QR CS." |
| `invoice` | CS/PPCS | yes | "Invoice number as unique ID per transaction for QR CS. It must be English uppercase letters and numbers only." |
| `csExtExpiryTime` | CS/PPCS | no | "Value is in minute which indicates that the expiry time of the requested QR code will be in next X minutes from the current time. If not specific the default expirytime will be 15 minutes." |
| `csNote` | CS/PPCS | no | "Description of QRCS Transaction" |
| `csUserDefined` | CS/PPCS | no | "Any value which defined by user." |

Not in v1: `numberOfTimesUsable`, `expiryDate` — **there is no expiry for the QR 30 part in v1** (a v1 PromptPay QR stays payable). Those exist only in v2 (§3.2).

Example requests from the doc:

```json
{ "qrType": "PP", "ppType": "BILLERID", "ppId": "123456789012345",
  "amount": "1.00", "ref1": "REFERENCE1", "ref2": "REFERENCE2", "ref3": "SCB" }
```
```json
{ "qrType": "PPCS", "ppType": "BILLERID", "ppId": "123456789012345", "amount": "100.00",
  "ref1": "REFERENCE1", "ref2": "REFERENCE2", "ref3": "SCB",
  "merchantId": "684349039613126", "terminalId": "379479514042628",
  "invoice": "INVOICE", "csExtExpiryTime": "60" }
```

**What a sandbox call returns** (verbatim from the doc's sandbox examples; the sandbox merchant name is "TestMerchant" / "Sandbox Terminal"):

QR 30:
```json
{ "status": { "code": 1000, "description": "Success" },
  "data": {
    "qrRawData": "00020101021230670016A00000067701011201151234567890123450210REFERENCE10310REFERENCE252047011530376454041.005802TH6007BANGKOK62070703SCB6304CE18",
    "qrImage": "R0lGODdh9AH0AYAAAAAAAP///ywAAAAA9AH0AQAC/4yPqcvtD6OctNqLs968+w+G4k..." } }
```
`qrImage` is base64 of a **GIF** (`R0lGODdh` = `GIF87a`), no `data:` prefix. `qrRawData` is the standard EMVCo / Thai QR string (tag 30 with AID `A000000677010112`, biller ID, ref1, ref2; tag 54 amount; tag 62 sub-tag 07 = ref3), so the POS can render it with any QR library and does not need `qrImage`.

QR CS / PPCS adds:
```json
"csExtExpiryTime": "2019-04-19 10:54:49", "responseCode": "000", "qrCodeType": "EM",
"qrCodeId": "20190419111003263000000", "poi": "12", "amount": "100.00",
"currencyCode": "764", "currencyName": "Baht", "csNote": "", "invoice": "INVOICE",
"merchantId": "684349039613126", "merchantName": "TestMerchant", "csUserDefined": "",
"terminalId": "379479514042628", "terminalName": "Sandbox Terminal",
"channels": [ { "seqNo": "1", "channelName": "VISA", "channelCode": "VSA" } ]
```
Response field notes from the doc: `responseCode` "Status '000' is Success"; `poi` "11=Static, 12=Dynamic"; `qrCodeId` is the key for the QR CS inquiry (§4.3); `csExtExpiryTime` is a local (Bangkok) wall-clock string.

### 3.2 `POST /v2/payment/qrcode/create` (QR 30 only, adds expiry and usage count)

Source: https://developer.scb/assets/documents/api-reference-index/qr-payments/post-qrcode-create-v2.html

| Field | Required | Doc description |
|---|---|---|
| `qrType` | yes | "List of value: PP" |
| `amount` | no | Number(13,2) "Format 2 digits: 100.00" |
| `ppType` | yes | "BILLERID" |
| `ppId` | yes | "Accept only BILLERID length must be 15 digits" |
| `ref1` | yes | String(20) "Accept only A-Z or 0-9" |
| `ref2` | no | String(20) |
| `ref3` | no | String(20) |
| `numberOfTimes` | no | "Accept 0 - 9999" |
| `expiryDate` | conditional | "Format: YYYY-MM-DD HH:MM:SS. Required if numberOfTimes not null" |

Response: `data.success`, `data.code` ("00"), `data.message`, `data.moreInfo`, `data.data.qrRawData`, `data.data.url` ("URL to render QR code", e.g. `https://qrservice-render.scb.co.th/v3/api/renderQR?bqr=...`), `data.data.expiryDate`, `data.data.numberOfTimes`, and `data.request` (echo). No base64 image in v2 — render `qrRawData` ourselves.

**Design note:** v2 with `numberOfTimes: 1` and an `expiryDate` is the only way to get a single-use, expiring PromptPay QR. Whether SCB enforces expiry at the payer's bank (via the QR data) or only server-side is **UNCERTAIN** — test in sandbox by paying after `expiryDate`. `ref3` is optional in v2 but still needed (with the prefix) for the webhook to route to us.

---

## 4. Payment confirmation (webhook) and inquiry

### 4.1 Webhook

Source: https://developer.scb/assets/documents/documentation/qr-payment/payment-confirmation.html

- "After the customer scans and pays successfully, SCB will send a payment confirmation to Merchant's registered URL." Sent for "any payment that is initiated from a mobile banking application supporting QR 30 and/or QR CS payment" and for SCB EASY deeplink payments.
- Method/headers: the page does not state the verb; every implementation (Odoo module, Medium Part 4, Go/PHP SDKs) treats it as an **HTTP POST with a JSON body**. No signature, HMAC, bearer token or IP list is documented. **UNCERTAIN whether SCB adds any auth header** — capture the raw headers in sandbox and log them.
- Retry: "SCB will re-send the payment confirmation to merchant up to 3 times, with an interval of 12 seconds in between attempts." If still unanswered, "SCB will provide the transaction details to the merchant's registered e-mail."
- Expected merchant response (doc): `{"resCode": "00", "resDesc": "success", "transactionId": "<echo request value>", "confirmId": "<optional>"}`. (`resCode` and `resDesc` are fixed values.) Reply HTTP 200 quickly and process asynchronously.

Payload fields (doc table; applicability in brackets):

| Field | Doc description |
|---|---|
| `transactionId` | "Transaction ID generated by source system" [all] |
| `amount` | Transaction amount (String in the table; a sandbox sample shows a JSON number — parse both) [all] |
| `transactionDateandTime` | ISO 8601; **GMT+7 for QR 30 / BP, GMT (UTC) for QR CS** [all] |
| `currencyCode` | ISO 4217, "764" [all] |
| `transactionType` | "Domestic Transfer" (QR 30 / BP) or "AUTH" (card types) [all] |
| `merchantId` | optional for QR 30; present for card types |
| `terminalId`, `qrId`, `consumerPAN`, `merchantPAN`, `traceNo`, `authorizeCode`, `paymentMethod` ("QRCS"...), `invoice`, `note` | card / QR CS |
| `payeeProxyType` "BILLERID", `payeeProxyId` (our Biller ID), `payeeAccountNumber`, `payeeName` | QR 30 / BP |
| `payerProxyType` ("ACCOUNT" per table; sandbox sample shows "MSISDN"), `payerProxyId`, `payerAccountNumber`, `payerName` | QR 30 / BP |
| `billPaymentRef1`, `billPaymentRef2`, `billPaymentRef3` | QR 30 / BP (`billPaymentRef1` also on some card types) |
| `sendingBankCode`, `receivingBankCode` | "3-digit bank code" (SCB = 014) |
| `channelCode` | "PMH", "VISA", "MASTER", ... |
| `tenor`, `ippType`, `productCode` | CCIPP only |
| `exchangeRate`, `equivalentAmount`, `equivalentCurrencyCode`, `companyId` | Alipay+/WeChat only |

`payeeProprietaryData` (from the task brief) does **not** appear in the official table — do not rely on it.

Sandbox sample payload as received by a developer (third-party, Medium Part 4 https://aijo.medium.com/...part-4-a84034306ee1 ):

```json
{ "payeeProxyId": "762342992129431", "payeeProxyType": "BILLERID",
  "payeeAccountNumber": "0987654321", "payeeName": "Sandbox",
  "payerProxyId": "0812345678", "payerProxyType": "MSISDN",
  "payerAccountNumber": "0123456789", "payerName": "Susirinee Nucheck",
  "sendingBankCode": "014", "receivingBankCode": "014", "amount": 100,
  "transactionId": "201907169lbqgPbt1Bl3oiA",
  "transactionDateandTime": "2019-07-16T11:30:58+07:00",
  "billPaymentRef1": "53729086453", "billPaymentRef3": "PTF", "currencyCode": "764" }
```

### 4.2 QR 30 inquiry — `GET /v1/payment/billpayment/inquiry`

Source: https://developer.scb/assets/documents/api-reference-index/qr-payments/get-billpayment-inquiry.html

"This endpoint support Thai QR Code Tag 30 and My Prompt QR (B Scan C) Transaction Inquiry." Same headers as above.

| Query param | Required | Doc description |
|---|---|---|
| `eventCode` | yes | "00300100 - Thai QR Code Tag 30 (C Scan B)  00300104 - My Prompt QR (B Scan C)" |
| `transactionDate` | yes | "Format: yyyy-MM-dd" |
| `billerId` | if 00300100 | String(15) |
| `reference1` | if 00300100 | String(20) |
| `reference2` | no | String(20) |
| `partnerTransactionId` | if 00300104 | String(35) |
| `amount` | no | Decimal(15,2) |

Correction to the brief: **00300104 is My Prompt QR (merchant-scans-customer), not QR CS.** QR CS has its own inquiry (§4.3).

Response `data` is an **array** of transactions with: `eventCode`, `transactionType` ("Domestic Transfers"...), `reverseFlag` ("R indicate transaction is refunded"), `payeeProxyId/Type`, `payeeAccountNumber`, `payeeName`, `payerProxyId/Type`, `payerAccountNumber`, `payerName`, `sendingBankCode`, `receivingBankCode`, `amount`, `transactionId`, `fastEasySlipNumber`, `transactionDateandTime` ("yyyy-MM-ddThh:mm:ss.sss±hh:mm"), `billPaymentRef1/2/3`, `currencyCode`, `equivalentAmount`, `equivalentCurrencyCode`, `exchangeRate`, `channelCode`, `partnerTransactionId`, `tepaCode`. There is no explicit "status" field: the v3 doc states "if the inquired transaction is successfully paid, the service will return transaction detail" and the QR CS doc "transaction details will only be returned if the inquired transaction is fully paid" — i.e. **paid = a matching record comes back; unpaid = empty/none**. The exact response for "not yet paid" (empty `data` vs. an error code) is **UNCERTAIN** — verify in sandbox. Note the doc's example uses `curl -X POST` on this GET endpoint; treat the method as GET (the PHP SDK uses GET successfully).

`transactionDate` is the **payment** date (Bangkok). A QR created at 23:58 and paid at 00:02 is found under the next day — query both dates around midnight.

### 4.3 QR CS inquiry — `GET /v1/payment/qrcode/creditcard/{qrId}`

Source: https://developer.scb/assets/documents/api-reference-index/qr-payments/get-qrcs-inquiry.html (`qrId` = `qrCodeId` from the create response, "Length: up to 20"). Response: `transactionId`, `amount`, `transactionDateandTime` ("yyyyMMdd HH:mm:ss"), `merchantPAN`, `consumerPAN` (masked), `currencyCode`, `merchantId`, `terminalId`, `qrId`, `traceNo`, `authorizeCode`, `paymentMethod` "QRCS", `transactionType` "SETTLED for payment successful transaction", `channelCode` ("VISA", "MASTER"), `invoice`, `note`. The sandbox nav labels one variant "obsolete"; the page itself is not marked deprecated — **UNCERTAIN**, test it.

### 4.4 `POST /v3/payment/billpayment/inquiry` (search, ISO 20022 style)

Source: https://developer.scb/assets/documents/api-reference-index/qr-payments/post-billpayment-inquiry.html — body `searchPayment{ messageIdentification, creationDateTime, paymentSearchCriteria{ requestedExecutionDate.dateSearch{fromDate,toDate}, paymentIdentification{...}, instructedAmount{...}, parties{...}, serviceType ("Bill Payment", "B Scan C"...), includeInitiate }, supplementaryData.envelope.additionalData{ creditorAccount{proxyIdentificationType "billerid", proxyIdentification}, billReference1/2/3, partnerIdentification, pageSize, pageNumber, includeHistoryDetails } }`. Response `data.searchPaymentStatusReport{ groupHeader, originalGroupInformationAndStatus{ responseStatus "SUCCESS"/"FAILURE", totalRecords }, searchPaymentReport[]{ transactionInformationAndStatus{ transactionStatus "ACCC" (success) / "RJCT" / "PDNG" / "CANC", acceptanceDateTime, originalTransactionReference{ interbankSettlementAmount{amount,currency}, interbankSettlementDate } }, supplementaryData... originalMessage{ billReference1/2/3, receivingProxyIdentification, ... }, historyDetails[] } }`. This is the only API that searches a **date range with paging** — the closest thing to a reconciliation pull (§7.3). Whether a biller can list *all* of its transactions in a range (vs. only lookups by reference) is **UNCERTAIN** — test in sandbox.

### 4.5 Slip verification — `GET /v1/payment/billpayment/transactions/{transRef}?sendingBank=014`

Source: https://developer.scb/assets/documents/api-reference-index/qr-payments/get-billpayment-transactions.html — verifies a customer's SCB slip (`transRef` = slip reference) and returns sender/receiver, amount, `ref1/ref2/ref3`. Useful for manual "customer shows a slip" disputes.

---

## 5. Sandbox testing

Source: https://developer.scb/assets/documents/documentation/basics/developer-sandbox.html (+ install PDF `./developer-sandbox/how-to-download-install-easysandbox(android-iOS).pdf`)

- Base URL: sandbox **`https://api-sandbox.partners.scb/partners/sandbox/`** (every doc example); production (probable, §1.2) `https://api.partners.scb/partners/`. Paths after the base are identical (`v1/oauth/token`, `v1/payment/qrcode/create`, ...). The void page prints its sandbox URL without the `/sandbox/` segment — probably a doc error.
- How a payment is simulated: there is **no "simulate payment" API or portal button** for QR. The **SCB EASY Simulator app** (Android https://appdistribution.firebase.dev/i/f280ebea68846e8a , iOS https://appdistribution.firebase.dev/i/f3a1ac16e87ff84c — Firebase App Distribution, so the tester's e-mail must be invited/registered) is a fake mobile-banking app:
  1. "Apps > Your Application > Simulator App Log in > SCB EASY Simulator App" — scan the login QR shown in the portal. "Each log in session is tied to one device per app"; log out to reuse the device for another app.
  2. "When using the simulator app, you will be asked to enter a PIN. Each PIN is linked to a test customer profile pre-generated when an app is created" (Apps > Your Application > Customer Profile).
  3. For QR 30: in the simulator choose Scan QR Code, scan the QR our API produced (or one made in the portal's Tools), enter the PIN, review biller name/amount, confirm. (Third-party description; the SCB page documents the deeplink flow explicitly and the QR flow by reference.)
  4. For deeplink: open the returned `scbeasysim://...` URL on the phone with the simulator installed; "SCB EASY App displays payment information for user confirmation, and once confirmed, displays a success page with a 'Return to Partner App' button."
  5. "SCB will send a payment confirmation to merchant URL as per your payment confirmation endpoint provided in the merchant profile." — **yes, sandbox webhooks are delivered to a public HTTPS URL** with a valid certificate (community uses ngrok; a staging server with a real certificate is better).
- A portal **Tools** section can generate tokens and QRs from the browser for smoke tests (third-party).
- Limits: "All accounts are rate limited to 5 throughputs per second (TPS) per API" (per app). Production limits are not published — **UNCERTAIN**.
- Sandbox differences: installment (CCIPP) "In Sandbox, however, the charge is set to be paid in full only"; `prodCode` "1001" in sandbox; merchant/biller names are test strings; QR CS returns `responseCode: "000"`.
- Mae Manee Simulator (https://developer.scb/assets/documents/documentation/basics/developer-mae-manee-sandbox.html) is for the separate Mae Manee merchant-app APIs — not needed.

---

## 6. SCB EASY deeplink (booking site on mobile)

Sources: guide https://developer.scb/assets/documents/documentation/pay-with-scb/payment-via-scb.html ; create https://developer.scb/assets/documents/api-reference-index/payment/post-deeplink-transaction.html ; inquiry https://developer.scb/assets/documents/api-reference-index/payment/retrieving-transaction-detail.html ; metadata guide PDF https://developer.scb/assets/documents/api-reference-index/payment/payment-transaction/Metadata_guide_20210209.pdf

Flow (guide): 1 access token → 3 `POST /v3/deeplink/transactions` → user pays in SCB EASY → 7 Payment Confirmation (webhook, same as §4.1) → 9 `GET /v2/transactions/{transactionId}`.

`POST /v3/deeplink/transactions` — headers as usual **plus `channel: "scbeasy"`**. Body:

| Field | Required | Doc description |
|---|---|---|
| `transactionType` | yes | `"PURCHASE"` |
| `transactionSubType` | yes | array of `"BP"` (bill payment from account), `"CCFA"` (credit card full amount), `"CCIPP"` (installment) — the app lets the user choose among the ones listed |
| `sessionValidityPeriod` | no | integer seconds, "60–1800", default 0 (disabled) (the example response shows 60000 — inconsistent; **UNCERTAIN**) |
| `sessionValidUntil` | no | epoch seconds, 1–30 min from creation, GMT+7 |
| `billPayment` | if BP | `paymentAmount` Decimal(14,2), `accountTo` String(15) = **Biller ID**, `accountFrom` (opt), `ref1` String(20), `ref2` (opt / required if profile has two refs), `ref3` "Prefix+value" for confirmation routing |
| `creditCardFullAmount` | if CCFA | `merchantId` String(20), `terminalId` (opt), `orderReference` String(20) alphanumeric, `paymentAmount` Decimal(15,2) |
| `installmentPaymentPlan` | if CCIPP | `merchantId`, `terminalId`, `orderReference`, `paymentAmount`, `tenor`, `ippType` "1"/"2"/"3", `prodCode` |
| `merchantMetaData` | no | `callbackUrl`, `merchantInfo{name}`, `paymentInfo[]` (max 10 lines, see metadata guide) |

Response: `data.transactionId`, `data.deeplinkUrl` (sandbox example `"scbeasysim://purchase/254ae415-..."`; production scheme is not printed — **UNCERTAIN**, presumably `scbeasy://`), `data.userRefId`. HTTP 201 / code 1000 "Deeplink successfully created"; 501/4101 "Current channel is not supported".

`GET /v2/transactions/{transactionId}` → `statusCode` **0 PENDING, 1 PAID, 2 CANCELLED, 3 INVALID, 4 PARTIAL, 5 EXPIRED**, `transactionMethod` (BP/CCFA/CCIPP actually used), `paidAmount`, `fee`, `billPayment{...}`, `creditCardFullAmount{approveCode, traceNo, merchantName...}`, `merchantMetaData{deeplinkUrl, callbackUrl, paymentInfo}`, timestamps.

Callback: "A 'callbackUrl' is an optional parameter that can be supplied in the merchantMetadata"; "if the URL is not provided, there will be no redirection back to your app." It is a **client-side redirect** after the "Return to Partner App" button; the docs do not list any query parameters appended to it — **UNCERTAIN**; never treat the redirect as proof of payment. The **server-side** notification for deeplink payments is the same Payment Confirmation webhook (BP: per Biller ID + ref3 prefix; CCFA/CCIPP: per Merchant ID).

Booking-site use: on a phone, show a "Pay with SCB EASY" button that opens `deeplinkUrl` (only useful to SCB EASY customers); on desktop, or for any other bank's customer, show the PromptPay QR from §3 instead (any Thai banking app can pay a Tag 30 QR). Both paths end in the same webhook + inquiry.

---

## 7. Refund / void, settlement, reconciliation

### 7.1 QR 30 (PromptPay) — no practical refund/void API

- The QR overview (https://developer.scb/assets/documents/documentation/qr-payment/thai-qr.html) lists `POST /v1/payment/qrcode/void` under the QR 30 flow. Its page (https://developer.scb/assets/documents/api-reference-index/qr-payments/post-qrcode-void.html) says "This endpoint for void transaction from qrcode c scan b" but also "This endpoint has only the document specification". Its body is an ISO 20022 / ISO 8583 reversal: `channelDateTime`, `originalPaymentInformationAndReversal{ originalEndToEndIdentification, originalInstructedAmount{transactionAmount, transactionCurrency} }`, `bp{ reversalType: CANCELLATION_REQUEST | REFUND_REQUEST | ISO20022_CANCELLATION_REQUEST, bpReference }`, `initiatingPartyId`; `bpReference` is "Generated by Payment Hub in InitiatePayment response" — an internal SCB reference that the QR-create API never returns. **Conclusion: not usable by an ordinary partner without a bespoke arrangement with SCB — UNCERTAIN, ask; plan for manual refunds (bank transfer) instead.**
- The "B Scan C Refund" (`POST /v1/payment/merchant/rtp/refund`; "full-amount refund can only be executed successfully before 23:00 hours of the same day") applies to **My Prompt QR (merchant scans the customer's QR)** — a different product (needs a production CSR). Not applicable to our merchant-presented QR.
- `reverseFlag: "R"` in the inquiry response shows that SCB *can* mark a QR 30 transaction refunded — refunds done by the bank/branch would appear there.

### 7.2 QR CS (card) — no void/refund API published

The QR CS flow lists only create, confirmation and inquiry. Card voids/refunds would go through SCB acquiring (merchant portal https://scbmerchantgateway.scb.co.th/ or the merchant hotline). **UNCERTAIN** — ask SCB whether same-day void for QR CS is available to API merchants.

### 7.3 Settlement and reconciliation

- Business QR Payment page: "Get paid the same day"; "Download the report via SCB Business Net for use in accounting"; "Download payment information and reports in real time in TXT, CSV and PDF formats"; Tag 30 "enables a payment report that can be reconciled with the company's bank account". PromptPay credits are effectively real-time to the linked SCB account.
- Service Request form note (12 Feb 2021): "VISA, MasterCard and JCB transactions are credited to the receiving account on the day after the transaction date; other payment types on the next business day; transactions after 22:00 are treated as the next day's." The merchant page summary says "next business day". Expect QR 30 money in the account immediately but the bank's daily report/cut-off to run at 22:00 Bangkok.
- No settlement/report **API** exists in the Open API index. Options: (a) the SCB Business Net / Business Anywhere CSV/TXT export (manual or scheduled by staff) reconciled against our `payment` rows by `ref1`; (b) `POST /v3/payment/billpayment/inquiry` date-range search (§4.4) as an automated daily pull — verify scope in sandbox; (c) per-transaction `GET .../billpayment/inquiry` by `ref1` for anything still pending at end of day.

---

## 8. Errors and limits

Source: https://developer.scb/assets/documents/api-reference-index/references/generic-response-codes.html

| HTTP | code | Description |
|---|---|---|
| 200/201/202/204 | 1000 | Success / Creation successful / accepted / deleted |
| 400 | 1101 | "Missing required parameters" |
| 400 | 1102 | "Invalid parameters entered" |
| 400 | 1103 | "Empty string input not supported" |
| 404 | 1104 | "Requested entity record does not exist" |
| 400 | 1105 | "Unrecognized field name was entered - Please check spelling and/or refer to the API docs" |
| 400 | 1111 | "Data entry duplicated with existing" |
| 501 | 4101 | "Current channel is not supported" |
| 400/500 | 8101 | "Invalid response from downstream service" |
| 400 | 8102 | "Payment API error code" (downstream payment error, e.g. bad biller/ref/amount) |
| 500 | 8901 / 8902 | Database errors |
| 400 | 9100 | "Required standard headers" |
| 401 | 9100 | "Missing required authorization credentials" |
| 401 | 9300 | "Invalid/expired temporary token" (also "Invalid authorization code") |
| 401 | 9500 | "Invalid apikey provided" |
| 403 | 9503 | "Invalid access rights" |
| 500 | 9700 | "Generic server side error" |
| 405/415/500/502/503/504 | 9900 | wrong method / unsupported content type / threat detected / bad upstream / unavailable / "API Request Timeout" |

Correction to the brief: 1101 is *missing parameters* (not "invalid credentials"); token expiry is **9300**; bad API key is **9500**; 1105–1109 are field-validation codes. Handle: 9300 → refresh token and retry once; 9900/503/504 → retry with backoff; 8102 → surface `status.description` to the operator and do not retry blindly.

Rate limits: sandbox "5 throughputs per second (TPS) per API" per app. Production: not published (**UNCERTAIN**). Keep polling per open QR at ≥3 s intervals and share one token.

---

## 9. Amount and reference constraints (for our reference design)

- `amount`: v1 string, "up to 13 characters including '.'", examples `"100"`, `"100.00"` → always send two decimals as a string (`"1250.00"`); v2 Number(13,2); deeplink BP Decimal(14,2), CCFA Decimal(15,2). Minor unit: satang; THB only (`currencyCode` "764"). **Maximum amount:** not stated by the API — PromptPay per-transaction and daily caps are set by the *payer's* bank app (SCB EASY default limits are configurable by the customer) — **UNCERTAIN**, expect large tickets (>THB 50k–200k) to fail on the payer side; offer card/EDC for those.
- `ref1`, `ref2`: ≤20 chars, `[A-Z0-9]` only (no hyphen, no lowercase, no Thai). `ref2` only if the biller profile is set to two references.
- `ref3`: registered prefix + our value, ≤20 chars total, `[A-Z0-9]`; the prefix is what makes SCB call our webhook.
- QR CS `invoice`: unique per transaction, uppercase letters and digits.
- `requestUId`: unique per request; v2 says 32 alphanumeric chars, v1 examples are 36-char UUIDs → use a UUID v4 without hyphens (32 hex) to satisfy both.
- Inquiry keys: `billerId` (15) + `reference1` (20) + `transactionDate` (`yyyy-MM-dd`); QR CS: `qrId` (≤20 — note the sample `qrCodeId` is 23 digits; **UNCERTAIN**, test).
- Webhook time zones: QR 30 `+07:00`; QR CS in GMT; QR CS inquiry uses `yyyyMMdd HH:mm:ss` with no zone.

Suggested encoding: `ref1` = payment-intent number (e.g. `OTO` + 12–14 uppercase base-32 chars of a UUIDv7-derived id, or a zero-padded numeric id), `ref2` = branch+station code (`HKT01T03`) or the local date `20260920`, `ref3` = `<PREFIX>` + short intent id. Keep `ref1` globally unique per operator so inquiry by `billerId+ref1+date` is unambiguous.

---

## 10. Configuration the owner must supply

| # | Item | Where it comes from | Env var (API server only — never on the box or in the browser) |
|---|---|---|---|
| 1 | Environment | `sandbox` now, `production` after go-live | `SCB_ENV` = `sandbox` \| `production` |
| 2 | API base URL | sandbox `https://api-sandbox.partners.scb/partners/sandbox`; production probably `https://api.partners.scb/partners` (confirm in the production pack) | `SCB_API_BASE_URL` (derived from `SCB_ENV` if unset) |
| 3 | API Key (= `applicationKey`, also sent as `resourceOwnerId`) | developer.scb > Apps > (app) > Application | `SCB_APPLICATION_KEY` |
| 4 | API Secret (= `applicationSecret`) | same page | `SCB_APPLICATION_SECRET` |
| 5 | Resource owner id | same value as the API Key per docs; keep separate in case SCB issues a distinct value in production | `SCB_RESOURCE_OWNER_ID` (default = `SCB_APPLICATION_KEY`) |
| 6 | PromptPay Biller ID (15 digits, Tag 30) | sandbox: Merchant Profile > Biller Information; production: SCB Business QR / Payment Gateway onboarding | `SCB_BILLER_ID` |
| 7 | Reference 3 prefix | same profile page (SCB-assigned) | `SCB_REF3_PREFIX` |
| 8 | Number of supported references on the biller profile (1 or 2) | Merchant Profile > "Supporting Reference" | `SCB_SUPPORTING_REFERENCES` = `1` \| `2` |
| 9 | QR CS Merchant ID and Terminal ID (only if card QR wanted) | sandbox: Merchant Profile > Merchant Information; production: card-acquiring onboarding (MID on the service request form) | `SCB_MERCHANT_ID`, `SCB_TERMINAL_ID` |
| 10 | Default QR type and QR CS expiry | our choice | `SCB_QR_TYPE` = `PP` \| `PPCS`, `SCB_CS_EXPIRY_MINUTES` (default 15) |
| 11 | Payment confirmation URL (public HTTPS, valid CA cert) registered in the app / by SCB per Biller ID + prefix (and per Merchant ID for QR CS) | we host it, e.g. `https://api.<staging-domain>/webhooks/scb/<SCB_CALLBACK_SECRET>` | `SCB_CALLBACK_URL` (for self-check/docs), `SCB_CALLBACK_SECRET` (our random path/query token; SCB signs nothing) |
| 12 | Registered e-mail for failed webhooks | portal / onboarding | (ops runbook, not env) |
| 13 | Production client certificate (if SCB requires a CSR for our APIs) | issued by SCB after onboarding | `SCB_CLIENT_CERT_PATH`, `SCB_CLIENT_KEY_PATH` (optional) |
| 14 | Deeplink enablement | biller (BP) and merchant (CCFA) status on the production app | `SCB_DEEPLINK_ENABLED`, `SCB_DEEPLINK_CHANNEL` = `scbeasy` |
| 15 | Business prerequisites for production | SCB THB savings/current account; Biller ID (Tag 30, juristic person); service request + company documents; SCB review; UAT/PVT with SCB; production keys/cert; fee schedule incl. possible THB 50,000 development-support fee | — |
| 16 | Egress IPs of the staging/production API servers | Render (or wherever) static egress — only if SCB asks for an allow-list | — |
| 17 | Sandbox testers | e-mails to invite to the Firebase App Distribution builds of the SCB EASY Simulator; simulator login is one device per app | — |

Sandbox checklist for the client demo: create the app → copy API Key/Secret → read Biller ID + prefix + Merchant/Terminal ID from Merchant Profile → set the Payment Confirmation Endpoint to the staging webhook (public HTTPS) → install the simulator, log in via the portal QR, note a customer PIN → pay a QR from the till and from the booking page → watch the webhook and the inquiry.

---

## 11. Design implications for the POS and booking site

1. **QR needs the cloud, and the secret never leaves our API.** Token + `qrcode/create` are called by `apps/api` (service layer), never by the Pi box or the browser. The box receives `{ paymentIntentId, qrRawData, amount, expiresAt, qrType }` and renders the QR locally (any QR lib; `qrImage` is unnecessary). If the box is offline it cannot mint a QR — the till must fall back to **EDC card terminal or cash**, and the sale records `payment_method = card_edc | cash`. (A printed static Tag 30 QR with manual amount entry would work offline but gives no automatic match; only offer it as a last resort with manual confirmation.)
2. **Idempotent QR creation.** One `payment_intent` row per attempt with `client_request_id`; store `requestUId`, request body, `qrRawData`, `qrCodeId`, `csExtExpiryTime`, and reuse the same QR on retries/redraws. A new QR is minted only when the amount changes, and the previous intent is marked `superseded` — its `ref1` stays reserved because **a v1 QR 30 remains payable indefinitely**. Prefer `/v2` with `numberOfTimes: 1` + `expiryDate` for the booking site and, if sandbox tests confirm expiry enforcement, for the till too (v2 is PP-only; for PPCS use v1 and rely on our own timer plus late-payment handling).
3. **Webhook handling.** Endpoint `POST /webhooks/scb/:secret`: reject if `:secret` ≠ `SCB_CALLBACK_SECRET`; parse JSON leniently (`amount` may be number or string; `transactionDateandTime` is `+07:00` for QR 30 and UTC for QR CS); insert into `scb_payment_notification` keyed by `transactionId` (unique, so SCB's 3 retries are idempotent); respond `200 {"resCode":"00","resDesc":"success","transactionId":<echo>}` within a second; process in a job: match `payeeProxyId == SCB_BILLER_ID`, `billPaymentRef1` (+`billPaymentRef2`) → `payment_intent`, compare `amount` in satang, then mark the intent `paid` and the sale `settled`, and push the state to the till and customer display (the display already polls/streams from our API). **Verify before trusting**: because the webhook carries no signature, confirm any notification whose intent is high-value (or any notification, cheaply) with `GET /v1/payment/billpayment/inquiry` before releasing goods; at minimum verify when the matched intent is not in `awaiting_payment`.
4. **Polling fallback.** While a QR is displayed the till (via our API) polls `GET /payments/:intentId` which, if no webhook has arrived in N seconds, calls the SCB inquiry (`eventCode=00300100&billerId&reference1&transactionDate` — try today and yesterday near midnight; QR CS via `qrcode/creditcard/{qrCodeId}`) at ≥3 s intervals and stops at expiry. An end-of-day job re-queries every intent left `awaiting_payment`/`expired` for that date, and (if sandbox confirms scope) runs the v3 date-range search for reconciliation against `payment` rows; discrepancies go to the admin console.
5. **Late or unmatched payments.** If a notification arrives for an intent that is `cancelled`, `expired` or `superseded`, or `ref1` is unknown, or the amount differs: record it as `unmatched_payment` with the payer name/bank/time, alert the branch manager, and offer "apply to sale" (if the sale is still open) or "refund manually" — there is no API refund for PromptPay; a staff member transfers the money back and records the refund reference. Never auto-cancel a sale that still has an open QR without first checking inquiry once.
6. **Booking site.** Desktop: show the PP (or PPCS) QR with a countdown (`expiryDate`), poll our status endpoint, and on `paid` issue the booking. Mobile: same page plus "Pay with SCB EASY" opening `deeplinkUrl` (sub-types `["BP"]`, optionally `"CCFA"` once merchant status exists); on return via `callbackUrl` show "checking payment…" and rely on webhook/`GET /v2/transactions/{id}` (`statusCode` 1 = PAID) — never on the redirect. Hold the booking slot only for the QR validity window. Cards for non-SCB customers are out of the Open API's scope; SCB's hosted Payment Gateway (separate product/contract, https://scbpaymentgateway.scb.co.th/ , sandbox https://sandbox-pgw.partners.scb/) would be the SCB route if needed.
7. **What to log (pino, per request).** `requestUId`, endpoint, `SCB_ENV`, `status.code/description`, HTTP status, latency, retry count, token age; for QR creates the intent id, `ref1/ref2/ref3`, amount, `qrCodeId`, `csExtExpiryTime`; for webhooks the raw body, all headers, source IP, our matching outcome and response time; for inquiries the query and record count. Mask `consumerPAN`/`merchantPAN`, never log the API Secret or bearer token. Every state change on `payment_intent` also goes through `audit.record`.
8. **Sandbox-specific caveats to encode in tests.** 5 TPS per API; simulator login is one device per app; `payerProxyType` may be `MSISDN` in sandbox vs `ACCOUNT` in docs; QR CS `qrCodeId` length (23 in samples vs "up to 20" in the inquiry doc); the exact "not paid yet" inquiry response; whether a v2 `expiryDate` is enforced; whether SCB sends any authentication header; production deeplink scheme.

---

## 12. Open questions for SCB (collect answers before production)

1. Does production QR 30 / deeplink (C Scan B) require a CSR/client certificate, or only B Scan C?
2. Exact production base URL and whether `resourceOwnerId` equals the API Key in production.
3. Is `POST /v1/payment/qrcode/void` available to API partners for QR 30, and where does `bpReference` come from? Is there any void for QR CS?
4. Does SCB filter webhook targets or API callers by IP? Does the webhook carry any authentication header?
5. Is `POST /v3/payment/billpayment/inquiry` allowed to list all transactions for our Biller ID in a date range (reconciliation)?
6. Production rate limits; whether the THB 50,000 "system development support fee" applies to the QR API; timeline for UAT/PVT.
7. Can the biller profile be set to two references, and can we choose the ref3 prefix?

---

## Sources

SCB Developer Portal (developer.scb):
- Getting started — https://developer.scb/assets/documents/documentation/basics/getting-started.html
- Authentication guide — https://developer.scb/assets/documents/documentation/basics/authentication.html
- OAuth token — https://developer.scb/assets/documents/api-reference-index/authentication/post-oauth-token.html
- Sandbox / SCB EASY Simulator — https://developer.scb/assets/documents/documentation/basics/developer-sandbox.html
- QR payment overview — https://developer.scb/assets/documents/documentation/qr-payment/thai-qr.html
- QR create v1 — https://developer.scb/assets/documents/api-reference-index/qr-payments/post-qrcode-create.html
- QR create v2 — https://developer.scb/assets/documents/api-reference-index/qr-payments/post-qrcode-create-v2.html
- Payment confirmation — https://developer.scb/assets/documents/documentation/qr-payment/payment-confirmation.html
- Bill payment inquiry (GET) — https://developer.scb/assets/documents/api-reference-index/qr-payments/get-billpayment-inquiry.html
- Bill payment inquiry v3 (POST) — https://developer.scb/assets/documents/api-reference-index/qr-payments/post-billpayment-inquiry.html
- QR CS inquiry — https://developer.scb/assets/documents/api-reference-index/qr-payments/get-qrcs-inquiry.html
- Slip verification — https://developer.scb/assets/documents/api-reference-index/qr-payments/get-billpayment-transactions.html
- QR void — https://developer.scb/assets/documents/api-reference-index/qr-payments/post-qrcode-void.html
- Deeplink guide — https://developer.scb/assets/documents/documentation/pay-with-scb/payment-via-scb.html
- Deeplink create — https://developer.scb/assets/documents/api-reference-index/payment/post-deeplink-transaction.html
- Deeplink transaction detail — https://developer.scb/assets/documents/api-reference-index/payment/retrieving-transaction-detail.html
- Generic response codes — https://developer.scb/assets/documents/api-reference-index/references/generic-response-codes.html
- Glossary — https://developer.scb/assets/documents/api-reference-index/references/glossary.html
- CSR — https://developer.scb/assets/documents/api-reference-index/references/certificate-signing-request.html

SCB corporate pages and documents:
- Merchant Payment Gateway page (Thai; fees, qualifications, forms) — https://www.scb.co.th/th/personal-banking/payment/for-merchant/payment-gateway.html
- Business QR Payment — https://www.scb.co.th/en/corporate-banking/business-cash-management/scb-business-collection/business-qr-payment
- Service request form (12 Feb 2021) — https://www.scb.co.th/content/dam/scb/personal-banking/payment/merchant-acquisition/document/1-service-request.pdf
- API service terms — https://www.scb.co.th/getmedia/c5158d0d-7c0a-4ae4-83c7-1fc11dd80e93/1-api-service-requirements.pdf
- Bank API access terms — https://www.scb.co.th/content/dam/scb/personal-banking/payment/for-merchant/document/7-bank-access-api-requirement.pdf
- Merchant portal / hosted gateway — https://scbmerchantgateway.scb.co.th/ , https://scbpaymentgateway.scb.co.th/ , https://sandbox-pgw.partners.scb/

Third-party (used only for portal walkthroughs and sandbox behaviour; marked as such above):
- T.T. Software Solution, "Getting started with SCB Open API ตอนที่ 1" — https://medium.com/t-t-software-solution/สรุปเนื้อหาจากกิจกรรม-scb-x-kku-getting-started-with-scb-open-api-ตอนที่-1-scb-open-api-2d96c32c7f0e
- Chanintorn A., "สร้าง Payment Chatbot ด้วย SCB Open Banking API" Parts 1, 3, 4 — https://aijo.medium.com/...ac1095e76ec9 , ...161bdc0aa64b , ...a84034306ee1
- Blognone, SCB developer portal launch (24 May 2019) — https://www.blognone.com/node/109936
- Odoo "POS Thai QR30 - SCB" module — https://apps.odoo.com/apps/modules/18.0/pos_qr30_scb
- PHP SDK fixtures (production URL, request shapes) — https://github.com/COQUARD-Cyrille-Freelance/scb-payment-api
- Node example service — https://github.com/ayuthmang/scb-openapi-oh-my-merchant-service
- ESP32 SDK — https://github.com/ArtronShop/ArtronShop_SCB_API
- Python notes — https://github.com/sang-sakarin/scb-payment/blob/master/qrcode_payment.md
