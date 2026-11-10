# SCRUM-831 never ask twice: staging proof

Run on 10 November 2026, 21:39-21:51 Bangkok (14:39:43-14:51:11 UTC), on commit
`cd9e42bf1fe028117f0ba69acba0efbd30b02401`.

| Service | Live deploy before | Live deploy after |
|---|---|---|
| oto-api-staging | `dep-dbpie1mgekts73a23ra0`, `cd9e42bf` (14:19 UTC) | `dep-dbpiqjp42hec73dkksq0`, `cd9e42bf` (14:46 UTC) |
| oto-inbox-staging | `dep-dbpie1rbc2fs73a9surg`, `cd9e42bf` (14:16 UTC) | `dep-dbpiqjp42hec73dkktpg`, `cd9e42bf` (14:43 UTC) |
| oto-console-staging | `dep-dbpiaup42hec73djom1g`, `a80ca263` (14:09 UTC) | `dep-dbpiqk142hec73dkku70`, `cd9e42bf` (14:43 UTC) |

At 14:42:23 UTC a push to main started new deploys of the same code commit on all three services. This run
did not start them. The inbox and the Console went live on them at 14:43 UTC and the api at 14:46 UTC. So
the first two turns of threads A and B ran on the earlier api deploy, and the later turns on the new one.
Both deploys carry the same code. This change has no Console code; the Console is listed only for the record.

The browser was a headless Chromium 153 at 1440×900, light, en-GB, Asia/Bangkok. The staging administrator
came in through the launcher with the owner view in the inbox. Every picture masks that person's name,
avatar and initials, the other staff names, the list of other conversations and every phone-like number.
Each thread was its own ZZ TEST customer on the simulator account "Demo WhatsApp · Central Floresta". Every
line went in through the inbox's own Settings › Simulator · test only dialog with the Category hint
"Birthdays & Events". The assistant was live on that account (`aiMode: live`). Nothing reached a phone.
Console › Health was skipped: this change adds no job.

## Checks

| Step | Check | Result | Value | Picture |
|---|---|---|---|---|
| 0 | api and inbox live on `cd9e42bf` before and after | Pass | see the table above | |
| 0 | Assistant live on Demo WhatsApp · Central Floresta | Pass | `aiMode: live` | |
| A1 | "Hi, we'd like a birthday party for our son (ZZ TEST)": the playbook's combined opener | Pass | reply after 18.6 s, `ai_replied` intent `birthday_party`: "Amazing, thank you! We'd love to organize a party for your son 🎈" + "What date or dates are you thinking of, roughly how many people, and which branch, Central Floresta or Robinson Chalong?" | `831-st-01-opener-asked-lines.png` |
| A1 | Under the opener: date / guests / park "waiting for the answer" | Pass | "asked: the date · waiting for the answer", "asked: how many people · waiting for the answer", "asked: the park · waiting for the answer". The child's age was not asked, so there is no age entry. | `831-st-01-opener-asked-lines.png` |
| A2 | "14 November, about 15 kids, Central Floresta": the entries read answered | Pass | "answered 2026-11-14", "answered 15 kids", "answered Central Floresta". The turn handed the details to the birthday team (`ai_handover`, intent `birthday_details`, reason `OK`) with the closing line "Thank you so much! Our birthday manager will be with you shortly." | `831-st-02-answered-lines.png` |
| A3 | "what time slots do you have?" and "can we bring our own cake?": nothing asked again | Pass (no assistant line) | No assistant line came to either, after 64 s each. After its hand-over the assistant leaves the thread to the team (`aiState: left_for_team`). The entries stay answered. | `831-st-03-no-repeat.png` |
| A3b | Extra, not in the brief: a person pressed Resume, then "Sorry, which time slots are free?" | Pass | `POST …/ai-resume` 200. The assistant took the turn (`ai_handover`, intents `birthday_advice`, `birthday_cake`, reason `OVERRULED_BIRTHDAY`, rule `birthday_advice`) and sent only the closing line. It asked nothing again. Note: the family got the same closing line a second time. | `831-st-06-extra-after-resume.png` |
| A4 | Audit `inbox.ai.repeat_guard` for this thread | Pass | 0 rows. There are also 0 rows across the whole operator since the run began. | |
| A4 | Audit `inbox.ai.open_question` for this thread | Pass | 2 rows: asked `date, guests_count, park`; then answered `date, guests_count, park` | |
| B1 | "Хотим отметить день рождения сына (ZZ TEST)": the opener in Russian | Pass | reply after 13.2 s, `birthday_party`: "…Подскажите, какие даты вы рассматриваете, примерно сколько будет гостей и какой филиал вам удобнее, Central Floresta или Robinson Chalong?". Entries: date / how many people / park waiting. The age was not asked, so "ему восемь лет" was not sent. | |
| B2 | "21 ноября, человек 12, Central Floresta": the entries read answered | Pass | "answered 2026-11-21", "answered 12", "answered Central Floresta". Then a hand-over to the birthday team (`birthday_details`, `OK`) with "Большое спасибо! Наш менеджер по праздникам скоро свяжется с вами." | `831-st-04-ru-answered.png` |
| B3 | "Какое время у вас свободно?" and "Можно принести свой торт?": nothing asked again | Pass (no assistant line) | No assistant line came (`left_for_team`). The entries stay answered. | `831-st-04-ru-answered.png` |
| B4 | Audit for thread B | Pass | `repeat_guard` 0 rows; `open_question` 2 rows (asked date/guests/park, then answered all three) | |
| C1 | "We would like a birthday party for our daughter (ZZ TEST)": the opener | Pass | reply after 13.4 s, `birthday_party`, the same combined question. Entries: date / how many people / park waiting. | |
| C2 | "table for 8? (ZZ TEST)": the guests and age entries must not read answered 8 | **Fail** | The guests entry reads **"asked: how many people · answered 8"**, taken from that line. The date and park entries read "not answered", because the turn handed over (`birthday_details`, `OK`), which closes what is still open. The age was not asked, so the age half could not be checked. | `831-st-05-looks-like-answer.png` |
| C3 | "28 November, about 10 kids, Central Floresta": the entries then read answered | **Not reached** | No assistant turn came (`left_for_team` since C2), so the memory never read this line. The entries stay as in C2: guests 8, date and park not answered. | |
| C4 | Audit for thread C | Pass | `repeat_guard` 0 rows; `open_question` 2 rows: asked date/guests/park, then answered `guests_count` and withdrawn `date, park` | |
| D | The conversation detail carries `openQuestions` | Pass | `GET /api/inbox/conversations/:id` 200 with `openQuestions` (thread A's array below) | |

No assistant line in any thread asked anything a second time, and the repeat guard never fired. That last
point also means this run did not exercise the guard. In each thread the assistant asked its one combined
question. When the family answered, it handed the thread to the birthday team, and after that it does not
write again. The question it might have repeated never came up.

## What did not pass

**C2: a question that holds a number is read as the head-count.** The family wrote "table for 8?". The
guests entry now reads "answered 8". The slot reader in `packages/assistant/src/slots.ts` treats "for" before
a number as a head-count cue (`HEADCOUNT_CUE`), so "for 8" reads as 8 people. A question mark stops only a
bare number ("8?"), not one with a cue. The reader's own comment lists "table for 8?" as *no age*, and that
holds. For the guests question it is read as a count. The model read it the same way: it labelled the line
`birthday_details` ("gives the party basics") and handed the thread over. Two possible fixes:

- the reader refuses a count from a line that asks something; or
- the owner rules that "table for 8?" counts as the head-count, and this check changes.

**C3** follows from C2. Once the thread was handed over, the assistant took no further turn, so the proper
answer was never read. The staff member who picks up the thread sees "how many people · answered 8" under
the opener, not 10.

## Thread A's `openQuestions`, as `GET /api/inbox/conversations/:id` answers it (final read)

| Slot | State | Answer | Asked on | Answered by | Closed |
|---|---|---|---|---|---|
| `date` | answered | `2026-11-14` | the opener's question line (`…0199ff5c0779`) | the family's line 2 (`…7122e8173d92`) | 14:41:32 UTC |
| `guests_count` | answered | `15 kids` | the same line | the same line 2 | 14:41:32 UTC |
| `park` | answered | `central` (the inbox shows "Central Floresta") | the same line | the same line 2 | 14:41:32 UTC |

Thread B: `date` answered `2026-11-21`, `guests_count` answered `12`, `park` answered `central`.
Thread C: `date` withdrawn, `guests_count` answered `8`, `park` withdrawn. `receipt.json` carries every
array after every turn, with ids.

## Audit counts

| Thread | `inbox.ai.repeat_guard` | `inbox.ai.open_question` | `inbox.ai.handover` |
|---|---|---|---|
| A | 0 | 2 (asked 3 · answered 3) | 2 (the details hand-over at A2, then the extra advice hand-over at A3b) |
| B | 0 | 2 (asked 3 · answered 3) | 1 |
| C | 0 | 2 (asked 3 · answered 1, withdrawn 2) | 1 |
| Operator-wide since 14:39:43 UTC | 0 | | |

## Clean-up, read back

- The three ZZ TEST conversations (A, B, C) were marked handled through the inbox's own
  `POST /api/inbox/conversations/:id/handle`. Each answered 200 and reads back `handled`.
- Signed out of the inbox, the Console and the launcher (200 each). Afterwards `/api/inbox/me`, the
  Console's `/api/me` and the launcher's `/api/me` each answer 401.
- The one extra action was the Resume on thread A (A3b), a ZZ TEST thread, which was then handled. No other
  conversation, setting or key was read or changed.
- Nothing was sent to a phone. The simulator account is internal, and no hand-over contact is set on the
  branch: the advice hand-over's pill reads "manager not notified (no contact)".

`receipt.json` holds every route, status and id, each turn's intents and reason, the assistant's lines,
the `openQuestions` arrays after every turn, and the audit rows. It holds no name, number or key.
