# SCRUM-745 local proof: the language button beside "Your Order"

Run on 4 November 2026 at about 15:40 Bangkok on the isolated till harness
(disposable seeded database, local API and POS, Edge):

```
POS_E2E_SHOTS=<folder> pnpm --filter @oto/pos e2e e2e/display-language-button.spec.ts
```

A walk-in ticket (1 Hour Play) is put on the till so the built-in customer display
shows its order screen. The display is switched through its own button to Thai,
Russian, Chinese, French and English in turn, and for each the button's box and the
`Your Order` heading's box are measured on the screen: they never meet, the heading
ends before the button starts, and the button stays on the screen. Passed at 1440,
1024 and 768 px wide (768 is the narrowest width that still shows the display beside
the till; below it the phone till has no built-in display pane).

| Screen | Width | Language |
|---|---|---|
| `s745-1440-th.png`, `s745-1440-ru.png`, `s745-1440-en.png` | 1440 | Thai, Russian, English |
| `s745-1024-th.png`, `s745-1024-ru.png`, `s745-1024-en.png` | 1024 | Thai, Russian, English |
| `s745-768-th.png`, `s745-768-ru.png`, `s745-768-en.png` | 768 | Thai, Russian, English |

At 768 px, in every language shown, the park's name and the order heading each take
two lines: `Oto Play / Park` and `Your / Order` in English, `Oto Play / Park` and
`Ваш / заказ` in Russian, the Thai name and `คำสั่งซื้อของคุณ` in Thai. All of them are
whole and uncovered. The display pane is about 384 px wide there, and the button now
takes its own room in the header row instead of floating over the heading, so English
and Russian most likely fit on one line at this width before the change (reasoned from
the pane width, not measured on the earlier build). At 1024 and 1440 px every language
keeps the name and heading on one line each.

Every other display screen (membership, welcome, details, payment, thank you) keeps
the button in its corner, where its heading is centred
(`apps/pos/test/s745-display-language-button.test.ts`).

The `Reception Till 1 is yours` notice in the lower right is the till's own station
notice after sign-in, not part of this change.
