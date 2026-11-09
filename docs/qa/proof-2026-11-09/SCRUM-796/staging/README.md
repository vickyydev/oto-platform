# SCRUM-796 — staging proof: the till takes the amount due unless staff choose a partial payment

**Where:** staging till, https://oto-pos-web-staging.onrender.com, at commit `4d9ddb8c` (both `oto-pos-web-staging` and `oto-pos-staging` read back live at that commit before and after the run).
**When:** 9 November 2026, 17:00–17:13 Bangkok time.
**Who:** the staging reception account ("Som") on a till made for this test, **ZZ TEST SCRUM-796 till** (code prefix Z796) on Virtual box 1 at Oto Play Park, Central Floresta. Every sale was a ZZ TEST walk-in on the Tourist rate, ticket "1 Kid + 1 Adult (1 hour)", ฿500, **cash only**.
**Browser:** headless Chromium, 1440 × 900 (step 6 at 375 × 812).

## Result: all six checks passed

| # | Check | Result | Pictures |
|---|---|---|---|
| 1 | Cash takes the full amount by default | PASS | 01a, 01b |
| 2 | Customer hands over more (฿1000 for ฿500) | PASS | 02a, 02b |
| 3 | Cash short is refused | PASS | 03a, 03b |
| 4 | Partial payment, save as partly paid, resume, finish | PASS | 04a – 04k |
| 5 | Card takes the full amount, no amount field | PASS | 05 |
| 6 | The same on the phone layout | PASS | 06a, 06b (06c is the clean-up) |

## What each step showed

**1. Full amount by default.** One ticket rung up, Pay, then Cash. There is no "Payment amount" field; a **Partial payment** button stands where it was. **Cash received already reads 500.00**, **Change ฿0.00**, no keypad, and under the method grid only **Hold sale** (no "Save as partly paid"). Confirm Payment Received was pressed once: Payment Successful, receipt **Z796-000001**, bands and receipt sent to the simulated printers. Two taps after Pay.
- `796-st-01a-cash-takes-the-full-amount.png` — the payment screen after Cash (the column is scrolled a little so Confirm is in frame; the "Amount Due" title is clipped at the top, ฿500 is visible).
- `796-st-01b-paid-in-two-taps.png` — Payment Successful (band codes covered).

**2. Over-payment.** New sale, Cash, then a tap on Cash received: it **kept 500.00** (it was not emptied) and the keypad opened. 1, 0, 0, 0 on the keypad: Cash received **1000**, **Change ฿500.00**. Confirmed: receipt **Z796-000003**; the platform recorded the cash as ฿1000 handed over, ฿500 change, and the receipt printed.
- `796-st-02a-cash-1000-change-500.png`, `796-st-02b-over-payment-recorded.png`.
- The first try of this step (receipt **Z796-000002**, the same result) was pictured scrolled to the foot with the Cash received field out of frame, so it was done once more on its own sale and pictured properly. Both sales are recorded.

**3. Cash short.** New sale, Cash, Cash received, 100 typed: the line **"Cash received must cover this payment."** appears under Change and **Confirm Payment Received is disabled** (pale). Clearing and typing 500 brought Confirm back. The sale was then cancelled with the till's own **Cancel** (order panel): voided, "Cancelled at the till", no money taken.
- `796-st-03a-cash-short-refusal-line.png` — 100 in the field, the refusal line.
- `796-st-03b-cash-short-confirm-shut.png` — the same screen at its foot, Confirm disabled.

**4. Partial payment.** New sale, Cash, **Partial payment**:
- "Payment amount" appears **filled with 500.00** with **Full amount** beside its label, and the keypad is open on it; **Save as partly paid** now shows beside Hold sale but is shut, with **"Take a part payment first — nothing has been paid on this sale yet."** (`04a`, `04b`).
- **Full amount**: the field closes, Partial payment is back, Cash received 500.00, only Hold sale (`04c`).
- Partial payment again, 100 on the keypad: Payment amount **100**, Cash received **followed to 100.00** (`04d`). Confirm: **Recorded payments: Cash · ฿100.00, Balance due ฿400.00**, Amount Due ฿400 (`04e`). Save as partly paid is now enabled; Hold sale is shut with "฿100 has been paid on this sale — use Save as partly paid." (`04f`).
- After the part the till clears the method; tapping Cash shows Partial payment closed and **Cash received 400.00**, the balance (`04g`).
- **Save as partly paid**, named "ZZ TEST 796 part": it appears in **Held sales** as **Partly paid, ฿100 paid · balance ฿400** (`04h`; it was the only entry in the list).
- **Resume — take the balance**: the screen asks only for **฿400**, says "Resumed from Held sales: ZZ TEST 796 part. ฿100 already paid — take the balance.", and after Cash, **Cash received reads 400.00**; Save as partly paid stays visible because money is already paid (`04i`, `04j`).
- Confirm: Payment Successful, receipt **Z796-000004** (two cash parts, ฿100 + ฿400), bands and receipt printed (`04k`).

**5. Card.** New sale, Card: no amount field and no Cash received; Partial payment stands in its place, only Hold sale, and the button reads "Start card payment". It was **not pressed**. The sale was cancelled with the till's Cancel: voided, no payment attempt.
- `796-st-05-card-takes-the-full-amount.png`.

**6. Phone layout (375 × 812).** The same signed-in till, narrowed to phone width (no second session). One ticket, the number typed on the customer's half, Pay, Cash: the same screen as step 1 — no Payment amount field, Partial payment, **Cash received 500.00**, **Change ฿0.00**, only Hold sale.
- `796-st-06a-phone-cash-takes-the-full-amount.png`, `796-st-06b-phone-only-hold-sale.png`.

## Two things seen that are not part of SCRUM-796

Both come from code this change did not touch; they are noted for a separate ticket.

1. **The phone's payment screen is wider than the phone.** At 375 px the payment column is 446 px wide: the bottom button "Confirm Payment Received" runs past the right edge (it ends at 462 px) and the PromptPay card's name is cut (`06a`, `06b`). The bottom bar is in `StepPayment.tsx`, unchanged by SCRUM-796.
2. **The phone's Cancel after Pay does not cancel the sale.** On the phone layout, going Back from the payment screen and pressing Cancel cleared the screen but sent nothing to the platform: the sale stayed open (unpaid). The phone's Cancel only resets the screen (`resetSale` in `MobileTill.tsx`, last changed 22 September). The counter till's Cancel does void (steps 3 and 5). To close this test sale, the till was widened back to the counter layout, which reopened it as "Resumed after a reload … Cancel to void it", and its Cancel voided it (`06c`).

## Sales made (all ZZ TEST, cash only, kept as records)

| Receipt | Status | Step |
|---|---|---|
| Z796-000001 | paid | 1 — full amount |
| Z796-000002 | paid | 2 — over-payment, first try |
| Z796-000003 | paid | 2 — over-payment, pictured |
| (none) | voided | 3 — cash short, cancelled at the till |
| Z796-000004 | paid | 4 — ฿100 part + ฿400 balance |
| (none) | voided | 5 — Card tapped, cancelled at the till |
| (none) | voided | 6 — phone layout, voided on the counter |

Sale ids, times and every request are in `receipt.json`.

## Clean-up

- No unpaid sale was left on the ZZ TEST till; Held sales holds nothing of this run.
- The till's session was signed out (it then answered 401), the simulated printers were unassigned from the ZZ TEST till, the till was **archived** and read back archived with no devices, and the admin session was signed out (401 after).
- The walk-in number +66 89 796 0011 is still not a member.
- Not touched: the park's Pi, Till 1 (Pi), Till 2 (test), Reception Till 1 and FWBooth1 (read back unchanged); the "7 overdue" and "4 out of stock" banners were left alone; no SMS, no setting changed, no card or QR payment started.
