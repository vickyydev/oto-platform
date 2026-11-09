# SCRUM-814 Book Date and the BEO AI Fill read the party's date: staging proof

Run on 10 November 2026, 03:43-03:53 Bangkok (the park's today: Tuesday
10 November 2026), on the live commit `3c1c41b26daaffb08756fe75eaa50cead872482a`.
oto-api-staging, oto-inbox-staging and oto-app-staging were live on it before
the run and on the same deploys after it (`receipt.json`: `liveBefore`,
`liveAfter`). Nothing was deployed or restarted and no setting was changed.

A headless Chromium at 1440 wide, in the Bangkok time zone. The staging
administrator played the team member: owner view in the inbox (it may book a
date and reply), global admin in the OTO App. Its name, the other staff names
and their initials are masked in every picture. ZZ TEST records only. The
customer side is the simulator account "Demo WhatsApp · Central Floresta",
with ZZ TEST numbers +6689 814 0001 to 0004: nothing reached a real phone, no
SMS was sent. Book Date was opened and cancelled each time, never saved
(SCRUM-812: the api cannot reach the OTO App's directory since the restore, so
a Save would fail). One real model call was made (the OTO App's AI Fill).

## Book Date: the dialog's first values

Each customer line went in through the simulator route
(`POST /api/inbox/simulator/inbound`, the Simulator panel's own route) with
the category Birthdays and the language given. The team's line was typed into
the inbox's reply box and sent with Send. The inbox assistant answered the
customer lines inside the simulator, as it does; its lines are not read by
Book Date.

| Chat | Book Date opened with | Result | Pictures |
|---|---|---|---|
| Russian. Customer: "Здравствуйте! Хотим отметить день рождения сына 15 ноября, 12 детей". Team: "Здравствуйте! 15 ноября занято, можем предложить 21-го ноября в 14:00". Customer: "Да, давайте 21-го" | Date 21/11/2026, "The chat says “21-го ноября”"; Start time 14:00, "The chat says “в 14:00”"; kids 12; Central Floresta | Pass | `814-st-01-ru-chat-team-offers-21st.png`, `814-st-02-ru-book-date-21-nov-14-00-12-kids.png` |
| Russian weekday. Customer: "Можно в субботу в 2 часа дня?" | Date 14/11/2026 (the coming Saturday), "The chat says “в субботу”"; 14:00, "The chat says “в 2 часа дня”"; kids empty | Pass | `814-st-03-ru-weekday-chat.png`, `814-st-04-ru-weekday-book-date-saturday-14-00.png` |
| Thai. Customer: "สวัสดีค่ะ อยากจัดงานวันเกิดลูก วันที่ 15 พ.ย. บ่าย 2 โมง เด็ก 10 คน" | Date 15/11/2026, "The chat says “15 พ.ย.”"; 14:00, "The chat says “บ่าย 2 โมง”"; kids 10 | Pass | `814-st-05-th-chat.png`, `814-st-06-th-book-date-15-nov-14-00-10-kids.png` |
| Thai, a further customer line: "หรือวันเสาร์หน้า 21 พฤศจิกายน 2569 ก็ได้ค่ะ" | Date 21/11/2026, "The chat says “วันเสาร์หน้า 21 พฤศจิกายน 2569”"; 14:00 with no phrase (the later line names no time, and the earlier time belongs to the other day, so the Events module's 14:00 stands); kids 10 | Pass | `814-st-07-th-chat-saturday-21-nov-2569.png`, `814-st-08-th-book-date-21-nov.png` |
| English. Customer: "Hi, can we book a party on Saturday 21 November at 2 pm for 15 kids?" | Date 21/11/2026, "The chat says “Saturday 21 November”"; 14:00, "The chat says “2 pm”"; kids 15 | Pass | `814-st-09-en-chat.png`, `814-st-10-en-book-date-21-nov-14-00-15-kids.png` |

After each Cancel the conversation still had no event (read back through
`GET /api/inbox/conversations/:id`).

The inbox's api has no route that hands back Book Date's reading (it runs in
the browser). The one server read that uses the same shared reader, the BEO
confirmation pick (`GET /api/inbox/conversations/:id/beo-confirmation`),
answered 200 with no message for all four: it needs a team line naming the
date, the time and a count, food or programme, which none of these has.

Seen on the way, outside this ticket: on the Russian weekday chat the inbox
assistant classed the question as a general one (intent "faq") and answered
"бронировать не нужно" and the opening hours.

## The BEO AI Fill in the OTO App

A ZZ TEST event "ZZ TEST 814 date" at Central Floresta, booked for Sunday
15 November 2026 (`POST /api/admin/events`, 201), opened in Studio > Events.
AI Fill, the text pasted: "Подтверждаем день рождения 21 ноября в 14:00, 12
детей, меню: пицца. Депозит получен 9 ноября", Parse with AI (200, one model
call).

| Check | Result | Picture |
|---|---|---|
| The review step shows the Date line "Sat 21 Nov 2026 — the message says …", amber "The event is booked for Sun 15 Nov 2026: not the same day.", unticked | **Not shown.** The review has no Date line and no tick. The summary says "21 November 2026", but the answer carries no `event.eventDate` | `814-st-11-app-ai-fill-review-no-date-line-saved-format.png` |
| Load into Editor without a tick: the date stays 15 Nov | Pass: the form shows November 15th, 2026; the server read 2026-11-15 before Save and after Save | `814-st-12-app-loaded-without-tick-date-stays-15-nov.png`, `814-st-14-app-saved-date-still-15-nov.png` |
| The deposit date is this year's (the fill knows the park's today) | Pass: the form's deposit date is November 9th, 2026; after Save the BEO reads `depositDate: 2026-11-09` | `814-st-13-app-party-details-deposit-date-2026-11-09.png` |
| Tick the date, Load, Save: the date becomes 21 Nov | Not run: there was no tick to press | — |

**Why the Date line is missing.** The park group has its own saved BEO AI
settings (`ai_beo_parsing_advice` and `ai_beo_parsing_output_format`, both
saved on 1 May 2026, on staging since the 9 November restore from production).
A saved output format replaces the built-in one, and this one does not name
`eventDate` or `eventDateText` (read by name only: the values were not printed
or kept). So the model is never asked for the party's date. The run's activity
row says `promptFrom: { advice: setting, outputFormat: setting, model: built_in }`.
The today line is added to the saved advice as designed, which is why the
deposit date came back as 2026-11-09. The setting came from production in
the restore, so production should behave the same: no Date line until the
date fields reach a saved format too (not checked on production here).

## Clean-up, read back (`receipt.json`: `cleanup`, `signOut`)

- The ZZ TEST event: `DELETE /api/admin/events/:id` 204; the event and its BEO
  read 404; no "ZZ TEST 814" event left at Central Floresta.
- The four ZZ TEST conversations were marked handled through the inbox's Mark
  as Handled route (each 200, read back `handled`, no event). This is how the
  SCRUM-660 proof left its conversations.
- Signed out: the inbox and launcher sessions (the inbox's `/inbox/me` and the
  launcher's `/me` answer 401) and the OTO App and launcher sessions (the
  app's `/api/user` and the launcher's `/me` answer 401).
- What stays: the four handled ZZ TEST conversations and their ZZ TEST
  contacts, the team's one Russian reply, the assistant's simulator replies,
  and one `beo_ai_fill` activity row (no message text in it).

The scripts are kept in the scratchpad folder `s814p` (a driver and its steps).
