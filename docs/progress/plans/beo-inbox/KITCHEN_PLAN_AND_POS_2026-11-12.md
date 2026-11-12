# Kitchen plan and the POS: findings and the owner's decisions

Investigation on 12 November at origin/main de22ef68b, with staging read-backs from one ZZ TEST party (deleted after).

OWNER'S WORDS (12 Nov): "kitchen plan menu is not syncing with pos". He then answered the plan's eight questions (below); that is his go for these lanes, with "Run the workflows and deploy it asap without waiting for CI actions".

## A. POS menu into the BEO's kitchen plan: NOT BUILT
- Kitchen and bar plan lines are hand-typed (EditableText, apps/oto-app/client/src/components/beo/beo-event-editor.tsx:494-501, placeholder "Item name"); the buttons are "+ EXTRA" (:3368) and "+ NEW ITEM (not in the menu)" (:3380, which makes a BEO-only POS product, SCRUM-828). Nothing lets staff pick an item the POS already sells.
- The app never reads the POS catalogue (apps/oto-app/server/lib/beoCatalogueFill.ts:47-49).
- Set-menu codes are typed by hand in Settings > Set menu templates (set-menu-templates-settings.tsx:139-145) and never checked against the POS.
- AI-matched lines write the code into the line's note, not its product code (apps/oto-app/server/lib/beoAiApprove.ts:404-415).
- Staging, Central Floresta: the till's menu read returns 174 live items, 137 of them food and drink (76 kitchen, 61 bar). The app has 9 set-menu templates with 95 lines, 24 coded (all 24 live on the POS); six templates have no codes (Set Central, Set at Robinson, Cake under 10 kids, Cake over 10 kids, After school 10 kids chalong, After school central 20pax).
- Name mismatches by code: Veggie sticks vs "Vegetable sticks"; Fried rice Veggie/Chicken/Shrimp vs "Fried rice"; Margherita/Hawaiian/Pepperoni Pizza vs "Margherita"/"Hawaiian"/"Pepperoni".
- Template dishes with no POS item: Fish fingers, Fruit skewers, Belgian Waffles, the drinks pitcher's Juice and Mors. ORIGIN: entered into the OTO App's set-menu templates on 9 November by SCRUM-803 from the park's printed package (catalog-source/Birthday Package_Floresta.pdf and the owner's text); see docs/qa/proof-2026-11-09/SCRUM-803/staging-seed/receipt.json. The POS sells Kids juice Apple/Orange/Pineapple and Cranberry mors (CF-66-1..4, made at the bar).

## B. BEO kitchen plan to the till: BROKEN
The read is live: GET /parties/:id reads the view otoapp_v.event_packages each time.
1. No package -> no plan: the view inner-joins beo_package_snapshots (apps/oto-app/migrations/0048…sql:344); apps/api party-plan.ts:56 returns null; the till falls back to kitchen {needed:false}, hard-coded at apps/pos/src/api/events.ts:195 -> "No kitchen service for this party." (PartyDetail.tsx:579).
2. Only coded lines reach the till (0048…sql:205, :263); hand-typed lines are dropped from the party page, both slips and the settlement.
3. A choice staff make in the BEO's set-menu block never arrives; the view reads the choice only from the parent link's submission (sel.is_submitted, :361); a later staff change does not arrive either.
4. The cake is not in the view; the till's plan section has no cake row (PartyDetail.tsx:510-542).
5. Bar items carry no code (the view hard-codes 'product_code', NULL at :322).
6. Uncoded drinks (the set menu's pitcher) print on the KITCHEN slip.
7. The phone party page never reads the plan (MobilePartyDetail.tsx:260-299).
8. The till's party Edit form shows an empty kitchen plan; changes there are "kept in the OTO App", never written (apps/pos/src/api/parties.ts:404).
Settlement charges only BEO-only codes (apps/api/src/services/party-settlement.ts:159-192); an archived BEO-only item drops out (:167-170). The slip prints a choice without its dish ("Veggie" alone).

## THE OWNER'S DECISIONS (12 Nov; his words in quotes)
1. Hand-typed lines not on the till: allowed, printed to the kitchen by name, marked "not on the till menu". (the recommendation, accepted)
2. A till item added as an EXTRA is charged at settlement: "Not 0 baht, charge it according to the right entered price". Reading: an EXTRA line is charged at the price entered on that line in the BEO; where no price was entered and the line is a till item, the till's price; a set-menu (included) line stays part of the package. If the code shows a case this reading does not settle, report it as a question for the owner; never invent a price.
   **Ruled on 12 November 17:35, when the review asked whether the entered price is for one item or for the whole line: "its price per item."** The charge is the entered price times the quantity.
3. Staff change a choice after the parent submitted: "Every record should get updated in this POS and BEO entries accordingly". The latest change wins, and the BEO, the till's party page, the slips and the parent's own view all show the same choice.
4. The cake: "Follow according to selected choice from beo form". The party page and the kitchen slip show the cake exactly as the BEO's cake choice says (its type, notes and time); nothing when the BEO says no cake.
5. The older set menus: "Dont remove any menu". Nothing is retired, renamed or deleted.
6. Dishes the POS lacks: "where did these dishes coming from? we already fed the park's active menu in the POS with real data". Nothing is added to the POS. The origin is above (the printed package, SCRUM-803). Where a template line has a real POS match a person can code it through the picker; unmatched lines stay by name, marked not on the till menu.
7. The till's party Edit form kitchen section: "Let it be edited with right permission of admin or manager and update it in BEO as well". A branch manager or admin edits the kitchen plan on the till and the change is written to the BEO in the OTO App (audited on both sides); other roles see it read-only.
8. A party with a kitchen plan but no package: shown on the till and its slips print; settling still needs a package. ("yes")

## LANE B: the whole kitchen plan reaches the till
- A new oto-app migration (the next free number in apps/oto-app/migrations; CREATE OR REPLACE on otoapp_v.event_packages): LEFT JOIN on the package; every kitchen-plan line with or without a code, marked set menu / extra / party-only; set-menu choices from the BEO's own lines matched by group so the latest choice wins (an open group still says "Choice not made"); set-menu codes from the template; the cake and the bar service time; bar items with their own code; the adults' handling from 0048 kept EXACTLY.
- Decision 3 also needs the parent's own view to show the staff's later choice: find where the parent link reads its selection and make both sides read one record (report exactly what you did).
- api: party-plan.ts and PartyPlanSchema in packages/shared (the package may be empty; lines know where they came from; the cake); settle still refuses a party with no package; the slip (packages/shared/src/party-slips.ts, apps/api/src/services/party-slips.ts) prints every line, routes drinks to the bar by code, and prints "Fried rice: Veggie", not a bare "Veggie"; EXTRA lines are charged per decision 2 in party-settlement.ts.
- Tills: PartyDetail.tsx and MobilePartyDetail.tsx show every line and the cake; events.ts stops hard-coding an empty kitchen; the party page re-reads the plan on focus and every 60 s while open.
- RISK: SCRUM-861's change detection rebuilds each party's slips from the plan; once more lines arrive, every party whose slips already printed that day would print a VOID and an UPDATED slip. The first plan read after this deploy must NOT count as a change; say how you made that so and test it.
- Tests: api party-plan unit tests (no package, hand-typed lines, staff override, bar codes, cake), party-slips composition tests, the GET /parties/:id integration test, settlement tests for an EXTRA's price; the oto-app view checks (kitchen-adults, party-menu-item, birthday-packages); the apps/api text pins (*review*) because the lane touches apps/oto-app/server; the POS party page tests.
- Deploys: oto-app (migration), api, both tills. The park's box needs nothing (slips are composed in the api).

## LANE B2 (after Lane B lands): the till's party Edit form writes the kitchen plan to the BEO (decision 7)
A server-to-server door on the OTO App for the platform to write a party's kitchen-plan lines (the app owns the data), a platform route with a manager/admin permission guard, idempotent, audited on both sides; the till's Edit form fills its kitchen section from the BEO and saves through it; other roles read-only.

## LANE A: the POS menu inside the BEO
- api: GET /otoapp/party-menu/catalogue?branchId= next to apps/api/src/routes/otoapp-party-menu.ts, reachable with the app's provisioning key only (never a person's session), branch-scoped, archived items left out: code, name, category, station (kitchen/bar), price, BEO-only flag.
- OTO App server: a door passing the till's menu through, 60-second cache, no copy in the app's database.
- OTO App screens: a searchable till-menu picker on kids, adults, set-menu "+ Add item" and bar lines, writing the POS name and code; a "No longer on the till" mark when a code goes dead; free typing and "+ NEW ITEM" stay; the Settings set-menu "Code" boxes become the same picker with a warning on a dead code. No menu is removed or renamed.
- The AI fill part (Phase C of the BEO fill plan) comes AFTER the fill's Phases A and B land, in its own lane: the fill gets the till's food and drink as its menu and writes the code as the line's product code (beoCatalogueFill.ts, beoAiApprove.ts). Do not touch those two files in Lane A.
- Tests: the api door (key-only, branch-scoped, archived left out), a UI check for the picker.
- Deploys: oto-app and api.

## State, 12 November 17:50
- LANE A (SCRUM-905, the POS menu inside the BEO) landed on main at 4392efbfe at 17:42 and is deployed to staging (api and the OTO App); its staging proof is running. Ticket in Testing.
- LANE B (SCRUM-906, the whole kitchen plan reaches the till) is in its fix round, with the owner's ruling of 12 November that an EXTRA's price is per item. SCRUM-907 (Lane B2) follows it.

## Questions from the SCRUM-905 build, to put to the owner together (the build uses the default named in each)
1. Items taken off sale are not offered, and a BEO line carrying such a code shows "No longer on the till". Should an item off sale count as gone, or stay pickable?
2. Items with no till code are not offered, because a BEO line is matched to the till by its code. Should every food and drink item be given a code in the Console? (The number of uncoded items at Floresta was not measured.)
3. "Food and drink" means menu items made at the kitchen or the bar. Items that print nowhere (pre-packed snacks), merchandise and ticket add-ons are left out. Right?
4. Items made from a BEO for another party are offered too, in their own group at the end, "Made for a party (BEO only)". Hide them instead?
5. A picked EXTRA takes the till's WEEKDAY price, even for a weekend or holiday party. Should a weekend party take the weekend price?
6. The price is written only when the line's badge says EXTRA; a SET line keeps its price. If staff flip the badge after picking, the price does not change. Right?
7. Typing a new name over a picked line keeps the till code; "Not from the till" removes it. Should typing a different name remove the code by itself?
8. In Set menu templates a pick writes only the code, and fills the name only when an always-included item has none; a choice group's name and an existing name are never changed. Right?
9. Settings checks a code against every park the manager may open (a template belongs to the whole group), so a code on sale at any park counts as live. Right?
10. The search shows for the roles that may save a BEO (global admin, operator admin, admin, manager). Should staff see it too?

## State, 12 November 18:20
- LANE B (SCRUM-906) finished its build, two independent reviews and the fix round. It is being rebased onto main for landing (its two platform migrations take the next free numbers after 0121; its OTO App migration is 0050). Deploy order: the OTO App, then the platform, then both tills.
- The fix round added: after the release, a party with no package is not printed late in one burst (a one-time start mark); the BEO PDF prints an EXTRA line's price as "each", per the owner's ruling that the price is per item.
- Being fixed in the land preparation: a bar-plan line whose till item prints nowhere still prints on the bar slip; one very large quantity cannot blank a party's plan.

## Questions from the SCRUM-906 build, to put to the owner together (question 1 is ANSWERED: the price is per item)
1. EXTRA lines are charged at the entered price × quantity (price per portion). The BEO's own extras total adds a line's price once, whatever its quantity (beo-event-editor.tsx:1270-1275). Should the entered price be per portion, or for the whole line?
2. The cake's own EXTRA price (the BEO cake section's EXTRA badge with a cake price) is not charged at the till. Decision 2 names till items added as EXTRA, and the cake is not a till item. Should an EXTRA cake be charged at its BEO price?
3. A hand-typed EXTRA line with no price is not charged. It only prints for the kitchen, marked 'not on the till menu'. No price is invented. Correct?
4. A BEO line with no SET/EXTRA badge (saved before the badge existed) counts as EXTRA, because that is how the BEO shows it, so it is charged if it has a price or a till code. Correct?
5. A hand-typed EXTRA line with a price is charged under its own name at that price, taxed as food for a kitchen line and as bar for a bar line. Correct?
6. A till item added as EXTRA with no entered price is charged at the till's price for the party's date, using the weekend price on weekends and holidays. Correct?
7. Drinks go to the bar slip only by their till code. The set menu's uncoded drinks (the pitcher's Juice and Mors) stay on the KITCHEN slip, marked 'not on the till menu', until someone codes them. A bar-plan line with a kitchen code prints on the kitchen slip. Is that acceptable?
8. 'Not on the till menu' also marks a line whose code the till no longer sells (an archived product), not only hand-typed lines. Correct?
9. 'Own Cake' (the family's cake) is also printed on the kitchen slip, with its time and notes, because the BEO's cake choice says so. Should it print?
10. A party with a kitchen plan and no package prints its slips at 11:00, the default, because the slip time is set by the package. Is 11:00 right?
11. When several dishes are chosen for one choice group, the page and slip show each dish with no count, because the menu does not say how portions split (as 0042 already reads it). Correct?
12. The one-time switch-over means a BEO change made in the minute around the api deploy is not sent as VOID/UPDATED: it is taken as already printed. Accept that small window, with the OTO App deployed first so it happens once?
13. Some BEOs were saved before the 'Different for adults' switch existed, and their adults' list repeats the kids' list. Both lists now reach the till in full (0048 already did this for coded lines). The brief said keep 0048's handling exactly, so it was kept. Should a repeated adults' list be skipped instead?
14. The parent's submitted link page now lists the choices as the team currently has them (a small list under 'Submitted on'). Is that addition acceptable?
15. The till's party page re-reads the plan every minute and on focus, and pauses while the Settle or Edit form is open. Correct?
16. The 'included' flag the AI fill puts on a line is ignored; only the SET/EXTRA badge decides whether a line is charged. Correct?

## State, 12 November 20:04: LANE B (SCRUM-906) LANDED
- On main at f17359759. Deploy order kept: the OTO App first (its migration 0050), then the platform (migrations 0123_party_slip_baseline and 0124_party_slip_schedule_start), then both tills. The counter box needs nothing.
- Fixed in the land preparation: every bar-plan line prints (on the kitchen slip only when its till item is a kitchen dish, otherwise on the bar slip, bottled water included); one quantity bound (999,999) for the plan and its view, so a mistyped quantity cannot blank a party's plan.
- On the release day: the Health page's job:parties.slips line shows notCaughtUp and changesRebased and no burst of prints; one pos.party_slip_schedule_start row per live park; today's parties with no package whose 11:00 slip time has passed do not print by themselves (staff press "Print party slips now").
- Next: the staging proof; then LANE B2 (SCRUM-907, a manager or admin edits a party's kitchen plan on the till and the BEO is updated).

## Questions that stand after SCRUM-906 landed (these replace the sixteen above; the first of those, the price per item, is answered)
1. Should a cake marked EXTRA be charged at its BEO price? Today it is not charged.
2. A hand-typed EXTRA line with no price is not charged; it only prints for the kitchen, marked "not on the till menu". Right?
3. A BEO line saved before the SET/EXTRA badge existed counts as EXTRA, so it is charged if it has a price or a till code. Right?
4. A hand-typed EXTRA line with a price is charged under its own name at that price, as food (a kitchen line) or bar (a bar line). Right?
5. A till item added as EXTRA with no price is charged at the till's price for the party's day (the weekend price on weekends and holidays). Right?
6. A price of 0 on a till item's EXTRA line is treated as "no price", so the till's price is charged. Right?
7. An item made for one party (a PARTY- code) is charged at the till's price for it, even if the BEO line shows a different price. Right?
8. Only the SET/EXTRA badge decides what is charged; the AI fill's "included" mark is ignored. Right?
9. Drinks go to the bar slip by their till code. The set menu's uncoded Juice and Mors stay on the kitchen slip, marked, until someone codes them. A bar line coded as a kitchen dish prints on the kitchen slip. A bar line whose till item prints nowhere (bottled water) prints on the bar slip. Acceptable?
10. "Not on the till menu" also marks a line whose code the till no longer sells. Right?
11. Should "Own Cake" (the family's cake) print on the kitchen slip with its time and notes?
12. A party with a kitchen plan but no package prints its slips at 11:00. Is 11:00 right?
13. When several dishes are chosen in one choice group, each shows with no count. Right?
14. On the release day, a BEO change made in the minute around the switch is not sent as VOID/UPDATED, and a choice staff changed after the slips printed but before the release is taken as already printed. Accept both, with a reprint check that day?
15. On the release day, a party with no package whose slip time has already passed is not printed by the schedule; staff press "Print party slips now". Right?
16. Should the schedule ever skip a party that is already over? Today a party with a package entered after its slip time still prints at the next tick.
17. Older BEOs whose adults' list repeats the kids' list show every dish twice on the till, and a priced extra is charged twice. Should a repeated adults' list be skipped?
18. A set-menu dish staff deleted from the BEO comes back from the template on the till and the slip. Should it stay off?
19. The parent's link page now lists the choices as the team currently has them. Acceptable?
20. The till's party page re-reads the plan every minute and when the till comes back to the front, and pauses while Settle or Edit is open. Right?
21. The BEO PDF prints an EXTRA line's price as "120฿ each". Is that wording right?

## State, 12 November 23:47: LANE B2 is built and reviewed (SCRUM-907, 950, 951); land preparation running
- Lane partyedit907 (C:/oto-lanes/partyedit907-20261112, run wf_80dfdf8a-b3c, 13 commits, tip 1f617acaf before the rebase). No platform migration and no app migration. Its full report is in the planner's scratchpad, l907/build-report.json.
- Deploy order when it lands: the OTO App first (the new door POST /api/directory/events/:id/kitchen-plan and GET .../kitchen-plan/choices), then the platform (its pre-deploy sync gives branch managers the new permission pos:party:kitchen_update), then both tills. In the other order nothing breaks: the till says the BEO could not be changed.
- Fixed from the reviews: with "Different for adults" on, a count change or a removal on the till carries the adults' copy of the dish. Being fixed in the land preparation: the Settle form's new rows grouped like its other figures; a refusal reads the party again; the Kitchen card shows the BEO's own "needed" state; the combined Save's messages; a test of the platform's real calls to the door.
- Left for a follow-up ticket: a named extra's amount is price times count, not the engine's priced line (differs only where a park adds a service charge or exclusive VAT to food); on the release day every slip printed before it is taken as already printed; a kids' drink that prints at the bar gets the bar's service time.

### Questions for the owner from this lane
1. No existing permission is held by a manager and not by reception (pos:party:update is reception's too), so a new pos:party:kitchen_update was added for branch managers and admins only. Right?
2. The door uses the platform's existing OTO App directory key (events:write, tenant-bound) because the provisioning key only works app-to-platform. Acceptable?
3. A dish added on the till is written with no price, so Settle party charges the till's own price for the party's day (the weekend price on weekends). The BEO's own picker writes the weekday price onto the line instead. Should a till-added dish carry a price into the BEO (SCRUM-949)?
4. Food added on the till goes on the kids' list, as the BEO's '+ EXTRA' does. With 'Different for adults' on, it is marked 'kids only'. Should the till also offer the adults' list?
5. Only EXTRA lines can be removed on the till. A set-menu dish is refused because it comes back from the template. Right?
6. A choice changed on the till also changes the adults' own copy of that choice when 'Different for adults' is on, as the parent's submit keeps it. Right?
7. The till changes counts, notes, extras, set-menu choices and the cake's time and note only. The food and bar times, the cake's kind and count, the set menu template and a line's SET/EXTRA badge stay BEO-only. Right?
8. The 'changed on the till by …' record is in the Activity Logbook, not on the BEO page itself. Should the BEO page show it too?
9. Settle party: the Add-ons row now shows only the plan's own add-ons, and each kitchen extra is its own row. A ฿0 party-only item lists as '1 × ฿0 ฿0'. Right?
10. The new Settle rows use lib/bahtText.ts as the brief asked (ungrouped '฿1200'), while the form's existing figures use the grouped '฿1,200'. Which format should the form use throughout?
11. The bar slip prints the bar service time itself as READY BY, with no ready offset taken off. When the BEO has a bar time and no kids' food time, the bar slip still prints the bar time. Right?
12. On the release day every slip printed before the release is taken as already printed (composer 3), so a real BEO change made in the minute around the deploy is not sent as VOID/UPDATED. Accept, with a reprint check that day?
13. The phone till has no Edit form and no Settle view (the prototype has neither), so nothing was added there. Should the phone get the kitchen edit?
14. A party whose BEO was last saved before "Different for adults" existed and whose adults' list repeats the kids' dishes shows each dish twice on the till (the plan view's reading); the BEO editor reads the same BEO as one list; the first save, in the BEO or on the till, settles it. Should such older BEOs be re-saved in one go?

## State, 13 November 01:18: LANE B2 LANDED (SCRUM-907, 950, 951), main b229f96e2
- Nineteen commits; no platform migration, no app migration. Deploy order, running: the OTO App (the door POST /api/directory/events/:id/kitchen-plan and GET .../kitchen-plan/choices), then the platform (its pre-deploy sync gives branch managers pos:party:kitchen_update), then both tills. The counter box needs no release (slips are composed on the platform).
- Left and ticketed: SCRUM-966 (the BEO's "kitchen required" switch does not reach the till or the slips; the extras' amounts where a park adds a service charge; the release-day slip mark; a kids' drink at the bar; three older BEO editor points).

### Two more questions for the owner from this lane (they follow the fourteen above)
15. A till user can still add an extra after the party is settled, as the BEO already can; the kitchen makes it and nobody charges it. Should the till's kitchen edit be refused once a party is settled?
16. The BEO's own "Kitchen required" switch never reaches the till or the slips: a BEO switched to no kitchen service still prints its lines, and the till's card shows "needed" when the plan has food or a cake. Should the switch reach the till and the slips? It needs a change to the OTO App's plan view.
