# SCRUM-815 The AI Fill review in edit mode: staging checks

Two runs. The first (13:44-13:53 Bangkok) is the whole chain from the inbox;
the second section below is the earlier check on a pasted text.

## Run 2: Create BEO from the inbox (10 November 2026, 13:44-13:53 Bangkok)

Live: oto-api-staging and oto-inbox-staging at `17d16c9d`, oto-app-staging at
`8b3e3674` (a deploy of `608e3c0b`, not started by this run, went live on the
app at 13:53:09, after the clean-up). The staging administrator through the
launcher, in the inbox as the team member; names masked in every picture. The
ZZ TEST conversation (Russian, Central Floresta, simulator channel) and Book
Date are in `../../SCRUM-812/staging/README.md`: the event was booked there
for 21 Nov 2026, 14:00, 10 kids.

| Step | Result | Picture |
|---|---|---|
| Create BEO: `POST /api/inbox/conversations/:id/open-beo` (aiFill) → 200; a new tab; the OTO App's hand-off `POST /api/auth/handoff` → 200; the BEO editor opened on the booked event and ran `POST /api/events/:id/beo/ai-fill/inbox` → 200 in 14.3 s (one model call). It read the whole conversation (4 messages) and took the team's confirmation as the ruling message | Pass | — |
| The review opens in edit mode with the catalogue ("AI Fill — Review, edit and approve") | Pass | `815-st-02-inbox-create-beo-review-edit-mode-whole.png` |
| Event Info: child Миша, Date "Sat 21 Nov 2026 — the message says «21 ноября»" with "The same day the event is booked for." (no amber, no tick box), 10 children, 4 adults, start 14:00 | Pass | `815-st-03-review-event-info.png` |
| Package: "Birthday package, Central Floresta" (said: "Пакет Birthday package Central Floresta"), catalogue ฿16,900 / ฿20,900; add-ons at 0 | Pass | `815-st-04-review-package.png` |
| Kitchen plan: set menu "Birthday set menu, Central Floresta"; Pizza → **Margherita** (CF-24), Hot dish → Chicken schnitzel (CF-37), Waffles or pancakes → Waffles (CF-4), Drinks pitcher → Juice; Fried rice not chosen (the chat names none); cake: the park's cake, "Торт-мороженое от парка", 15:30 | Pass. French fries and fruit skewers are the set menu's "Always" items, so they need no choice | `815-st-05-review-kitchen-plan.png` |
| Entertainment: **Zombie game** ×1, catalogue ฿4,000 | Pass | `815-st-06-review-entertainment.png` |
| Deposit: paid 3,000 THB, Received ticked, dated 09/11/2026 | Pass | `815-st-07-review-deposit.png` |
| Source marks | Every filled field says "from the team". None says "from the family": the team's confirmation repeated everything the family said, and it wins | all of the above |
| The chat's price beside the catalogue's | Not shown: the chat names no price for the package or the animator (only the deposit), so there was nothing to set beside the catalogue's | — |
| Approve and create: `POST /api/events/:id/beo/ai-fill/approve` → **200**, written: event, package, set menu with 4 choices, cake, 1 entertainment, deposit. The rest of the fill then opened in the preview of before (title, booking name, activities, party details, timeline); it was closed without loading | Pass | `815-st-08-after-approve-rest-of-fill-preview-not-loaded.png` |
| Read back through the OTO App's routes: event 21 Nov, 14:00, 10 / 4, child Миша; package snapshot "Birthday package, Central Floresta", 10 kids and 4 adults included; kitchen plan set menu on, the same template, cake INTERNAL 15:30; set-menu selection Margherita, Chicken schnitzel, Waffles, Juice; entertainment Zombie game (฿4,000); billing deposit paid 3,000 on 2026-11-09, and Party Details prepayment 3,000 dated 2026-11-09; Final Message to Parent is the team's confirmation word for word | Pass | `815-st-09-beo-package-module-after-approve.png`, `815-st-10-beo-kitchen-plan-after-approve.png`, `815-st-11-beo-party-details-deposit-after-approve.png` |
| The party through the api (`GET /api/parties/:id`): plan present, planStatus **ready**, 21 Nov 14:00, package Floresta 10 / 4, expected 10 / 4, Zombie game, the set menu with Margherita | Pass | — |

Seen on the app at `8b3e3674`, already changed on main but not deployed there:

- The package module's breakdown reads "Package Total: ฿0.00", and Party
  Details reads Total 0฿ with Outstanding −3,000฿ (`815-st-09`, `815-st-11`).
  Main has `a090e96b` (the package total reads the package's price for the
  party's day).
- The till's party plan reads the deposit as 0 (`settlement.depositSatang: 0`)
  while billing holds 3,000 paid. Main has `a84ceb2b` and `d9a49816` (one
  deposit, read by the till wherever the BEO or the event entered it).

Clean-up (read back): the event deleted (204, then 404 for the event, its BEO
and its package snapshot; the party 404), the conversation marked handled, and
every session signed out (401). Details in `receipt.json` under `inboxRun`.

## Run 1: the catalogue section on a pasted text

Run on 10 November 2026, 04:45-04:49 Bangkok, on oto-app-staging live at
`8b3e36741279a52e87a1fb8723077f02eba0a096`, in the same run as the SCRUM-816
proof (see `../../SCRUM-816/staging/README.md` for the set-up, the event and
the clean-up). Staging administrator, name masked. ZZ TEST event only.

### What was checked

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

### What the free-text fill did with the same words (saved, read back)

After Load into Editor and Save (`GET /api/events/:id/beo`): the POS name
"Birthday package Central Floresta" as text, no package snapshot; the set menu
off, no template; "Margherita pizza" ×1 as a free kids-menu line; no
entertainment selection, "Animator - Zombie game" in Activities. None of it was
matched to a catalogue item.

The event was deleted afterwards (404 read back) and the session signed out
(401), as recorded in `receipt.json`.
