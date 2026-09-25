# Setting up the Lucky Wheel in the Console — voucher types, booth staff, PINs, session length

One page for the set-up you do yourself on staging before the bench test: what each prize is worth and what its slip says, who may sign in at the booth and with which PIN, how long a sign-in lasts, and the publish that sends it to the booth. Everything is done in the Console, apart from step 1, in the POS admin; nothing here needs an engineer.

It is safe to repeat. Going through the steps again with the same values changes nothing: the list shows what is already set, **Save settings** stays greyed out when nothing changed, and a publish with nothing new says "Nothing differs from the published version".

Sign in to the staging Console with your own administrator account. The steps are in this order because each one uses the one before: a prize points at a voucher type, and a publish sends the prizes, the words and the session length together.

## 1. Before you start: the products the free prizes hand over

A free-product voucher hands over one product, so the product has to exist first. Check in the POS admin under **Products**:

- **Kids Pizza**: the F&B menu on staging has no item called Kids Pizza (25 September). Link the Kids Pizza type (step 2) to the menu's pizza, **Margherita Pizza** (code FB-PIZZA), or add a Kids Pizza item to **F&B Menu** first and link that. A free product is exactly one product: Kids Pizza gives the pizza only, and a drink with it is paid for as usual.
- **Bracelet Workshop**: check that it exists wherever the park sells it — **Add-ons** or **Merch / Retail** — and add it there first if it does not.
- **1+1 Kids Ticket**: it applies to one ticket package. Decide which (not Eat & Play — the free ticket must not be valid for it).

**Which till takes the slip.** A product from **F&B Menu** is made by the kitchen, so its voucher is redeemed at the restaurant (F&B) till only; the ticket till answers "Redeem this voucher at the restaurant till". An **Add-on** or a **Merch / Retail** product, and every other kind of voucher, is redeemed at the ticket till. The counter's own guide is [COUNTER_VOUCHERS.md](COUNTER_VOUCHERS.md).

**If the POS admin says "This branch is not on the platform"** ("“HKT Central” has no record in the database…"), it is not showing your park's own products, and anything added under that notice stays in that browser tab: it never reaches the platform or the Console's lists. Only the **F&B Menu** page shows this notice. In the same state **Add-ons** and **Merch / Retail** show the prototype's lists with no notice (your park's own Bracelet Workshop, for one, is not in them), so open F&B Menu first, before you check or add anything. It happens when the admin page is opened or reloaded while the POS is locked (it locks itself after two minutes untouched): the page still opens, but it cannot read the park's records. Press **Back to POS**, unlock the POS with your password, open the admin page again and reload it (F5): the notice is gone. Add nothing, on any of these pages, while it shows.

**At another park.** A money-off voucher is honoured at every park. A 1+1 is honoured at its package's park and at any park with a ticket package of the same name. A free product is honoured only at the park that sells the product it is linked to; at any other park the till answers "This voucher's item is not sold at this branch — ask a manager".

## 2. Voucher types — Console → Voucher types

The page lists every voucher type. Each line says what it is worth, how long it lasts, whether its slip carries the park's own words once a booth using it is published, and which booth prize uses it. A line with an **amber sentence** is one the till cannot honour yet (for example "No product linked — the till answers "not set up yet"") — that is what to fix. The one exception is a Hand-over prize, whose amber sentence says how reception honours it (below).

**Edit the six launch types.** Click a line, change the fields, press **Save**:

| Type | What it is worth | Link to |
|---|---|---|
| 100 THB Voucher | Amount off, 100 | — |
| 150 THB Voucher | Amount off, 150 | — |
| 200 THB Voucher | Amount off, 200 | — |
| Free Bracelet Workshop | Free product | the Bracelet Workshop product |
| Kids Pizza | Free product | Margherita Pizza, or your own Kids Pizza item (section 1) |
| 1+1 Kids Ticket | Free ticket 1+1 | the ticket package it is valid for |

**Picking the product.** The product list names each product with its code in brackets and its park, and a few names appear twice — two Ice Cream Cones, two Grip Socks. They are different products: **Grip Socks (MR-SOCKS)** is the shop's and **Grip Socks (AO-GRIPSOCKS)** the ticket add-on, and one Ice Cream Cone has a code (FB-ICECREAM) where the other has none. Pick by the code, and by the till you want the family sent to (section 1).

For each one, in **What the slip says**:

- **Title** (English and Thai) — the big line under "★ YOU WON ★". Left empty, the slip prints the prize's name.
- **Instruction** (English and Thai) — what the family does with the slip, printed English then Thai. Left empty, the slip prints "Show this QR at OTO Reception to claim: …".
- **Terms** (English and Thai) — the small print at the foot of the slip, one line per line you type. **Replace the placeholder terms**: the ones on staging were written before the booth had a home and name "HKT Central".

The preview under the fields shows the slip's lines in the order they print; with the title left empty it shows the name of the prize that uses the type, because that is what the slip prints. A saved title or instruction reaches the slip at the booth's next publish (step 5); when a type's terms reach it depends on the wheel version the booth is running, and [When each change takes effect](#when-each-change-takes-effect), at the end of this page, says exactly. Then **How long it lasts**: a number of days, or **Never expires**. The days count from the day a voucher is won, and it is good until the end of the last one, on the park's clock: with 14 days, a voucher won on 25 September, at whatever hour, prints "Expires 09 Oct 2026" and is honoured until the end of 9 October. (A prize can still set its own number of days on the Booths page; left empty there, it takes this one.)

A free product or a 1+1 cannot be saved without its product or package — the Save button stays greyed out and says what is missing.

**A new type** (for example "50 THB off"): **New voucher type** → the name in English and Thai → **Amount off** → 50 → the words → the expiry → **Create voucher type**. Then, on the Booths page, point a prize at it (the prize's **Voucher** field).

**A Hand-over prize** is a prize given out as it is, with no product behind it. It is given out at reception: the family brings the slip, reception rings it up on its own as a ฿0 sale, which uses the voucher, and hands the prize over once that sale is confirmed. So keep the prize at reception, not at the booth. The slip's standard line already sends the family to reception; an instruction of your own should too.

**Archive** takes a type off the list; vouchers already printed under it are still honoured. A booth prize that still points at it cannot be published until it points at another type. **Show archived voucher types**, at the foot of the list, brings it back into view, and **Restore** brings it back.

What is the same for every booth voucher, and is therefore not a setting: it is redeemed **online only** (a till working offline refuses it), **once**, **one per sale and never with a promo code**, at the till section 1 names, and at **any park**, except a free product, honoured only where its product is on sale, and a 1+1, honoured only at a park with a ticket package of the same name (section 1).

## 3. Booth staff and PINs — Console → Booths → the booth → Booth staff

- **Add somebody**: choose them under **Person** (search by name or phone) → **Add to booth**. The list offers the people of the booth's branch and the park's administrators — add yourself too.
- **Set PIN**: 4 to 8 digits, typed twice → **Save PIN**. The PIN is never shown again, anywhere. Forgotten? **Reset PIN** gives a new one. A PIN belongs to the person, so it is the same at every booth they work. Give each person digits nobody else at their booths uses: a booth refuses a PIN that two of its people share, as if it were wrong, and signs neither of them in.
- **Withdraw PIN** stops the PIN working; **Remove** takes the person off this booth (their PIN stays theirs for other booths).
- People on the list can also sign in at the booth with **their own phone and password** when their role allows it — the panel names those roles. Somebody not on the list cannot sign in at this booth either way.

Changes here reach the booth at the box's next pull — within about a minute when it is online. No publish is needed. From that pull a new PIN works and a withdrawn one no longer does; somebody taken off the list can no longer sign in with their PIN, and a sign-in they already have at the booth ends at that pull too. A phone-and-password sign-in is checked by the platform itself, so somebody taken off the list is refused that way at once. Do not send PINs in chat or email; tell each person their own.

## 4. How long a sign-in lasts — Console → Booths → the booth → Booth settings

**Staff session length**, in hours: left empty it is 12, at most 24. A sign-in ends when this time is up or when somebody signs out — never because nobody pressed anything. Press **Save settings**; it reaches the booth with the next publish, and a sign-in already running keeps the length it started with.

## 5. Publish — Console → Booths → the booth → Publish

**Review and publish** shows what the booth will run. Check two lines before you press:

- **Staff sign-in** — "lasts 10 hours" (or whatever you set).
- **Slip wording** — "the park's own words for 6 of the 6 voucher types this booth's prizes use" once all six are worded.

Then **Publish version N**. The box picks it up at its next pull and reports it with its next heartbeat — about two minutes: a pull of up to a minute, then a heartbeat. **What this booth is running → Wheel version** shows the new number once it has.

A booth with no layout — a new one — is refused ("This booth has no wheel design"): choose one under **Booth settings** → **Layout** first. So is a booth whose code prefix is not exactly two capital letters or digits: set it on the booth's station under **Devices**, then publish.

## 6. Check a slip

- **Staging's virtual box**: spin on the booth page paired to Booth 1, then Console → **Devices** → **Virtual box 1** → **Printing** → press **Receipt Printer 2**, Booth 1's printer: the slip is shown as a picture — your title, your instruction in both languages, your terms, and "No expiry" for a type that never expires. The panel may say "Nothing has been printed on this box" just above the picture: that list shows only what the platform sends to the box's printers (a test print, a receipt from a till), not the slips the booth prints by itself, so the picture below it is still your slip.
- **The Pi**: the slip comes out of the printer.

## When each change takes effect

| You change | It takes effect |
|---|---|
| What a type is worth (amount, product, package) | At once, at the till — for every voucher of that type not yet redeemed, slips already printed included |
| What a type's slip says — title, instruction and terms | It depends on the wheel version the booth is running — see below the table |
| A type's expiry | Read from the type when a voucher is won, so it applies to vouchers won after the box's next pull (about a minute): the days count from the day of the win, to the end of the last one. A slip already printed keeps its date. A prize with its own number of days uses those instead |
| A prize's own number of days (Booths page) | At the booth's next publish |
| Booth staff and PINs | At the box's next pull, without a publish (a phone-and-password sign-in by somebody taken off is refused at once) |
| The session length | At the booth's next publish, for sign-ins after it |

**What decides a slip's words is the wheel version the booth is running**, not what the type says now:

- **A type that version carries words for** — the type had a title or an instruction when that version was published — prints that version's title, instruction and terms. Any edit to them, clearing the title and the instruction included, waits for the booth's next publish; the publish review shows the booth as changed until then.
- **Any other type** prints the prize's name, the standard line and the type's current terms, so an edit to its terms is on paper at the box's next pull (about a minute), without a publish.
- **That includes a type you have just given its first title or instruction.** The publish review shows the booth as changed, but until the booth is published with it the slip keeps the prize's name and the standard line, while its terms already follow the pull. So after wording a type, or changing its words, publish every booth that uses it (step 5).
