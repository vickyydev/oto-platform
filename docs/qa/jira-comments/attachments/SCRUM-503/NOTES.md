# SCRUM-503 counter smalls on staging - capture notes

Captured 8 Oct 2026, about 05:10 to 05:25 Bangkok time. Staging on `c6194664`.
Playwright as the seeded platform admin; Demo Branch 2 only. Nothing committed,
Jira not touched.

## Result: none of the three requested pictures could be taken

| Wanted | Why not |
|---|---|
| The counter-box refusal starting "This counter's box refused this order" | The wording only appears when the counter's BOX answers the refusal (`answeredBy: 'box'`). Demo Branch 2 has no box: the till says "Reception Till 1 is yours - No box is assigned to this station yet, so nothing will print." The only running virtual box belongs to Central Floresta (slot virtual-1), where the payment run `0d008153` lives, and a station can only sit on a box of its own park, so it could not be used. |
| The Console box "Go offline" switch ON, then a band scan answered by the box | Same: there is no box at Demo Branch 2, so there is no switch to turn on. |
| The prepaid meal line legible on the order panel | A prepaid meal needs a band that holds one. The F&B demo band "Kai #1007 - Prepaid food" is a prototype fixture whose prepaid items (Chicken Nuggets, Fresh Orange Juice) are not on Demo Branch 2's menu, so tapping the ZZ TEST items never makes a prepaid line. A real prepaid meal comes from a supervised stay: a drop-off booking with a signed form, checked in, with a band code; the till says "No bookings are waiting to be checked in" and the ticket sale at this park printed no band codes (no box). Not built up in this run. |

## What was captured

| File | What the viewer sees | What was done |
|---|---|---|
| `SCRUM-503-staging-console-devices-demo-branch-2-no-box-so-no-go-offline-switch.png` | Console > Devices with the branch picker on Demo Branch 2: "0 boxes - 0 online - 2 stations", "No box at this branch yet - Add one to get a claim code; the Pi redeems it the first time it boots on site." Stations: Demo Booth 1 (BOOTH, "on Demo booth box") and Reception Till 1 (TILL, "no box assigned"). This is the evidence for the blocker, not for the fix. | Opened Console Devices and chose Demo Branch 2. Nothing pressed. |

## To finish

Give Demo Branch 2 a box (a virtual-box slot beside the demo park, or a Pi
claimed with a code), assign Reception Till 1 to it, then: send an order the box
refuses (see the counter's note), switch the box offline in Devices and scan a
band, and sell a prepaid meal through a supervised stay.
