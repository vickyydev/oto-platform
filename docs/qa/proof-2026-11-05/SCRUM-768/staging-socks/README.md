# SCRUM-768 follow-up: a free Regular Socks on the socks counter, staging proof

Run on 5 November 2026, 21:55-21:59 Bangkok (clean-up 22:00-22:01), on the live commit
`33a60bbd57bcf4911218fde6e99386561528dbfa` (main CI run 42043872668 green on that SHA, the Till
end-to-end step running `e2e/ticket-free-socks.spec.ts` included). oto-api-staging,
oto-pos-web-staging, oto-pos-staging and oto-console-staging were live on that commit before and
after the run (`live-before.json` read 21:53, `live-after.json` read 22:00; the api's live deploy
finished at 21:49). Nothing was deployed or restarted during the run and no setting was read or
changed. No migration ships with this change.

A real Edge browser (Playwright, `channel: msedge`, Edge 156) in the Bangkok time zone: the till at
1600 wide with its customer display beside it (the till's own test harness, the customer half), the
Console at 1500 wide. ZZ TEST records only, cash only, no SMS. The park's Pi, Till 1 (Pi), Till 2
(test), FWBooth1 and Reception Till 1 were not used; Reception Till 1's simulated band and receipt
printers on Virtual box 1 were shared with the test till for the run and its own assignments were
not changed.

## Set-up

- ZZ TEST stock: Regular Socks was out of stock at Central Floresta (0 at the sell point). In the
  Console, Inventory, Regular Socks, Adjust: +5, reason "ZZ TEST SCRUM-768 staging proof: 5 Regular
  Socks for the socks counter test" (landed at the FOH sell point, level 5).
- One till made for this run on Virtual box 1, "ZZ TEST SCRUM-768 socks till" (Z768S), with Virtual
  box 1's simulated Band Printer (kids), Band Printer (adults) and Receipt Printer 1; signed in as the
  staging reception account, Som (Reception). Printers unassigned and the till archived afterwards.
- Walk-in numbers +66 89 768 0011 (the free socks sale) and +66 89 768 0012 (the plain ticket);
  neither is a member before or after the run.

## What a person sees

| Plan step | Result | Screenshot |
| --- | --- | --- |
| 0. Console Inventory: Regular Socks adjusted +5 with the ZZ TEST reason; the card reads "Low · 5" | Pass | `st-00a-console-zz-test-stock-adjustment-regular-socks-plus-5.png`, `st-00b-console-regular-socks-in-stock-5.png` |
| 1. Console, Tickets, Central Floresta: "ZZ TEST 768 Socks Staging", 2 Hours, kids ฿500 weekday / ฿600 weekend (same for Expat and Thai), adults "Same as kid price"; Free items in the rate: 1 Free add-on, Regular Socks, Tourist only. The list shows "1× Free Regular Socks (Tourist)"; saved under the Regular Socks product's own id (AO-SOCKS) | Pass | `st-01a-console-tickets-list-zz-test-768-socks-staging.png`, `st-01b-saved-ticket-free-regular-socks-tourist-only.png` |
| 2. Walk-in by phone (number typed on the customer half, Continue as walk-in), Tourist, the ZZ TEST ticket with 1 kid and 1 adult, the order panel's socks counter at 2: the panel reads "Regular Socks ฿50 each · 1 free"; the customer display lists Kids 1 × ฿500, Adults 1 × ฿500, "Regular Socks 1 × ฿50" and a separate "Regular Socks (free) 1 × ฿0", total ฿1,050. The platform's own quote has the same four lines | Pass | `st-02a-order-panel-and-display-one-socks-charged-one-free.png` |
| 3. Continue: the sale is saved (the stock guard passes with stock on the shelf) and Amount Due reads ฿1,050, exactly one pair at the product price | Pass | `st-03-amount-due-one-socks-charged.png` |
| 4. Paid in cash: "Payment Successful, Receipt Z768S-000001 • ฿1050 • Cash"; the sale reads finalised with lines Kids ฿500, Adults ฿500, Regular Socks 1 × ฿50 and Regular Socks (free) 1 × ฿0 (both kind socks) | Pass | `st-04a-paid-in-cash.png` (band codes and the collect code hidden) |
| 4. The receipt Receipt Printer 1 drew, read on the Console's Virtual box 1 printing panel: "1× Regular Socks ฿50", "1× Regular Socks (free) ฿0", TOTAL ฿1,050, Cash ฿1,050, and under Credit issued "1× Regular Socks to collect" and "1× Regular Socks (free) to collect" | Pass | `st-04b-receipt-printed-regular-socks-and-free-socks.png` (band codes hidden) |
| 5. The older fault: 2 Hours Play (no free items), walk-in Tourist, 1 kid, 1 adult and 1 pair on the counter: the panel reads "Regular Socks ฿50 each" and the customer display "Regular Socks 1 × ฿50" (it was ฿0 before), total ฿1,290; with the customer half hidden, the add-on grid's Regular Socks card reads "+฿50". Cancelled before payment, nothing written | Pass | `st-05a-plain-ticket-counter-socks-charged-50.png`, `st-05b-plain-ticket-counter-socks-50-matches-add-on-card.png` |
| 6. Regular Socks stock at Central Floresta went from 5 to 3 with the sale: both pairs, the free one included | Pass | read-back in `receipt.json` (`steps.paid.socksStockAfter`) |
| 7. "ZZ TEST 768 Socks Staging" deleted in the Console and read back archived (inactive, archivedAt 22:00:02); no live ticket at any branch has free items | Pass | `st-06-zz-test-768-socks-staging-ticket-archived.png` |
| 7. The three unused ZZ TEST socks taken back in the Console (Adjust −3, reason "ZZ TEST SCRUM-768 staging proof: take back the 3 unused test socks"); Regular Socks reads "Out" again, as before the run | Pass | `st-07-console-regular-socks-unused-test-stock-taken-back.png` |

## Not shown on staging

- The box path (the counter box or the booth pricing a free Regular Socks on the counter while the
  internet is down): covered by `packages/box-agent/test/s768-free-socks-offline.test.ts` and the api
  and pos tests in the lane record; it reaches the park's boxes only with the next box release.

## Clean-up (22:00-22:01, read back)

- Stock: +5 Regular Socks added as ZZ TEST at the Central Floresta sell point; the paid sale took 2
  (one charged, one free); the 3 left were taken back with a ZZ TEST reason. Regular Socks reads 0,
  "Out", as before the run.
- "ZZ TEST 768 Socks Staging" archived; no live ticket at any branch has free items.
- The paid cash sale Z768S-000001 (฿1,050) stays on record as paid, as in earlier proofs; no unpaid
  sale exists on the till. The plain 2 Hours Play order was cancelled before anything was saved.
- Both sessions this run opened (till and Console) signed out (GET /me 401 afterwards); the ZZ TEST
  SCRUM-768 socks till's printers unassigned and the till archived; Reception Till 1 keeps its seven
  devices, and Reception Till 1, Till 1 (Pi), Till 2 (test) and FWBooth1 are unchanged.
- `receipt.json` holds every step's read-back, the created records and the clean-up.

## Jira

Seven of these images are attached to SCRUM-768 and shown inside comment 13520
(`jira-comment-768.txt`, `jira-publication.json`); the ticket was walked to Deployed (ten commit
links added) and read back Deployed, never Done. The harness that drove the run is in `harness/`
(setting names only, never a value).
