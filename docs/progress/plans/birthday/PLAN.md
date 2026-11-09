# Birthday packages on the POS: plan

_Written 2026-11-09 from the owner's and the tester's notes of the same day
(the Floresta Birthday package, the two After School packages, the
Entertainment menu, the tester's three rules, the owner's note on kitchen slips
at a set time). Source texts: the three PDFs and the owner's text as pasted,
kept with the catalog sources outside the repository. Status: APPROVED by the owner on 2026-11-09 (section 6 holds the answers)._

## 1. What exists today (read from the code, 2026-11-09)

- The POS has no party package of its own. A party is an OTO App event
  (`otoapp.core_events`) read through `otoapp_v.events`. The till's Events tab
  opens a party page with a tab: extra charges (`pos.party_charge`, kinds
  ticket and fnb, "never a sale: no kitchen ticket, no stock, no bands"),
  payments (`pos.party_payment`, a real payment attempt, no sale and no
  receipt) and edits written back to the app (`pos.party_edit`). Walk-up party
  guests are added on the check-in board at a flat branch price (450, never
  tiered) and get a band one at a time at check-in.
- The OTO App holds the planning side: `birthday_package_templates` (base price,
  pricing mode), `package_line_item_templates` (category play, food, setup,
  cake, entertainment, other; included; qty; price), `entertainment_package_templates`
  (name, duration, price), `beo_set_menu_templates` (labels and choice groups,
  no quantities, no product link), `beo_kitchen_plans` (menus, kids' and adults'
  food times, ready-by offset 20 min), `beo_bar_plans`, `beo_event_billing`
  (package price, add-ons, an unused `pos_order_ref`), timeline, and AI Fill
  from the inbox (SCRUM-660). Missing: kids, adults and socks limits; weekday
  and weekend prices; extra-child prices; age range and extra-child surcharge on
  entertainment; a link from a set-menu item to a real menu product with a
  quantity; a food-voucher or credit amount on an add-on.
- The seam view `otoapp_v.events` carries only the core fields (counts, value,
  deposit, decoration, activities); the till's party page receives
  `lineItems: []`, `kitchen: none`, no package name.
- Printing: kitchen and bar slips are made only by a finalised sale, grouped by
  prep station (`product_category.default_prep_station`, `product.prep_station_override`)
  and sent to the station's kitchen and bar printers. There is no timed print
  job, no ready-by field on the prep ticket, no void or updated slip (the
  owner's E1 item in `NEXT_PRIORITY_2026-11-08.md`).

## 2. The principle

Plan in the OTO App, execute in the POS. Staff already plan every party in the
BEO (package, counts, menu, food times, entertainment, add-ons). The POS reads
that plan and does what only it can: one real sale for the money, bands and
socks against stock, the receipt, the kitchen and bar slips. The packages are
defined once, in the app, and seeded there.

## 3. Lane 1, OTO App: complete the package data and open it to the POS

Expand-only migrations on the app's tables and two new seam views.

- `birthday_package_templates`: kids included, adults included, socks included
  (count, or "all children"), hours, price weekday, price weekend, extra child
  weekday, extra child weekend, extra adult rule ("regular rate" or a weekday /
  weekend pair), included display lines (the receipt's 0-baht lines: table,
  program, cake, water), branch.
- `entertainment_package_templates`: age range text, max kids, extra-child
  price, duration minutes, category (games, shows, workshops, other), price per
  piece where the menu says "per pcs".
- Set-menu template items: menu product code (the till catalog's codes, e.g.
  CF-11 French fries), quantity, choice group where the menu offers a choice
  (pizza: margherita, hawaiian or pepperoni), replacement note (Fish & Chips
  may be 2 Chicken Schnitzel).
- Add-on templates: price, "grants F&B credit of N satang" (table reservation
  5,000 and the private zone 3,000 both go towards food and drinks), prints a
  voucher yes/no.
- Views `otoapp_v.event_packages` (per event: the package snapshot with limits
  and prices, actual kids and adults, the chosen set menu with product codes
  and quantities, add-ons with prices and credit, kitchen food times and ready
  offset, bar items) for the platform to read.
- Seed, through the app's own routes on staging: the Floresta Birthday package
  (weekday 16,900, weekend 20,900, up to 10 children, extra child 1,300 /
  1,500, 4 adults, socks for all, the set menu with choices, the 30-minute
  program, the cake); After School 10 kids 10,900 and 20 kids 18,900 (10 and 20
  adults included, the fixed food sets with quantities, the 3,000 private zone
  add-on, socks not included); the Entertainment menu (19 lines with age ranges,
  durations, max kids and extra-child surcharges); the add-ons (reserved table
  5,000 with 5,000 credit, Classic balloon decoration 4,000, PRO photo zone
  8,900, program upgrade from 1,000, Bracelet Making 100 per child).

## 4. Lane 2, POS: settle a party as one real sale

On the party page, "Settle party" replaces "Add tickets" (Add F&B on the day
stays). Staff confirm the actual numbers; the api composes one sale from
existing line kinds:

- a package fee line at the package price for the party's date (weekday or
  weekend), with the included items as 0-baht lines so the guest receipt shows
  what the price covers;
- the participants: the actual kids and adults on a ticket line of the
  package's hours, so bands print at finalisation as for any ticket sale;
- extra children beyond the included count at the package's extra-child price
  for the date; extra adults beyond the included count at the package's own
  extra-adult price for the date (350 / 500 on the Floresta package);
- socks: included pairs as free Regular Socks (stock reduced, as SCRUM-768 and
  SCRUM-799 built), extra pairs at 60;
- add-ons from the plan as lines; a table reservation or private zone grants its
  F&B credit to the party and prints the credit voucher the till already prints
  for credits;
- the deposit already paid in the app recorded as a payment on the sale so the
  receipt reads the balance due; the balance taken through the normal payment
  screen (SCRUM-796).

The party tab's extra charges stay for on-the-day additions. The party's event
and attendees are unchanged; check-in on the board keeps working.

## 5. Lane 3, kitchen and bar slips at a set time

- Each party carries its slip time (from the BEO, default 11:00); a branch
  setting names the station whose kitchen and bar printers receive the slips
  (tagged later by the park; until then the job records no printer).
- A job in the api's runner: at that time, for every party of the day at the
  park, one kitchen slip and one bar slip per prep station from the set menu
  and bar plan, headed with the party name, table, number of children and
  "ready by" (the kitchen plan's kids' food time minus its ready offset); the
  prep ticket template gains the ready-by line.
- "Print party slips now" on the party page for a reprint.
- Changes after printing (void slip and updated slip, the owner's E1) follow in
  their own ticket once this lands.

## 6. The owner's decisions (2026-11-09)

1. The principle and the three lanes: agreed.
2. Extra adult on the Floresta package: 350 weekday / 500 weekend as the PDF
   prints, because that is the package's price; the regular tier rate is for a
   normal sale without a package. (After School includes its parents.)
3. Slip time: settable per party from the birthday package in the BEO, with
   11:00 as the default. Food slips go to the kitchen printer, which the park
   tags later; drinks go to the bar printer. Until a station is tagged for a
   park, the job records "no printer" and the party page shows it.

## 7. Answers to the tester's open questions

- The set menu is chosen in the BEO's kitchen plan, as today; the POS shows it
  and prints it. No checkbox at the till.
- The order goes to the kitchen at the branch's set time with the ready-by time
  from the kitchen plan.
- Entertainment upgrades and custom options are chosen in the BEO's
  entertainment section (the menu as a list plus a custom line); the POS lists
  them as add-on lines on the sale.

## 8. Order and size

Lane 1 first (about a day; it carries the seed). Lanes 2 and 3 start on Lane
1's data shape and land after it (about a day and a half, and half a day to a
day). Each lands through the release slot with a ZZ TEST staging proof inside
its Jira comment.
