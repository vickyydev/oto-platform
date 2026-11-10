# SCRUM-787 A cake time with no word of whose cake it is leaves the cake type: staging proof

Same run as `SCRUM-818/staging` (10 November 2026, 14:23-14:31 Bangkok,
oto-app-staging live at `608e3c0ba23e385a6ffd0eac34421196a57ca6a6`, the
staging administrator, name masked).

A ZZ TEST event "ZZ TEST 818 cake" at Central Floresta (Saturday 21 November
2026, 10 children, 4 adults). Its BEO cake type was set to EXTERNAL (the
family's own cake) beforehand: `PUT /api/events/:id/beo/kitchen-plan`
`{ cakeMode: "EXTERNAL" }` 201, read back EXTERNAL with no time. Pasted in AI
Fill: "Подтверждаем день рождения 21 ноября в 14:00, 10 детей. Торт в 15:30."

| Check | Result | Picture |
|---|---|---|
| The review shows the cake time | Pass: Cake time 15:30, notes "Торт в 15:30", "from the team" | `787-st-01-cake-review-whole.png` |
| The cake type line says "not said" | Pass: the cake select reads "Not said" and the line "Not said who brings the cake: the BEO keeps its own cake type (the family's own cake)." The answer's catalogue cake has `mode: null` | same |
| Approve and create keeps EXTERNAL | Pass: approve 200 (written: event, cake); the kitchen plan reads `cakeMode EXTERNAL`, `cakeTime 15:30`, notes "Торт в 15:30" | `787-st-02-cake-after-approve-rest.png` (the rest of the fill that opened next) |
| Load into Editor and Save keep EXTERNAL | Pass: the rest loaded, the title stayed "ZZ TEST 818 cake", Save `PUT /api/events/:id/beo` 200; the kitchen plan still reads EXTERNAL, 15:30; the editor's Cake block shows "Own Cake" selected with Cake Time 15:30 | `787-st-03-kitchen-plan-after-save.png` |

## Note

- On the SCRUM-818 paste (which also names the Floresta package, whose
  included lines hold the park's ice-cream cake), the same words "Торт в
  15:30" were proposed as "The park's cake" by the catalogue read. That BEO's
  type was No Cake beforehand, and the approval wrote INTERNAL. Whether a
  package that includes a cake counts as "said" is for the owner.

Clean-up: see `SCRUM-818/staging/README.md`.
