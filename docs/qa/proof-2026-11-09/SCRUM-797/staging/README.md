# SCRUM-797 — Extra Hour from History, on staging

**Result: passed.** A wristband code pasted into History opens the order, from the child's band and from the adult's band. Add time offers +1, +2 or +3 hours at ฿300 per child per hour and shows the sum before payment. The extra hour was paid in cash on the same wristbands. A Full Day pass and an order with no child are refused. Two small things are noted at the end. Neither of them belongs to this ticket.

- **Where:** the staging till app, https://oto-pos-web-staging.onrender.com, at Oto Play Park, Central Floresta.
- **Version:** commit b48dd7ac, live on oto-api-staging, oto-pos-web-staging and oto-pos-staging before the run began (read at 10:44 UTC; details in `receipt.json` → `deploys`).
- **When:** 9 November 2026, 17:44–17:55 Bangkok time. No page errors were recorded.
- **How:** a headless Chromium at 1440 × 900, signed in as the staging reception account (Som).
- **Till:** a test till made for this run, "ZZ TEST SCRUM-797 till" on Virtual box 1, receipt prefix Z797. It was archived at the end.
- **Customer:** every sale was a walk-in on a test phone number that is not a member, paid in cash.

## What was done, and what each picture shows

### 1. A 1-hour ticket for 3 children and 1 adult

- `797-st-01-paid-1-hour-play-3-kids-1-adult.png`: 1 Hour Play for 3 kids and 1 adult, paid in cash, ฿2,420. Receipt **Z797-000001**. The success screen lists the 3 child bracelets (Z797-7DDNB5, Z797-6573QJ, Z797-WK6KDQ).
- `797-st-01b-adult-band-code.png`: the same screen scrolled to the adult bracelet, Z797-6Y6PK9.

The ticket also gives ฿350 of credit. Its QR code is covered in every picture, because whoever holds that code can spend the credit.

### 2. The child's band opens the order, and 2 extra hours are paid

- `797-st-02a-kid-band-pasted-order-loads.png`: in History, Scan bracelet, the child's code Z797-7DDNB5 was pasted into the box and Find was pressed. The band's page shows the order Z797-000001.
- `797-st-02b-order-open-add-time.png`: the order is open, with the Add time button beside Reprint.
- `797-st-02c-add-time-options-3-children.png`: Add time shows "฿300 per child per hour, on the same bracelets" and three choices:
  - +1 hour (3 children x 1 hour x ฿300) ฿900
  - +2 hours ฿1800
  - +3 hours ฿2700

  There is no 30-minute choice.
- `797-st-02d-plus-2-hours-sum-1800.png`: +2 hours is chosen. "Amount to charge" reads ฿1800, and the line under it reads **"3 children x 2 hours x ฿300 = ฿1,800"**.
- `797-st-02e-kid-bands-ticked-and-locked.png`: the three children's bracelets are ticked and greyed out, so they cannot be unticked. A click on one left it ticked. The adult's bracelet is ticked too, and it stays the staff's choice.
- `797-st-02f-cash-takes-1800.png`: after "Continue to payment", Cash was chosen. Cash received is already 1800.00 and the change is ฿0.00. The button reads "Record cash".
- `797-st-02g-paid-time-added-1800-under-the-order.png`: paid. The order shows "Added +2 hours to 4 of 4 bracelets" and a TIME ADDED card: +2 hours ฿1800 · 4 bracelets · Cash · by Som (Reception). The bracelets printed are still the same four codes, so no new wristband was made.
- `797-st-02h-history-list-charge-1800.png`: the History list shows the charge **Z797-000002**, Paid ฿1800, above the order Z797-000001.
- `797-st-02i-charge-detail-extra-hour-x-2.png`: the charge opened. It is an extra-time charge with the line "Extra hour x 2", 3 × ฿600 = ฿1800, paid in cash. It reads "Extra play for Z797-000001" and "The original admission receipt stays unchanged".

### 3. The adult's band opens the same order

- `797-st-03a-adult-band-pasted-same-order.png`: the adult's code Z797-6Y6PK9 was pasted into the same box and Find was pressed. The same order, Z797-000001, opens.
- `797-st-03b-order-from-adult-band-time-added.png`: the order shows the +2 hours ฿1800 already added, and Add time is still on offer.
- `797-st-03c-second-add-time-offered.png`: Add time opens again with the same three choices, so a second extension would be allowed. Nothing was chosen. The window was closed, and no second charge was made (read back afterwards: still one extension).

### 4. Two orders that are refused

- `797-st-04a-paid-full-day-pass-1-child.png`: a Full Day Pass for 1 child, plus the 1 adult the ticket comes with, paid in cash, ฿1,440. Receipt **Z797-000003**. The till does not sell children alone; the platform refuses such an order.
- `797-st-04b-full-day-refused.png`: this order's Add time, opened from its child band Z797-4EKVWY. It shows the red line "An extra hour is added only to a 1 or 2-hour child ticket. A Full Day pass cannot take extra hours." and no choices. The amount is ฿0 and the button reads "Choose a duration".
- `797-st-04c-paid-2-hours-play-adults-only.png`: the till does accept an order with adults only. 2 Hours Play for 2 adults and no child was paid in cash, ฿700. Receipt **Z797-000004**.
- `797-st-04d-no-child-refused.png`: this order's Add time, opened from its adult band Z797-G7MYXH. It shows the red line "This order has no child ticket. An extra hour is charged per child on a 1 or 2-hour child ticket." and no choices.

### 5. What the platform recorded (read as the admin, no pictures)

- **The order's time additions** (`GET /sales/<Z797-000001>/extensions`): children 3, ฿300 per child per hour (30000 satang), no refusal, the three choices. One extension: +2 hours (120 minutes), 4 bracelets, amount ฿1,800 (180000 satang), applied, paid in cash.
- **The charge Z797-000002:** finalised, ฿1,800. One line: "Extra hour x 2", quantity 3, ฿600 each. Paid in cash, ฿1,800 handed over, no change. It made no new wristband; its only print job is a receipt.
- **The order's bands:** the same four codes as at the sale, all still active. Each of the four, looked up by code, opens order Z797-000001.
- **The refusals:** both refused orders read back with no choices and no extension. The Full Day pass gives `EXTENSION_TICKET_NOT_ELIGIBLE`, and the adults-only order gives `EXTENSION_NO_CHILDREN`.

## Receipts made (all on the test till, all kept)

| Receipt | What | Amount | Status |
|---|---|---|---|
| Z797-000001 | 1 Hour Play, 3 kids + 1 adult | ฿2,420 | paid |
| Z797-000002 | Extra hour x 2 for 3 children, on Z797-000001 | ฿1,800 | paid |
| Z797-000003 | Full Day Pass, 1 kid + 1 adult | ฿1,440 | paid |
| Z797-000004 | 2 Hours Play, 2 adults | ฿700 | paid |

## Clean-up

The till signed out; afterwards its session was refused. The test till's printers were unassigned and the till was archived; a read-back shows it archived with no devices. All 13 print jobs of the four sales read back as printed, so nothing is left waiting on the shared test printers. The admin session signed out too.

The four sales stay recorded. Till 1 (Pi), Till 2 (test), Reception Till 1 and FWBooth1 read back unchanged. No till notice was pressed, no setting was changed and no text message was sent. Only cash was used, and nothing was refunded.

## Noted along the way (outside this ticket)

1. **A paste alone does not open a band in History.** In History's "Scan bracelet" box the pasted code stayed in the box, and Find had to be pressed each time. The order then opened every time. The paste-to-open change of SCRUM-790 names History in its commit, but it changed only the wristband box used at F&B and the shop. History has its own box.
2. **The History list did not refresh after the extra hour was paid.** The list showed the new charge Z797-000002 only after leaving History and opening it again. The order's own TIME ADDED card showed it at once.
3. **Two ways of writing the same amount.** The choices and "Amount to charge" read ฿1800 with no comma, while the sum line reads ฿1,800. The lane kept the window's existing style on purpose.

Everything else (every press, every request and its answer, the API read-back) is in `receipt.json`.
