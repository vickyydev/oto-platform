# SCRUM-842 — The assistant asks the child's age although the customer's line already says it

Staging proof, 11 November 2026, 20:40 to 20:42 Bangkok. **Result: not passed.** The English line and the Russian
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
