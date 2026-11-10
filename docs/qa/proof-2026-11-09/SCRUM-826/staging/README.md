# SCRUM-826 Refresh in Book Date: staging proof

**Result: FAILED** on the BEO form's steps 6 and 7 (the whole-conversation
reading is not stable between two presses on an unchanged chat); the Book
Date half (steps 1–3), the BEO form's steps 4, 5, 8 and 9, the clean-up and
the sign-out passed. Nothing was walked in Jira.

> **Re-checked after the fix (463fac2a6) on 11 November, 04:40–04:54 Bangkok:
> PASSED.** See "Re-check after the fix" at the end of this file and
> `receipt-recheck.json`.

## When, where, how

Run on 11 November 2026, 03:50–04:04 Bangkok (`20:50–21:04Z` in
`receipt.json`). Live throughout (recorded before and after, unchanged):

| Service | Deploy | Commit |
|---|---|---|
| oto-inbox-staging | `dep-dbpo03nf3r2c738oslag` | `820c3fa4c73e1201b3d6e27f1396603c52205f02` |
| oto-app-staging | `dep-dbpo03vf3r2c738osm10` | `820c3fa4c73e1201b3d6e27f1396603c52205f02` |
| oto-api-staging (untouched by this change) | `dep-dbpnlerrjlhs73bsbgeg` | `eaf9ad0c54957c2722b486d26054e49e9bd88dc5` |

The staging administrator, signed in through the launcher and handed into
the inbox (one tab for the thread, one for the Simulator dialog) and, in a
second session, into the OTO App. Headless Chromium, Asia/Bangkok. Every
line of the family came through the inbox's own Settings › Simulator · test
only dialog into "Demo WhatsApp · Central Floresta" from one fresh ZZ TEST
number with the Category hint Birthdays & Events; the team's one line
through the inbox composer. The assistant was live on that account (it
replied to the opener and handed over to the team; its lines are not read by
any fill). Names, initials and every phone-like number are masked in the
pictures; the receipt holds routes, statuses, ids and the exact lines seen.

## The thread

Conversation `01a1c739-f54e-751b-ac5f-1d20612c6bf6`, "ZZ TEST 826 family",
English:

1. family: "Hi! A party for ZZ Test Child turning 7, 12 kids and 4 adults, Saturday 21 November at 2pm (ZZ TEST)"
2. family: "now 15 kids and 6 adults, let's start at 3pm (ZZ TEST)"
3. team: "Confirmed: ZZ Test Child's 7th birthday party on Saturday 21 November 2026 at 15:00, 15 kids and 5 adults, Birthday package Central Floresta, the park's cake at 15:30. (ZZ TEST)"
4. family: "ok, 6 adults and the cake at 16:00 (ZZ TEST)"
5. family: "great, see you then! (ZZ TEST)"
6. family: "actually no cake, thanks (ZZ TEST)"

## A. Book Date (the inbox)

| Step | What was pressed | What showed | Result | Picture |
|---|---|---|---|---|
| 1 | Line 1 sent; the thread opened; **Book Date** | "Read the whole chat" after 5.4 s (`GET …/book-date-proposal` 200). Date `2026-11-21` "The chat says “Saturday 21 November” from the family"; Start time `14:00` "“at 2pm”"; Park Central Floresta; Kids `12` "“12 kids”"; Adults `4` "“4 adults”"; Child's name `ZZ Test Child`; Turning `7` "“turning 7”"; the header row reads "READ FROM THE CHAT · Read the whole chat · Fetch from chat" (the button's title: "Read the chat again as it is now. What you typed here stays.") | Pass | `01-book-date-read-from-chat.png` |
| 2 | Adults typed `5` (hint still "“4 adults”"); line 2 sent through the Simulator on the other tab; **Fetch from chat** pressed at once | The button read "Fetching from the chat…" and was disabled while it read (3.3 s, `GET …/book-date-proposal` 200). After: Kids `15` "The chat says “15 kids” from the family"; Start time `15:00` "“start at 3pm”"; Adults still `5`, its hint now "The chat says “6 adults” from the family"; date, child and age unchanged. The line under the button: **"Filled from the chat: start time, number of kids · kept what you typed: number of adults."** | Pass | `02-book-date-fetch-filled-kept-adults.png` |
| 3a | **Fetch from chat** again, no new line | "Fetching from the chat…" (3.4 s, 200), every field as before; the line: **"Nothing new in the chat · kept what you typed: number of adults."** | Pass | `03-book-date-fetch-nothing-new.png` |
| 3b | **Book date** | `POST …/book-date` 200 with date `2026-11-21`, `15:00`, kids 15, adults 5, the child, age 7, Central Floresta. Event `01a1c73a-5e1a-74ef-ada8-26b187cca18c` "ZZ Test Child's 7th Birthday", Tentative; the note "Event: 21 Nov 2026 at Central Floresta · tentative in the Events calendar"; the chip "Event: 21 Nov 2026 at Central Floresta"; the buttons now Date Booked and Create BEO | Pass | `04-date-booked.png` |

How the BEO was created from this chat (the SCRUM-815 path): the team's
confirmation (line 3) sent from the composer (`POST …/messages` 200, author
staff, sent); **Create BEO** on the thread → `POST …/open-beo` 200 (aiFill)
→ a new tab, the OTO App's `POST /api/auth/handoff` 200 → the BEO editor on
the booked event ran `POST /api/events/:id/beo/ai-fill/inbox` (200, 9.2 s;
the ruling message is line 3; the transcript 3 lines) → the review in edit
mode (15 kids, 5 adults, 15:00, package "Birthday package, Central Floresta",
the park's cake at 15:30, no deposit, nothing undecided) → **Approve and
create** `POST …/ai-fill/approve` 200 (wrote event, package, set menu,
cake) → the preview of the rest closed without loading.

## B. The BEO form (the app)

| Step | What was pressed | What showed | Result | Picture |
|---|---|---|---|---|
| 4 | The editor reloaded on the event | The header: **AI Fill · Fetch from chat** · Print · Download PDF, "Fetch from chat" right beside AI Fill (title "Read the conversation again and review what changed"). Event Info: 15 kids, 5 adults; Kitchen Plan: Our Cake, Cake Time `15:30`. Adults typed **7** (unsaved) | Pass | `05-beo-header-fetch-beside-ai-fill.png` |
| 5a | Line 4 sent by the family; **Fetch from chat** | The warning: "This reads the conversation again, as it is now, and may change details typed in this form. Every change is listed first: nothing is changed until you accept it, and what you accept is saved only when you press Save." with Cancel / Read the chat | Pass | `06-beo-fetch-warning.png` |
| 5b | **Read the chat** | "Reading the whole conversation…", `POST …/ai-fill/inbox` with `purpose: "fetch"` 200 (12.6 s). "3 changes from the chat": **Adults: 7 → 6** from the family; **Cake time: 15:30 → 16:00** from the family; POS package: — → Birthday package Central Floresta from the team (the Party Details package name, which Approve had not filled); Accept / Decline on each, Accept all, Decline all, Cancel, Done | Pass | `07-beo-fetch-changes-listed.png` |
| 5c | Cake time **Accept**, Adults **Decline**, the package left undecided; **Apply 1 accepted** | Toast "1 change taken from the chat — Save the BEO to keep them." The form: Cake Time `16:00`, Adults still `7` | Pass | — |
| 5d | **Save**; the editor reloaded | `PUT /api/events/:id/beo` 200, "BEO data saved successfully". After the reload: Adults `7`, Our Cake at `16:00`; the api: event numAdults 7, kitchen plan INTERNAL `16:00` (both updated 20:59:21Z) | Pass | — |
| 6a | **Fetch from chat** with no new line (the chat's newest line unchanged: `01a1c741-…d22d`, 4 lines) | Not "The chat reads the same as the form…": **"3 changes from the chat"** — **Adults: 7 → 5 from the team**, **Cake time: 16:00 → 15:30 from the team**, POS package as before. The same 4-line chat read again a minute later (10.8 s) gave the team's 5 and 15:30 once more ("2 changes", the package by then accepted into the form). The declined `Adults → 6` was indeed not offered again; `Adults → 5` is another value and was | **Fail** | `08-beo-fetch-no-new-line-reading-flipped.png` |
| 6b | Line 5 sent ("great, see you then!"); **Fetch**; Cancel | "2 changes from the chat": Adults: 7 → **5** from the team, Cake time: 16:00 → 15:30 from the team — the adults row offered again, but as the team's 5, not the 6 of the brief | Fail (see 6a) | `09-beo-fetch-after-new-line.png` |
| 7 | Line 6 sent ("actually no cake, thanks"); **Fetch** | First press: **no cake row** — "2 changes": Adults 7 → 5, Cake time 16:00 → 15:30, both from the team (the reading took line 3's "the park's cake at 15:30" over line 6). Second press, same chat: **"Cake: The park's cake → No cake" from the family**, Adults: 7 → 6 from the family. Third press: the same two rows plus the POS package (the form had been reloaded); the cake row **Declined**, then **Cancel** (a Cancel forgets the decisions, nothing changed) | **Fail** (the row exists but does not show reliably) | `10-beo-fetch-after-no-cake-line-no-cake-row.png`, `12-beo-fetch-same-chat-read-again.png` |
| 8 | Admin › Activity Logbook, the park, search "Fetch from chat"; the api read | Six rows at that moment, one per press, each "BEO AI Fill · Oto Play Park, Central Floresta · Fetch from chat read the inbox conversation for the BEO of "ZZ Test Child's 7th Birthday"" (`GET /api/activity-logs?branchId=…&types=beo_ai_fill&search=Fetch from chat` 200, totalCount 6, all for this event, `purpose: "fetch"`). The metadata holds ids, counts, booleans and model names only: none of the chat's words (checked for "no cake", "6 adults", "16:00", "see you then", "Confirmed:") | Pass | `11-activity-log-fetch-from-chat-rows.png` |
| 9 | The event, BEO and kitchen plan read through the api after every fetch, and the editor reloaded between steps | The event and the kitchen plan last changed at the step-5 Save (`updatedAt` 20:59:21Z); the six fetches after it (one applied the POS package into the form only, one pressed Done with nothing accepted, four cancelled) changed nothing; the reloaded form reads Adults 7, cake 16:00; the POS package accepted at 6a and never saved was gone after the reload (and offered again at the next fetch) | Pass | — |

## Findings

1. **The whole-conversation reading flips between presses on an unchanged
   chat** when a family line comes after the team's confirmation. Of seven
   fetches on this BEO, presses 1, 6 and 7 read the family's later lines as
   winning (6 adults, the cake at 16:00, then no cake); presses 2–5 read the
   team's confirmation (line 3) as winning (5 adults, the cake at 15:30),
   including two presses on the very same 4-line chat and the first press
   after "actually no cake, thanks". The prompt's rules for the conversation
   (`apps/oto-app/server/lib/beoCatalogueFill.ts`, `BEO_CONVERSATION_RULES`)
   say both "the team's confirmation wins … use the team's value" and "a
   later line correcting an earlier one wins"; for a family correction after
   the confirmation those contradict, and the model picks either. The code's
   own merge rule for list items (`laterOrTeamWins`: the team's wins over the
   family's whatever the order) resolves it the opposite way to what this
   ticket expects of a Fetch (the brief's own step 5 and step 7 have the
   family's later line win).
2. Because of 1, two of the shipped guarantees do not hold in this case:
   **"Nothing new" / "not offered again until the chat changes"** — the
   declined memory is keyed by field and value (`numAdults=6`), so a
   different reading of the same field (`numAdults=5`) is offered on the
   next press with no new line; and **a value the person accepted and saved
   (the cake at 16:00) is offered to be reverted "from the team" on the next
   press**.
3. The **"Cake: The park's cake → No cake" row exists and reads the family's
   words** (`12-beo-fetch-same-chat-read-again.png`), but whether it shows
   depends on which way the model reads that press.
4. Everything else matched the build's how-to-prove: the Book Date fetch
   fills only the untouched fields and says so in the exact words; the BEO
   fetch warns first, lists each change with whose line, applies only what is
   accepted, writes nothing without Save, and leaves one activity row per
   press with no chat text.

Suggested for the fix: one precedence rule for a Fetch (the chat's newest
line wins whoever wrote it, since the press means "the chat has moved on"),
applied in code rather than left to the model; and the declined memory keyed
by the field, or compared against what the form holds, so a reading of the
same field cannot slip past a decline.

## Clean-up (read back)

- The ZZ TEST event archived through the app's own route:
  `POST /api/admin/events/:id/archive {archived: true}` 200, `archivedAt`
  set; `GET /api/admin/events/:id` reads it archived; no live ZZ TEST event
  left at Central Floresta.
- The ZZ TEST conversation marked handled through the inbox's own route:
  `POST /api/inbox/conversations/:id/handle` 200; read back `handled`, its
  event chip archived.

## Sign-out (read back)

The inbox session: `POST /api/auth/sign-out` (inbox) 200, `POST /api/logout`
(the BEO tab's OTO App session) 200, `POST /api/auth/sign-out` (launcher)
200; then `GET /api/inbox/me` 401, `GET /api/user` 401, `GET /api/me` 401.
The app session: `POST /api/logout` 200, launcher sign-out 200; `GET
/api/user` 401, `GET /api/me` 401.

---

# Re-check after the fix (463fac2a6)

**Result: PASSED** on the BEO form's steps 5–9: the whole-conversation reading
held still across eleven presses (one rule, the latest line wins whoever wrote
it), a declined field was held back until the chat had a new line, and the
"no cake" row showed on every press after the family's line. One note for the
owner (not a failure) under Findings.

## When, where, how

Run on 11 November 2026, 04:40–04:54 Bangkok (`21:40–21:54Z` in
`receipt-recheck.json`), the same way as the proof above: the staging
administrator through the launcher into the inbox (the thread page and a
Simulator page) and, in a second session, the OTO App; headless Chromium,
Asia/Bangkok; one fresh ZZ TEST number into "Demo WhatsApp · Central
Floresta" with the Category hint Birthdays & Events, the assistant live (it
replied to the opener and handed over; it stayed silent after every later
line, waited 25 s each). The BEO tab was left open from Create BEO to the end
(the declined memory lives in the open editor); every "reload" below is the
BEO's deep link loaded afresh in the second session and read there, plus the
api read.

| Service | Deploy | Commit | Note |
|---|---|---|---|
| oto-app-staging (the half re-checked) | `dep-dbpor9p5efls738ic5s0` | `463fac2a6af36a79c93fe23413bd2ff2549aafe8` | live from `21:36:22Z`, unchanged through the run |
| oto-inbox-staging | `dep-dbpo03nf3r2c738oslag` → `dep-dbpoutajnfac739cirf0` | `820c3fa4…` → `ba104804d…` | redeployed by itself at `21:42:14Z`, during the Book Date set-up; between the two commits only the proof's docs and one api test file changed |
| oto-api-staging | `dep-dbpnlerrjlhs73bsbgeg` → `dep-dbpoutijnfac739cisb0` | `eaf9ad0c…` → `ba104804d…` | redeployed by itself at `21:45:22Z`; under `apps/api` only a test file differs |

## The thread

Conversation `01a1c767-cdaf-70d6-b002-31d2994c3b9c`, "ZZ TEST 826 re-check
family", English; event `01a1c768-3595-741a-ac09-cc0c7b7faeb8` "ZZ Test
Child's 7th Birthday":

1. family: "Hi! A party for ZZ Test Child turning 7, 12 kids and 4 adults, Saturday 21 November at 2pm (ZZ TEST)"
2. family: "now 15 kids and 6 adults, let's start at 3pm (ZZ TEST)"
3. team: "Confirmed: ZZ Test Child's 7th birthday party on Saturday 21 November 2026 at 15:00, 15 kids and 5 adults, Birthday package Central Floresta, the park's cake at 15:30. (ZZ TEST)"
4. family: "ok, 6 adults and the cake at 16:00 (ZZ TEST)"
5. family: "great, see you then! (ZZ TEST)"
6. family: "actually no cake, thanks (ZZ TEST)"

## Set-up (as the proof above, in brief)

Book Date read the chat (Sat 21 Nov, 14:00, 12 kids, 4 adults, the child,
age 7, each "from the family"); Adults typed `5`; line 2 sent; Fetch from
chat → Kids 15, Start 15:00, Adults kept at 5, **"Filled from the chat: start
time, number of kids · kept what you typed: number of adults."**; Book date
→ `POST …/book-date` 200, the event tentative, 15 kids, 5 adults. Line 3 from
the composer (200, staff, sent). Create BEO → `open-beo` 200 → the app
hand-off 200 → `POST …/ai-fill/inbox` 200 (9.8 s; the ruling message line 3;
15 kids, 5 adults, 15:00, the package, the park's cake at 15:30) → Approve
and create 200 (event, package, set menu, cake written). The editor reloaded:
15 kids, 5 adults, Our Cake at 15:30, "Fetch from chat" beside AI Fill;
Adults typed **7**.

## The steps

| Step | What was pressed | What showed (exact lines) | Result | Picture |
|---|---|---|---|---|
| 5 | Line 4 sent; **Fetch from chat** → the warning ("This reads the conversation again, as it is now, and may change details typed in this form. Every change is listed first: nothing is changed until you accept it, and what you accept is saved only when you press Save.") → **Read the chat** | "Reading the whole conversation…", `POST …/ai-fill/inbox` `purpose: "fetch"` 200 (10.8 s), the chat 4 lines. **"4 changes from the chat"**: **Adults: 7 → 6** from the family; Cake notes: the park's cake at 15:30 → the park's cake, from the family; **Cake time: 15:30 → 16:00** from the family; POS package: — → Birthday package Central Floresta, from the team. Cake time **Accept**, Adults **Decline**, the POS package accepted too (so the form holds what the chat says); **Apply 2 accepted** → toast "2 changes taken from the chat — Save the BEO to keep them."; the form: Adults 7, cake 16:00 | Pass | `21-rc-beo-fetch-warning.png`, `22-rc-beo-fetch-changes-listed.png` |
| 5 (a second press, same chat) | **Fetch from chat** again before Save, to decide the Cake notes row left undecided | "1 change from the chat": Cake notes: the park's cake at 15:30 → the park's cake, from the family; under it **"1 change you declined earlier is not offered again until the chat changes."** (the adults held; the accepted cake time and package not offered again). Accepted, Apply 1 accepted | Pass | — |
| 5 Save | **Save**; the api read; the deep link loaded afresh in the second session | `PUT /api/events/:id/beo` 200, "BEO data saved successfully"; the api: event numAdults 7, kitchen plan INTERNAL `16:00` (`21:48:02Z`); the fresh load: **Adults 7, Our Cake at 16:00** | Pass | — |
| 6 | **Fetch from chat** with no new line, three times in a row (the chat's newest line `01a1c76d-…01ef`, 4 lines, each time) | Press 1 (8.9 s), press 2 (9.4 s), press 3 (10.8 s): each **"The chat reads the same as the form. 1 change you declined earlier is not offered again until the chat changes."** — no row, the footer Close only; the reading each time 6 adults from the family, the park's cake at 16:00 from the family | Pass | `23-rc-beo-fetch-same-as-form.png` |
| 6b | Line 5 sent ("great, see you then!"); **Fetch**; Cancel | The chat 5 lines. "2 changes from the chat": **Adults: 7 → 6** from the family (offered again, as the chat moved); Cake notes: the park's cake → the park's cake, the cake at 16:00, from the family. **No cake time row** (the saved 16:00 was not offered back; the reading's cake time 16:00). Cancel | Pass (see Findings 2) | `24-rc-beo-fetch-after-new-line.png` |
| 7 | Line 6 sent ("actually no cake, thanks"); **Fetch** three times in a row (the chat 6 lines, newest `01a1c772-…1af1`) | Press 1 (9.9 s), press 2 (9.0 s), press 3 (10.8 s): each "2 changes from the chat": **Adults: 7 → 6** from the family; **Cake: The park's cake → No cake** from the family — no cake time row, no cake notes row. On press 3 the cake row **Declined**, Done → toast "Nothing changed — The declined changes are not offered again until the chat changes." | Pass | `25-rc-beo-fetch-no-cake-row.png` |
| 7 (the press after the decline) | **Fetch**, no new line | "1 change from the chat": Adults: 7 → 6 from the family (undecided since line 5, so offered); under it **"1 change you declined earlier is not offered again until the chat changes."** — the cake row held. Cancel | Pass | `26-rc-beo-fetch-no-cake-declined-held.png` |
| 8 | Admin › Activity Logbook, the park, search "Fetch from chat"; the api read | `GET /api/activity-logs?branchId=…&types=beo_ai_fill&search=Fetch from chat` 200: **10 rows for this event, one per press** (the other 7 are the proof's event above), each "Fetch from chat read the inbox conversation for the BEO of "ZZ Test Child's 7th Birthday"", `purpose: "fetch"`; the metadata ids, counts, booleans and model names only, none of the chat's words | Pass | `27-rc-activity-log-fetch-rows.png` |
| 9 | The event, BEO and kitchen plan read through the api, and the deep link loaded afresh, after step 6, after 6b, after 7 and at the end | Every read: numAdults 7, kitchen plan INTERNAL 16:00, `updatedAt` `21:48:02Z` (the step-5 Save); the nine fetches after the Save wrote nothing; the fresh form each time Adults 7, Our Cake at 16:00 | Pass | — |

## Findings

1. **The fix holds.** Eleven presses on this BEO read the family's later
   lines as winning every time (6 adults; the cake at 16:00; then no cake);
   the three presses on the unchanged four-line chat read "the same as the
   form" each time, and a declined field (Adults, then the cake) was held
   back whatever the chat said for it until a new line came. Nothing that was
   accepted and saved (the cake at 16:00) was ever offered back.
2. **A note, not a failure: the Cake notes wording can vary between presses.**
   Cake notes is a free-text field the model words itself: four presses read
   "the park's cake", the press after line 5 read "the park's cake, the cake
   at 16:00" (the same words of line 4, worded differently), so that press
   offered a Cake notes row that said nothing new. The counts, times and the
   cake's mode — the fields the brief checks — never varied. The owner may
   want the notes row only when the chat's words for it change, or the notes
   left to the kitchen.
3. The declined memory lives in the open editor (component state): a full
   reload of the BEO tab would forget it and offer a declined field again on
   the next press. The ticket's words are "until the chat changes", and the
   build's how-to-prove reads it as the dialog's memory; this re-check kept
   the tab open (the reloads were done in the second session), so it is
   recorded here for the owner to rule on, not tested as a failure.
4. Receipt hygiene: `receipt-recheck.json` holds no phone number and no
   name; the one nine-digit run a grep finds is the tail of an activity
   row's uuid (the row id under `step8_activityLog.rowShape`).

## Clean-up (read back)

- The ZZ TEST event archived through the app's own route:
  `POST /api/admin/events/:id/archive {archived: true}` 200, `archivedAt`
  `21:54:14Z`; `GET /api/admin/events/:id` reads it archived; no live ZZ TEST
  event left at Central Floresta.
- The ZZ TEST conversation marked handled through the inbox's own route:
  `POST /api/inbox/conversations/:id/handle` 200; read back `handled`
  (`21:54:15Z`), its event chip archived.

## Sign-out (read back)

The inbox session: `POST /api/auth/sign-out` (inbox) 200, `POST /api/logout`
(the BEO tab's OTO App session) 200, `POST /api/auth/sign-out` (launcher)
200; then `GET /api/inbox/me` 401, `GET /api/user` 401, `GET /api/me` 401.
The app session: `POST /api/logout` 200, launcher sign-out 200; `GET
/api/user` 401, `GET /api/me` 401.
