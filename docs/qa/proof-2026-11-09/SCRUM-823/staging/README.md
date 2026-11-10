# SCRUM-823 advice questions to a person: staging proof, part 1 — the rule

Run on 10 November 2026, 20:48-21:13 Bangkok, on commit
`a80ca26308b3965e721f409aa413387bb386750d`. Before the run, all four services were live on it:

| Service | Live deploy before | Live deploy after |
|---|---|---|
| oto-api-staging | `dep-dbphti5g1s2s738g02og` (13:44 UTC) | the same |
| oto-inbox-staging | `dep-dbphtj6tlv9c73fkk6q0` (13:41 UTC) | `dep-dbpiaup42hec73djom50`, same commit (14:09 UTC) |
| oto-console-staging | `dep-dbphtjetlv9c73fkk86g` (13:41 UTC) | `dep-dbpiaup42hec73djom1g`, same commit (14:09 UTC) |
| oto-app-staging | `dep-dbphtim1egvs73c63dsg` (13:43 UTC) | the same |

At 14:08:59 UTC a redeploy of the same commit started on the api, the inbox and the Console. This run did
not start it. By then every rule check had been made. The api's redeploy was still rolling out at the end
of the run, and the earlier api deploy stayed live (`receipt.json`: `liveAfter`). Nothing was deployed,
restarted or reconfigured by this run.

This part proves the rule. The notification half (the OTO App bell) runs later. The platform's OTO App key
does not yet hold `notifications:write`, so in this run **every bell notice was expected to fail**, and the
pill was expected to say "manager not notified". Both came out that way, and the table marks them Pass
(expected).

The browser was a headless Chromium 153 at 1440×900, light, en-GB, Asia/Bangkok. The staging administrator
came in through the launcher: owner view in the inbox, administrator in the Console. Its name, avatar and
initials are masked in every picture, as are the other staff names, the list of other conversations and
every phone-like number. The customers were the simulator account "Demo WhatsApp · Central Floresta", with
one ZZ TEST number per thread. Each line went in through the inbox's own Settings › Simulator · test only
dialog with the Category hint "Birthdays & Events". The assistant was live on that account. Nothing reached
a real phone: the simulator is internal, and on staging the phone ping is only written to the log.

## Set-up (step 1)

In Console › Branches › Oto Play Park, Central Floresta › Edit:

- **Birthday manager on duty**: "ZZ TEST Birthday Manager", OTO App user id
  `00000000-0000-4000-8000-000000000823`, a ZZ TEST phone, WhatsApp.
- **GM contact**: "ZZ TEST GM", OTO App user id `00000000-0000-4000-8000-000000000824`, a ZZ TEST phone,
  Telegram.

Both user ids are made up; no such user exists. They are there so that a bell notice is written and tried
for each person. With the field left empty, only the phone row would exist. The phones are masked in the
picture and in the receipt.

## Checks

| Step | Check | Result | Value | Picture |
|---|---|---|---|---|
| 0 | api, inbox, Console and OTO App live on `a80ca263` | Pass | all four live on it before and after | |
| 0 | Assistant live on Demo WhatsApp · Central Floresta | Pass | aiMode `live` | |
| 1 | Both contacts filled and saved in the Console | Pass | `PATCH /api/branches/:id` 200 | `823-st-01-branch-contacts.png` |
| 1 | `GET /api/branches` as administrator: both contacts present, phone in E.164 | Pass | birthday manager `+66*****0823`, WhatsApp; GM `+66*****0824`, Telegram; both the numbers entered | |
| 1 | Leak check: `GET /api/branches` as the reception account | Pass | 200, both contacts `null` (reception holds `admin:branch:read`, not `admin:branch:update`); signed out, read back 401 | |
| 2 | Thread A "Which branch would you recommend for a party of 12 kids?": the family gets only the birthday team's closing line | Pass | one assistant line, "Thank you so much! Our birthday manager will be with you shortly." (`closing_birthday`); no recommendation, no branch named | `823-st-02-advice-handed-over.png` |
| 2 | Thread A is in the Birthdays & Events queue and the turn reads `birthday_advice` | Pass | category `birthdays`, team Birthdays & Events; `ai_handover` intents `["birthday_advice"]`, reason `OK` | |
| 2 | Thread A's pill | Pass | "AI handed over to the team · birthday advice · manager not notified (sending failed)" | `823-st-02-advice-handed-over.png` |
| 3 | Thread B "Do you have parking at Central Floresta?": a fact is still answered | Pass | `ai_replied`, intent `directions_parking`, "Yes! Parking is free at Central Floresta 😊"; no hand-over, no notice | `823-st-03-fact-still-answered.png` |
| 4 | Thread C "We want a birthday party for our daughter. What would you suggest?": handed to Birthdays & Events | Pass | `ai_handover` intents `["birthday_advice"]`; manager not notified (sending failed) | `823-st-04-opener-not-sent-advice-handed-over.png` |
| 4 | Thread C: the date-and-park opener goes out beside the hand-over | **Fail** | No opener was sent. The model read the message as advice only (`["birthday_advice"]`, no `birthday_party`), so there was no opener to keep. The family got only the closing line. | `823-st-04-opener-not-sent-advice-handed-over.png` |
| 4b | Extra thread C2, not in the brief: "We would like to book a birthday party for our son. Which package would you recommend?" | **Fail** | No opener here either. The model read both parts (`["birthday_advice","birthday_party"]`) and decided to hand over itself (reason `OK`, rule `null`). The server keeps the opener only when the model chose to answer (`openerBesideAdvice` in `packages/assistant/src/advice.ts` requires `action === 'answer'`), so only the closing line went. | `823-st-04b-extra-party-and-advice-opener-not-sent.png` |
| 5 | Thread D (Russian) "Посоветуйте, какой филиал лучше для 10 детей?" | Pass | only "Большое спасибо! Наш менеджер по праздникам скоро свяжется с вами." (`closing_birthday`); intents `["birthday_advice"]`; manager not notified (sending failed) | `823-st-05-ru-advice-handed-over.png` |
| 6 | Thread A bell notice (app) | Pass (expected) | `failed`, `OTOAPP_SCOPE_REQUIRED`, 1 attempt | |
| 6 | Thread A phone notice (WhatsApp) | Pass (expected) | `skipped`, `PING_NOT_LIVE` | |
| 6 | Thread A pill: manager not notified, with the reason | Pass (expected) | `notNotified: true`, `notNotifiedWhy: failed` → "manager not notified (sending failed)" | |
| 6 | Console › Health: `job:inbox.handover_escalation` present and running | Pass | "ok · every 1m"; read twice a minute apart, 13:55:25 then 13:56:25 UTC | `823-st-06-health-escalation-job.png` |
| 7 | Thread A untouched for 16 minutes: escalated once | Pass | audit `inbox.handover.escalate` at 14:06:25 UTC (15 min 55 s after the hand-over); before it, the notices were app `failed` and WhatsApp `skipped` | |
| 7 | Thread A escalation rows | Pass (expected) | app `failed` `OTOAPP_SCOPE_REQUIRED`; Telegram `skipped` `PING_NOT_LIVE` | |
| 7 | Thread A pill: GM not notified, with the reason | Pass (expected) | "AI handed over to the team · birthday advice · manager not notified (sending failed) · GM not notified (sending failed)" | `823-st-07-escalation-after-15-min.png` |
| 7b | Extra: a hand-over a person handles within 15 minutes never escalates (thread C2, handled at clean-up 12.5 minutes after its hand-over) | Pass | `pickedUpAt` 14:07:48 UTC, no escalation row, GM not told | |

Two notes on the pill:

- It says "to the team", not "to Birthdays & Events". Each thread was already in the Birthdays & Events
  queue through the Category hint, so the hand-over moved nothing (`reroutedTeamId: null`). The thread's
  category and team read `birthdays` / Birthdays & Events throughout.
- The words "birthday advice" appear on the hand-over pill itself. That pill sits inside the timeline's
  collapsed group line, so each picture shows the group opened, as a press on that line would.

## The notice rows, as recorded

The pill's source is the conversation detail's `handoverNotices`
(`GET /api/inbox/conversations/:id`). The api exposes only the result (who was notified, or why not), not
the rows. The rows below were read three ways:

- the audit row `inbox.handover.escalate`, which lists the notices' states at the moment of escalation;
- the api's own warning line "an inbox hand-over notice could not be sent", kept to the notice id, the
  channel and the code;
- one read-only `SELECT` of `inbox.handover_notification`, run as a Render one-off job on
  oto-api-staging (`job-dbpic108v5cc73eblsjg`). It left out the `target` column, so no app user id and no
  number were read.

| Thread | Kind | Channel | State | Code |
|---|---|---|---|---|
| A, C, D | notice (birthday manager) | app (bell) | failed | `OTOAPP_SCOPE_REQUIRED` |
| A, C, D | notice (birthday manager) | whatsapp | skipped | `PING_NOT_LIVE` |
| A, C, D | escalation (GM) | app (bell) | failed | `OTOAPP_SCOPE_REQUIRED` |
| A, C, D | escalation (GM) | telegram | skipped | `PING_NOT_LIVE` |
| C2 | notice (birthday manager) | app / whatsapp | failed / skipped | as above; picked up 14:07:48 UTC, never escalated |
| B | — | — | — | no rows: a fact answered is not a hand-over |

Thread C escalated at 14:06:25 UTC and thread D at 14:07:25 UTC, each 15 minutes after its hand-over, in the
same sweep as thread A or the next one.

**Why the bell waits.** The bell call reached the OTO App, and the app refused it with `scope_required`:
the platform's directory key does not hold `notifications:write` yet. Once the owner grants that permission,
part 2 repeats the advice hand-over with a real OTO App user id and expects the bell row `sent` and the pill
"manager notified HH:MM". The phone ping stays `skipped` / `PING_NOT_LIVE` until a WhatsApp or Telegram
sender that delivers is switched on; the notice sender only writes a hashed recipient and the message's
digest to the log.

## What did not pass

**The opener beside advice (step 4).** In neither attempt did the family get the date-and-park question:

- **Thread C** (the brief's wording): the model labelled the line `birthday_advice` only. With no
  `birthday_party` part in the turn, there was nothing to keep.
- **Thread C2** (extra wording): the model labelled both parts but chose to hand over itself. The server's
  rule (`openerBesideAdvice`) keeps the opener only when the model's own decision was to answer.

In both threads the advice reached a person and the rule otherwise held. The family simply was not asked
for the date and the park first. Fixing this needs a code or prompt change: either the gate also keeps the
opener when the model hands over a turn that holds `birthday_party`, or the model is told to answer the
opener and leave the advice to the gate.

## Clean-up, read back

- The five ZZ TEST conversations (A, B, C, C2, D) were marked handled through the inbox's own
  `POST /api/inbox/conversations/:id/handle`. Each answered 200 and reads back `handled`.
- The two contacts were cleared in the same Console editor (fields emptied, Save branch). The
  `PATCH /api/branches/:id` sent `null` for both and answered 200. `GET /api/branches` now reads
  `birthdayManagerContact: null` and `gmContact: null`, as before the run, and the other branch has none.
- Signed out of the inbox, the Console and the launcher (200 each). Afterwards `/api/inbox/me`, the
  Console's `/api/me` and the launcher's `/api/me` each answer 401. The reception account's own session
  was signed out at once, and its `/api/me` read back 401.
- No other conversation or branch was touched, and no setting or key was read or changed.

`receipt.json` holds every route, status and id, the turns' intents and reasons, the `handoverNotices`
reads, the audit rows, the warning lines and the notice rows. It holds no name, number or key.
