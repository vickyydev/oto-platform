# SCRUM-832 follow-ups — staging check, 11 November 2026

Staging api live on `601dc16495c0f3d51bbf1d227b644419634fd7de` (deploy `dep-dbq2ei8n74is739h1uqg`, live 15:33 Bangkok).
Driven through the inbox's own simulator as the staging administrator; every thread is a `ZZ TEST 832fu`
simulator contact, marked handled afterwards. Details in `receipt.json`.

| Step | Where | Result |
|---|---|---|
| A English birthday line | Demo WhatsApp · Central Floresta (a park's own number) | Pass on the repeat (`fu-a-english-park-number.png`): one message, date and people, no branch question. The first attempt, 46 s after the deploy turned live, still asked the branch (`fu-x-first-attempt-english.png`). |
| B Russian birthday line | same number | Pass on the repeat (`fu-b-russian-park-number.png`): one message, whole sentence, no branch question. The first attempt, 53 s after live, still asked the branch (`fu-x-first-attempt-russian.png`). Thai also passes (`fu-b-thai-park-number.png`). |
| C control | Demo Facebook (no park) | Pass (`fu-c-control-general-number.png`): date, people and branch asked in one message; the park is recorded as an open question. |
| D one-line hand-over | — | Not shown: it needs the closing templates switched off. Covered by the engine tests (inbox-ai-one-message). |

Not seen on staging:

- The new `messages` value in the coherence record. No turn in this run was a reviewed one: every record read
  `{ state: "skipped", reason: "NOT_MIXED" }`, or was absent on a silent hand-over.
- The park-clause cut itself at work. In the passing threads the assistant did not write the branch question
  at all (`composition.parkQuestions` 0), so there was nothing to cut. Run locally on the two first-attempt
  replies, the landed cut removes the branch clause from both.

The two first attempts are read as answered by the previous instance while it drained after the deploy;
that is an inference from the timing and the local check, not something observed.

Also noticed, outside this change: a nanny question and a socks + lost jacket question on the park's number
were handed over with no message to the customer (reason `SILENCE_POLICY`).
