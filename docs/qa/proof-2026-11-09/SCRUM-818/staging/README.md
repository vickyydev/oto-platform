# SCRUM-818 AI Fill's pasted message is matched to the catalogue: staging proof

Run on 10 November 2026, 14:23-14:31 Bangkok, on oto-app-staging and
oto-api-staging both live at `608e3c0ba23e385a6ffd0eac34421196a57ca6a6`
(Render deploys `dep-dbpcagu417fc739h23ug` and `dep-dbpcagu417fc739h22vg`; the
app's `/api/qa-reports/config` answered the same version). Nothing was
deployed or restarted and no setting was changed. A headless Chromium at 1440
wide, in the Bangkok time zone, signed in as the staging administrator (global
admin; its name is masked in every picture). ZZ TEST records only; no SMS.
One model call for this ticket (three in the whole run).

Before the run: no "ZZ TEST 818" event at Central Floresta and no "ZZ GM"
employee was left from the earlier attempt (`receipt.json`: `leftBehindBefore`).

## The run

A ZZ TEST event "ZZ TEST 818 party" at Central Floresta, Saturday
21 November 2026 at 14:00, 12 children and 6 adults (`POST /api/admin/events`
201), opened in Studio > Events, AI Fill, the message pasted:
"Подтверждаем день рождения Миши 21 ноября в 14:00, 12 детей, 6 взрослых.
Пакет Birthday package Central Floresta: пицца Маргарита, куриный шницель,
картофель фри. Торт в 15:30. Аниматор: Zombie game. Ведущий: ZZ GM. Депозит
3000 бат получен 9 ноября." Parse with AI: `POST /api/ai/parse-beo` 200 in
13.8 s, the answer carrying a review with `origin: "pasted"`.

| Check | Result | Picture |
|---|---|---|
| The catalogue review opens in edit mode, not the free-text one | Pass: "AI Fill — Review, edit and approve", every field editable, "Approve and create" and "Load into Editor instead" | `818-st-01-pasted-review-whole.png` |
| The header names the pasted message | Pass: "Read from the pasted message. The pasted message is read as the team's confirmation and matched to the park's catalogue." | `818-st-02-review-read-from-the-pasted-message.png` |
| Sources "from the team" | Pass: every filled field carries "from the team" | `818-st-01`, `818-st-03` to `818-st-07` |
| The Floresta package | Pass: "Birthday package, Central Floresta", catalogue ฿16,900 / ฿20,900, "Пакет Birthday package Central Floresta → Birthday package, Central Floresta" | `818-st-04-review-package.png` |
| The set menu with Pizza → Margherita | Pass: "Birthday set menu, Central Floresta"; "пицца Маргарита → Margherita (CF-24)"; also "куриный шницель → Chicken schnitzel (CF-37)" | `818-st-05-review-kitchen-plan.png` |
| Zombie game | Pass: Entertainment "Zombie game" ×1, catalogue ฿4,000 | `818-st-06-review-entertainment.png` |
| Deposit 3,000 on 2026-11-09 | Pass: 3000 THB, Received ticked, 09/11/2026 | `818-st-07-review-deposit.png` |
| Approve and create | Pass: `POST /api/events/:id/beo/ai-fill/approve` 200 on the same event, written: event, package, set menu (2 choices), cake, entertainment 1, deposit | — |
| Package snapshot read back | Pass: Birthday package, Central Floresta; the event reads 12 children / 6 adults; the package includes 10 / 4 | `818-st-08-package-module-after-approve.png` |
| Kitchen plan with Margherita | Pass: set menu on, kids' menu Margherita (Pizza), Chicken schnitzel (Hot dish), fries, veggie sticks, fruit skewers; the set-menu selection reads Pizza → Margherita | `818-st-09-kitchen-plan-after-approve.png` |
| Zombie game selection | Pass: one entertainment selection "Zombie game" | — |
| The deposit | Pass: billing deposit paid 3,000 on 2026-11-09; Party Details 3,000 / 2026-11-09; the event's Prepayment 3,000 / 2026-11-09 | — |

## Notes

- The review proposed "The park's cake" for "Торт в 15:30" (the catalogue
  read answered INTERNAL, while the form's own read answered NOT_SAID). The
  Floresta package includes the park's ice-cream cake, so the model may have
  read it from the package; the paste on its own (`SCRUM-787` folder) was not
  guessed.
- On a paste that names no entertainment the review says "The conversation
  names no entertainment." (`SCRUM-787/staging/787-st-01-cake-review-whole.png`):
  the word is the inbox's, not "the pasted message".
- After Approve and create, the rest of the fill opened in the preview (title,
  activities, party details, team, timeline) and was closed without loading.

## Clean-up, read back (`receipt.json`: `cleanup`, `signOut`)

- The three ZZ TEST 818 events (`party`, `thai`, `cake`) deleted:
  `DELETE /api/admin/events/:id` 204 each; the event, its BEO and the api's
  party read 404 for each; no "ZZ TEST 818" event left at Central Floresta.
- The ZZ TEST employee "ZZ GM" deleted: `DELETE /api/employees/:id` 204, then
  404; no active "ZZ GM" left.
- Signed out: the app's `/api/logout` 200 and the launcher's sign-out 200; the
  app's `/api/user` and the launcher's `/api/me` then answer 401.
