# SCRUM-828 a new menu item from the BEO, BEO-only on the till: staging proof

Run on Tuesday 10 November 2026, from 22:04 to 22:15 Bangkok time, on staging. The run used one ZZ TEST party in the OTO App
and one ZZ TEST till. The till's business day starts at 05:00, so the whole run fell on the business day of 10 November, a
weekday.

**Live on staging**, read with `scripts/agent/render.mjs deploys` before the run (21:59) and after it (22:14). Both readings
were the same, and nothing was deployed or restarted during the run.

| Service | Live commit | Deploy |
|---|---|---|
| oto-api-staging | a3d87300 | dep-dbpj01gm7kps73b30gl0 |
| oto-app-staging | a3d87300 | dep-dbpj020m7kps73b30id0 |
| oto-console-staging | a3d87300 | dep-dbpj02gm7kps73b30k30 |
| oto-pos-web-staging | a3d87300 | dep-dbpj02om7kps73b30kog |

The API's pre-deploy step applies platform migration 0113, and the app's applies migration 0047. The run did not read the
migration tables, but the 0047 change is in effect: the till's plan carries the kitchen-plan lines that have codes.

## The set-up

- **Before the run:** the operator had no "Party menu" category and no BEO-only product. The Regular Socks shelf at Central
  Floresta read 0, and the branch names no party-slips station.
- **The party:** "ZZ TEST 828 party" was created in the OTO App by the staging administrator, signed in through the launcher.
  It is at Central Floresta, dated 10 November, 19:00 to 21:00, with 2 children and 2 adults (201). "Birthday package, Central
  Floresta" was then applied (201). The package switched on its set menu, "Birthday set menu, Central Floresta".
- **The till:** "ZZ TEST SCRUM-828 till", receipt prefix Z828X. It was set up on Virtual box 1 with the simulated kids band
  printer, adult band printer and Receipt Printer 1, and the reception account signed it in.
- **Pictures:** each is 1440×900, light, en-GB, Asia/Bangkok. Real names are covered with solid magenta boxes. In the OTO App
  pictures, the events board behind the BEO is hidden, because its cards carry customers' party names. No band code or credit
  QR appears in any picture.

## The codes

| Item | Where it was added | Made at | Price | Till code | Product id |
|---|---|---|---|---|---|
| ZZ TEST unicorn cake | Kids menu | Kitchen | Free / included / alternate (฿0) | **PARTY-1CAEA076** | 01a0bbdc-8c41-7406-92ee-093f1caea076 |
| ZZ TEST bubble tea | Adults menu | Bar | ฿125 | **PARTY-7E6DD628** | 01a0bbdc-8c41-71dd-b193-1fa77e6dd628 |

## Checks

| # | Check | Result | Value | Picture |
|---|---|---|---|---|
| 1 | BEO › Kitchen Plan › Kids menu › "+ NEW ITEM (not in the menu)": the cake, Kitchen, free | Pass | The dialog was filled as briefed and "Add to the till and the BEO" was pressed (22:06:42). The route answered 200, not a replay. The toast read "New item added: ZZ TEST unicorn cake is on the till as PARTY-1CAEA076, for this party only." The Kids list shows "EXTRA 1 ZZ TEST unicorn cake PARTY-1CAEA076", and the tab reads Kids Menu (1) | 828-st-01-beo-new-item-dialog, 828-st-02-beo-line-with-code |
| 2 | Adults menu: the bubble tea, Bar, ฿125 | Pass | The route answered 200 (22:07:33). The toast read "ZZ TEST bubble tea is on the till as PARTY-7E6DD628, for this party only." The Adults list shows "EXTRA 1 ZZ TEST bubble tea PARTY-7E6DD628" | none (the dialog was not pictured for this item) |
| 3 | Save BEO, reload: both lines still there with their codes | Pass | Save answered 200, "BEO data saved successfully". After a fresh page load, Kids Menu (1) shows the cake with PARTY-1CAEA076, and Adults Menu (1) shows the tea with PARTY-7E6DD628. The app's kitchen-plan read agrees: the cake is included at price 0, and the tea is not included, at price 125 | 828-st-02b-beo-after-save-reload |
| 4 | Console › Catalogue › Menu, Central Floresta: the Party menu section with the BEO only badge | Pass | The section reads "PARTY MENU 2". ZZ TEST bubble tea shows the BEO only badge at ฿125, and ZZ TEST unicorn cake shows it at ฿0. Both are Central Floresta menu items in the category "Party menu" (code PARTY-MENU, F&B tax area). The tea is made at the bar and the cake in the kitchen | 828-st-03-console-party-menu-beo-only |
| 5 | Console: open one, the BEO only switch is on (not saved) | Pass | ZZ TEST bubble tea opened with the BEO only switch on. The form was closed with Escape, and nothing was written | 828-st-03b-console-item-beo-only-switch |
| 6 | Till F&B grid: no "Party menu" tab, neither item anywhere | Pass | There are 24 category tabs, from Breakfast to Free Drinks Menu, and none is Party menu. Every tab was opened, and neither item appears in any of them. The dish search for "ZZ TEST", "unicorn", "bubble tea" and "PARTY-" answers "No dishes match" each time | 828-st-04-till-fnb-grid-no-party-menu, 828-st-04b-till-fnb-search-zz-test |
| 7 | The till's menu read leaves them out; `?includeBeoOnly=true` has them | Pass | With no query, `GET /branches/:id/menu` answers 200 with 174 products: neither item, and no BEO-only product at all. The Party menu category is listed with 0 items, so the till shows no tab for it. With `?includeBeoOnly=true` it answers 176 products, both items included, beoOnly true, at 12,500 and 0 satang | none |
| 8 | Till › the party: its plan's set menu lists both items with their codes | Pass, with a note | The plan read (`GET /parties/:id`, planStatus ready) lists the set menu's 8 lines first. "ZZ TEST unicorn cake" ×1 follows with PARTY-1CAEA076, then "ZZ TEST bubble tea" ×1 with PARTY-7E6DD628. The bar plan is empty. The party page's Kitchen plan shows both names ×1 after the set menu, but **it does not draw the codes**: the codes are in the plan read only | 828-st-05-till-party-plan-items |
| 9 | Settle party form: the package, socks, and the add-ons with the tea at ฿125 | Pass on the figures; the form does not name the tea | The form shows Package (weekday) ฿16,900, Socks · 2 free ฿0, **Add-ons ฿125**, Total ฿17,025, Deposit paid −฿0 and Balance ฿17,025. The add-ons are one row, and the form does not list "ZZ TEST bubble tea" by name. The quote the form is drawn from (`POST /parties/:id/settle/preview`, 200) names it: the tea is an add-on at 1 × 12,500 satang, and the cake is an included line at 1 × 0 | 828-st-06-settle-form-priced-item |
| 10 | Pay the balance in cash, one tap, full amount | Pass | Settle answered 200, and finalise answered 200. The screen read "Settled, receipt Z828X-000001". There was one cash payment of ฿17,025 (tendered ฿17,025, change ฿0). The sale lines include **ZZ TEST bubble tea 1 × ฿125** (taxed as F&B, VAT ฿8.18 included) and ZZ TEST unicorn cake 1 × ฿0. 5 jobs printed on Virtual box 1: the receipt, 2 kids bands and 2 adult bands | 828-st-06b-paid-settled-receipt |
| 11 | Socks: +2 ZZ TEST pairs first, 0 after the sale | Pass | The shelf went 0, then +2 in the Console (reason "ZZ TEST SCRUM-828: 2 pairs in for the party settlement"), then 2, and the sale took 2, leaving 0 | none |
| 12 | Slips: "Print party slips now" lists the cake on the kitchen slip and the tea on the bar slip | Pass, read as below | The press answered 200 and made run 2. The kitchen slip and the bar slip both read "No printer named for this park", and no job was queued. Earlier, at 22:05, before the tea existed, the slips job's own run 1 had the bar slip as "Nothing to print". The slip documents could not be read directly; see "The slips" below | 828-st-07-slips-block-no-printer |
| 13 | Failure path | Not run | Skipped, as allowed | none |

**The settlement, in baht.**

| Item | Amount |
|---|---|
| Package (weekday) | 16,900 |
| Socks, 2 free | 0 |
| Add-ons (ZZ TEST bubble tea 1 × 125) | 125 |
| ZZ TEST unicorn cake (included line) | 0 |
| **Total** | **17,025** |
| Deposit | 0 |
| **Balance, paid in cash** | **17,025** |

Receipt Z828X-000001. The sale (01a1c604-7a87-74ed-a1ff-237f512bb7c2) was written back to the OTO App: the billing's POS
reference is that sale, and the till reports the write-back as synced.

## The slips

When nothing is queued to a printer, no route or page returns a slip's stored document. The run therefore shows the slip
contents in two ways.

- **The run's own records.**
  - Run 1, at 22:05, was the slips job's scheduled run. It came right after the package was applied, before either new item
    existed. The kitchen slip read "No printer" and the bar slip read "Nothing to print": the party had nothing for the bar.
  - Run 2, at 22:13, was the press, made after both items existed. The kitchen slip and the bar slip both read "No printer".
  - So the bar slip had something to print once the tea was added. The plan's bar list is empty, and every other line goes to
    the kitchen, so the tea is the only line that can be on the bar slip.
- **The documents, composed again.** The two slips were composed again with `composePartySlips`
  (`packages/shared/src/party-slips.ts`). This is the function the API's run calls. It was given the plan read straight after
  the press, and each code's prep station from the menu read.
  - Kitchen slip, "Birthday party, ZZ TEST 828 party, 22:13, Children: 2": the 8 set-menu dishes, each choice still marked
    "Choice not made in the OTO App", then **1 × ZZ TEST unicorn cake**.
  - Bar slip: **1 × ZZ TEST bubble tea**, and nothing else.

Picture 07 shows the party page's slips block, not the documents: there is no page for a slip that nothing printed.

## What did not match the brief

- **The settle form does not name the item.** The form shows the add-ons as one row, "Add-ons ฿125", not "ZZ TEST bubble tea
  1 × ฿125". The money is right, and the item is named in the form's own quote, on the sale and on the receipt.
- **The till's party page does not show the codes.** It lists "ZZ TEST unicorn cake ×1" and "ZZ TEST bubble tea ×1"; the
  PARTY- codes are in the plan read only.
- **No picture of the slip documents.** No page shows them (see above).

## Smaller notes

- **`includeBeoOnly=false` still includes the items.** `GET /branches/:id/menu?includeBeoOnly=false` also returns both
  BEO-only items, because the query value is turned into true whatever it says (`z.coerce.boolean()` in
  `apps/api/src/routes/menu.ts`; `includeArchived` is read the same way). The till sends no query and the Console sends
  `true`, so nothing on screen is affected today.
- **The Party menu category stays.** This run made the operator's first "Party menu" category (01a1c5ff-44b3-7199-a1bd-10f76e0138a4,
  code PARTY-MENU). It was left in place, empty: the feature makes it once and reuses it. With no live items it shows neither
  on the till nor in the Console's Menu page. It is still listed under Console › Categories.
- **The scheduled slips came first.** The party was made on its own day after its 11:00 slip time, so the job printed its
  scheduled slips within a minute of the package being applied, before the two items were added. A late addition reaches the
  slips through "Print party slips now". That is the SCRUM-805 design.
- **Masking:**
  - In pictures 01 and 02, four magenta boxes sit on empty parts of the BEO sheet. They were drawn over the signed-in user's
    name on the hidden events board beneath the sheet, and they hide nothing on the sheet. The helper was corrected for the
    later app picture (02b).
  - In 06 and 06b, the word "display" in "Hide customer display" is covered, as in the SCRUM-804 run. In 06b one more box sits
    on an empty spot, over text hidden behind the settle screen.
  - In 07, the till's toast is not masked; it shows only the slips' state.

## Clean-up, read back

- **The two products:** both were archived in the Console (Menu › Delete › Delete), and each DELETE answered 200. Read back
  with `includeArchived=true`, both are archived (PARTY-1CAEA076 at 22:14:13, PARTY-7E6DD628 at 22:14:17). No live BEO-only
  product is left.
- **The till:** it was signed out (/me 401). Its printers were unassigned (0 devices) and it was archived.
- **The sale:** the paid sale Z828X-000001 (finalised, ฿17,025) stays on record. It was not voided.
- **The party:** it was deleted in the OTO App (204). The event and its package snapshot read 404, and the till's party read
  answers 404 NOT_FOUND. No "ZZ TEST 828" event is left at Central Floresta.
- **Socks:** the Regular Socks shelf reads 0 (Store 0, BOH 0, FOH 0).
- **The branch:** the party-slips station is still none. It was only read.
- **The other tills:** Reception Till 1, Till 1 (Pi), Till 2 (test) and FWBooth1 were not touched. No till notice was pressed.
- **Sessions:**
  - Console: sign-out 200, then /me 401.
  - OTO App: logout 200, then the launcher sign-out 200. After that, /api/user answers 401 and the launcher's /me answers 401.
  - Till: /me 401.
  - Admin API: sign-out 200, then /me 401.

The routes, statuses, ids and figures are in receipt.json. Money there is in satang.

## Re-check: the flag read

Pass, on 10 November 2026 at 23:03 Bangkok, on `9b2bd8bc1` (api `dep-dbpjrmbrjlhs7384fksg`), reading Central Floresta's `GET /api/branches/:id/menu` through the administrator's Console session. No BEO-only product is live, so the plain read, `?includeBeoOnly=false`, `=0` and `=true` each answer 200 with 174 products and none BEO-only. With `includeArchived=true`, `includeBeoOnly=false` answers 246 products with 0 BEO-only, and `includeBeoOnly=true` answers 248, adding this run's two archived ZZ TEST BEO-only items (`beoOnly: true`): `false` now reads as no (`receipt.json` → `recheck_2026_11_10`).
