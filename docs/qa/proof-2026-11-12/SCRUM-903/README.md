# SCRUM-903 — staging proof: BEO AI Fill runs on the whole conversation and shows the chat's words for every value (Phase A)

**When:** 12 November 2026, 15:38–16:39 Bangkok (08:38Z–09:39Z). The run was interrupted at about 16:01 and resumed at 16:15 with the same driver, sessions and work file; nothing was duplicated (thread B's first line was sent just before the interruption and was reused).
**Result: all seven points PASS.** Defects and Phase B misses below.

## Deploys (`deploys.json`)

| Service | Before the run | After the run |
|---|---|---|
| oto-app-staging | `dep-dbqng2psrm7s73deor4g` at **4cdcf5d1b** (live 08:30:19Z, pre-deploy migrations passed) | `dep-dbqnogd9el5s73f4mbbg` at **4cdcf5d1b** (live 08:46:46Z — redeployed by someone else, same commit) |
| oto-inbox-staging | `dep-dbqjk93bc2fs73dj0mpg` at dc5f5513c | `dep-dbqnogl9el5s73f4mc8g` at 4cdcf5d1b (08:45:00Z; no inbox code change between the two) |
| oto-api-staging | `dep-dbqnj10n74is73co4us0` at 7cb06ac6c (POS/console work, live 08:37:44Z) | unchanged |

Every AI Fill of this proof ran on `dep-dbqnogd9el5s73f4mbbg` (4cdcf5d1b).

## How

The SCRUM-827 harness (one headless Chromium, the inbox's and the OTO App's own UI; `proof.mjs` holds every script): the staging administrator signed in through the launcher and handed into the inbox and the OTO App. Three fresh ZZ TEST conversations on the simulator channel **Demo WhatsApp · Central Floresta** (invented numbers never used before):

* **A — the owner's case, only the family writes** ("ZZ TEST 903 family only"): (1) a party for ZZ Test Lina turning 6, Saturday 5 December 14:00–16:30, 12 kids and 8 adults; (2) the Birthday package, Central Floresta, a Hawaiian pizza (on the park's set menu) and a durian pizza (on no menu) for the kids, chicken fried rice for the adults, the Bubble show, a dinosaur theme with green balloons, a peanut allergy; (3) the park's chocolate cake at 16:00 and "We already transferred the 3,000 baht deposit this morning"; later (4) "one more adult … 9 adults". No team message at all.
* **B — with the team's confirmation** ("ZZ TEST 903 confirmed family"): one family line, then the team's "Confirmed: ZZ Test Niko's 8th birthday party on Sunday 6 December 2026, 11:00 to 13:30, 15 kids and 6 adults, Birthday package, Central Floresta, the Birthday set menu, Central Floresta with Margherita pizza, Face painting, the park's cake at 12:30, booking name ZZ TEST Niko, in the Party Room. Deposit 3,000 THB asked." from the inbox composer.
* **C — empty**: a contact made with the inbox's own New contact dialog (a record only), moved to Birthdays & Events with the header's team picker, the date typed by hand in Book Date.

## Results

| # | Point | Result | What was read back | Pictures |
|---|---|---|---|---|
| 1 | The owner's case | **PASS** | Book Date read the family's lines (5 Dec, 14:00, 12/8, ZZ Test Lina, 6). Create BEO → `POST /api/events/:id/beo/ai-fill/inbox` **200** in 25.6 s, 3 lines read, `ruling: null`, `source: null`. The review opened (no "AI Fill did not run"). Header: "Nothing is confirmed by the team yet: no message of the team's names the date, the time and the party details. Every value is what the chat says so far — check each one before approving." and "Under each value, the chat's own words for it, whose line they are and when it was written." No "Load into Editor instead", no Final Message line. Pre-filled, all *from the family*: Child, Children 12, Adults 8, Start 14:00, End 16:30; Decoration "For decoration a dinosaur theme with green balloons please"; Special requests "One of the kids is allergic to peanuts"; Package "Birthday package, Central Floresta" (฿16,900 / ฿20,900); Set menu "Birthday set menu, Central Floresta"; Pizza → **Hawaiian** ("a Hawaiian pizza → Hawaiian (CF-27)"); **"a durian pizza" as a highlighted "Not in the menu" line** with Keep as a free line / Leave out; Adults "chicken fried rice → Fried rice (Veggie) (CF-43)" (see defect 1); Cake "The park's cake", "the park's chocolate cake", 16:00; Entertainment **Bubble show** ×1; Timeline 16:00 cake; Deposit asked 3000. Under **every** filled value: The chat says “…” · *from the family* · Thu 12 Nov 15:39/15:40 (16 reason lines; no family/team mark without one). Approve and create disabled: "Decide the 1 line the catalogue does not have before approving." | 01, 02, 03-top, 03-middle, 03-lower |
| 2 | Approve with the undecided line decided | **PASS** | Before approval (`GET /api/events/:id/beo`, `/kitchen-plan`, `/timeline`): decoration, special requests, package, kitchen plan, entertainment, timeline and billing all empty; one activity row "AI Fill read the inbox conversation for the BEO of …" with counts only (`ruling: false`), none of the chat's words. Durian line → Keep as a free line; Approve enabled; one press → `POST …/ai-fill/approve` **200**, written: event, package, setMenu, choices 1, kitchenLines 2, freeKitchenLines 1, cake, entertainment 1, timelineLines 1, deposit; 17 sources (16 family, 1 default). Read back: endTime 16:30, decoration and special requests as above, package snapshot "Birthday package, Central Floresta" (11 lines), kitchen plan INTERNAL 16:00 "the park's chocolate cake", kids menu Hawaiian (Pizza) + the set's always-included items + "a durian pizza" (Not in the menu), adults menu … + "Fried rice (Veggie)" CF-43, entertainment selection Bubble show, timeline Guests arrive (auto) / Cake moment (auto) / cake. The reloaded form shows it (08–12). The approval's activity row holds catalogue names and counts only. | 04, 06, 07, 08, 09, 11, 12 |
| 3 | The deposit guard | **PASS** (review and write) | The review row reads **"Deposit asked"**, 3000 THB, **Received not ticked**, with the family's line under it. After approval: billing `depositRequired: true, depositAmount: 3000, depositPaid: false, depositPaidAmount: null`; the event's `prepaymentAmount: null`; the form's Billing says Deposit paid ฿0, Financial Summary NOT PAID. (Fetch from chat does still offer it as received — defect 2.) | 05, 10 |
| 4 | With the team's confirmation | **PASS** | Book Date read the team's line (6 Dec, 11:00, 15/6, ZZ Test Niko, 8). Create BEO → 200 in 14.2 s, 2 lines read, the ruling = the team's line (line 2). Header "2 messages read; the team's confirmation from ███ wins where the family and the team both speak."; Load into Editor instead present; "Approve and create also puts the team's confirmation, word for word, in Final Message to Parent." Every value *from the team* with the chat's words under it (Date row in its own older wording, see defect 4); Booking name kept with "The chat says "ZZ TEST Niko" · Use the chat's"; Location "Party Room, Central Floresta", Activities "Face painting", POS name/3 items/notes, Margherita (CF-24), cake 12:30, Face painting, timeline 11:00/12:30/13:30, deposit asked 3000. Approve → 200 (21 team sources); read back: Final Message to Parent (`internalStaffNotes`) **equals the team's line word for word**; billing deposit 3000 not paid. | 15, 16-part1..3, 17 |
| 5 | Fetch from chat on an existing ZZ TEST BEO | **PASS** | On A's approved BEO after the family's "9 adults" line: `purpose: fetch` 200 in 29.9 s; "3 changes from the chat" (Adults 8 → 9; Deposit — → ฿3,000; Deposit date — → Thu 12 Nov 2026) and "2 changes to the package, menu or entertainment" (Set menu · Fried rice — → Chicken; Kids menu — → a durian pizza for the kids (not on the menu)). **Every row** carries The chat says “…” · *from the family* · its time. Cancelled: nothing applied. | 14 |
| 6 | An empty conversation | **PASS** | Thread C: 0 messages; Book Date "The chat names no date / no start time" (the api logged `NO_LINES`, no model call); typed 7 Dec 10:00 → event "ZZ Test Mika's 5th Birthday". Create BEO → `POST …/ai-fill/inbox` **409** `reason: no_conversation`, and the BEO shows "AI Fill did not run: the conversation has no messages to read yet." | 18, 19 |
| 7 | Reliability | **PASS — 3 of 3** | Point 1's conversation filled three times: #1 Create BEO (review), #2 the deep link `?beo=…&fill=inbox` (review, 22.4 s, with "This BEO already has its package, kitchen plan, entertainment, deposit: approving replaces what the review fills."), #3 Fetch from chat (list). All three `outcome: filled`; the app's log lines and activity rows carry **no `attempts` field: the retry was never needed**. #1 and #2 gave the same values (only the timeline steps and the dish wording differed). | 03, 13, 14 |

## Chat details the review did not pick up (for Phase B)

1. **The party date** (A: "Saturday 5 December"): no date row in the family-only review (the date row comes from the ruling read). Book Date had set it.
2. **The child's turning age** (A: "turning 6"): no age row in the review (B neither); the age on the event is Book Date's.
3. **The adults' dish as a set-menu choice**: reviews #1 and #2 made "chicken fried rice for the adults" an Adults menu line matched to Fried rice (Veggie); the set menu's own Fried rice group stayed "Not chosen yet" (Fetch from chat read it as Fried rice → Chicken).
4. **The allergy into its own place**: it went to Special requests (the form's placeholder suggests that is intended; the BEO record also has an `allergiesNotes` field that stays empty).
5. With no ruling, **booking name, location, setup, POS box and hosts** are not read (the family gave no booking name or room here, so nothing was lost in this run) — as the build says.

## Defects and observations (steps)

1. **Wrong dish written for "chicken fried rice" (medium).** Thread A, line 2 "… chicken fried rice for the adults …" → Create BEO: the review shows "chicken fried rice → Fried rice (Veggie) (CF-43)"; Approve writes the adults' menu line "Fried rice (Veggie)", code CF-43 (read back). CF-43 is the set menu's code for all three fried-rice options, and the first option's name is shown and written. Seen in both reviews (#1, #2). Pre-dates 903 (the food-by-code match), surfaced by the owner's kind of chat.
2. **Fetch from chat offers the family's "already transferred" deposit as received money.** Thread A after approval → Fetch from chat → row "Deposit: — → ฿3,000" (field `prepaymentReceived`) and "Deposit date: — → Thu 12 Nov 2026", both *from the family*, with Accept / Accept all. One Accept would mark a family claim as received. Not accepted in this run. The fix round named this for Phase B / SCRUM-844 (deposit asked vs received).
3. **The reason line often does not contain the value's words when they come from a long team confirmation.** Thread B: Location, Activities, Booking name, POS name, the three POS items, POS notes, Deposit and two timeline steps all quote the first 120 characters of the team's line ("Confirmed: ZZ Test Niko's 8th birthday … 15 kids and 6 adults, Birthday…"), which stops before "Party Room", "Face painting", "Deposit 3,000 THB". By the build's rule (whole line clipped), but to a reader it is no reason.
4. **The Date row keeps the older wording** ("— the message says "Sunday 6 December 2026"", no time) while every other row says The chat says “…” · time.
5. **The show the review writes is nowhere in the BEO editor** (pre-existing): Bubble show / Face painting are written as entertainment selections; the editor's Birthday Package section shows none (the package module's entertainment part is never mounted in the editor) and Party Host → Entertainment Acts still says "No entertainment acts yet". Only Billing's till list shows "Bubble show ฿5,500". The owner checking "entertainment pre-filled" on the form will not find it (06, 09, 10).
6. The approval toast always lists "… the setup plan, the POS box, … the team you ticked …" even when none of those was written (thread A wrote no setup, POS or team).
7. Kitchen Plan after the AI approval shows the green **"Selections received · Received 12/11/2026"** although no parent answered the menu link (four groups still "pending parent selection") (11).
8. Billing's "Deposit from the family's chat" box says "No deposit asked yet" with 3000 in "Deposit to ask", while the BEO already holds deposit asked 3000 (10).
9. Timeline near-duplicates (known since SCRUM-827): auto "Cake moment" and the chat's "cake" at the same 16:00 (12).
10. Set menu's reason (thread A) quotes the package's words "Birthday package, Central Floresta", because the set menu came with the package.
11. Outside 903: the inbox ran the Book Date model read **twice, ~4 s apart, on each thread open** (api log `inbox.book_date_proposal`: A 5 reads, B 3 reads). Staging also hung several requests for the full 120 s that answered in 0.1 s at once on retry (`GET /api/admin/events?range=all`, `/api/activity-logs`, `GET /api/inbox/conversations/:id`, one `POST …/archive` that did not land and was repeated).

No untranslated word or raw key was seen (English threads). Page errors: none besides Radix's "`DialogContent` requires a `DialogTitle`" console warning on a plain reload of each BEO; no failed API call.

## Model calls caused

AI Fill: 5 (A ×3 conversation reads, B ×2 — form read + conversation read; C refused before any call), retries 0. Book Date reads: 8 (A 5, B 3; C's two were `NO_LINES`, no call). Inbox assistant: 2 turns (the hand-over greeting on A and on B). **15 model calls in all.**

## Clean-up and sign-out

Archived through `POST /api/admin/events/:id/archive {archived: true}` and read back `isArchived: true`: ZZ Test Lina's 6th Birthday (A), ZZ Test Niko's 8th Birthday (B), ZZ Test Mika's 5th Birthday (C). Conversations A, B, C marked handled (`POST /api/inbox/conversations/:id/handle` 200; read back `handled`, event archived). Left: the contact "ZZ TEST 903 empty chat" (the inbox has no delete route for contacts) and the three handled ZZ TEST threads, as earlier proofs left theirs. A live "ZZ Test Child's 7th Birthday" (28 Nov) at Central Floresta was there before this run and is not this proof's. Every session signed out and read back 401 (inbox, the BEO tab's app session, launcher, the app session).

## Files

`receipt.json` (routes, statuses, ids, the exact review lines, scrubbed; no name, no phone, no key), `deploys.json`, `proof.mjs` (the harness). Pictures: staff names and initials masked with solid boxes, the simulator numbers masked, the events board behind the editor hidden.

| Picture | Shows |
|---|---|
| 01-p1-book-date-read-the-family-lines.png | Book Date reading only the family's lines |
| 02-p1-thread-family-only-date-booked.png | Thread A: family lines only, Date Booked, Create BEO |
| 03-p1-review-top/middle/lower.png | The family-only review, every value with The chat says |
| 04-p2-kitchen-plan-durian-kept-as-free-line.png | The durian pizza kept as a free line; Hawaiian matched; the fried-rice match |
| 05-p3-deposit-asked-received-not-ticked.png | Deposit asked 3000, Received not ticked, the family's words |
| 06-p2-form-after-approve.png / 07-p2-toast-after-approve.png | The form right after Approve and create; the toast |
| 08…12-p2/p3-reloaded-form-*.png | The reloaded form: Event Info, Birthday Package, Billing (deposit ฿0 paid), Kitchen Plan, Timeline |
| 13-p7-fill2-review-part1.png | The second fill (deep link): the review again, with the replaces line |
| 14-p5-fetch-from-chat-rows.png | Fetch from chat: every row with The chat says |
| 15-p4-book-date-team-confirmation.png | Book Date on thread B reading the team's line |
| 16-p4-review-team-confirmed-part1..3.png | The review with the ruling: the chat's words under each row |
| 17-p4-reloaded-form-final-message-to-parent.png | Final Message to Parent holds the team's line |
| 18-p6-empty-thread-date-booked.png | The empty thread after Book Date |
| 19-p6-empty-chat-ai-fill-did-not-run.png | "AI Fill did not run: the conversation has no messages to read yet." |
