# Setting up the Lucky Wheel in the Console — voucher types, booth staff, PINs, session length

One page for the set-up you do yourself on staging before the bench test: what each prize is worth and what its slip says, who may sign in at the booth and with which PIN, how long a sign-in lasts, and the publish that sends it to the booth. Everything is done in the Console, apart from step 1, in the POS admin; nothing here needs an engineer.

It is safe to repeat. Going through the steps again with the same values changes nothing: the list shows what is already set, **Save settings** stays greyed out when nothing changed, and a publish with nothing new says "Nothing differs from the published version".

Sign in to the staging Console with your own administrator account. The steps are in this order because each one uses the one before: a prize points at a voucher type, and a publish sends the prizes, the words and the session length together.

## 1. Before you start: the products the free prizes hand over

A free-product voucher hands over a product from the menu, so the product has to exist first.

- **Kids Pizza** and **Bracelet Workshop**: check that both exist in the POS admin under **Products** — the pizza in **F&B Menu**, the workshop wherever the park sells it (**Add-ons** or **Merch / Retail**). If one does not, add it there first. Any of those kinds works: the till puts it on the sale and takes its price off.
- **1+1 Kids Ticket**: it applies to one ticket package. Decide which (not Eat & Play — the free ticket must not be valid for it).

A product or package at one park is honoured at every park: the till at another branch hands over its own product with the same code, or its own package with the same name.

## 2. Voucher types — Console → Voucher types

The page lists every voucher type. Each line says what it is worth, how long it lasts, whether its slip carries the park's own words once a booth using it is published, and which booth prize uses it. A line with an **amber sentence** is one the till cannot honour yet (for example "No product linked — the till answers "not set up yet"") — that is what to fix.

**Edit the six launch types.** Click a line, change the fields, press **Save**:

| Type | What it is worth | Link to |
|---|---|---|
| 100 THB Voucher | Amount off, 100 | — |
| 150 THB Voucher | Amount off, 150 | — |
| 200 THB Voucher | Amount off, 200 | — |
| Free Bracelet Workshop | Free product | the Bracelet Workshop product |
| Kids Pizza | Free product | the kids pizza product |
| 1+1 Kids Ticket | Free ticket 1+1 | the ticket package it is valid for |

For each one, in **What the slip says**:

- **Title** (English and Thai) — the big line under "★ YOU WON ★". Left empty, the slip prints the prize's name.
- **Instruction** (English and Thai) — what the family does with the slip, printed English then Thai. Left empty, the slip prints "Show this QR at OTO Reception to claim: …".
- **Terms** (English and Thai) — the small print at the foot of the slip, one line per line you type. **Replace the placeholder terms**: the ones on staging were written before the booth had a home and name "HKT Central".

The preview under the fields shows the slip's lines in the order they print; with the title left empty it shows the name of the prize that uses the type, because that is what the slip prints. A saved title or instruction reaches the slip at the booth's next publish (step 5); when a type's terms reach it depends on the wheel version the booth is running, and [When each change takes effect](#when-each-change-takes-effect), at the end of this page, says exactly. Then **How long it lasts**: a number of days, counted from the moment a voucher is won, or **Never expires**. (A prize can still set its own number of days on the Booths page; left empty there, it takes this one.)

A free product or a 1+1 cannot be saved without its product or package — the Save button stays greyed out and says what is missing.

**A new type** (for example "50 THB off"): **New voucher type** → the name in English and Thai → **Amount off** → 50 → the words → the expiry → **Create voucher type**. Then, on the Booths page, point a prize at it (the prize's **Voucher** field).

**Archive** takes a type off the list; vouchers already printed under it are still honoured. A booth prize that still points at it cannot be published until it points at another type. **Show archived voucher types**, at the foot of the list, brings it back into view, and **Restore** brings it back.

What is the same for every booth voucher, and is therefore not a setting: it is redeemed **online only** (a till working offline refuses it), **once**, **one per sale and never with a promo code**, at **any branch**.

## 3. Booth staff and PINs — Console → Booths → the booth → Booth staff

- **Add somebody**: choose them under **Person** (search by name or phone) → **Add to booth**. The list offers the people of the booth's branch and the park's administrators — add yourself too.
- **Set PIN**: 4 to 8 digits, typed twice → **Save PIN**. The PIN is never shown again, anywhere. Forgotten? **Reset PIN** gives a new one. A PIN belongs to the person, so it is the same at every booth they work.
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

## 6. Check a slip

- **Staging's virtual box**: spin on the booth page paired to Booth 1, then Console → **Devices** → **Virtual box 1** → **Printing** → press the booth's receipt printer: the slip is shown as a picture — your title, your instruction in both languages, your terms, and "No expiry" for a type that never expires. The panel may say "Nothing has been printed on this box" just above the picture: that list shows only what the platform sends to the box's printers (a test print, a receipt from a till), not the slips the booth prints by itself, so the picture below it is still your slip.
- **The Pi**: the slip comes out of the printer.

## When each change takes effect

| You change | It takes effect |
|---|---|
| What a type is worth (amount, product, package) | At once, at the till — for every voucher of that type not yet redeemed, slips already printed included |
| What a type's slip says — title, instruction and terms | It depends on the wheel version the booth is running — see below the table |
| A type's expiry | Read from the type when a voucher is won and counted from that moment, so it applies to vouchers won after the box's next pull (about a minute); a slip already printed keeps its date. A prize with its own number of days uses those instead |
| A prize's own number of days (Booths page) | At the booth's next publish |
| Booth staff and PINs | At the box's next pull, without a publish (a phone-and-password sign-in by somebody taken off is refused at once) |
| The session length | At the booth's next publish, for sign-ins after it |

**What decides a slip's words is the wheel version the booth is running**, not what the type says now:

- **A type that version carries words for** — the type had a title or an instruction when that version was published — prints that version's title, instruction and terms. Any edit to them, clearing the title and the instruction included, waits for the booth's next publish; the publish review shows the booth as changed until then.
- **Any other type** prints the prize's name, the standard line and the type's current terms, so an edit to its terms is on paper at the box's next pull (about a minute), without a publish.
- **That includes a type you have just given its first title or instruction.** The publish review shows the booth as changed, but until the booth is published with it the slip keeps the prize's name and the standard line, while its terms already follow the pull. So after wording a type, or changing its words, publish every booth that uses it (step 5).
