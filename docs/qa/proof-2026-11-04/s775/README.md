# SCRUM-775 Book Date and Create BEO: local proof

Built on lane `lane/inbox775-20261104`, cut from main `76f507574`. Proved
locally on 4 November 2026 with the real platform api, the inbox (its
production build behind `vite preview`) and the OTO App (its own server and
client) on one disposable database (embedded Postgres, dropped afterwards).
Nothing touched staging, a park device, SMS or payments.

Owner decision, 4 November (closes Inbox owner question Q23): the OTO App's
Events module is the one home for birthday orders.

## What a person sees

| Step | Screenshot |
|---|---|
| A ZZ TEST birthday chat ("15 kids on 21/mar", "6 years old"): Book Date and Create BEO are live | `s775-01-birthday-chat-book-date-live.png` |
| Book Date opens the confirm read from the chat: 21/03/2027 (the chat's "21/mar"), 14:00, Central Floresta, 15 kids, the contact's name and phone, turning 6 | `s775-02-book-date-confirm-prefilled.png` |
| Saved with a double press: "Date Booked", the chip "Event: 21 Mar 2027 at Central Floresta", the note "tentative in the Events calendar"; the BEO card reads 1 | `s775-03-event-chip-date-booked.png` |
| Create BEO opens a new tab, signed in through the suite hand-off (`POST /inbox/conversations/{id}/open-beo`), on the event's BEO form: title, child, booking name, WhatsApp number, age 6, 21 March 2027 at 14:00, 15 kids, and "From the inbox" | `s775-04-create-beo-opens-prefilled-beo-form.png` |
| The app's board: the event in the Tentative column (made once, after the four default columns) | `s775-05-events-board-tentative-column.png` |
| The app's calendar: the birthday on Sunday 21 March 2027; Confirmed Events 0 | `s775-06-events-calendar-on-the-date.png` |
| The inbox timeline pill "Date blocked in the Events calendar by … · awaiting confirmation" beside the chip | `s775-07-inbox-pill-and-chip.png` |
| The dashboard's "BEOs created · week" card: 1, since Monday 2026-11-02 | `s775-08-dashboard-beo-card.png` |

## Read back (`local-proof.json`)

- One `core_events` row for the conversation after the double press: event
  type birthday, status `tentative`, the mapped app branch, 2027-03-21 14:00,
  15 kids, child "ZZ TEST Mali", age 6, booking name and E.164 phone, and
  `inbox_conversation_id` = the conversation. The conversation's
  `event_order_ref` is that event's id.
- Through the api alone: the same id again answered 200 with
  `x-oto-replay: true` and `created: false`; a new id answered 409
  `EVENT_ALREADY_BOOKED`; still one event.
- One `inbox.conversation.book_date` audit row, by the person who pressed.
- Create BEO's press: one `auth.handoff_issue` row with
  `purpose: inbox.create_beo`, the conversation and the event (the jti, never
  the token). Through the api alone, `POST …/open-beo` answered 200 with the
  event's id and a hand-off whose target is its BEO form.
- The park group's statuses: Upcoming, In Progress, Completed, Cancelled, then
  Tentative (orange) at the end.

The harness is `s775-local-proof.mts.txt` (run from `apps/api` with tsx).

## Local gates

| Gate | Result |
|---|---|
| `pnpm --filter @oto/shared typecheck`, `@oto/api`, `@oto/inbox`, `@oto/api-types` | pass |
| `pnpm --filter @oto/api exec vitest run --pool=forks test/inbox-book-date.test.ts` | 23 / 23 (review round: the park check, the archived event, Create BEO's recorded hand-off, the BEO card's week and visibility) |
| the four route guards (`routes-guarded`, `route-write-conformance`, `id-conformance`, `route-scope-target`) | 109 / 109 |
| `test/inbox-read.test.ts`, `test/inbox-actions.test.ts`, `test/otoapp-directory.test.ts` | pass (96) |
| `test/otoapp-events-seam.test.ts`, `test/s217b-r1.test.ts` | 51 / 51 |
| `pnpm api-types:check`; `@oto/api-types` seam walker | matches; 10 / 10 |
| `@oto/shared` `test/inbox.test.ts` | 41 / 41 |
| `@oto/inbox` test (all 12 files, `test/book-date.test.ts` new) and build | 238 / 238; built |
| OTO App `npm run check:ratchet` | 418 / 418, no new diagnostic |
| OTO App `tests/directory-inbox-event.check.ts` (fresh database, both migrators) | 9 / 9 |
| eslint on every changed `.ts` / `.tsx` outside `apps/oto-app` | clean |

## Staging proof plan (for the landing; ZZ TEST only)

Preconditions: the lane landed on main, CI green on its exact SHA, the api,
inbox and OTO App services live on that SHA, the OTO App migration 0035
applied (`otoapp.__drizzle_migrations`). No new setting: the api already holds
`OTOAPP_DIRECTORY_URL` and `OTOAPP_DIRECTORY_KEY`; confirm read-only that the
key's directory client carries `events:write` (the attendee write uses the
same scope).

1. On staging, play one ZZ TEST birthday conversation through the inbox
   simulator on a ZZ TEST simulator channel account at Central Floresta:
   "ZZ TEST birthday for 12 kids on 21/mar, turning 6 years" from a ZZ TEST
   number. No real customer conversation is opened or pressed.
2. Signed in as a ZZ TEST birthdays-team login (or the ZZ TEST manager),
   open it, press Book Date, check the pre-filled confirm (date, park, 12
   kids, name, phone, age), add child "ZZ TEST Child", press Book date twice.
   Screenshot the confirm and the strip with "Date Booked" and the chip.
3. Read back, read-only: exactly one `otoapp.core_events` row with
   `inbox_conversation_id` = the conversation, status `tentative`; the
   conversation's `event_order_ref` equals its id; one
   `inbox.conversation.book_date` audit row; the Tentative status row (note
   whether it was made now or already there).
4. Press Create BEO: the OTO App opens in a new tab on the event's BEO form
   with "From the inbox". Screenshot it. Do not save the BEO. Read back,
   read-only: one `auth.handoff_issue` row with `purpose: inbox.create_beo`
   naming the ZZ TEST conversation and event. The pressing login needs
   `app:oto_app:access`, as the launcher's OTO App tile does.
5. In the OTO App, screenshot the event in the Tentative column and on the
   calendar on its date; in the inbox, the BEO card.
6. Clean up through the screens: archive the ZZ TEST event in the OTO App
   (its own archive button) and mark the ZZ TEST conversation handled.
   Record that the Tentative status stays (it is the park group's own column
   from then on) and that the conversation keeps its link to the archived
   event, now shown as "Event archived" and "· Archived" on its chip.

## Not proven here

- Staging: proved on 5 November 2026 on live a9d89d0a, in `staging/` (its README).
- A birthdays-team agent with a department grant pressing in the browser: the
  api test covers that grant (`inbox-book-date.test.ts`); the browser ran as
  the seeded admin, who holds assign. The staging proof in `staging/` pressed
  both buttons as a login that is only in the birthdays team.
