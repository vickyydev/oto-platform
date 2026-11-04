# SCRUM-765 and SCRUM-773: staging proof

Socks on the main receipt only (SCRUM-765), and Driving licence in place of Residence certificate
with the expiry date back for Other (SCRUM-773).

Run on 5 November 2026 on the live commit `8ad993e11ddfa18701eec668a5e67afa30edc12a` (main CI run
41898564366 green on that SHA). oto-api-staging, oto-pos-web-staging, oto-pos-staging and
oto-console-staging finished deploying it at 03:02-03:04 Bangkok and were live on it before and after
the run (`live-before.json` read 03:13, `live-after.json` read 03:59). The steps ran 03:22-03:48
(first proof agent) and 03:54-03:59 (third proof agent, which opened every image, re-ran step 9
and ran steps 10-12 and the clean-up). Nothing was deployed or restarted during the run and no
setting was read or changed.

A real Edge browser (Playwright, `channel: msedge`, Edge 156) in the Bangkok time zone: the till at
1600 wide with its customer display beside it (the test harness), the Console at 1500 wide. ZZ TEST
members only, cash only, no SMS. The park's Pi, Till 1 (Pi), Till 2 (test) and FWBooth1 were not
used.

## Set-up

- Reception Till 1 on Virtual box 1, with its simulated printers (Receipt Printer 1, Band Printer
  (kids), Band Printer (adults)), signed in as the staging reception account, Som (Reception).
- Five members, each made for this run: "ZZ TEST 765 Socks", "ZZ TEST 765 No Wallet",
  "ZZ TEST 773 Licence", "ZZ TEST 773 Other" and "ZZ TEST 773 Walk-in" (the last made from the
  customer display in step 9).
- Regular Socks (catalogue code AO-SOCKS) is out of stock on staging, so the socks sold are Grip
  Socks (AO-GRIPSOCKS), the other socks product the rule names. Both are covered by the change.

## What a person sees

| Plan step | Result | Screenshot |
| --- | --- | --- |
| 765-1. 2 Hours Play for ZZ TEST 765 Socks: one kid ฿890, one adult ฿350, Bracelet Workshop ฿150, Grip Socks × 2 ฿160 | Pass | `s765-st-01a-configure-two-grip-socks-and-bracelet-workshop.png`, `s765-st-01-order-with-two-pairs-of-socks.png`, `s765-st-02a-cash-chosen.png` |
| 765-2. Paid in cash, T1-000084 ฿1550: "Credit Grants to Print, 3 total" lists the ฿350 credit, Bracelet Workshop ×1 and Grip Socks ×2 to collect; "Sending to printers" lists the item voucher (Bracelet Workshop), the two bracelets and the receipt, and no socks slip | Pass | `s765-st-02-payment-successful-socks-card.png` (codes hidden in the picture) |
| 765-3. Receipt Printer 1 drew the receipt with "2× Grip Socks (2×M) ฿160" and "Credit issued • 2× Grip Socks (2×M) to collect", then the Bracelet Workshop ITEM VOUCHER slip, then the cash drawer pulse; the band printers drew one kid and one adult band; no socks slip | Pass | `s765-st-03a-receipt-printer-receipt.png`, `s765-st-03b-receipt-printer-bracelet-workshop-slip.png`, `s765-st-03c-kids-band.png`, `s765-st-03d-adult-band.png` |
| 765-3. Console, Virtual box 1 > Printing at 03:22:27: item voucher, adult wristband, kids wristband, receipt, all printed; Receipt Printer 1's paper: #1 receipt, #2 Bracelet Workshop slip, #3 cash drawer pulse | Pass | `s765-st-03-console-virtual-box-1-print-queue.png`, `s765-st-03e-console-receipt-printer-1-paper.png`, `s765-st-03f-console-band-printer-kids-paper.png`, `s765-st-03g-console-band-printer-adults-paper.png` |
| 765-4. The sale read back: print jobs item_voucher (Receipt Printer 1), adult_wristband, kids_wristband, receipt; History lists "Grip Socks (2×M) 2× ฿80"; the reprint list offers Full receipt, Child bracelet, Adult bracelet (History never offers item slips for reprint) | Pass | `s765-st-04a-history-sale-detail.png`, `s765-st-04b-history-reprint-list-no-socks-slip.png` |
| 765-5. A sale where nobody earns a wallet: ZZ TEST 765 No Wallet (Thai on a Passport, so the Full Day Pass adult is free), one kid ฿620, the free adult, Grip Socks × 2 ฿160, cash T1-000085 ฿780: the card shows "1 total, Grip Socks ×2 to collect"; the receipt and the two bands printed, nothing else | Pass | `s765-st-05a-no-wallet-order-with-two-pairs-of-socks.png`, `s765-st-05b-no-wallet-payment-successful-socks-card.png`, `s765-st-05c-no-wallet-receipt-printer-receipt.png`, `s765-st-05d-no-wallet-kids-band.png`, `s765-st-05e-no-wallet-adult-band.png` |
| 773-6. ZZ TEST 773 Licence, Thai: "Verify Thai rate" offers Passport, Driving licence, School card, Other, with "Document expiry date"; no Residence certificate | Pass | `s773-st-06-verify-thai-document-list.png` |
| 773-7. Driving licence with expiry 30/06/2030: "Verify Thai — Driving licence", then "Thai rate verified · Driving licence · valid until 2030-06-30 · recorded by Som (Reception)"; looked up again: "Thai · verified", "Driving licence — no proof needed" | Pass | `s773-st-07a-driving-licence-with-expiry.png`, `s773-st-07b-thai-rate-verified-driving-licence.png`, `s773-st-07c-member-looked-up-again-thai-verified-driving-licence.png` |
| 773-8. ZZ TEST 773 Other, Other: "What did you check? *" (placeholder "e.g. Work permit") with "Document expiry date" under it; 31/01/2025 reads "The document has already expired." and the verify button stays off; "Work permit" with 31/12/2029 saves: "Other — Work permit · valid until 2029-12-31 · recorded by Som (Reception)" | Pass | `s773-st-08a-other-description-and-expiry-date.png`, `s773-st-08b-other-past-expiry-refused.png`, `s773-st-08c-other-work-permit-future-expiry.png`, `s773-st-08d-thai-rate-verified-other-work-permit.png` |
| 773-9. A Thai-rate Full Day Pass to that member, cash T1-000086 ฿620: History reads "Thai", with no document on the sale, because a member sale is priced from the profile, which carries the document | Shown | `s773-st-09a-thai-rate-order-other-work-permit.png`, `s773-st-09b-thai-rate-paid.png`, `s773-st-09c-history-member-sale-priced-from-profile.png` |
| 773-9. A walk-in who types a phone and nickname on the display: the claim is saved to the new profile "ZZ TEST 773 Walk-in" (Other — Work permit, valid until 2029-12-31) and the sale T1-000087 is priced from it | Shown | `s773-st-09d-walk-in-other-work-permit-with-expiry.png`, `s773-st-09e-walk-in-thai-rate-saved-other-work-permit.png`, `s773-st-09f-history-walk-in-with-details-priced-from-profile.png` |
| 773-9. The sale's own document line: a walk-in claim on Other "Work permit" with expiry 31/12/2029, the customer leaves their details empty, cash T1-000088 ฿620. History reads "Priced on other (Work permit), checked 05 Nov, 03:55"; the sale reads back tierClaim Other, Work permit, 2029-12-31 | Pass | `s773-st-09g-walk-in-claim-other-work-permit-with-expiry.png`, `s773-st-09h-walk-in-thai-rate-order-no-details.png`, `s773-st-09i-walk-in-thai-rate-paid.png`, `s773-st-09j-history-walk-in-sale-priced-on-other-work-permit.png` |
| 773-10. Console > Members > ZZ TEST 773 Licence > Edit: "Holds Thai on a Driving licence, valid to 2030-06-30 — verified by Som (Reception)"; the proof list reads Passport, Driving licence, School card (Other is the till's choice, with its own description); closed with Escape, nothing saved | Pass | `s773-st-10a-console-member-proof-type-list.png` |
| 773-10. Console > Tier verifications: ZZ TEST 773 Walk-in and ZZ TEST 773 Other on Other / Work permit to 2029-12-31, ZZ TEST 773 Licence on Driving licence to 2030-06-30, each checked by Som (Reception) | Pass | `s773-st-10b-console-tier-verifications.png` |
| 773-11. Old records, read-only: one ZZ TEST member holds a recorded Residence certificate check (ZZ TEST Tier Thai, 2 Oct). The till card reads "Thai · verified" and "Residence certificate — no proof needed"; the Console proof list reads "Residence certificate (recorded)", greyed, above the three choices. Nothing was rung up or saved; the member still reads Residence certificate afterwards | Pass | `s773-st-11a-till-member-recorded-residence-certificate.png`, `s773-st-11b-console-recorded-residence-certificate-option.png` |
| 773-12. GET /audit, entity member_tier_verification since 03:00: four member.tier_verify rows, all by Som (Reception): Passport (03:30), Driving licence to 2030-06-30 (03:31), Other to 2029-12-31 (03:33), Other to 2029-12-31 (03:36) | Pass | `receipt.json` steps.s12 |

## Not shown on staging

- The park's own counter box (Pi): its offline socks receipt and offline proof list take effect only
  when the box gets the box-agent update through the normal Pi update recipe. The cloud virtual box
  runs inside oto-api-staging, so the deploy covers it.
- A sale whose own claim was filed as Residence certificate: none was looked for and none was made.
  That the retired value still reads and files is pinned by
  `packages/shared/test/s773-tier-proof-documents.test.ts`,
  `apps/pos/test/s773-tier-proof-documents.test.ts`, `apps/api/test/s773-tier-proof-documents.test.ts`,
  `apps/api/test/members-visits.test.ts`, `apps/api/test/sync-api.test.ts` and
  `packages/box-agent/test/station-bridge.test.ts`, and by the local rehearsal in
  `docs/qa/proof-2026-11-04/s765-773/local/`.

## Finding outside these tickets

A walk-in who claims a tier on the till and then types a phone and nickname on the customer display
leaves an unpaid copy of the sale behind. Done on the display opens the payment screen, which records
the sale as a walk-in with the claim (03:36:27); the profile is saved a second later (03:36:28); the
Confirm press then records a second sale under the new member (T1-000087, 03:36:46) and the first
stays unpaid, so the till later shows "Your sale rung up at this till was left unpaid" for it
(`s773-st-09k-finding-unpaid-duplicate-after-walk-in-entered-details.png`, photographed only). It
comes from the deferred tier save (SCRUM-227) meeting the sale recorded when the payment screen opens
(S2-09a), not from SCRUM-765 or SCRUM-773. The copy this run left was voided in the clean-up.

## Incident during the run

The first proof agent's harness pressed buttons on old "left unpaid" notices at Reception Till 1
that this run did not create. Its record, as written in `receipt.json` (`incidents`):

- 2026-11-04T20:15:56Z: The first notice-dismiss loop pressed "Resume this sale" on an old unpaid ZZ TEST Parent sale of 1 Oct (฿1935) at Reception Till 1. Resume only reads the sale; the tab was closed without paying, cancelling or voiding it.
- 2026-11-04T20:20:00Z: HARNESS FAULT: the notice loop pressed the first button of each old "left unpaid" notice at Reception Till 1, which is "Void that unpaid sale" on most of them, in two passes (20:15:26-28 UTC and 20:18:24-25 UTC; the second pass ran the old helper from the module cache). 16 old unpaid sales (tendering, no money taken) from 23 Sep to 14 Oct were voided with the left-behind reason, voided by Som. Two others were opened with Resume and left unpaid. The tab was closed without paying or voiding anything else.

The 16 sale ids, their amounts and the times they were voided are in `receipt.json` (`voidedTonight`).
None of them had taken money. Before any further browser work the helper was replaced by one that
refuses to run, and the steps that called it were taken out of the harness (`harness/` holds the
steps without them). From then on no button on any notice was pressed: the notices were only read,
and one was photographed. Six older unpaid sales at Reception Till 1 remain open exactly as they
were found.

## Clean-up, read back at 03:59

- The unpaid copy of the walk-in sale left by this run (rung up 03:36 today) voided through the API
  on the till's own session, reason "ZZ TEST proof clean-up: unpaid duplicate left by the SCRUM-773
  staging proof run"; it reads back voided and its claim released. No other sale was voided.
- No unpaid sale from today is left at Reception Till 1.
- The five ZZ TEST members made for this run archived (each reads back 404).
- The paid proof sales kept for the record: T1-000084 to T1-000087 on ZZ TEST members, and
  T1-000088, the walk-in sale of step 9.
- ZZ TEST Tier Thai (step 11) unchanged: still Residence certificate, not archived.
- The till, Console and API sessions signed out (each `/me` answers 401).

## Jira

- SCRUM-765: 19 screenshots attached, 7 shown inside comment 13492 (`jira-comment-765.txt`).
- SCRUM-773: 22 screenshots attached, 10 shown inside comment 13494 (`jira-comment-773.txt`).
- `jira.mjs walk` moved both to Deployed and linked their commits (two on SCRUM-765, one on
  SCRUM-773); both read back Deployed, never Done (`jira-publication.json`).

## Files

- `receipt.json`: the run's record: fixture, every step's text and read-backs, images, printer
  outputs, the incident, the clean-up, and `proofAgent3` (the review, the re-run and the finding).
- `live-before.json`, `live-after.json`: the four services' live deploys and commit.
- `harness/`: the driver and the steps.
