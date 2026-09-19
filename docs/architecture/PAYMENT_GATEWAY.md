# Payment gateway — 2C2P (SCB-acquired) for QR and online payments

**DRAFT — research in progress.** Written 2026-09-20 from the public 2C2P
documentation; sandbox first, production by configuration.

Decision note: owner direction 2026-09-20 (`docs/briefs/OWNER_DIRECTION.md`)
and `docs/briefs/PROJECT_CONTEXT.md` §7.2 — 2C2P is the payment gateway, SCB
is the acquiring bank behind the merchant account. The SCB Developer Portal
direct API is kept as an alternative provider
(`docs/architecture/research/2026-09-20-scb-direct-api-research.md`).

No credentials of ours appear in this document.

## Facts captured so far

- API version 4.3. Sandbox base `https://sandbox-pgw.2c2p.com/payment/4.3/`,
  production `https://pgw.2c2p.com/payment/4.3/`.
- Every request and response is a JWT (JWS) signed HS256 with the merchant
  Secret Key, wrapped as `{"payload": "<jwt>"}`.
- Payment Token: `POST /payment/4.3/paymentToken` → `webPaymentUrl`,
  `paymentToken`, `respCode`, `respDesc`.
- Do Payment: `POST /payment/4.3/payment` → for QR, `type: "URL"`,
  `data: "https://api.2c2p.com/pgw/qr/<uuid>.png"`, `respCode 1005`.
- Payment Inquiry: `POST /payment/4.3/paymentInquiry`.
- Backend notification posts the same `{"payload": "<jwt>"}` envelope to
  `backendReturnUrl`.
- respCode: 0000 successful, 0001 pending, 0003 cancelled, 1005 (QR pending),
  2001 in progress, 2002 not found, 4xxx issuer/scheme, 5009 payment expired,
  9xxx request validation.

Research continues; this file is overwritten with the final version.
