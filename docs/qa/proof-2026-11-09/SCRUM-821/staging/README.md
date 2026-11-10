# SCRUM-821 Book Date reads the whole chat with the model: staging proof

Run on 10 November 2026, 15:20-15:24 Bangkok (the park's today: Tuesday
10 November 2026), on the live commit `c48f8aaa5d42b5cfcc647638545f8bed1843a9a8`.
oto-api-staging and oto-inbox-staging were live on it before the run and on
the same deploys after it (`receipt.json`: `liveBefore`, `liveAfter`). Nothing
was deployed or restarted and no setting was read or changed.

A headless Chromium at 1440 wide, in the Bangkok time zone. The staging
administrator played the team member (owner view in the inbox). Its name, the
other staff names and their initials are masked in every picture. ZZ TEST
records only. The customer side is the simulator account "Demo WhatsApp ·
Central Floresta", with ZZ TEST simulator numbers in the +6689 821 000x
series: nothing reached a real phone, no SMS was sent. Each customer line went
in through the simulator route (`POST /api/inbox/simulator/inbound`) with the
category Birthdays; each team line was typed into the inbox's reply box and
sent with Send. Book Date was opened and cancelled every time, never saved.

## What Book Date showed

| Chat | After the model answered | Result | Pictures |
|---|---|---|---|
| English with typos. Family: "hi, bday for my son Misha (6 yo) on sat 21 novmber at 2pm pls, 12 kds and 4 adust". Team: "Great! 21 November at 14:00 works, 12 children and 4 adults noted." | Date 21/11/2026 "21 November" from the team; 14:00 "14:00" from the team; kids 12 "12 children" from the team; adults 4 "4 adults" from the team; child Misha "Misha" from the family; age 6 "6 yo" from the family | Pass | `821-st-01-en-chat-typos.png`, `821-st-02-en-book-date-reading-the-whole-chat.png` (before), `821-st-03-en-book-date-model-21-nov-14-00-12-kids-4-adults-misha-6.png` (after) |
| Russian with typos. Family: "Хотим день рождения дочки Ани, 5 лет, 15 ноабря в 15:00, 8 детй и 6 взрослх" | Date 15/11/2026 "15 ноабря"; 15:00 "в 15:00"; kids 8 "8 детй"; adults 6 "6 взрослх"; child "Ани" (the chat's own form) "дочки Ани"; age 5 "5 лет"; all from the family | Pass | `821-st-04-ru-chat-typos.png`, `821-st-05-ru-book-date-model-15-nov-15-00-8-kids-6-adults-5.png` |
| Thai. Family: "อยากจัดวันเกิดน้องมีน่า 7 ขวบ วันที่ 22 พ.ย. บ่ายสอง เด็ก 10 คน ผู้ใหญ่ 5 คน" | Date 22/11/2026 "วันที่ 22 พ.ย."; 14:00 "บ่ายสอง"; kids 10 "เด็ก 10 คน"; adults 5 "ผู้ใหญ่ 5 คน"; child "มีน่า" "น้องมีน่า"; age 7 "7 ขวบ"; all from the family | Pass | `821-st-06-th-chat.png`, `821-st-07-th-book-date-model-22-nov-14-00-10-kids-5-adults-7.png` |
| Disagreement. Family: "Hello, we would like a birthday party on 21 November for 10 kids". Team: "sorry, 22 November is what we have" | Both readings took the team's date: 22/11/2026 "22 November" from the team, no choice shown; the family's 21 November appears nowhere in the dialog. Kids 10 "10 kids" from the family; the start time is the Events module's 14:00 with no words | Shown | `821-st-08-dis-chat-family-21-team-22.png`, `821-st-09-dis-book-date-team-22-nov-wins-no-choice.png` |
| Added to show the choice. Family: "Hi, a birthday party on 21 November please, 10 kids". Team: "Sorry, 21 November is full. We have the day after free." Family: "ok, the day after then" | The Date field emptied, "The chat reads two ways: choose one": Sun 22 Nov 2026 "the day after then" from the family (the model), and Sat 21 Nov 2026 "21 November" (the pattern reading, from the team's "is full" line, shown with no source mark) | Shown | `821-st-10-dis2-chat-the-day-after.png`, `821-st-11-dis2-book-date-two-readings-choose-one.png` |

The "before" picture (`821-st-02`) is the dialog while "Reading the whole
chat…" shows: the pattern reading only, date 21/11/2026 "21 November", 14:00
"at 14:00", kids, adults, name and age empty. To catch it, the page's own
`GET …/book-date-proposal` was fetched from the server at once (it took 5.4 s)
and handed to the page after that picture. The other chats ran at natural
speed; the model answered in 2.6 to 3.9 s.

On the Russian chat the pattern reading had no date for "15 ноабря" (the
api's `patternReading.date` is null); the model's reading filled it. After each Cancel the conversation
still had no event (read back through `GET /api/inbox/conversations/:id`).

## The api's answer

`GET /api/inbox/conversations/01a1c48b-ac54-7c44-ae01-a4552f7c7cf2/book-date-proposal`
through the inbox session (the English chat): 200 in 3.0 s, `model: "ai"`.
Date 2026-11-21 "21 November" team; start 14:00 "14:00" team; kids 12
"12 children" team; adults 4 "4 adults" team; child "Misha" family; age 6
"6 yo" family; no park named. The pattern reading beside it: 2026-11-21
"21 November" team, 14:00 "at 14:00".

## Seen on the way

- When the two readings disagree, the pattern's option has no "from the team"
  or "from the family" mark, though the api's `patternReading.source` names
  it (the merge passes `source: null` for the pattern option).
- In the choice chat the pattern reading took the 21st from the team's line
  that says the 21st is full; the model read the agreed day after.
- The Russian child's name is proposed in the chat's own case ("Ани"), not
  the nominative "Аня".

## Clean-up, read back

The five ZZ TEST conversations were marked handled through the inbox's own
route (`POST /api/inbox/conversations/:id/handle`, 200 each); each read back
as handled with no event. The inbox and the launcher were signed out (200);
`GET /api/inbox/me` and the launcher's `GET /api/me` then answered 401.
