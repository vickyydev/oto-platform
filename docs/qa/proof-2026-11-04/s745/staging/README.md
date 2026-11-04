# SCRUM-745 staging proof, 4 November 2026

Run at 21:01 to 21:02 Bangkok (14:01 to 14:02 UTC) in the same Edge session and on
the same ZZ TEST till as the SCRUM-741 proof (`../../s741/staging/README.md` has the
fixture, the live readback and the cleanup). Live commit:
`ba64e70baf91b0de9146e644672dfa82fcee78d7` on oto-pos-web-staging
(dep-dbljebavcj2c738r8u8g) and oto-api-staging (dep-dbljebavcj2c738r8t90).

The till showed its built-in customer display beside it ("Test harness — staff till
and customer display share one live sale"). A ZZ TEST walk-in ticket (Skip — walk-in
(Tourist), 1 Hour Play, ฿1,040) put the display on its order screen. The display was
switched through its own button to Thai, Russian and English in turn; for each, the
button's box and the heading's box were measured on the screen. The ticket was then
cancelled: no payment.

| Width | Language | Screen | Heading box, button box (x, width) | Seen |
|---|---|---|---|---|
| 1440 | Thai | [screen](s745-st-1440-th.png) | 1197 + 120, 1333 + 75 | `คำสั่งซื้อของคุณ` whole, button `ไทย` to its right in the same row |
| 1440 | Russian | [screen](s745-st-1440-ru.png) | 1196 + 90, 1302 + 106 | `Ваш заказ` whole, button `Русский` to its right |
| 1440 | English | [screen](s745-st-1440-en.png) | 1202 + 93, 1311 + 97 | `Your Order` whole, button `English` to its right |
| 768 | Thai | [screen](s745-st-768-th.png) | 578 + 67, 661 + 75 | Heading on two lines, whole; button to its right, on the screen |
| 768 | Russian | [screen](s745-st-768-ru.png) | 566 + 48, 630 + 106 | `Ваш / заказ`, whole; button to its right |
| 768 | English | [screen](s745-st-768-en.png) | 574 + 49, 639 + 97 | `Your / Order`, whole; button to its right |

In all six the boxes never meet, the heading ends before the button starts, and the
button stays inside the window (`receipt.json` in the SCRUM-741 folder, `steps.s745`).
768 is the same till window narrowed to an upright iPad's width.

A screen other than the order: [the "Are you a member?" screen at 1440](s745-st-1440-00-membership-screen-corner-button.png)
keeps the language button in its top-right corner, above the centred heading, as before.

Seen at 768 but not part of this change: with the built-in display shown, the staff
side's left column (`Configure: 1 Hour Play`, `Add Another Ticket`) is squeezed under
the Current Order panel. The local proof noted the same ("the till's own layout, not
this check's"). It is the test-harness split view; a separate display device does not
share the window.

## Jira

SCRUM-745 got the seven screens attached and one plain comment (13471) showing them
with how to retest. It was walked to Deployed (`node scripts/agent/jira.mjs walk
SCRUM-745 Deployed`, one commit link added) and read back as Deployed
(`jira-publication.json`).
