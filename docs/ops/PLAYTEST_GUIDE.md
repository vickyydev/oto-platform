# Play-test guide — selling, printing, finding and refunding

For the park's team, first round. This walks through everything the tills can do now,
on the staging system, with nothing at risk: staging is a rehearsal copy with made-up
members and money, and it can be reset. Work through the numbered parts in order the
first time; after that, wander freely — finding things we did not think of is the point.

The wheel booth has its own guides already: [BOOTH_SETUP.md](BOOTH_SETUP.md) for the
Console side and [COUNTER_VOUCHERS.md](COUNTER_VOUCHERS.md) for redeeming a slip at the
counter. This guide covers the rest of the counter's day.

## Before you start

- Open the staging launcher in a desktop browser and sign in with the details you were
  given. Pick **POS**. (Sign-in details are never written in these documents — ask if
  you do not have them.)
- Take a till when it asks — **Reception Till 1** is set up for everything below.
- Staging has no paper printer. Everything that "prints" appears in the **print
  simulator**: open the Console in a second tab → **Devices** → the till's box →
  **Printing**. Each slip shows there as it would print, and that is where you check
  the receipts, wristbands and kitchen tickets this guide talks about.
- Two kinds of account matter here: a **reception** account (sells, cannot approve
  refunds) and a **manager** account (can). Try part 5 with both.

## 1. Sell tickets and look at what printed

1. Start a sale: find a member by phone (any seeded member) or use walk-in.
2. Add **2 children's tickets and 1 adult**, take **cash**, and complete the sale.
3. On the payment-done screen, notice each wristband's **short code** (like
   `T1-8WJY24`) listed under its row — that is what staff read out if paper ever fails.
4. In the print simulator, check what arrived:
   - **One receipt**: the Thai abbreviated tax-invoice header, the VAT line, the cash
     tender, the member's nickname, and the three band short codes.
   - **Two kids' bands and one adult band**: each with a QR and its short code. A kids
     band names the child and shows the allergy line where the child has one.
5. If something did not print, the till says so itself, for example "Bar ticket not
   printed — no bar printer at this station". That sentence appearing is correct
   behaviour, not a fault.

## 2. A restaurant order and its kitchen tickets

1. Switch to the **F&B** station, start an order for a member whose child has an
   allergy note, add one kitchen item and one drink, and add an order note.
2. Complete and pay. In the print simulator:
   - The **kitchen ticket** carries the allergy line and your note.
   - Till 1 deliberately has **no bar printer**, so the drink's ticket is recorded as
     skipped and the till says so. That is the intended behaviour to check.

## 3. A shop sale

Sell something from the **Shop** tab. One receipt in the simulator, and if the item
carries a voucher label, an item voucher beside it.

## 4. Find it all again in History

1. Open **History**. Today's sales are listed; each opens into a detail with its
   items, payments, bands and printouts.
2. **Search by wristband**: type or scan a band's short code from part 1. The band's
   sale appears, whatever day it was made.
3. **Search by phone**: type the member's phone in any format. Their sales appear.
4. In a sale's detail, find the **Bracelets printed** card and the payment rows with
   their attempts.

## 5. Refunds — try to be refused

1. As **reception**, open the cash sale from part 1 and press **Refund**. You should
   be told a manager's approval is needed. That refusal is the test.
2. As a **manager**, refund one item. The amount is capped at what remains, and a
   reason is required. The sale's badge moves to *Partially refunded*.
3. Refund the rest. The badge moves to *Refunded*.
4. The detail now shows the **Refund history**: amount, reason, refund number (like
   `T1-R-000001`), who made it and who approved it, and how the money goes back.
5. If you have a card sale from the terminal simulator, refund it too: inside the
   terminal's void window it voids; after the window, the money is handed back in
   cash.

## 6. Print something again

In a sale's detail, press **Reprint** and choose the receipt, then a band group. Each
arrives in the simulator marked as a **copy**, and the detail's **Reprint history**
records what was reprinted, by whom, and which original it copies. A reprinted band
keeps its code — the child's wristband stays valid, only the paper is new.

## 7. The wheel's voucher at the counter

Spin the staging wheel (the booth page), then redeem the printed voucher's code in a
new sale, following [COUNTER_VOUCHERS.md](COUNTER_VOUCHERS.md). It is used up only
when the sale completes, and a second try tells you who redeemed it and when.

## What to write down when something looks wrong

One line per finding is enough, but include: **where** (which screen or slip), **what
you did** (the exact steps, with the sale's receipt number if there is one), **what
you saw**, and **what you expected**. A photo or screenshot beats a description.
Send findings as one list, not one message each; they are turned into tickets and
fixed in rounds.

## Not in this round, on purpose

- **Selling with the internet down** — being built next; today the till needs its
  connection.
- **Real receipt and wristband printers** — the simulator stands in for them until
  the on-site work.
- **Wallets and credit, stock counts, cash-up and day close, child check-in, the
  arrival gate** — later parts of the plan, each with its own round.
- Anything in the OTO App beyond what its own screens already do.
