# SCRUM-812 The api's calls to the OTO App accepted again: staging check

Run on 10 November 2026, 13:43-13:53 Bangkok, after the OTO App's directory
clients were re-issued and oto-api-staging restarted with the corrected
`OTOAPP_JOBS_KEYS` tenant. Live during the chain: oto-api-staging and
oto-inbox-staging at `17d16c9d`, oto-app-staging at `8b3e3674` (read before and
after the run with `scripts/agent/render.mjs`). A deploy of `608e3c0b`, not
started by this run, went live on oto-app-staging at 13:53:09, after the
clean-up; the api was updating to it at 13:53:15.

The staging administrator signed in through the launcher and worked in the
inbox as the team member (name masked in every picture). One ZZ TEST
conversation, played through the simulator into "Demo WhatsApp · Central
Floresta" from a ZZ TEST number: nothing reached a phone. The same run carried
on into Create BEO: see `../../SCRUM-815/staging/README.md`.

## Results

| Step | Result | Picture |
|---|---|---|
| The family's two lines (Russian): the assistant answered the first (`ai_replied`, birthday_party) and handed the second over to Birthdays & Events (`ai_handover`, closing_birthday). The team's confirmation sent through the inbox's reply box (200, sent); the family's "Отлично, спасибо!" | Pass | `812-st-01-ru-chat-before-book-date.png`, `812-st-04-ru-chat-end-team-confirmation-event-chip.png` |
| Book Date opens on 21 Nov 2026 ("The chat says «21 ноября»"), 14:00 ("в 14:00"), Central Floresta, 10 kids, turning 6 | Pass. Adults and the child's name were left empty in the dialog (the chat says 4 adults and Миша); the BEO review later filled both | `812-st-02-ru-book-date-21-nov-14-00-10-kids.png` |
| Save ("Book date"): `POST /api/inbox/conversations/:id/book-date` → **200**; the party created in the OTO App ("Birthday · ZZ TEST 812 RU birthday", 21 Nov, 14:00, Tentative, 10 kids); the conversation shows "Event: 21 Nov 2026 at Central Floresta · tentative in the Events calendar", Date Booked and the event chip | **Pass**: the api's call to the OTO App was accepted (no `OTOAPP_INVALID_DIRECTORY_KEY`) | `812-st-03-ru-book-date-saved-event-chip.png` |
| The party read through the api as the administrator: `GET /api/parties/:id?branchId=…` → 200, plan present, planStatus **ready** (after Approve and create) | Pass | — |
| Console > Health, `job:otoapp.presence` | **Not proven yet.** Still "failed", last run 11:11 Bangkok (04:11Z), before the keys were re-issued: "OTOAPP_INVALID_DIRECTORY_KEY" for park group 681b18d1…, and "OTOAPP_NIGHT_JOB_UNKEYED" for park group 6b21b917… (no jobs:run key for it in `OTOAPP_JOBS_KEYS`). It runs every 6 hours; next due about 17:11 Bangkok. Not run by hand: its test control repairs presence data in the OTO App, a write this run was not asked to make. Two alerts stay open (failed 4 times in a row; not succeeded since 9 Nov). `job:otoapp.attention` shows the same | `812-st-05-console-health-otoapp-presence.png` (the alerts), `812-st-06-console-health-job-register-presence.png` (the job register) |

## Clean-up, read back

- The ZZ TEST event: `DELETE /api/admin/events/:id` → 204; then the event,
  its BEO and its package snapshot → 404; no ZZ TEST event left at Central
  Floresta; `GET /api/parties/:id` → 404 NOT_FOUND.
- The ZZ TEST conversation marked handled (`POST …/handle` → 200, read back
  "handled"). Its stored event link still reads the deleted event
  (Tentative, not archived): the inbox keeps the link after the event is
  deleted in the OTO App.
- Signed out of the inbox, the OTO App (both sessions), the Console and the
  launcher: every one read back 401.

`receipt.json` has every route, status and value; no names, phone numbers,
account ids or keys.
