# SCRUM-817 A day or time in a birthday thread stays with the party: staging proof

Run on 10 November 2026, 12:38-12:43 Bangkok, on the live commit
`17d16c9d26a86bf8a610d6fbc6fe90a16f62bffe`. oto-api-staging was live on it
before and after the run (`receipt.json`: `liveBefore`, `liveAfter`).
oto-inbox-staging serves the inbox screens and was live on `8b3e3674`; the fix
is in the api. Nothing was deployed or restarted and no setting was changed.

A headless Chromium in the Bangkok time zone. The staging administrator played
the team member in the inbox (owner view); its name and the other staff names
and initials are masked in every picture. The customer side is the simulator
account "Demo WhatsApp · Central Floresta" with four ZZ TEST numbers
(+6689 817 0001 to 0004): nothing reached a real phone. Each customer line went
in through the Simulator panel's own route (`POST /api/inbox/simulator/inbound`).
The birthday threads were played with the category Birthdays & Events; the
control thread had no category, so the inbox filed it under General
(Reception · Central Floresta). The live assistant (AI mode "live") answered
every line within about 12 seconds.

## What the pictures show

| Picture | Thread | The customer's day-or-time line | The assistant's answer | Pass |
|---|---|---|---|---|
| `817-st-01-ru-birthday-thread-saturday-2pm-stays-birthday.png` | Birthdays & Events, Russian | "Можно в субботу в 2 часа дня?" after the birthday opener | The birthday manager's closing line ("Наш менеджер по праздникам скоро свяжется с вами"), handed over to Birthdays & Events | Yes |
| `817-st-02-ru-general-thread-saturday-2pm-gets-hours.png` | General, Russian (control) | "Вы открыты в субботу в 2 часа дня?" | The opening hours, as before ("в субботу мы открыты ... с 10:00 до 20:00") | Yes |
| `817-st-03-th-birthday-thread-saturday-2pm-stays-birthday.png` | Birthdays & Events, Thai | "เสาร์นี้บ่ายสองได้ไหมคะ" after the birthday opener | The birthday flow: it notes the day and asks for the number of guests and the branch | Yes |
| `817-st-04-th-birthday-thread-reply-end.png` | The same Thai thread, scrolled to its end | | The birthday flow's whole second answer | Yes |
| `817-st-05-ru-birthday-thread-date-only-first-line.png` | Birthdays & Events, Russian, the case as first seen on staging | "Можно в субботу в 2 часа дня?" as the only line | A party answer asking how many guests | Yes |

No answer in a birthday thread gave the opening hours or said that no booking
is needed.

## The assistant's own record

Read through the inbox api as the team member
(`GET /api/inbox/conversations/:id`, the timeline's assistant pills):

- Russian birthday thread: the opener `ai_replied`, intent `birthday_party`;
  the Saturday line `ai_handover`, intent `birthday_details`, reason `OK`,
  rule none, to Birthdays & Events with the birthday closing line.
- Control: `ai_replied`, intent `hours`, filed under General.
- Thai birthday thread: both turns `ai_replied`, intent `birthday_party`.
- Date-only birthday thread: `ai_replied`, intent `birthday_party`.

The model itself read every birthday-thread date as the party's, so the
server's overrule (reason `OVERRULED_BIRTHDAY`, rule `birthday_date`) had
nothing to correct in this run and did not fire. That overrule is covered by
the unit and api tests in the commit.

## Clean-up, read back

- The four ZZ TEST conversations were marked handled through the inbox's own
  Mark as Handled route: each answered 200 and reads back as `handled`.
- Signed out of the inbox and the launcher: both 200; afterwards
  `/api/inbox/me` and the launcher's `/api/me` answer 401.
