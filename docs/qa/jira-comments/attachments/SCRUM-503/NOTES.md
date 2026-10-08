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

---

# Closing retake, 8 Oct 2026, about 07:00 to 07:55 Bangkok time

Staging on `c6194664`. Demo Branch 2, the Demo counter box and Reception Till 1
attached to it (see the SCRUM-217 and SCRUM-502 folders for how the box, its
simulated devices and the prepaid-meal child were set up). Signed in as the
seeded platform admin. Nothing committed, Jira not touched. The first pass's
single picture (Console Devices with no box) stays; it is the state before this
pass.

## The three asks

| Ask | Result |
|---|---|
| The Console's Go offline switch ON for the Demo counter box, with a band scan answered from the box lane, then switched back OFF | DONE. Go offline pressed at 07:38 and 07:43 (and earlier at 07:01, 07:05, 07:15 and 07:20 for the other runs); the till showed "Working from the box alone - no internet - console", and the band scan was answered by the box (the allergy alert and the prepaid entitlement came from the box's copy). The switch was put back OFF with Go online at 07:47. A later read (text) of the till showed no "box alone" banner, and the three meals the box had sold (D2-000019, D2-000021, D2-000023) were `finalised` on the platform. |
| The counter refusal starting "This counter's box" | NOT REACHED. The refusal was drawn, but it leads "The platform refused this order:" (picture below). See finding 1. |
| The prepaid meal line legible on the order panel | The meal's NAME is legible (dark ink). The badge and the two small texts on the same line are not; see finding 2. |

## Shots (file names start `SCRUM-503-staging-`)

| File | What the viewer literally sees | What was done |
|---|---|---|
| `console-devices-demo-counter-box-offline-go-offline-switch-on.png` | Console Devices at Demo Branch 2, "1 box - 1 online - 3 stations": the box card "Demo counter box" (VIRTUAL, virtual-1, 4 devices - 2 stations, up 1h 45m) with an amber warning "Online - heartbeat 3m old" instead of the usual green; the three stations (Demo Booth 1, Reception Till 1, ZZ TEST Kiosk 1) and the paired kiosk "last seen 1h 27m ago". The page itself does not say the switch is on; the next picture does. | Taken about three minutes after the 07:43 Go offline (the card itself says heartbeat 3m old; file time 07:46), not four. |
| `console-box-drawer-offline-go-offline-succeeded-in-history.png` | The box drawer scrolled to Controls (Test print, Apply config, Collect logs, Clear cache, Restart agent, Go offline, Go online) and "Command history": succeeded Go offline 07:43, succeeded Go online 07:40, succeeded Go offline 07:38, Print kids' wristband 07:28, Drawer kick 07:27, Print receipt 07:27, Go online 07:25, Go offline 07:20. Header "Online - heartbeat 3m old". The newest press is Go offline, so the switch is ON. | Opened the box, Refresh. |
| `band-scan-answered-from-box-lane-prepaid-meal-line-offered.png` | The F&B screen with the banner "Working from the box alone - no internet - console - What still works": a red "ALLERGY / MEDICAL ALERT - ZZ TEST MEAL CHILD 502 - None (ZZ TEST)", a lilac "PREPAID ENTITLEMENTS - ZZ TEST MEAL CHILD 502 - ZZ TEST Toastie, 1 left", the menu (Food, Drinks, Light Bites, ZZ TEST Toastie ฿90), the band chip "ZZ TEST Meal Child 502 - ฿0 credit - #D2-2YCJ8M" and, on the customer pane, "Welcome back, ZZ TEST Meal Child 502! Your credit balance ฿0". | The band's code typed into "Wristband code" and Load Tab pressed with the switch on. Typed, not scanned with a device. That the BOX (not the platform) answered is inferred from the "Working from the box alone" banner on the till and from the SCRUM-502 finding that the box lane did not know a child until after a Go online; no picture names who answered. |
| `box-lane-prepaid-meal-line-on-order-panel-before-it-is-served.png` | A box-lane order panel: the entitlement now reads "Served" (it is in the cart), and the order line "ZZ TEST Toa..." with a lilac gift icon, an empty lilac bar where the badge is, "Already paid at check-in" and "฿0" in pale lilac on lilac. The big customer pane lists "ZZ TEST Toastie ฿0, ฿90 base". | The third run's stale browser, before the meal was served by the other two. |
| `prepaid-meal-line-on-order-panel-platform-lane.png` | The same line on the platform lane (no banner): the name in dark ink, the badge a blank lilac bar, "Already paid at check-in" and ฿0 pale. | Said to be the first look at the tab, before the switch was used: not supported. The file time is 07:06, after Go offline was pressed at 07:05 (the go-online picture's command history lists it, with a Go online at 07:04 before it; a 07:01 press is from the notes, not a picture), and the band-scan picture is from the same minute. What this picture shows is only that the till has no "Working from the box alone" banner at that moment; that it was the platform lane is read from the missing banner, not from anything named in the picture. |
| `box-lane-stale-cart-requoted-after-meal-served-note-leads-the-platform-refused.png` | The stale browser after the meal was served elsewhere and an espresso (ZZ TEST Espresso ฿60) was added: a rose note "The platform refused this order: ZZ TEST Meal Child 502B's prepaid ZZ TEST Toastie has already been served." with "Fix this to charge - the sale would be refused for the same reason.", a second note "Priced on this till. The platform did not price this cart.", the Charge button greyed at ฿60; banner "Working from the box alone - no internet - console". | Third run, switch on. |
| `console-box-drawer-go-online-pressed-switch-back-off.png` | The drawer at Command history with "succeeded Go online - just now - queued 8 Oct, 07:47" at the top, over the earlier Go offline rows. | Switch back OFF. The header read "Offline - heartbeat 4m old" when the press was made; a few minutes later the till showed no banner and the meals had synced (text read-back from the till and the sales list, not pictured). WHAT THE PICTURE DOES AND DOES NOT SHOW: it shows the Go online command as succeeded at 07:47 (the command history, the newest row). It does not show the box back to normal: in the same picture the drawer header reads "Offline - heartbeat 4m old" in red, the box card behind it "Offline - heartbeat 4m old" and the page header "1 box - 0 online - 3 stations", because the box had stopped heartbeating while the switch was on. Read on its own the picture can look like the opposite of its file name; the "back to normal" half is the text read-back above. |

## Findings

1. **The box's refusal is drawn with the platform's name.** On the stale cart
   above, the till was on the box lane and the request it sent was the box's:
   TEXT READ-BACK from the browser's own requests while the espresso was added:
   `POST /api/box/v1/station/:id/intents` answered 409, and there was no
   `/api/sales/quote` request at all. Yet the note leads "The platform refused this
   order:", not "This counter's box refused this order:". By a read of the code
   (no edit): `lib/cartQuote.ts` `quoteErrorOf` marks a refusal the box gave
   (`answeredBy: 'box'`), but the F&B station (`pages/OrderStation.tsx`, line 303)
   and the Shop station (`pages/MerchStation.tsx`, line 169) both price through
   `useItemCartQuoteWithPromos` in `lib/itemPromoQuote.ts`, which has its own
   `quoteErrorOf` (line 36) with no such mark. So the live counter screens cannot
   say the box. Not changed here.
2. **The prepaid line is only half legible.** The meal's name takes the panel's own
   ink, as intended, but the badge reads as an empty lilac bar, and "Already paid at
   check-in" and "฿0" are pale lilac on a lilac tint. On the order-confirmed card
   (SCRUM-502 folder) the PREPAID badge and ฿0 are the same.
3. **While the switch is on the box card is not labelled offline.** It stays "Online"
   with an amber "heartbeat 3m old"; "Offline" only appears after about four or five
   minutes of silence (two reads said "Offline - heartbeat 4m old" and "5m old" when
   the drawer was opened). Nothing on the card or in the drawer's header says the
   switch is on; the command history is the only place.
4. The box found a newly checked-in child only after a Go online (SCRUM-502 folder,
   problem 1).

## Left on staging

The Demo counter box is ONLINE (switch off) and was not archived. The records are
those listed in the SCRUM-217 and SCRUM-502 folders.
