# SCRUM-766 — A wristband pasted anywhere on the till, on staging

**Result: passed, with one note.** A wristband code pasted with no box selected is picked up on F&B, the Shop, History and the ticket till. Nobody has to select the wristband box first.

- F&B and the Shop open the tab.
- History opens the band's order.
- The ticket till shows a message saying where the band opens, and the sale on screen does not change.
- A made-up code shows "No tab found" in the band box.
- A code typed by hand into a field stays in that field.

**The note:** on staging, a play ticket's **child** band has no tab, because the ticket's ฿350 food credit goes on the **adult's** band. So the "tab loads" pictures for F&B and the Shop use the adult band from the same sale. The child band was pasted on both screens too. Both screens picked it up and showed "No tab found" for it.

- **Where:** the staging till app, https://oto-pos-web-staging.onrender.com, at Oto Play Park, Central Floresta.
- **Version:** commit 748ed62f, live on oto-pos-web-staging and oto-pos-staging before the run began (read at 12:52 UTC). The page's script carries the change. Details are in `receipt.json` → `deploys` and `bundle`.
- **When:** 9 November 2026, 19:53–20:03 Bangkok time. No page errors were recorded.
- **How:** a headless Chromium at 1440 × 900, signed in as the staging reception account. Before each paste, the screen's heading was clicked and anything still selected was cleared; the page reported that nothing was selected every time. The code was then pasted with Ctrl+V. "By hand" means one key every 200 ms.
- **Till:** a test till made for this run, "ZZ TEST SCRUM-767 till" on Virtual box 1, receipt prefix Z767. It was archived at the end.

## The sale

- `766-st-00-paid-1-hour-play-kid-band.png`: a walk-in sale of 1 Hour Play for 1 child and 1 adult, paid in cash, ฿1,040. Receipt **Z767-000001**. The child bracelet's printed code is **Z767-4HV7TD** and the adult bracelet's is Z767-HQBDM7. The credit QR code is covered, because whoever holds it can spend the credit.

  The adult is on the sale because a child alone opens the drop-off form, which is the SCRUM-767 screen.

## What each picture shows

- `766-st-01a-fnb-kid-band-paste-caught-no-tab-on-it.png`: **F&B**, nothing selected, the child band Z767-4HV7TD pasted. The page picked it up: the code is now in the wristband box, and one look-up was made for it. The platform answered that no tab carries this band, so the box reads "No tab found for "Z767-4HV7TD"".
- `766-st-01b-fnb-adult-band-paste-tab-loads.png`: **F&B**, Scan Wristband opened again, nothing selected, the adult band Z767-HQBDM7 pasted. **The tab loads**: "Walk-in guest, ฿350 credit, #Z767-HQBDM7", and the customer half reads "Welcome back, Walk-in guest! Your credit balance ฿350". Neither the box nor Load Tab was touched.
- `766-st-02-shop-paste-nothing-selected-tab-loads.png`: **the Shop**, Retail Sale, nothing selected, the adult band pasted. **The sale opens on that tab** (Walk-in guest, ฿350 credit). The child band pasted here the same way showed "No tab found" in the band box, as on F&B (no picture).
- `766-st-03-history-paste-nothing-selected-order-opens.png`: **History**, the day's list, nothing selected, the child band Z767-4HV7TD pasted. **The band's page opens**: "Walk-in #Z767-4HV7TD", Total spent ฿1040, and its one order, Z767-000001, Ticket, Paid ฿1040.
- `766-st-04-ticket-till-paste-toast-sale-unchanged.png`: **the ticket till**, with a sale being rung up (1 Hour Play, 1 child + 1 adult, ฿1040, not paid). Nothing selected, the child band pasted. A message reads **"That is wristband Z767-4HV7TD. It opens at F&B, the shop or History. Nothing changed on this sale."** The order panel read the same before and after the paste, and no look-up or write was made. The cart was then cancelled; it was never paid.
- `766-st-05a-typed-by-hand-into-history-search-stays.png`: **typed by hand** into History's search box (Z767-4HV7TD, one key every 200 ms). The code stays in the box. The box runs its own search ("Bracelet Z767-4HV7TD: 1 sale on the platform, any day") and the band's page does **not** open.
- `766-st-05b-typed-by-hand-into-fnb-dish-search-stays.png`: also typed by hand, into F&B's "Search dish…" box on a guest order. Unlike History's search box, this box does not read band codes itself. The text stays in the box ("No dishes match"), no look-up is made and no tab loads; the order stays a guest order. This one was not asked for. It covers the other kind of field.
- `766-st-06-fnb-made-up-code-no-tab-found.png`: **F&B**, nothing selected, a made-up band-shaped code Z767-ZZZZZZ pasted. The band box shows the code and its own words: **"No tab found for "Z767-ZZZZZZ". Try a code below or continue as guest."**

## What the till sent (read from the browser)

- **One look-up per paste:**
  - the child band at F&B: 404, no tab
  - the adult band at F&B: 200
  - the adult band at the Shop: 200
  - the child band at the Shop: 404, no tab
  - the child band at History: the band's sales, 200
  - the made-up code at F&B: 404, no tab
- **None** for the ticket-till paste or for the code typed into Search dish….
- History's search box made its own search for the typed code. That is the search box's own job.
- **Writes:** sign-in, the sale and its cash payment (Z767-000001), the print jobs for that sale, price quotes for the carts, and the till re-stating its station after each page load. Nothing was written by any paste or by the typing.

## Clean-up

The sale's three print jobs (two bracelets and the receipt) read back as printed on the shared test printers. The till signed out and its session was refused afterwards. The test till's printers were unassigned and the till was archived; a read-back shows it archived with no devices. The admin session signed out too.

The sale Z767-000001 stays recorded, and its two bands were left active, as in the earlier proofs. The tabs were only opened, never charged. Till 1 (Pi), Till 2 (test), Reception Till 1 and FWBooth1 read back unchanged. No till notice was pressed, no setting was changed, no text message was sent, only cash was used and nothing was refunded.

Every paste, look-up and write is in `receipt.json`.
