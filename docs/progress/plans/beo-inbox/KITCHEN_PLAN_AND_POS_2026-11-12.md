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
