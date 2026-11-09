# SCRUM-816 The BEO prompt always carries the fields the app reads: staging proof

Run on 10 November 2026, 04:45-04:49 Bangkok, on oto-app-staging live at
`8b3e36741279a52e87a1fb8723077f02eba0a096` (Render deploy
`dep-dbp3r4om7kps739o4b1g`; the app's `/api/qa-reports/config` answered the
same version). Nothing was deployed or restarted and no setting was changed.
A headless Chromium at 1440 wide, in the Bangkok time zone, signed in as the
staging administrator (global admin; its name is masked in every picture).
ZZ TEST records only; no SMS. Two real model calls (two AI Fill runs).

## The setting that hid the date

Central Floresta's park group still has its own saved `ai_beo_parsing_advice`
and `ai_beo_parsing_output_format` (both saved 1 May 2026). The saved output
format still names neither `eventDate` nor `eventDateText` (read by name only;
the values were not printed or kept). Before SCRUM-816 that is why the Date
line of SCRUM-814 never showed.

## The run

A ZZ TEST event "ZZ TEST 816 date" at Central Floresta booked for Sunday
15 November 2026 at 14:00 (`POST /api/admin/events`), opened in Studio >
Events, AI Fill, the text pasted: "Подтверждаем день рождения Миши 21 ноября в
14:00, 12 детей, 4 взрослых. Пакет Birthday package Central Floresta, пицца
Маргарита, аниматор Zombie game. Депозит получен 9 ноября", Parse with AI
(`POST /api/ai/parse-beo` 200 in 11.2 s; the second run 7.8 s).

| Check | Result | Picture |
|---|---|---|
| The answer carries the date | Pass: `eventDate 2026-11-21`, `eventDateText "21 ноября"` | — |
| The review shows the Date line | Pass: "Sat 21 Nov 2026 — the message says "21 ноября"" on an amber row | `816-st-01-app-ai-fill-review-date-line-21-nov-differs-unticked.png` |
| The amber line and the tick | Pass: "The event is booked for Sun 15 Nov 2026: not the same day.", "Tick to make Sat 21 Nov 2026 the event's date." unticked | same |
| Load into Editor without the tick: the date stays 15 Nov | Pass: the form shows November 15th, 2026; Save (PUT 200) and the server reads `eventDate 2026-11-15` for the event and the BEO | `816-st-02-app-loaded-without-tick-date-stays-15-nov.png` |
| The deposit date | Pass: the form's deposit date November 9th, 2026; after Save the BEO reads `depositDate 2026-11-09` | `816-st-03-app-party-details-deposit-date-2026-11-09.png` |
| AI Fill again, tick, Load, Save: the date becomes 21 Nov | Pass: ticked in the review, the form shows November 21st, 2026, Save (PUT 200), the header reads "21 November '26 at 14:00" and the server reads `2026-11-21` for the event and the BEO | `816-st-04-app-ai-fill-review-date-ticked.png`, `816-st-05-app-loaded-with-tick-form-date-21-nov.png`, `816-st-06-app-saved-date-21-nov.png` |
| The activity row | Pass: both `beo_ai_fill` rows for the event say `promptFrom: { advice: setting, outputFormat: setting, model: built_in, requiredFields: appended }`, outcome filled, source pasted (yesterday's 814 row has no `requiredFields`) | — |

## Clean-up, read back (`receipt.json`: `cleanup`, `signOut`)

- `DELETE /api/admin/events/:id` 204; the event and its BEO read 404; no
  "ZZ TEST 816" event left at Central Floresta.
- Signed out of the OTO App (`/api/logout` 200) and the launcher (200); the
  app's `/api/user` and the launcher's `/me` answer 401.
- What stays: two `beo_ai_fill` activity rows (no message text in them).

The scripts are in the scratchpad folder `s816p` (a driver and its steps,
reused from `s814p`).
