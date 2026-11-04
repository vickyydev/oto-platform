# SCRUM-775 Book Date and Create BEO: staging proof

Run on 5 November 2026, 00:43-00:56 Bangkok, on the live commit
`a9d89d0a4a36d08e0150088b16e1b8242dfb5b04` (main CI run 41868828175 green on
that SHA). oto-api-staging, oto-inbox-staging, oto-app-staging, oto-pos-staging,
oto-launcher-staging and oto-console-staging were live on it before the run and
on the same deploys after it (`live-before.json`, `live-after.json`). Nothing
was deployed or restarted, and no setting was read by value or changed.

A real Edge browser (Playwright, `channel: msedge`) at 1440 and 1920 wide, in
the Bangkok time zone. ZZ TEST records only. No SMS, no WhatsApp send (the
channel account is a simulator), no sale or payment, no park device (the
park's Pi, Till 1 (Pi), Till 2 (test) and FWBooth1 untouched). No real customer
conversation was opened or pressed.

## Preconditions read back (read-only)

- OTO App: 35 migrations applied, `0035` the newest;
  `core_events.inbox_conversation_id` is a nullable uuid.
- The api's directory key matches the active OTO App directory client
  "oto-api-staging (events seam)" in the Default tenant, with scopes
  `["events:write"]` (matched by hash inside a one-off job; the key and the
  hash were never printed).
- The park "Oto Play Park, Central Floresta" maps to the app branch
  `540f6e5e-…` in that same tenant. Before the run the tenant had the four
  default statuses and no Tentative status. No event was linked to any
  conversation and no `inbox.conversation.book_date` audit row existed.
- The simulator is on for this deployment (a boolean read in the job).

## The logins

- The staging administrator played the customer message through the inbox's
  Simulator panel (it needs `inbox:channel:manage`).
- Book Date and Create BEO were pressed by a login made for this run,
  "ZZ TEST S775 mw2en8wa birthdays team": `inbox_agent` at the Birthdays &
  Events department only (no `inbox:conversation:assign`) and linked to the
  OTO App as a manager, which gave it `app:oto_app:access`. It was made as an
  invited account in a one-off job with an audit row and no SMS, then given a
  temporary password from the Console and changed to a random one nobody
  keeps. So the birthdays-team path that the local proof could not show in a
  browser is the one shown here.

No ZZ TEST-named simulator channel account exists on staging and none can be
made from a screen, so the message went into the existing simulator account
"Demo WhatsApp · Central Floresta" from a ZZ TEST contact, as earlier ZZ TEST
inbox checks did. That account's assistant is set to live, so it answered the
contact once inside the simulator ("Our birthday manager will be with you
shortly") and handed over to the team.

## What a person sees

| Step | Screenshot |
|---|---|
| The Simulator panel: Demo WhatsApp · Central Floresta, from a ZZ TEST number, "ZZ TEST S775 Birthday", Birthdays & Events, English, "ZZ TEST birthday for 12 kids on 21/mar, turning 6 years" | `s775-st-01-simulator-zz-test-birthday-message.png` |
| The birthdays-team login on the conversation: Book Date and Create BEO enabled | `s775-st-02-birthday-chat-book-date-and-create-beo-live.png` |
| Book Date's confirm read from the chat: 21/03/2027 with "The chat says “21/mar”", 14:00, Central Floresta, 12 kids, booking name, the contact's phone, turning 6 | `s775-st-03-book-date-confirm-prefilled.png` |
| The same with the child "ZZ TEST Child" added, before Book date was pressed twice quickly | `s775-st-03b-confirm-with-child-before-save.png` |
| Saved: "Date Booked" (disabled), the chip "Event: 21 Mar 2027 at Central Floresta", the note "tentative in the Events calendar"; the BEO card reads 1 | `s775-st-04-date-booked-and-event-chip.png` |
| The timeline pill "Date blocked in the Events calendar by ZZ TEST S775 mw2en8wa birthdays team · awaiting confirmation" | `s775-st-05-timeline-pill-date-blocked.png` |
| Create BEO: a new tab, signed in through the hand-off, on `/studio/events/kanban` (no `?beo=` left in the address) with the event's BEO form open: title "ZZ TEST Child's 6th Birthday", "From the inbox", the child, the booking name, the WhatsApp number, age 6, 21 March 2027 at 14:00, 12 kids. Not saved | `s775-st-06-create-beo-opens-prefilled-beo-form.png` |
| The Events board: the event in the Tentative column (orange, after Cancelled) | `s775-st-07-events-board-tentative-column.png` |
| The calendar for March 2027: "14:00 ZZ TEST Child's 6th Birthday" on Sunday 21; Confirmed Events 0 | `s775-st-08-events-calendar-21-march-2027.png` |
| The inbox dashboard: "BEOs created · week" 1, since Monday 2026-11-02 | `s775-st-09-inbox-dashboard-beo-card.png` |
| Clean-up: the BEO editor's own archive button | `s775-st-10-beo-editor-archive-button.png` |
| After the archive: "Event archived" toast, the Tentative column stays, now empty | `s775-st-11-board-after-archive-tentative-column-stays.png` |
| The inbox after the archive: "Event archived" and the chip "Event: 21 Mar 2027 at Central Floresta · Archived" | `s775-st-12-inbox-chip-event-archived.png` |
| Mark as Handled's confirm | `s775-st-13-mark-handled-confirm.png` |
| The handled conversation keeps its link to the archived event | `s775-st-14-handled-conversation-keeps-archived-event.png` |

## Read back

- `step2-book-date-ui.json`: the confirm's values; the double press sent one
  request (200, no replay), because the first press closed the dialog.
- `step3-readback.json` (read-only job): exactly one `otoapp.core_events` row
  with `inbox_conversation_id` = the conversation: type birthday, status
  `tentative`, 2027-03-21 14:00, 12 kids, child "ZZ TEST Child", age 6, the
  booking name and a phone, at the Central Floresta app branch. The
  conversation's `event_order_ref` is that event's id. One
  `inbox.conversation.book_date` audit row, by the birthdays-team login. The
  Tentative status (orange, sort 4) was created by this press, at the same
  instant as the event.
- `step4-6-beo-board-api.json` and `step4-6-readback.json`: Create BEO's
  `POST …/open-beo` answered 200; one `auth.handoff_issue` audit row with
  `purpose: inbox.create_beo`, the conversation and the event, by the
  birthdays-team login. It holds the jti and no token. The event's `updated_at`
  was unchanged, so the BEO was not saved. Through the api alone: the same
  body id again answered 200 with `x-oto-replay: true` and `created: false`;
  a new id answered 409 `EVENT_ALREADY_BOOKED` with `details.eventId` = the
  event. There was still one event and one book_date row. The dashboard
  answered `beosThisWeek: 1`, `weekStart: 2026-11-02`: the card counts the
  dates booked this week, not the events whose party falls this week.

## Clean-up (`cleanup.json`)

- The ZZ TEST event is archived with the BEO editor's archive button
  (`is_archived` true, status still `tentative`). The Tentative status stays as
  the park group's column.
- The ZZ TEST conversation is marked handled by the birthdays-team login. It
  keeps `event_order_ref`, and its chip now reads "Event archived" and
  "· Archived".
- The ZZ TEST S775 login is inactive, with no grants, no live session and no
  app link, and its OTO App user is off.
- What stays: the handled ZZ TEST conversation and its ZZ TEST contact, the
  archived ZZ TEST event, the Tentative status row, the audit rows, and the
  assistant's one simulator reply.

## Not proven here

- A real WhatsApp number: the run used the simulator only.
- Saving the BEO in the OTO App: Create BEO's form was opened and left unsaved,
  as planned.

The harness is under `harness/` (readable copies; settings are read by name).
