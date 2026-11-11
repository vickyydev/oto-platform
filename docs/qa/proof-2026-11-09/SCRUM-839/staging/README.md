# SCRUM-839 — staging proof

**Ticket:** BEO Billing: the older Financial Summary still reads "Deposit Paid: 0" after a deposit is paid through the chat, when the party has no billing record yet.

**When / where:** 11 November 2026, 18:52–18:53 Bangkok, staging. api, OTO App and inbox all live on commit `3410a7344834cdd6e383e25c2cb02ed14a670f6b`. Headless Chromium, the staging administrator through the launcher. One ZZ TEST party ("ZZ Test Child's 7th Birthday", Sat 19 Dec 2026) booked from a ZZ TEST simulator thread on "Demo WhatsApp · Central Floresta"; the simulated payment page only.

## Result: passed

| Step | What happened | |
|---|---|---|
| Before | The party has no billing record (`GET /api/events/:id/beo/billing` → 200, `null`). Financial Summary: Deposit Paid 0, Date Paid "Select date". Chat panel: "No deposit asked yet". | as expected |
| Request deposit 3000 | 200, state `requested`; the link in the chat is a full address on the staging api. | Pass |
| The link opened exactly as posted, in a browser with no session | The simulated page: ฿3,000, Pay / Fail. `839-01` | Pass |
| Pay | 200; "Thank you — your deposit is being confirmed." | Pass |
| The BEO loaded afresh, Billing opened | Chat panel: "Deposit paid · ฿3,000 — Paid 11 Nov, 18:52 through the chat". **Financial Summary: Deposit Paid 3000, Date Paid November 11th, 2026.** `839-02` | Pass |
| Reads | The request: `paid`, deposit after 300000 satang, write-back `synced`. The event: prepayment 3000, dated 2026-11-11. The billing record is still `null` — reading made none. | Pass |

Compare `docs/qa/proof-2026-11-09/SCRUM-825/staging/825-09-billing-deposit-paid.png`, where the same box read 0 after the same payment.

## Seen on the way (not this ticket's subject)

With no invoice rows the summary's totals are ฿0, so the box shows the badge PAID and "Overpaid: ฿3,000" beside Outstanding ฿0. That is the older box's own arithmetic on an empty invoice; the deposit figure itself is right.

## Not shown

- The summary taking the paid figure while the BEO stays open (without a reload): the ticket's step is the reload; the live update is covered by the check that runs in CI.
- A party that already has a billing record (unchanged behaviour), and picking a date over the event's deposit.

## Pictures

- `839-01-payment-page.png` — the simulated payment page from the chat's link (invoice number covered).
- `839-02-billing-financial-summary-deposit-paid.png` — the Billing section after the reload: chat panel Paid ฿3,000 and Financial Summary Deposit Paid 3000, 11 November 2026.

## Left on staging

The test party is archived and its thread marked handled at the end of the run (see the SCRUM-838 receipt's clean-up).
