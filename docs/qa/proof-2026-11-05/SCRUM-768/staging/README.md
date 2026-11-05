# SCRUM-768 Free items set on a ticket apply at the till: staging proof

Run on 5 November 2026, 19:28-19:40 Bangkok, on the live commit
`fe6181bdb1edefd0f100b9c19be177446991ad0d` (main CI run 42020809305 green on that SHA). The four
staging services were live on it before and after the run (`../../SCRUM-740/live-before.json` and
`../../SCRUM-740/live-after.json`, read 19:12 and 19:43). Same browser, rules and staging account as
the SCRUM-740 run (see `../../SCRUM-740/staging/README.md`): ZZ TEST records only, cash only, no SMS,
no setting changed, the park's Pi, Till 1 (Pi), Till 2 (test), FWBooth1 and Reception Till 1 not
used. The till is "ZZ TEST SCRUM-768 till" (Z768) on Virtual box 1, archived afterwards.

**Result: free child, free adult and a free add-on from the add-on grid work; a free Regular Socks
does not apply to the socks counter on the order panel. SCRUM-768 stays in Testing.**

## What a person sees

| Plan step | Result | Screenshot |
| --- | --- | --- |
| 1. Console, Tickets, Central Floresta: "ZZ TEST 768 Ticket", 2 Hours, kids ฿500 weekday / ฿600 weekend (Expat and Thai the same, set price), adults "Same as kid price"; Free items in the rate: 1 Free child, 1 Free adult, 1 Free add-on Regular Socks, each for Tourist only. Saved and opened again | Pass | `st-01a-console-tickets-list-zz-test-768-ticket.png`, `st-01b-saved-ticket-prices.png`, `st-01c-saved-ticket-free-items-tourist-only.png` |
| 2. Walk-in Tourist, 2 kids and 3 adults: the order panel reads "Kids ฿500 each · 1 free" and "Adults ฿500 each · 1 free"; the customer display lists Kids 1 × ฿500, "Kids (free) 1 × ฿0", Adults 2 × ฿1,000, "Adults (free) 1 × ฿0"; total ฿1,500 (only the paid units). The platform's own quote has the same lines | Pass | `st-02a-order-panel-and-display-free-kid-and-adult.png` |
| 2. Two Regular Socks added on the order panel's socks counter: the display reads "Regular Socks 2 × ฿0" with no "Regular Socks (free)" row, and the panel shows no "1 free" against the socks | **Does not work** (see below) | `st-02a-order-panel-and-display-free-kid-and-adult.png` |
| 2. With the two socks the sale cannot be saved: "Finish the order before taking payment." (the till's stock guard: Regular Socks is out of stock at Central Floresta on staging) | Blocked by staging stock | `st-02c-socks-out-of-stock-order-cannot-be-saved.png` |
| 3. Socks taken off, Amount Due ฿1,500, paid in cash: "Receipt Z768-000001 • ฿1500 • Cash", 2 child and 3 adult bracelets (the free child and adult get their bands) | Pass | `st-02b-amount-due-only-the-paid-units.png`, `st-03a-paid-in-cash.png` (band codes hidden) |
| 3. History: Z768-000001 lists Kids 1× ฿500, "Kids (free) 1× ฿0", Adults 2× ฿1,000, "Adults (free) 1× ฿0", total paid ฿1,500 | Pass | `st-03b-history-sale-free-lines-at-0.png` (band codes hidden) |
| 3. The receipt, reprinted from History to the simulated Receipt Printer 1 (assigned to this ZZ TEST till for the run) and read on the Console's Virtual box 1 paper: "1× Kids (free) ฿0", "1× Adults (free) ฿0", TOTAL ฿1,500 | Pass | `st-03c-receipt-printed-free-lines-at-0.png` (band codes hidden) |
| 4. A new walk-in at Expat (verified on a passport, as the till requires), same 2 kids and 3 adults: no free lines, every unit charged, ฿2,500. Cancelled before payment | Pass | `st-04-expat-not-ticked-every-unit-charged.png` |
| Beyond the plan: a fourth free item, Free add-on Bracelet Workshop for Tourist, added to the same ticket; 1 kid, 1 adult and 2 Bracelet Workshop from the add-on grid: "Bracelet Workshop × 2 · 1 free ฿150", the display shows "Bracelet Workshop (free) 1 × ฿0", total ฿650, the platform quote agrees. Cancelled before payment | Pass | `st-05-free-add-on-from-the-add-on-grid-bracelet-workshop.png` |
| 5. "ZZ TEST 768 Ticket" deleted in the Console, read back archived (inactive, archivedAt 19:40); no live ticket at any branch has free items | Pass | `st-06-zz-test-768-ticket-archived.png` |

## What does not work: free Regular Socks on the socks counter

The Console saves the free add-on under the Regular Socks product's own id (code AO-SOCKS,
`01a0cb02-13a9-790f-85a1-73e6ccf9f9da`). The till counts socks on the order panel under the
prototype's fixed id `a-socks` (`apps/pos/src/lib/pricing.ts` SOCKS_ID, `apps/pos/src/lib/cartWire.ts`
SOCKS_ADDON_ID), and the shared engine matches the free add-on to the socks count by that id, so
the two never meet: the socks stay unmarked. The same lookup also prices the counter's socks: the
live catalogue has no `a-socks` entry, so the order panel reads "Regular Socks ฿0 each" while the
add-on card reads ฿50, and the till sends ฿0 to the platform. That ฿0 is older than this change and
shows on every ticket (2 Hours Play included). On staging it costs nothing today only because
Regular Socks is out of stock and cannot be sold.

The free add-on does work for an add-on taken from the add-on grid (Bracelet Workshop above), which
uses the product's own id.

## Not shown on staging

- The box path (the counter box or the booth pricing with the free items while the internet is
  down): covered by `apps/api/test/ticket-free-items-offline.test.ts` and the box-agent tests in the
  lane record; it reaches the park's boxes only with the next box release install.

## Jira

SCRUM-768 was not moved and no comment was added: it reads Testing. The read-backs for this run
(the saved free items, the platform quotes, the sale, the archive) are in
`../../SCRUM-740/staging/receipt.json` under `steps.ticket768Saved`, `order768`, `expat768`,
`addonGrid768`, `ticket768Fourth`, `reprint768` and `archive768`, and the harness in
`../../SCRUM-740/staging/harness/`.
