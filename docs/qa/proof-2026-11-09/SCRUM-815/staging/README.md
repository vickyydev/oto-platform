# SCRUM-815 The AI Fill review's catalogue section on a pasted text: staging check

Run on 10 November 2026, 04:45-04:49 Bangkok, on oto-app-staging live at
`8b3e36741279a52e87a1fb8723077f02eba0a096`, in the same run as the SCRUM-816
proof (see `../../SCRUM-816/staging/README.md` for the set-up, the event and
the clean-up). Staging administrator, name masked. ZZ TEST event only.

## What was checked

The pasted text named the package, the pizza and the animator: "… Пакет
Birthday package Central Floresta, пицца Маргарита, аниматор Zombie game …".
The check: does the review show the catalogue section (package, set menu and
entertainment matched by id, each with its source mark, the chat's price
beside the catalogue's, "Approve and create")?

| Check | Result | Picture |
|---|---|---|
| The catalogue section in the review of a pasted text | **Not shown.** The review is the free-text "AI Fill — Review & Confirm" with "Load into Editor": no package select, no set menu, no entertainment match, no source marks, no "Approve and create". The answer of `POST /api/ai/parse-beo` has no `review` (keys: summary, event, kitchenPlan, partyDetails, proposals). Both runs alike | `815-st-01-app-ai-fill-pasted-review-no-catalogue-section.png` |
| "Approve and create", then the package module, kitchen plan and entertainment | Not run: not offered | — |

**Why.** In the deployed code the catalogue review is built only on the
inbox's path: `POST /api/events/:id/beo/ai-fill/inbox` reads the park's
catalogue and passes it to the fill, and the editor opens the review only from
that answer (`runInboxAiFill` in `beo-event-editor.tsx`). The pasted path,
`POST /api/ai/parse-beo`, runs the same fill with no catalogue
(`ai-routes.ts`), and the editor always opens the free-text preview for it
(`handleAiFillParse`). So a pasted text never gets the catalogue section; an
event booked from the inbox with a team confirmation would. That path was not
driven here.

## What the free-text fill did with the same words (saved, read back)

After Load into Editor and Save (`GET /api/events/:id/beo`): the POS name
"Birthday package Central Floresta" as text, no package snapshot; the set menu
off, no template; "Margherita pizza" ×1 as a free kids-menu line; no
entertainment selection, "Animator - Zombie game" in Activities. None of it was
matched to a catalogue item.

The event was deleted afterwards (404 read back) and the session signed out
(401), as recorded in `receipt.json`.
