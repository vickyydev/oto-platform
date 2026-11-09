# SCRUM-772 — staging proof: the Thai rate is one confirmation with two buttons, no document, the staff member recorded

**Where:** the staging till (https://oto-pos-web-staging.onrender.com) and the staging Console (https://oto-console-staging.onrender.com), at commit `31db95a0`. `oto-api-staging`, `oto-pos-web-staging`, `oto-pos-staging` and `oto-console-staging` all read back live at that commit before and after the run.
**When:** 9 November 2026, about 21:25–21:43 Bangkok time.
**Who:** on the till, the staging reception account, on a till made for this test, **ZZ TEST SCRUM-772 till**, on Virtual box 1 at Oto Play Park, Central Floresta, with the shared simulated band and receipt printers. In the Console, the staging administrator. Both names are covered in every picture.
**Customers:** two made-up ZZ TEST numbers, neither a member before the run. They are called "ZZ TEST number 1" and "ZZ TEST number 2" here and in `receipt.json`. Cash only.
**Browser:** headless Chromium, 1440 × 900.

## Result: every check passed

| # | Check | Result | Pictures |
|---|---|---|---|
| 1 | Choosing Thai shows one confirmation: the "Confirmed by …" line and two buttons | PASS | 01 |
| 2 | Cancel closes it and changes nothing | PASS | 02 |
| 3 | Confirm Thai rate prices the cart at the Thai rate | PASS | 03 |
| 4 | Cash payment on the normal payment screen | PASS, after a fix to the test till (see below) | 04a, 04b |
| 5 | The Expat rate still asks for a document and an expiry date | PASS | 05 |
| 6 | The Console lists "Confirmed at the till by …" with the till, and its member form asks no document for Thai | PASS | 06a, 06b |
| 7 | The API reads back the member, the verification record and the sale's claim | PASS | (receipt.json) |
| 8 | History on the till names who confirmed the Thai rate | PASS | 08 |

## What each step showed

**1. The confirmation.** A walk-in with ZZ TEST number 1 (typed on the customer's half), then **Thai** on Select Customer Type. The step reads **"Verify Thai rate"**, "No document needed. Saved to their profile once they enter their details.", then the line **"Confirmed by [name] (Reception) — recorded automatically with date & time."** and exactly **two buttons: Cancel and Confirm Thai rate** (plus the window's own close cross). There is no document list, no expiry date and no reason to choose. There is no member card because this guest is a walk-in, not a member.
- `772-st-01-thai-confirmation-two-buttons.png`

**2. Cancel.** The step closed. The till stayed on Select Customer Type with an empty order (฿0), and nothing was sent to the platform.
- `772-st-02-cancel-closes-the-step.png`

**3. Confirm Thai rate.** Thai again, then **Confirm Thai rate**. The till sent one request, `POST /sales/tier-approvals` with the reason `confirmed_at_till`. The platform answered 200 with the evidence "Approved by hand", no expiry, and the reception account and this till stamped from the session. The order panel now carries the **THAI** chip. With **1 Hour Play, 1 kid + 1 adult**, the order reads **Kids ฿420 × 1, Adults ฿350 each · 1 free × 1, Total ฿420**. The same order at the Tourist rate is **฿690**, because the Tourist weekday kid price is ฿690 and the adult is included free. The customer's half shows the same ฿420.
- `772-st-03-order-priced-at-thai-rate.png`

**4. Pay cash.** **Pay ฿420** opened the details step, because the Thai rate needs a name before it can be saved to a new member. The customer typed the nickname "ZZ TEST 772 Thai" on their half and pressed Done. The number given at the start was kept and shown, not asked for again. The till then did four things, each answered 200:
- it rang the sale up at ฿420, Thai;
- it made the member;
- it saved the Thai rate on the member ("Approved by hand", no expiry);
- it joined the member to the sale.

Tapping **Cash** filled the full amount: Cash received 420.00, Change ฿0.00, and no amount field (the SCRUM-796 behaviour).
- **First Confirm Payment Received was refused:** "That value is already taken" (409). This is not caused by SCRUM-772; see "One thing seen" below. `772-st-04a-first-confirm-refused-receipt-number-taken.png`
- After the test till's code prefix was changed from Z772 to **Z772T**, Confirm Payment Received was pressed again on the same sale. The result was **Payment Successful, receipt Z772T-000001, ฿420, Cash**. The bands and the receipt went to the simulated printers. The band codes are covered in the picture. `772-st-04b-paid-cash.png`

**5. Expat is unchanged.** A second walk-in with ZZ TEST number 2, then **Expat**. The step is still the document step:
- "Verify Expat rate";
- "Proof checked *" with Passport, Driving licence, School card and Other;
- **"Document expiry date"**;
- "Checked by [name] (Reception) …";
- the button "Choose proof to verify".

It was closed with its cross and the sale was cancelled with the order panel's Cancel. Nothing was sent to the platform, and ZZ TEST number 2 is still not a member.
- `772-st-05-expat-keeps-document-and-expiry.png`

**6. Console.**
- **Catalogue & money > Tier verifications** (newest first). The ZZ TEST 772 Thai row is on top:
  - Upgrade: **Tourist → Thai**
  - Document: **"Confirmed at the till by [name] (Reception)"**, with **"ZZ TEST SCRUM-772 till"** under it
  - Expires: **"—"**
  - Checked by: [name] (Reception) · Oto Play Park, Central Floresta
  - Time: 09 Nov 2026, 21:30

  Above the list, "Thai rate approved by hand · per staff member" shows the reception account at 3 in the last 30 days, this one included. Every name and phone number on the page is covered, including other members' rows. `772-st-06a-console-tier-verifications-confirmed-at-the-till.png`
- **Members > Edit ZZ TEST 772 Thai.** The Verified tier box reads **"Holds Thai, confirmed at the till by [name] (Reception)."**, with Thai selected and **"No document needed for the Thai rate."** beside it. There is no document type and no expiry field. The form was closed with **Cancel** and nothing was saved; no write was sent while it was open. `772-st-06b-console-member-form-thai-no-document.png`

**7. API read-back** (all in `receipt.json`):
- `GET /members/:id` answered 200: tierCode **thai**, and a tier verification of thai with proof "Approved by hand", no expiry, by the reception account.
- `GET /members/tier-verifications` answered 200. The route has no filter, so the row was picked out by the member's id. The row reads tourist → thai, evidenceType **"Approved by hand"**, evidenceExpiresAt null, **station "ZZ TEST SCRUM-772 till"**, branch Central Floresta, verified by the reception account, note null.
- `GET /sales/:id` answered 200: receipt Z772T-000001, finalised, customerTier thai, ฿420, one approved cash payment, joined to the ZZ TEST member. Its **tierClaim** reads documentKind "Approved by hand", toTier thai, no expiry, and approval reason **confirmed_at_till** ("Confirmed at the till"), approved by the reception account.
- `GET /sales/tier-approvals/by-staff` answered 200 and lists the reception account.

**8. History on the till.** Sale Z772T-000001 (Paid, ฿420) reads **"ZZ TEST SCRUM-772 till · trading day 2026-11-09 · Thai · Weekday pricing · Thai rate confirmed at the till by [name], 09 Nov, 21:28"**, with "1 Hour Play · Thai, Kids 1× ฿420, Adults (free)" and Cash ฿420. In the picture the name, the ZZ TEST number and the band codes are covered.
- `772-st-08-history-thai-rate-confirmed-at-the-till.png`

## One thing seen that is not part of SCRUM-772

**A till can be given the code prefix of an archived till, and then no sale on it can be paid.** Code prefixes only have to differ between *live* tills, but receipt numbers have to be unique across the whole branch. This test till was made with prefix **Z772** as briefed. An archived ZZ TEST till of 4 November ("ZZ TEST SCRUM-772 mw2hnfyc till") had used the same prefix and already printed **Z772-000001**. So the new till's first receipt number was already taken, and its first cash Confirm was refused with only "That value is already taken" (409) and "Trying again will not help". Every later try would have hit the same number. The sale stayed unpaid and unnumbered; no money was recorded. Changing the test till's prefix to Z772T let the same sale finish.

This would also happen at the park if a till were archived and a new one given the old prefix. The station form and the payment screen give staff no hint of the cause. The fix belongs in the station form or the receipt allocator, not in SCRUM-772.

## Records made, and the clean-up read back

| Record | What happened to it | Read back |
|---|---|---|
| Sale Z772T-000001 (ZZ TEST number 1, Thai, ฿420 cash) | **Kept on record, not voided** | finalised |
| Member "ZZ TEST 772 Thai" (ZZ TEST number 1), made at the details step | Archived (`DELETE /members/:id` 200) | `GET /members/:id` 404, the number finds no member, register search "ZZ TEST 772" empty |
| ZZ TEST number 2 (the Expat sale) | Nothing was made | the number finds no member |
| Thai claim and verification records | Kept as the audit trail | as in step 7 |
| ZZ TEST SCRUM-772 till | Signed out, then printers unassigned (devices 0), then archived | till session `/me` 401; archived, 0 devices, 1 finalised sale |
| Console session (administrator) | Signed out with the Console's Sign out | `/api/me` 401; reload shows Sign in |
| API session (administrator) | Signed out | `/me` 401 |

Reception Till 1, Till 1 (Pi), Till 2 (test) and FWBooth1 were never used or changed: they are still live with 7, 4, 4 and 1 devices. No till notice was pressed, nothing was voided, and no SMS was sent. Nothing was deployed, restarted or set, apart from the test till's own prefix.

## Masking

Real names (the reception account, the administrator, other staff and other members) are covered with solid boxes laid over the page, not by editing the page. Phone numbers, band codes, password fields and toasts are covered too. `receipt.json` holds ids, statuses and requests, with no names and no phone numbers.

## Files

`772-st-01-thai-confirmation-two-buttons.png`, `772-st-02-cancel-closes-the-step.png`, `772-st-03-order-priced-at-thai-rate.png`, `772-st-04a-first-confirm-refused-receipt-number-taken.png`, `772-st-04b-paid-cash.png`, `772-st-05-expat-keeps-document-and-expiry.png`, `772-st-06a-console-tier-verifications-confirmed-at-the-till.png`, `772-st-06b-console-member-form-thai-no-document.png`, `772-st-08-history-thai-rate-confirmed-at-the-till.png`, `receipt.json`.
