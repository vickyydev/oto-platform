# SCRUM-443 branch chip on staging - capture notes

Captured 8 Oct 2026, about 05:15 to 05:20 Bangkok time. Staging on `c6194664`.
Playwright as the seeded platform admin in a page moved to Demo Branch 2,
Reception Till 1. Nothing committed, Jira not touched.

## What could NOT be shown

The ticket's point is a long park name drawn in full on two lines. Only Demo
Branch 2 may be driven in this run, and its name ("Demo Branch 2") is short, so the
chip draws it on ONE line. A two-line chip needs "Oto Play Park, Central Floresta"
or "Oto Play Park, Robinson Chalong" to be the active park; that means taking a
till at one of those parks, which was out of bounds. The two-line behaviour is
therefore not shown here. Nothing was faked: no response was rewritten.

## Shots (file names all start `SCRUM-443-staging-`)

| File | What the viewer sees | What was done |
|---|---|---|
| `till-header-1600-wide-demo-branch-2.png` | The till header strip at 1600 pixels wide: Oto logo, "0 in park / no gate", the branch chip "Demo Branch 2" on one line with its chevron, then Tickets, F&B, Shop, Events, Check-in, Cash, "Weekday pricing", Reception Till 1, Khun Anan. Nothing is cut or overlapping. TEXT READ-BACK: the chip is 164 by 32 pixels (`getBoundingClientRect`). | Header cropped (top 130 px) from a 1600x900 page. |
| `branch-dropdown-open-park-names-listed.png` | The chip's menu open over the till: "Oto Play Park, Central Floresta", "Oto Play Park, Robinson Chalong", and "Demo Branch 2" with the tick. This is the menu list, not the chip. | Pressed the chip; picked nothing; pressed Escape. |
| `phone-top-bar-390-wide-demo-branch-2.png` | The phone top bar at 390 pixels wide: "0 / no gate", the chip "Demo Branch 2" on one line with its chevron, then the theme and settings icons, over the "Select Customer Type" screen. TEXT READ-BACK: the chip is 142 by 32 pixels. | 390x844 session, waited for the "Reception Till 1 is yours" notice to go, cropped the top 300 px. |

There is no earlier build to compare with, so "unchanged" is not claimed; the
phone bar simply shows one line.

## Not touched

The upright-tablet header overlap (768 to 820 px, SCRUM-505) was not looked at.
