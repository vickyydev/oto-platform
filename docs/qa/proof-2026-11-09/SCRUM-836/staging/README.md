# SCRUM-836 — staging proof

**Ticket:** A party's start time cannot be cleared: the BEO form's emptied Start Time is not saved, and the api answers 500 to a null.

**When / where:** 11 November 2026, 18:46–18:51 Bangkok, staging. api, OTO App and inbox all live on commit `3410a7344834cdd6e383e25c2cb02ed14a670f6b` (deploys `dep-dbq577l6e07s73c632h0`, `dep-dbq577uk1f9s73dldtv0`, `dep-dbq57815efls739n9mfg`). Headless Chromium, signed in as the staging administrator through the launcher. ZZ TEST simulator threads on "Demo WhatsApp · Central Floresta" only.

## Result: every step passed

| Step | What was done | What happened | |
|---|---|---|---|
| a | A fresh ZZ TEST thread: date, kids, "we have not decided the start time yet, but we want the park's cake at 16:00". Book Date opened. | Start time is EMPTY, with the line "The chat names no start time". 16:00 (the cake) is not offered. `836-01` | Pass |
| a | 14:00 typed, Book date pressed. | 200; the party "ZZ Test Child's 7th Birthday", Sat 19 Dec 2026, 14:00, tentative. | Pass |
| a (control) | A second thread: "Saturday 19 December at 14:00, the park's cake at 16:00". Book Date opened (not booked). | Start time 14:00, "The chat says 'at 14:00'". `836-02` | Pass |
| b | Create BEO; the × pressed on Start Time. | Red line under the field: "A party needs a start time. It was 14:00: nothing is saved until a time is set." `836-03` | Pass |
| b | Save pressed. | Notice "Not saved — A party needs a start time. Set the time, then save." No request of any kind left the page (no PUT). `836-04` | Pass |
| b | The page loaded afresh. | Start Time 14:00 in the form and in both reads. `836-05` | Pass |
| c | From the signed-in page: `PATCH /api/admin/events/:id {startTime: null}` | 400 "A party needs a start time"; GET after: 14:00 | Pass |
| c | `{startTime: ""}` | 400 "A party needs a start time"; GET after: 14:00 | Pass |
| c | `{startTime: "2pm"}` | 400 "The start time must be a time as HH:MM on the 24-hour clock"; GET after: 14:00 | Pass |
| c | `{startTime: "15:30"}` | 200, startTime 15:30; GET after: 15:30 | Pass |

No 500 was seen anywhere.

## Pictures

- `836-01-book-date-start-time-empty.png` — Book Date on the thread with no start time: Start time empty.
- `836-02-control-book-date-1400.png` — the control thread: Start time 14:00.
- `836-03-start-time-emptied-red-line.png` — the BEO form, Start Time emptied, the red line.
- `836-04-save-refused-not-saved.png` — Save pressed: "Not saved".
- `836-05-after-reload-still-1400.png` — after a fresh load: 14:00 still there.

Phone fields are covered; the events board behind the BEO sheet is hidden.

## Not shown

- The same refusal on `POST /api/admin/events` (making an event with no start) and on the BEO's own `PUT` sent by hand: covered by the checks that run in CI, not pressed here.
- The camp, workshop and one-off forms.

## Left on staging

The test party was used again for the SCRUM-839 proof and archived at the end of the run; both threads marked handled (see the SCRUM-838 receipt's clean-up).

`receipt.json` holds every read and status.
