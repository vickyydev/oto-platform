# SCRUM-660 Create BEO with AI Fill: staging proof

Run on 6 November 2026, 11:29-11:51 Bangkok, on the live commit
`f33d7af46ceac37c950d1de708f82b6b9ae1e4e1` (main CI run 42156942116 green on
that SHA, the full OTO App job included). oto-api-staging, oto-inbox-staging,
oto-app-staging, oto-launcher-staging and oto-console-staging were live on it
before the run and on the same deploys after it (`live-before.json`,
`live-after.json`). Nothing was deployed or restarted, and no setting was read
by value or changed.

A real Edge browser (playwright-core, `channel: msedge`) at 1440 and 1920 wide,
in the Bangkok time zone. ZZ TEST records only. No SMS, no WhatsApp send (the
channel account is the simulator "Demo WhatsApp · Central Floresta"), no sale
or payment, no park device (the park's Pi, Till 1 (Pi), Till 2 (test) and
FWBooth1 untouched). No real customer conversation was opened or pressed.

**The model is real.** The OTO App called its default model `claude-opus-5`
with the key already set on oto-app-staging: six calls in all (`staging-proof.json`).
The simulator account's inbox assistant also answered each of the four ZZ TEST
customer messages once inside the simulator (four turns, on the platform's own
assistant, not the OTO App's key).

## Preconditions read back (read-only)

- No AI setting row exists on staging for any park group (`ai_*` keys: none).
  Before this change both AI helpers stopped with "missing setting"; every run
  here used the built-in instructions (`promptFrom: built_in` on each activity row).
- No `beo_ai_fill` activity row and no Create BEO hand-off with `fill` existed
  before the run.
- Central Floresta has active ZZ TEST employees, among them "ZZ TEST Payroll
  GM" (nickname "ZZ GM"), and an active "Event Department".

## The login

"ZZ TEST S660 mw4h6iqe birthdays team": `inbox_agent` at the Birthdays & Events
department only (no assign right) and linked to the OTO App as a manager. Made
as an invited account in a one-off job with an audit row and no SMS, then given
a temporary password from the Console and changed to a random one nobody keeps,
as SCRUM-775's staging proof did. The staging administrator played the four
customer messages through the inbox's Simulator panel.

## What a person sees

| Step | Screenshot |
|---|---|
| The Simulator panel: a ZZ TEST number, "ZZ TEST S660 Birthday EN", Birthdays & Events, English | `s660-st-01-simulator-zz-test-birthday-message.png` |
| Book Date read from the chat (21/03/2027, 14:00, Central Floresta, 12 kids) with the child added | `s660-st-02-book-date-confirm.png` |
| The birthdays-team login on the chat after Book Date: Date Booked, Create BEO, the event chip | `s660-st-03-inbox-chat-with-the-team-confirmation.png` |
| The team's holding reply, then its final confirmation, sent through the inbox composer; Create BEO | `s660-st-03b-inbox-chat-final-confirmation-and-create-beo.png` |
| English: Create BEO opens the BEO form with "AI Fill — Review & Confirm": "Read from the inbox", who sent it and when, the message word for word, "Load into Editor also puts this message, word for word, in Final Message to Parent", the Event Info and Setup Plan read from it | `s660-st-04-create-beo-ai-fill-preview-english.png` |
| The rest of the review: Kitchen Plan, Team (Party Host "ZZ GM (ZZ TEST Payroll GM)" offered and ticked here; "ZZ TEST Mint" and "the Event Department" flagged, nothing assigned), Timeline | `s660-st-05-team-proposals-ticked.png` |
| Load into Editor: the form holds 16:00, 8 adults and the message in Final Message to Parent; "BEO data loaded"; not saved | `s660-st-06-loaded-into-the-form-not-saved.png` |
| The Party Host field names ZZ GM; the Entertainment Host stays empty | `s660-st-07-party-host-assigned-in-the-form.png` |
| The Timeline section: the three lines (14:00 Start, 15:30 Cake, 16:00 End) that Load into Editor created on the server at once, before Save. This is the owner question already recorded, shown as it is | `s660-st-08-timeline-lines-written-at-load-into-editor.png` |
| Thai: the review in the message's own words (summary, menu พิซซ่า and น้ำผลไม้) | `s660-st-09-create-beo-ai-fill-preview-thai.png` |
| Thai, second run: Team row "พิธีกร ZZ GM" flagged as matching nobody; Timeline เริ่มงาน, เป่าเค้ก, จบงาน | `s660-st-09b-ai-fill-preview-thai-team-and-timeline-run2.png` |
| Russian: the review in Russian (summary, activities "ZZ TEST шоу мыльных пузырей") | `s660-st-10-create-beo-ai-fill-preview-russian.png` |
| Russian: Kitchen Plan (пицца, сок), Team "ZZ GM (ZZ TEST Payroll GM)" offered, Timeline Начало, Торт, Окончание | `s660-st-10b-ai-fill-preview-russian-team-and-timeline.png` |
| No confirmation yet: the form opens as SCRUM-775 opens it, with one line: "AI Fill did not run: no message from the team in this conversation names the date, the time and the party details yet." | `s660-st-11-no-confirmation-form-opens-with-one-line.png` |
| The event chip opens the form as before: no AI Fill, no line | `s660-st-12-event-chip-opens-the-form-as-before.png` |
| The BEO editor's paste AI Fill, with no setting saved: the text, then the answer | `s660-st-13-paste-ai-fill-text.png`, `s660-st-14-paste-ai-fill-answers.png` |
| The Events page's AI Event Assistant, with no setting saved: a draft with assumptions and 9 fields, where the tester's photo showed the missing-setting error. Cancelled; nothing created | `s660-st-15-ai-event-assistant-answers.png` |
| The OTO App activity logbook, filtered to BEO AI Fill: five rows, no message text | `s660-st-16-activity-logbook-beo-ai-fill-rows.png` |
| Clean-up through the screens: the BEO editor's archive button, the board after, the handled chat with "Event archived" | `s660-st-17-…`, `s660-st-18-…`, `s660-st-19-…` |

## The real model's answers

| Run | Read in | From press to review | Good? |
|---|---|---|---|
| English inbox fill | 17.2 s | 20.3 s | Good: title, 12 kids, 8 adults, 14:00-16:00, programme, menu, cake time, ready by 13:30, timeline, host "ZZ GM" |
| Thai inbox fill | 16.5 s | 19.3 s | Good on the fields, in Thai; the host came back as "พิธีกร ZZ GM" (the role word kept) |
| Thai inbox fill, second run | 14.9 s | 20.8 s | The same; this run also dropped the "ZZ TEST" tag from the menu item ("พิซซ่า") |
| Russian inbox fill | 13.7 s | 16.2 s | Good: in Russian, host "ZZ GM" matched |
| Paste AI Fill (English) | 15.0 s | — | Good: 12 kids, 5 adults, 14:00-16:00, menu, cake time, decoration |
| AI Event Assistant (English) | 11.3 s | — | Answered: a draft with its assumptions |

The answers are in `fill-answer-*.json` and `helper-answer-*.json`
(`fill-answer-th.json` holds the second Thai run; the first one read the same
fields, with the summary "ยืนยันงานวันเกิด ZZ TEST วันเสาร์ที่ 2027-03-20 …", the
menu "ZZ TEST พิซซ่า" and "น้ำผลไม้", and the same host "พิธีกร ZZ GM").
Nothing came back malformed; no answer was refused by the answer check.

Weak spots seen in the real answers (findings, not hidden):

1. Team names written with a role word or an article in front are not offered.
   The built-in instructions ask for the host "name or role, exactly as written",
   so the model returned "พิธีกร ZZ GM" (Thai, both runs) and "the Event
   Department" (English), and the plain matching found nobody. The safe path
   held: each was flagged and nothing was assigned. A person picks them by hand.
2. Cake type: the messages give a cake time but not who brings the cake. The
   instructions force one of three values, so the model chose "no cake"
   (English, Thai) and "venue provides" (Russian). The review step hides the
   cake type when it is "no cake", so a person sees only the cake time there.
3. The review step shows an empty "Party Details" box when the answer has
   nothing for it (cosmetic).

## Read back (`step10-readback.json`, `cleanup.json`)

- Five `beo_ai_fill` rows, one per fill (English, Thai twice, Russian, paste):
  `outcome: filled`, `source: inbox` with the conversation and message ids (or
  `pasted`), `model: claude-opus-5`, `promptFrom` all `built_in`, the message's
  length, the sections filled and the team counts (English 3 named / 1
  matched, Thai 1 / 0, Russian 1 / 1). No message text in any of them (checked
  against phrases from every message). The no-confirmation press made no model
  call and no row (409 `no_confirmation` in 0.1 s); the AI Event Assistant
  writes no BEO row.
- Six `auth.handoff_issue` rows with `purpose: inbox.create_beo`, all by the
  birthdays-team login, none mentioning a token: five with `fill: inbox` (the
  Create BEO presses) and one without (the event chip).
- What Load into Editor wrote before Save on the English event: three
  timeline rows (offsets 0, 90 and 120 minutes). No party host, setup plan or
  kitchen plan row; the event's adults, decoration and Final Message to Parent
  still empty and its `updated_at` unchanged, because Save was never pressed.
- The platform's pick for each conversation
  (`GET /inbox/conversations/{id}/beo-confirmation`, as the login): the final
  confirmation for English (over the holding reply), Thai and Russian, each
  naming the event Book Date made; `message: null` for the conversation with
  only a holding reply.
- No event was created by the AI Event Assistant.

## Clean-up (`cleanup.json`)

- The four ZZ TEST events are archived with the BEO editor's archive button
  (status still `tentative`).
- The four ZZ TEST conversations are marked handled by the birthdays-team
  login; each keeps its link to its archived event.
- The ZZ TEST S660 login is inactive, with no grants, no live session and no
  app link, and its OTO App user is off.
- What stays: the handled ZZ TEST conversations and their ZZ TEST contacts,
  the archived ZZ TEST events (the English one with the three timeline lines),
  the inactive login and its employee row, the audit and activity rows, and the
  assistant's simulator replies.

## Not proven here

- A real WhatsApp number: the run used the simulator only.
- Saving a BEO filled this way: every form was left unsaved, as planned.

The harness is under `harness/` (readable copies; settings are read by name).
`p4.mjs` meant to keep the first Thai answer under its own file name and did
not, which is why only the second Thai answer file is kept.
