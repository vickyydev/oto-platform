# SCRUM-774 Hold sale, Save as partly paid and Held sales: staging proof

Run on 5 November 2026, 05:01-05:09 Bangkok (preflight from 04:52), on the live commit
`a720b2c7601d9b800898aa8f981e6f4c7fa301a3` (main CI run 41914927024 green on that SHA).
oto-api-staging, oto-pos-web-staging, oto-pos-staging and oto-console-staging finished deploying it at
04:44-04:47 Bangkok and were live on it before and after the run (`live-before.json` read 04:52,
`live-after.json` read 05:09). The api's pre-deploy for that commit ran `drizzle-kit migrate` at 04:21
with "migrations applied successfully" (`predeploy-migrate-log.json`; the 04:46 pre-deploy of the same
commit was a no-op). Nothing was deployed or restarted during the run and no setting was read or
changed.

A real Edge browser (Playwright, `channel: msedge`, Edge 156) in the Bangkok time zone: the tablet till
at 1600 wide with its customer display beside it (the test harness), the phone till at 390 wide, the
Console at 1500 wide. ZZ TEST records only, cash only, no SMS. The park's Pi, Till 1 (Pi), Till 2
(test), FWBooth1 and Reception Till 1 were not used, and no till notice this run did not create was
pressed.

## Set-up

- Four tills made for this run on Virtual box 1 at Central Floresta (staging has no separate ZZ TEST
  branch; earlier proofs use the same box): "ZZ TEST SCRUM-774 till A" (Z774A), "till B" (Z774B),
  "till C" (Z774C, used as the phone till) and "till D" (Z774D, for the manager). No printers, card
  manual, no QR.
- One member made from till A, "ZZ TEST Khun Mali 774", with two children, "ZZ TEST Ploy" (6) and
  "ZZ TEST Pim" (4). The other sales are walk-ins named on the customer display: "ZZ TEST Khun Ben
  774", "ZZ TEST Khun Eve 774", "ZZ TEST Khun Cara 774", "ZZ TEST Khun Dao 774".
- Tills A, B and C signed in as the staging reception account, Som (Reception), which holds the void
  permission and refund create but not refund approval. Till D signed in as the staging manager, Khun
  Lek (Manager), who holds refund approval at Central Floresta.
- Every proof sale is on business date 2026-11-05. One walk-through sale rung up at 04:56 (business
  date 2026-11-04, before the 05:00 boundary) was cancelled from Current Order straight away, unpaid.

## What a person sees

| Plan step | Result | Screenshot |
| --- | --- | --- |
| 0. Preflight: GET /sales/held for Central Floresta answers 200 for reception (empty list); /platform/jobs lists `job:sales.held_midnight`, every 300 s, last outcome ok | Pass | `receipt.json` steps.s0 |
| 1. ZZ TEST Khun Mali 774 with both children confirmed on the display, 2 Hours Play, 2 kids and 1 adult, ฿2,130: the payment step shows Hold sale and Save as partly paid; Save as partly paid is shut with "Take a part payment first — nothing has been paid on this sale yet." | Pass | `s774-st-01-payment-step-hold-buttons.png` |
| 1. Hold sale: the name is filled in from the member ("ZZ TEST Khun Mali 774"), note "ZZ TEST back after lunch"; the dialog says nothing is issued while held and it is cancelled as not collected if still there at midnight | Pass | `s774-st-02-hold-dialog.png` |
| 1. Till A returns to Membership Check; Held sales "1 held · 0 partly paid", "฿2,130 to pay, Held by Som at ZZ TEST SCRUM-774 till A · 05:01", the note, Resume and Void; toast "Sale held … Nothing was issued." Read back: status tendering, no receipt number, 0 bands, 0 credit grants, 0 print jobs, 0 payment attempts; one open hold of kind held. The check-in board named neither child | Pass | `s774-st-03-held-list-till-a.png` |
| 2. Till B lists the same held sale; Resume opens it at till B: "Resumed from Held sales: ZZ TEST Khun Mali 774 — “ZZ TEST back after lunch”. Take the payment, hold it again, or Cancel to void it." The sale now sits on till B, still 0 bands | Pass | `s774-st-04-held-list-till-b.png`, `s774-st-05-resumed-on-till-b.png` |
| 2. Paid ฿2,130 cash at till B: "Payment Successful, Receipt Z774B-000001"; 2 child and 1 adult bracelets (codes hidden in the picture), one ฿350 credit grant. Read back: finalised on till B, 3 bands created in the payment's own transaction, 4 print jobs (skipped: these test tills have no printers, as the on-screen note says). Audit: sale.create, sale.hold, sale.hold.resume (reason resumed), sale.finalise, sale.print | Pass | `s774-st-06-paid-on-till-b-bands-issued.png` |
| 3. ZZ TEST Khun Ben 774, 2 Hours Play ฿1,240, ฿200 cash taken: Hold sale shut, "฿200 has been paid on this sale — use Save as partly paid.", recorded payments ฿200, balance ฿1,040. Still tendering, 0 bands, no receipt | Pass | `s774-st-07-part-payment-taken.png` (the left column is scrolled sideways after typing the amount; `s774-st-17-…` shows the same state unscrolled) |
| 3. Save as partly paid ("฿200 paid, balance ฿1,040 … Bands and the receipt are issued when the balance is paid"), note "ZZ TEST paying the rest at 18:00"; Held sales on till A and on till B: "฿200 paid · balance ฿1,040", Partly paid, "Resume — take the balance", and "Cancel and refund" shut for reception with "A refund needs a manager's approval — ask a manager to make it." | Pass | `s774-st-08-save-as-partly-paid-dialog.png`, `s774-st-09-part-paid-in-held-sales-till-a.png`, `s774-st-10-part-paid-in-held-sales-till-b.png` |
| 4. Today > End of Day for 05/11/2026 (one more sale, ZZ TEST Khun Eve 774, held with no money for the counts): "Held sales Held: 1 Partly paid: 1", both named, and "End of Day cannot close: 1 sale is partly paid — ZZ TEST Khun Ben 774 (in Held sales), ฿200 paid, balance ฿1,040. Take the balance or refund what was paid, from Held sales on a till, then close the day."; Close Day shut with the same words above it | Pass | `s774-st-11-end-of-day-counts.png`, `s774-st-12-close-day-shut-with-its-reason.png` |
| 4. The close route, called by the manager only after the day read open with this run's part-paid sale on it: 409 `PART_PAID_SALES` with the same message and the sale's id; the day read open afterwards | Pass | `receipt.json` steps.s4 |
| 4. The phone layout's End of Day: the same counts, names and refusal, and Close Day shut under it | Pass | `s774-st-13-phone-end-of-day-counts.png`, `s774-st-14-phone-close-day-shut-with-its-reason.png` |
| 5. Ben resumed on till B: "฿200 already paid — take the balance. Bands and the receipt are issued when it is paid."; Amount Due ฿1,040, customer display "Please pay ฿1040.00"; Hold sale shut with its reason, Save as partly paid open | Pass | `s774-st-15-resumed-asks-balance-only.png` |
| 5. ฿1,040 cash: "Receipt Z774B-000002 • ฿1240 • Cash", 1 child and 1 adult bracelet. Read back: two cash attempts, ฿200 at 05:02:14 and ฿1,040 at 05:03:41.800; both bands created at 05:03:41.800-.801, in the balance's own transaction and 87 s after the part payment | Pass | `s774-st-16-balance-paid-bands-issued.png` |
| 6. ZZ TEST Khun Cara 774, ฿300 cash, Save as partly paid; Hold sale shut with "฿300 has been paid on this sale — use Save as partly paid."; on reception's till "Cancel and refund" is shut with "A refund needs a manager's approval — ask a manager to make it." | Pass | `s774-st-17-part-payment-taken-hold-shut-with-reason.png`, `s774-st-18-reception-cancel-and-refund-shut-with-reason.png` |
| 6. The manager on till D: "Cancel and refund ฿300 — everything paid on this sale goes back the normal way … and the sale is closed. Nothing was issued for it.", reason "ZZ TEST customer left before paying the rest"; toast "Refunded and cancelled … ฿300 refunded (Z774D-R-000001). The sale is closed." Read back: one whole refund of 30000 satang (exactly what was taken), sale voided with that reason, 0 bands, gone from Held sales; audit sale.hold.release (reason refunded) and sale.refund by Khun Lek (Manager) | Pass | `s774-st-19-manager-cancel-and-refund-dialog.png`, `s774-st-20-manager-refunded-and-cancelled.png` |
| 7. Phone till (till C): Held sales lists Eve (held) and ZZ TEST Khun Dao 774 (฿250 paid · balance ฿990) with the shut refund and its reason | Pass | `s774-st-21-phone-held-sales.png` |
| 7. Resumed on the phone: "฿250 already paid — take the balance", recorded payments, balance due ฿990, Hold sale shut with its reason, Save as partly paid open; the sale moved to till C, 0 bands | Pass | `s774-st-22-phone-resumed-balance-and-buttons.png` |
| 7. Saved as partly paid again from the phone with note "ZZ TEST back at 18:00 for the rest": till A lists it as held at till C with that note | Pass | `s774-st-23-phone-saved-as-partly-paid-seen-on-till-a.png` |
| 7. Resumed on the phone again and paid ฿990 cash: "Receipt Z774C-000001 · ฿1240 · Cash", 1 child and 1 adult bracelet; bands created with the ฿990 tender | Pass | `s774-st-24-phone-balance-paid-bands-issued.png` |
| 8. Midnight, read only: Console > Platform jobs shows `job:sales.held_midnight` ok, every 300 s. It ran at 05:02:47 and 05:07:47, both after Eve was held at 05:02:46, and left her sale tendering, listed and unflagged, as it must before her calendar day ends at 00:00 on 6 November. No `sales.part_paid` alert was opened | Shown (see below) | `s774-st-25-console-platform-jobs-held-midnight.png`, `receipt.json` steps.s8, s8b, alerts |
| 9. Eve voided from Held sales on till A with reason "ZZ TEST proof finished": "Void this held sale … can never be paid. Nothing was issued for it."; toast "Held sale voided". Audit sale.hold.release (reason voided) and sale.void | Pass | `s774-st-26-void-held-sale-from-the-list.png`, `s774-st-27-held-sale-voided.png` |
| 9. End of Day afterwards: "Held: 0 Partly paid: 0 — Nothing is held or partly paid on this day."; Close Day open, with no refusal. It was not pressed: the day stays open for everyone else | Pass | `s774-st-28-end-of-day-after-cleanup.png`, `s774-st-29-close-day-no-longer-refused-over-part-paid.png` |

## Not shown on staging

- The midnight void itself. It cannot be watched at this hour and the job's clock cannot be moved on
  staging; no held sale was left overnight, because the run cleans up after itself. What was shown:
  the job is registered and running every 300 s on the live api, and it left today's held sale alone
  on two passes before midnight. What it does at midnight is shown by the local rehearsal
  (`docs/qa/proof-2026-11-04/s774/receipt.json`, job clock set to 00:00 Bangkok: the held sale voided
  "not collected", the part-paid one flagged and kept, one alert opened;
  `s774-13-after-midnight-held-voided-part-paid-flagged.png`) and pinned by
  `apps/api/test/sale-holds.test.ts` ("midnight: a held sale is voided as not collected, a part-paid
  one is flagged", four cases) and `packages/shared/test/sale-hold.test.ts` (23:59:59 still in its
  day, 00:00 outlived, 00:30 midnight not the 05:00 business day, held after midnight waits for the
  next).
- The part-paid alert `sales.part_paid:<branch>` opening at midnight and closing itself once the sale
  is resolved: it opens only at midnight, so it was not seen on staging (covered by the same tests).
- Step 10, the counter box lane: no box was changed and no till was put on a box lane.
- Printing: these test tills have no printers, so the bracelets and receipts were issued but their
  print jobs read "skipped".

## Observed, outside this change

- On a resumed or part-paid sale the Current Order column's button still reads the order total
  ("Pay ฿1240") while the payment step and the customer display ask for the balance (฿1,040). The
  label comes from the order column (`OrderSummary.tsx`), which this change does not touch.
- Right after Resume on the phone, the Hold sale reason read "A payment is in progress — finish or
  cancel it first." for a moment; a second later it read "฿250 has been paid on this sale — use Save
  as partly paid." (`s774-st-22-…`).
- The cancelled part-paid sale reads back as voided with refund status "partially_refunded" (฿300
  refunded against a ฿1,240 sale), although all of the ฿300 taken was given back. History's label for
  it was not looked at.

## Clean-up (05:09, read back)

- The four ZZ TEST tills archived; every session this run opened signed out (`/me` answers 401 for
  each); the ZZ TEST member archived (lookup no longer finds it).
- Sales left as ZZ TEST records: Z774B-000001 (฿2,130), Z774B-000002 (฿1,240) and Z774C-000001
  (฿1,240), paid in cash; the Cara sale voided with its ฿300 refund Z774D-R-000001; the Eve sale and
  the 04:56 walk-through sale voided, unpaid. Held sales at Central Floresta read 0 held, 0 partly
  paid, and End of Day for 2026-11-05 reads open with nothing held. The paid ZZ TEST sales count in
  that day's expected cash (฿4,610), as earlier ZZ TEST proof sales do.
- Reception Till 1, Till 1 (Pi), Till 2 (test) and FWBooth1 read back unarchived and untouched.

## Files

- `receipt.json`: every step's read-back, the fixture, the created records and the clean-up.
- `live-before.json`, `live-after.json`: the live commit of each staging service.
- `predeploy-migrate-log.json`: the api pre-deploy migrate lines for this commit.
- `harness/`: the driver and the steps that produced the pictures (`.txt` so they are never run by
  accident; they read staging accounts from the local environment and print no phone or password).
- `jira-comment-774.txt`, `jira-publication.json`: what was posted to SCRUM-774.
