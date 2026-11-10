# SCRUM-832 — one combined message per turn, the park first: staging proof

**When:** 11 November 2026, 00:41–00:54 Bangkok (2026-11-10 17:41–17:54 UTC).
**Where:** staging — the api at `ba3f25bb4` (deploy `dep-dbplcit6e07s73dbih6g`, live 17:41:19 UTC); the inbox and the Console at `9b2bd8bc1` (the inbox app is untouched by this change).
**How:** one headless Chromium (Playwright), the staging administrator through the launcher, handed into the inbox; every customer line sent through the inbox's own **Settings › Simulator · test only** dialog into the simulator account **Demo Facebook** — an operator-wide number with NO park (the account the owner's own case needs), Category hint General, the assistant live on it — each thread from its own fresh ZZ TEST number. Reads through the inbox api (`GET /api/inbox/conversations/:id`, `/messages`) and the audit. Pictures masked: the list of other conversations, names, initials, phone-like numbers.
**Record:** `receipt.json` (routes, statuses, ids, every turn's intents, `composition`, the open questions and the events; no name, no number).

## Results

| Thread | Line | Expected | Got | Result |
|---|---|---|---|---|
| **T** (Thai) | "ไปหาที่ไหนคะ" | the park question alone, recorded for the memory | ONE bubble, the persona's Thai park question — the model had written two bubbles (`composition.bubbles: 2`, `parkFirst: true`); the line under it reads "asked: the park · waiting" | **Pass** (picture 1) |
| T | "เซ็นทรัลค่ะ" | read as the answer; the way in + parking in ONE bubble; the park set | the memory reads "answered Central Floresta"; **branch set to Central Floresta by AI**, the thread moved to Reception · Central Floresta; ONE bubble of three parts (where, the way in, the parking), `bubbles: 3, joined: true, repeats: 0` | **Pass** (picture 1) |
| **N** | "Hi! How do we find you at Robinson Chalong?" | answered at once in ONE bubble, no park question, the park set | ONE bubble (the way in + "parking at the mall is free"), `askBranch: false`, `joined: true`; branch set to Robinson Chalong by AI | **Pass** (picture 2) |
| **H** | "What time do you open?" | answered at once (the same hours at both parks), no park question | "Both our parks … 10:00–20:00 …" in one bubble, no question | **Pass** (picture 3) |
| H | "Is there parking?" | answered at once | "Yes! Parking is free at both malls" | **Pass** |
| **P** | "How to find you guys?" | the park question alone | **the GM's holding line** — `ai_handover`, reason `GROUNDING_MISSING`: the model asked the park ALONE and cited nothing, and the (older) grounding gate refused a reply with no source before the new step ran; the thread went to the GM's queue | **FAIL → fixed** (below) |
| P | after Resume, "Central" | ONE bubble; the park set | ONE bubble of three parts (`bubbles: 3, joined: true`), the parking said once; the park NOT set, because the thread is now a GM thread (the park is set on General threads only) — a consequence of the first line | one message **Pass**, the park a consequence of the fail (picture 4) |

The repeat guard fired 0 times. The open-question audit on T: `asked [park]` then `answered [park]`.

## The fail, and the fix

The model's bare park question — "Which park are you planning to visit, Central Floresta or Robinson Chalong?" and nothing else, as the prompt allows on a general enquiry with no park — states no fact, but the grounding gate (gate 4, older than this change) asked it for a cited source and refused it as `GROUNDING_MISSING`, handing the family to the GM. The 823/831 lanes never met it because the model usually writes the locations beside the question (as on the owner's screenshots, and as it did on the Thai thread here).

Fix (lane/parkask832b-20261111): `bareParkQuestion` in `packages/assistant/src/gate.ts` — the model asked which park and nothing else (`askBranch` and every bubble a sentence that asks only the park), for a park-dependent enquiry (address, directions, hours; a greeting aside) on a general thread with no park known (not the thread's, not named by the model, not answered this episode) — needs no source; `parkFirst` in `compose.ts` then sends it as the playbook's own park question with the slot recorded (`composition.parkFirst: true`). Everywhere else the gate reads a source-less reply as before (a known park, a birthday or GM thread, a café question, a fact beside the question: still `GROUNDING_MISSING`). Tests: the bare question in en/th/ru (the persona's wording and the model's own) → the park question; the seven unchanged cases; through the engine, staging's exact case (the bare question, nothing cited → the park question with the open row, no hand-over, the thread General; "Central" → one message, branch set by AI, the memory answered).

## Clean-up

The four ZZ TEST threads marked handled through the inbox's own route; sessions signed out and read back (401). No other conversation, setting or key was read or changed. Nothing was sent to a phone or a page: the simulator account is internal.
