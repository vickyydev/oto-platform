# SCRUM-827 — staging proof: the BEO opens fully pre-filled from the conversation in one pass

**When:** 11 November 2026, 15:00–15:24 Bangkok (08:00:08Z–08:23:49Z).
**Result: PASSED** — all nine steps of the build's own how-to-prove, the clean-up and the sign-out.

## The deploys

| Service | Live before the run | Live after the run |
|---|---|---|
| oto-app-staging | `dep-dbq1oa1srm7s73989fb0` at **9a29dc61** (live 07:43:55Z) | `dep-dbq257jncjis73cjl1jg` at 9a29dc61 (live 08:12:25Z) |
| oto-api-staging | `dep-dbq1chd9el5s73927b0g` at 17742781 (live 07:20:41Z) | `dep-dbq257rncjis73cjl29g` at 9a29dc61 (live 08:13:43Z) |
| oto-inbox-staging | `dep-dbq1ch59el5s73927as0` at 17742781 (live 07:17:28Z) | `dep-dbq2583ncjis73cjl3og` at 9a29dc61 (live 08:10:09Z) |

Main was at `9a29dc619` (the landing: three commits, app only — no api or inbox change; the full SHA is on the ticket).
The proof waited for the app to be live at it, then ran. During the run (08:10–08:13Z) all three services were
redeployed by someone else — the app on the same SHA, the api and the inbox moved from 17742781 to 9a29dc61 (a
docs-only difference for them). Steps 1–5 ran on the first app deploy, steps 6–9 on the second; both are 9a29dc61.

## How

One headless Chromium (Playwright) drove the inbox's and the app's own UI; every write went through a button of theirs;
API reads (`GET /api/events/:id/beo`, `/beo/timeline`, `/beo/kitchen-plan`, `/admin/events/:id`) are the record. The
staging administrator signed in through the launcher and was handed into the inbox (thread page + a second page for
the Simulator dialog) and into the OTO App (a second session: the roster and catalogue reads, the typed-before field,
the plain event, the read-backs, the clean-up). Two fresh ZZ TEST simulator numbers, never used before, wrote into
**Demo WhatsApp · Central Floresta** with the hint *Birthdays & Events*; the assistant was live and answered as
expected ("Thank you so much! Our birthday manager will be with you shortly." then a hand-over).

The party host named in the team's confirmation is a real member of the park's roster (read through
`GET /api/employees?branchId=<park>`: 44 active people, all with a nickname; the one chosen has a nickname that is
unique among every name the park's people carry — the fill's own matching rule). The name was held in memory only:
masked in every picture, replaced by `{HOST}` / `[name]` in `receipt.json`, never written here.

The catalogue named in the confirmation, read through the app's API: the package **Birthday package, Central Floresta**,
the set menu **Set Central** with the Pizza 1 choice **Hawaii**, the entertainment **Birthday entertainment program**.

The family's lines (thread F): "Hi! A party for ZZ Test Child turning 7, 12 kids and 4 adults, Saturday 21 November at
2pm (ZZ TEST)" and "We'd like the park's cake at 16:00, a unicorn theme, a treasure hunt for the kids, and no nuts
please (ZZ TEST)". The team's confirmation from the composer: "Confirmed: ZZ Test Child's 7th birthday party on
Saturday 21 November 2026, 14:00 to 16:30, 12 kids and 4 adults, Birthday package, Central Floresta, the Set Central
set menu with Hawaii, Birthday entertainment program, the park's cake at 16:00, booking name ZZ TEST, in the Party
Room. Setup ready by 13:30: balloon arch. POS: ZZ TEST 827 party. Party host: {HOST}. Deposit 3,000 THB asked. (ZZ TEST)".

## Results

| # | Step | Result | What was seen (exact lines) | Pictures |
|---|---|---|---|---|
| 1 | A fresh ZZ TEST chat, the team's confirmation, Book Date, Create BEO | **Pass** | Simulator: "Received: a new conversation, routed." / "Received into the existing conversation."; the composer's line sent (200, `authorKind: staff`). Book Date read "Read the whole chat": Date 2026-11-21 — The chat says "Saturday 21 November 2026" *from the team*; Start 14:00 — "14:00 to 16:30"; 12 kids, 4 adults, ZZ Test Child, turning 7. `POST …/book-date` 200 → event "ZZ Test Child's 7th Birthday", Tentative; the note "Event: 21 Nov 2026 at Central Floresta · tentative in the Events calendar"; the buttons Date Booked, Create BEO. Create BEO: `POST …/open-beo` 200 (aiFill asked), the app's `POST /api/auth/handoff` 200, `POST /api/events/:id/beo/ai-fill/inbox` 200 in 19.7 s (3 messages read, origin inbox, the ruling = the team's confirmation). | 01, 02 |
| 2 | ONE review dialog with every section filled and marked | **Pass** | "AI Fill — Review, edit and approve"; header "3 messages read; the team's confirmation from [name] wins where the family and the team both speak." and the legend *from the team · from the family · the park's default · changed here*. **Event Info:** Title "ZZ Test Child's 7th Birthday" **the park's default**; Child "ZZ Test Child" from the team (the confirmation repeated the child's name: the latest line wins); Date "Sat 21 Nov 2026 — the message says "Saturday 21 November 2026"" + "The same day the event is booked for."; Children 12, Adults 4, Start 14:00, End 16:30 — all *from the team*; Booking name held "ZZ TEST 827 family" with `The chat says "ZZ TEST"` *from the team* + **Use the chat's** beneath; Location "Party Room, Central Floresta" *from the team*; Activities held "ZZ typed: face painting" with `The chat says "…"` *from the family · from the team* + Use the chat's beneath; Decoration "a unicorn theme / balloon arch" *from the family · from the team*; Special requests "no nuts please" **from the family**. **Team:** Party Host: [the roster's label] — the message says "[name]". Tick to assign. *from the team*, with a tick box. **Package:** Birthday package, Central Floresta *from the team*, "Catalogue ฿16,900 / ฿20,900", the five add-ons at 0. **POS:** POS name "Birthday package" *from the team*; three Included lines (Set Central set menu with Hawaii; Birthday entertainment program; Park's cake) each *from the team*; POS notes "POS: ZZ TEST 827 party. Deposit of 3,000 THB requested." *from the team*. **Setup Plan:** Ready by 13:30 *from the team*; Who empty; task "Balloon arch" *from the team*. **Kitchen Plan:** Set menu Set Central *from the team*; Pizza 1: Hawaii *from the team* (match line "Hawaii"); the other groups "Not chosen yet"; Cake "The park's cake", notes "the park's cake", 16:00 *from the team*. **Entertainment:** Birthday entertainment program × 1 *from the team*, "Catalogue ฿3,000". **Timeline:** 13:30 Setup ready by · 14:00 party start · 16:00 the park's cake · 16:30 party end, each *from the team*; "The park's own steps (guests arrive, the setup, the cake, the food) are added from the BEO when you approve." **from a template**. **Deposit asked:** 3000 THB, Received unticked *from the team*. The footer: "Approve and create also puts the team's confirmation, word for word, in Final Message to Parent." and "Approve and create writes the event's name and details, the counts, the times, the date when ticked, the package, the kitchen plan, the bar, the entertainment, the setup plan, the POS box, the timeline's steps, the team you ticked and the deposit — everything above, in one go. Nothing opens after it; a field the BEO already holds keeps its value unless you take the chat's." Buttons: Load into Editor instead / Approve and create (enabled). | 03-top, 03-middle, 03-lower |
| 3 | Nothing typed is overwritten | **Pass** | Before Create BEO, "ZZ typed: face painting" was typed into Activities through the form and saved (`PUT /api/events/:id/beo` 200). The review kept it in the field with the chat's words offered beneath. On the Booking name row (held "ZZ TEST 827 family", `The chat says "ZZ TEST"`, **Use the chat's**) the button was pressed once: the field became "ZZ TEST" marked *from the team*, the offer gone. Activities stayed as typed and the approval sent no `activities` (nobody's line); the read-back holds "ZZ typed: face painting". | 06-before, 06 |
| 4 | Tick the host, Approve and create ONCE, no second dialog, the form marked, an edit says "changed here" | **Pass** | The host's box ticked; one press → `POST /api/events/:id/beo/ai-fill/approve` 200; the body carried 28 sources (team 26, default 1 — the title, family 1 — the special requests), `details` with bookingName, locationText, specialRequests, decoration, setupReadyBy, posName, posNotes, 1 setup task, 3 POS items, 4 timeline steps, team.partyHost (employee, the chosen host); the answer `written`: event, package, setMenu, choices 1, cake, entertainment 1, setup, setupTasks 1, team 1, pos, posItems 3, timelineLines 4, deposit; `notWritten` none. The toast: "BEO created from the conversation — Saved: the event's name and details, …, the team you ticked and the deposit." The review closed; no "Review & Confirm" text, no preview confirm button, no AI Fill dialog (one dialog left: the editor's own sheet). The form: every chat section wears **from the chat** (Event Info, Party Host, Birthday Package, POS, Setup Plan, Kitchen Plan, Timeline); Title *the park's default*; Special Requests *from the family*; Decoration, Child, Booking Name, Start/End Time, Location, Expected Kids/Adults, Assigned Party Host (Employee: [name]), the package *from the team*; Activities (typed) wears no mark; Final Message to Parent holds the confirmation word for word. Decoration edited to "ZZ edited: unicorn theme, pastel balloons" → its mark reads **changed here**; Special Requests keeps *from the family*. | 07, 08 |
| 5 | Reopen (reload) and read through the API | **Pass** | `GET /api/events/:id/beo` 200: title "ZZ Test Child's 7th Birthday", bookingName "ZZ TEST", locationText "Party Room, Central Floresta", activities "ZZ typed: face painting", decoration "a unicorn theme\nballoon arch" (the unsaved edit of step 4 reverted, as expected), specialRequests "no nuts please", 12 / 4, 14:00–16:30; partyDetails packageName "Birthday package", items Set Central set menu with Hawaii / Birthday entertainment program / Park's cake, notes "POS: ZZ TEST 827 party. Deposit of 3,000 THB requested."; partyHost assigned = the chosen host; packageSnapshot "Birthday package, Central Floresta" (11 items); kitchenPlan cakeMode INTERNAL, cakeTime 16:00, set menu Set Central; billing depositAmount 3000, depositPaid false; setup plan row present (ready by 13:30 on the form, task "Balloon arch"). `GET …/beo/timeline` 200, 7 lines: −30 Balloon arch (auto), −30 Setup ready by, 0 Guests arrive (auto), 0 party start, 120 Cake moment (auto), 120 the park's cake, 150 party end. The reloaded form shows all of it; the session's marks are gone after a reload (see findings). | 09 |
| 6 | The no-start-time case | **Pass** | Thread G: "…a birthday for ZZ Test Child turning 6 on Sunday 22 November, 10 kids and 3 adults. We have not decided the start time yet, but we want the park's cake at 16:00"; the team's confirmation named the date, counts, package, cake and host — no time. Book Date's own rule is "Enter the start time as HH:MM." (it proposed 16:00, the cake's time, as the start: `The chat says "at 16:00"`), so 10:00 was typed in the dialog's Start time and the date booked (event "ZZ Test Child's 6th Birthday", 22 Nov). The start was then cleared through the app's own event route (`PATCH /api/admin/events/:id {startTime: ""}` 200; read-back ""). Create BEO → the review: Start empty, the chat's step "16:00 the park's cake" *from the team*. Approve and create (host ticked) → 200; the answer `written.timelineLines: 0`, **`notWritten.timeline: { reason: "no_start_time", message: "the party has no start time yet", steps: [16:00 the park's cake] }`**; the toast read "… Not written: the timeline's step (16:00 the park's cake) — the party has no start time yet. Set the start time, then add them to the Timeline." Create BEO again → the review (replaces: "This BEO already has its package, kitchen plan: approving replaces what the review fills."); Start set to 10:00 in the review's own field; approve → 200, `event.startTime: "10:00"` sent, `written.timelineLines: 1`, no notWritten. `GET …/beo/timeline`: 0 Guests arrive (auto), 360 Cake moment (auto), 360 the park's cake — the chat's step placed. | 11 |
| 7 | The pasted-message path | **Pass** | "ZZ TEST 827 pasted party" (a plain birthday BEO at Central Floresta, created through `POST /api/admin/events`, 23 Nov 13:00–15:00). "ZZ typed: a quiet corner, please" typed into Special Requests and NOT saved; AI Fill → the team's confirmation pasted → Parse with AI → `POST /api/ai/parse-beo` 200 in 16.1 s, origin **pasted**; the paste dialog gone, the same one review open: "Read from the pasted message — The pasted message is read as the team's confirmation and matched to the park's catalogue." legend *from the team · the park's default · changed here*. Title held "ZZ TEST 827 pasted party" with **`The park's default is "ZZ Test Child's Birthday"`** *the park's default* + **Use the park's default** beneath (never "The chat says"); Special requests held "ZZ typed: a quiet corner, please" (no offer: the chat's "no nuts" was not in the pasted line); Booking name ZZ TEST, Location, Activities "Birthday entertainment program", Decoration "balloon arch", Child, 12 / 4, 14:00–16:30, the host row, the package, Set Central, cake 16:00, 4 timeline steps, deposit asked 3000 — all *from the team*; the date row "The event is booked for Mon 23 Nov 2026: not the same day." with its tick left unticked. Approve and create once (host ticked) → 200, 27 sources all team, `details.specialRequests: "ZZ typed: a quiet corner, please"` (typed, unsaved: written by the one pass), no `title` (the BEO's own name kept); written: event, package, setMenu, choices 1, cake, entertainment 1, setup, setupTasks 1, team 1, pos, posItems 3, timelineLines 4, deposit. Toast "BEO created from the pasted message — Saved: …". No second dialog. The form: all seven chips, Activities/Decoration/Child/Booking Name/times/Location/counts *from the team*, Special Requests unmarked (nobody's line), the host assigned. Read-back: specialRequests "ZZ typed: a quiet corner, please", title unchanged, 7 timeline lines, deposit 3000 asked. | 13-top, 13-middle, 13-lower, 14 |
| 8 | Empty wording | **Pass** | The plain BEO before any fill, Party Host / POS / Setup Plan / Timeline expanded: "No line items yet. Click to add the first." · "No setup tasks yet. Click to add the first." · "No timeline steps yet. Click to add the first." · "No entertainment acts yet. Add one and give it a time to put it on the Timeline."; "Click here to add first" nowhere on the page; no "from the chat" chip; no lorem. | 12 |
| 9 | Fetch from chat still works on the filled BEO | **Pass** | A new family line on thread F: "one more adult is coming, so 5 adults please (ZZ TEST)". The BEO reopened from the thread (Create BEO: the fill ran again, 4 messages; its review closed with Escape — no approval sent). Fetch from chat → the warning ("This reads the conversation again, as it is now, and may change details typed in this form…"), Read the chat → "Reading the whole conversation…" → `POST …/beo/ai-fill/inbox` purpose **fetch** 200 (20.1 s) → "1 change from the chat": **Adults: 4 → 5** *from the family* (Accept / Decline); no title row; Cancel → the form keeps 4. | 15 |

## Findings

1. **No defect of SCRUM-827 seen.** Every section the chat gives was proposed, marked, approved in one pass, written and read back; the pasted path, the typed-text rule, the no-start-time answer and Fetch from chat all behaved as the build describes.
2. **The marks are session-only.** After a reload the form shows the values without their marks and chips (step 5). That is the ticket's open decision 2 ("persist the marks so a reopened BEO still shows them, or is the review plus the log enough?"), not a defect — noted so the owner sees it on staging.
3. **A party cannot have no start time through the UI.** Book Date requires "Enter the start time as HH:MM."; the BEO form's own clear (×) on Start Time followed by Save did not persist (`PUT …/beo` 200, the read-back still 10:00); `PATCH /api/admin/events/:id {startTime: null}` answers 500 (`core_events.start_time` is NOT NULL); only an empty string clears it. The no-start-time branch of SCRUM-827 therefore works (proved with the empty string) but is hard to reach by hand. Two side findings for a ticket: the form's cleared start time is not saved; the event route 500s on null.
4. **Book Date read the cake's time as the start.** With no party time in the chat, the dialog proposed Start 16:00 with `The chat says "at 16:00"` (no source mark) — the cake's time. The BEO review itself did not (Start empty). An observation for the Book Date reader, outside 827.
5. **The model's reading of the chat, where it was loose:** the Activities offer folded the form's typed text and the entertainment line into "a treasure hunt for the kids ZZ typed: face painting; Birthday entertainment program"; Decoration got "balloon arch" (the setup task) beside "a unicorn theme"; the POS name came out as "Birthday package" with "POS: ZZ TEST 827 party…" in the notes. None overwrote a held value; all are the model's words to check in the review, as the build intends.
6. **The chat's timed steps are written as their own lines beside the park's auto steps** ("party start" beside "Guests arrive", "the park's cake" beside "Cake moment"): a pair of near-duplicates per step. As designed ("never twice" is by label) — worth a look at whether a chat step that names the cake should fold into the auto cake step.
7. The child is marked *from the team* when the team's confirmation repeats the child's name (the latest line wins, SCRUM-826's rule); the family's mark shows only where the family's line is the last word (special requests, the adults change of step 9).
8. The pasted path's park's default read "ZZ Test Child's Birthday" without an age because the plain BEO had no turning age.
9. All three staging services were redeployed by someone else during the run (see the deploys table); the app's SHA did not change.

## Clean-up

Through the app's own archive route `POST /api/admin/events/:id/archive {archived: true}` (each 200, read back `isArchived: true`):
"ZZ Test Child's 7th Birthday" (thread F), "ZZ Test Child's 6th Birthday" (thread G), "ZZ TEST 827 pasted party".
No ZZ TEST event left live at Central Floresta. Both ZZ TEST threads marked handled through
`POST /api/inbox/conversations/:id/handle` (200; read back `handled`). No SMS, no payment, no real person's record touched.

## Sign-out

Every session signed out and read back 401 — twice, because the driver was restarted once mid-run (its step library
had changed) and the first sessions were signed out before the restart: the inbox (`POST /api/auth/sign-out` 200 →
`GET /api/inbox/me` 401), the BEO tab's app session (`POST /api/logout` 200 → `GET /api/user` 401), the launcher
(`POST /api/auth/sign-out` 200 → `GET /api/me` 401), and the app session likewise (401, 401). Times 08:16:52Z and 08:23:49Z.

## Files

`receipt.json` — routes, statuses, ids and the exact UI lines, scrubbed (no name, no phone, no key; both files checked
for digit runs of nine or more and for a Thai country prefix; git SHAs are kept to eight characters). Pictures: names and initials masked, the simulator number boxed
(07–09 post-masked over the WhatsApp field), the events board behind the editor sheet hidden.

| Picture | Shows |
|---|---|
| 01-step1-book-date-dialog.png | Book Date as it read thread F |
| 02-step1-date-booked.png | The thread after Book date: the note, Date Booked, Create BEO |
| 03-step2-review-top/middle/lower.png | The one review, part by part |
| 06-step3-use-the-chats-before.png / 06-step3-use-the-chats.png | The Booking name row before and after "Use the chat's" |
| 07-step4-form-marks.png | The form right after Approve and create, each field marked |
| 08-step4-changed-here.png | Decoration edited: "changed here" |
| 09-step5-reopened-form.png | The BEO reopened after a reload |
| 11-step6-steps-placed.png | Thread G's BEO after the second approval: the chat's step placed beside the auto steps |
| 12-step8-empty-words.png | A BEO nobody filled: the plain empty lines |
| 13-step7-pasted-review-top/middle/lower.png | The pasted-message path's review, the title offered as the park's default |
| 14-step7-pasted-approved.png | The form after the pasted message was approved |
| 15-step9-fetch-rows.png | Fetch from chat on the filled BEO: "Adults: 4 → 5" |
