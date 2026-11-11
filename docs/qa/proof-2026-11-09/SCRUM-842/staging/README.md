# SCRUM-842 — The assistant asks the child's age although the customer's line already says it

**Now passed: see "Re-check after the rule fix" at the end (21:22 Bangkok, commit `8d4a8468`).** First run: staging proof, 11 November 2026, 20:40 to 20:42 Bangkok. **Result: not passed.** The English line and the Russian
line were both answered with the question about the age. The ticket's status was left as it was.

## What was live

- `oto-api-staging` deploy `dep-dbq6np2jnfac73etva9g`: **live** at commit `266830f9`, finished 20:26:13 Bangkok,
  fourteen minutes before the first line was sent.
- `oto-app-staging` deploy `dep-dbq6nr6i0phs73bg2ekg`: **live** at commit `266830f9`, finished 20:24:28 Bangkok.
- Established by the host's control API (each deploy read by its id; it answered normally). There is no
  confirmation by behaviour for the api: the step that would have given it did not pass.

## How it was run

Three fresh ZZ TEST simulator numbers, each named "ZZ TEST 842", wrote one line to "Demo WhatsApp · Central
Floresta" through the inbox's Simulator with no category hint. Each made a new conversation.

## Steps

| Line | The assistant's first reply | Result |
| --- | --- | --- |
| "ZZ TEST do you have drop-off for a six year old?" (English) | "Happy to help! How old is your child?" | **Fail.** It asks the age the line already gives; no price |
| "ZZ TEST у вас есть drop-off для ребёнка 6 лет?" (Russian) | "С удовольствием подскажу! Сколько лет ребёнку?" | **Fail.** The same |
| "ZZ TEST do you have drop-off? we are 6 people" (control) | "Happy to help! How old is your child?" | Acceptable: it asks, and invents no age |

On each thread: intent `drop_off_service`, one reply within seconds of the line, the open question
"asked: child's age · waiting for the answer", the thread moved from General to Reception · Central Floresta.

## Why, as the records show it

- Every one of the three replies carries `askFirstRuleId` on its "AI replied" record, naming the same rule: an
  **approved team rule** for drop-off questions (approved on 4 November) whose ask-first question is
  set to **always** ask "Happy to help! How old is your child?" (with Thai and Russian wordings). The replies are
  that rule's question word for word.
- No `inbox.ai.repeat_guard` row was written for any of the three conversations (0 rows since the run began), and
  the reply records carry no composition figures (`composition.ageQuestions` is absent).
- In the code at this commit the rule's question replaces the assistant's own reply
  (`apps/api/src/services/inbox/ai-engine.ts`, `askFirstOf`), and the repeat guard steps aside for it
  (`apps/api/src/services/inbox/open-question.ts`, `repeatStage`: `if (input.askFirst) return …`). The age the
  customer said is read for the assistant's own reply only; the rule's question never looks at it.

So the fix covers a reply the assistant writes itself, and the staging line is answered by the team rule before
that reply is used.

## Pictures

- `842-01-english-line-age-asked.png` — the English line and the reply asking the age.
- `842-02-russian-line-age-asked.png` — the Russian line and the reply asking the age.
- `842-03-control-six-people-age-asked.png` — the control line; the age is asked, none invented.

In every picture the list of other conversations, the signed-in person's name and avatar and the contact number
are covered.

## Clean-up

The three threads are marked handled; every session is signed out; the browser is closed. No rule was changed.

## Not shown

- What the assistant says after the customer answers the age question.
- The assistant's own reply with the rule out of the way (the rule was not switched off for this run), so the
  fix's own path was not seen on staging.

## Re-check after the rule fix

11 November 2026, 21:22 to 21:25 Bangkok. **Result: passed.** The first run above stays as the record of what was
wrong before this fix.

### What was live

- `oto-api-staging` deploy `dep-dbq7haegekts73el5rug`: **live** at commit `8d4a8468`, finished 21:20:51 Bangkok
  (read by its id from the host's control API: building at 21:16 and 21:18, updating at 21:19, live at 21:21).
  The first line was sent at 21:22:30, more than 90 seconds after it went live.
- Behaviour agrees: the replies carry the new `askFirstSatisfied` field.

### Steps

Four fresh ZZ TEST simulator numbers, each named "ZZ TEST 842", no category hint, each a new conversation. The
team rule for drop-off (`01a1a56c-…`, "always ask the age first") was left approved and unchanged.

| Line | The assistant's first reply | Reply record | Result |
| --- | --- | --- | --- |
| "ZZ TEST do you have drop-off for a six year old?" | "Yes! Our drop-off service is for kids from their 5th birthday, so your little one is all set 😊 It's 225 baht per visit, with our child supervisors on the floor the whole time, regular photo updates for you, help ordering food and a contact person you can call anytime." then a second paragraph offering the nanny service (330 baht per hour at Central Floresta) | `askFirstSatisfied`: rule `01a1a56c-…`, slot `child_age`, reason `already_said`; no `askFirstRuleId`; no open question | **Pass** |
| "ZZ TEST у вас есть drop-off для ребёнка 6 лет?" | "Здравствуйте! Да, конечно 😊 Drop-off — с 5-летия, 225 бат за визит. Наши детские супервайзеры присматривают за ребёнком всё время, помогают с заказом еды и присылают вам фото." then the nanny paragraph | the same: `askFirstSatisfied`, `already_said`; no `askFirstRuleId`; no open question | **Pass** |
| "ZZ TEST do you have drop-off?" (control, no age) | "Happy to help! How old is your child?" | `askFirstRuleId` `01a1a56c-…`; no `askFirstSatisfied`; open question `child_age` | **Pass** (the rule still asks) |
| "ZZ TEST มี drop-off สำหรับลูก 6 ขวบไหมคะ" (Thai) | "มีค่ะ 😊 บริการฝากเด็ก (drop-off) สำหรับเด็กตั้งแต่อายุครบ 5 ขวบ 225 บาทต่อครั้ง …" then the nanny paragraph | the same: `askFirstSatisfied`, `already_said`; no `askFirstRuleId`; no open question | **Pass** (the Thai age was read) |

On every thread: intent `drop_off_service`, the thread moved from General to Reception · Central Floresta, and no
`inbox.ai.repeat_guard` row. The three answers were composed as one message (`composition.joined: true`, two
parts). The full reply texts and records are in `receipt.json` under `recheckAfterTheRuleFix`.

### Pictures

- `842-04-english-answered.png` — the English line answered with the price; no age question.
- `842-05-russian-answered.png` — the Russian line answered.
- `842-06-control-rule-still-asks.png` — the control line; the rule's question still goes.
- `842-07-thai-answered.png` — the Thai line answered.

These pictures only lay boxes over the page (the signed-in person's name and avatar, the contact number, the reply
field) and mask the list of other conversations; the page itself is not rewritten.

### Clean-up

The four threads are marked handled, every session is signed out, the browser is closed. No rule was changed.

### Not shown

- What the assistant says after the customer answers the rule's question on the control thread.
- The other ask-first rules (age rules, nanny booking) were not driven.
