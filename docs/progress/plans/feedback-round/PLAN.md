# The feedback round — the 8 November topics built (12 November 2026)

The owner's go, 12 November: build, test, deploy and prove every change noted from the
8 November feedback, each deployed by name as it finishes and proved on staging, with a
hunt for defects across the till before the demo at the park. CI never gates a ticket.

## Lanes

| Lane | Ticket | What it builds | Surface |
|---|---|---|---|
| lane/dropnumber863-20261112 | SCRUM-863 | The drop-off and nanny forms ask for and confirm the messaging number again, as the prototype does | till, shared |
| lane/membertier858-20261112 | SCRUM-858 | A verified member sees only their own rate | till |
| lane/payscreen859-20261112 | SCRUM-859 | The customer's payment screen shows the order lines | till, shared |
| lane/contacts860-20261112 | SCRUM-860 | Create a contact and edit a contact's name | api, inbox |
| lane/voidslip861a-20261112 | SCRUM-861 part 1 | VOID and UPDATED slips to the kitchen and the bar | api, box agent |
| lane/dropband861b-20261112 | SCRUM-861 part 2 | A wristband printer role for drop-off bands, kids printer as fallback | db, api, box agent, console |
| lane/dropcancel862-20261112 | SCRUM-862 | Cancel a waiting drop-off booking; earlier days leave the list | api, till |
| (after SCRUM-863 lands) | SCRUM-857 | Staff screen mirrors every family form live; Done without the receptionist; the photo on the paired display | till, shared |

Each lane: build with tests, two independent reviews, a fix round, then land fast-forward,
deploy the changed services by name, prove on staging with ZZ TEST records, post the
pictures and walk the ticket to Deployed.

## Held for the owner

- SCRUM-857: where the second number comes from; whether drop-off belongs in the inbox;
  automatic check-in (members have none today, so "the same as members" has no model).
- SCRUM-862: who may cancel a waiting booking (built as: whoever may register one).
- SCRUM-861: the park's box needs a release for the new printer role and slips; the box
  is not touched in this round.

## The defect hunt

Five read-only readers, one per area (ticket sale; drop-off and nanny; the customer
display; food, shop, party and History; trouble such as a double tap or a lost
connection), each finding checked by a second reader. Confirmed findings are fixed in
this round or ticketed.

## Interruption on 12 November, 03:33

Every agent stopped at once on the account's usage limit, a few minutes after launch.
Nothing was lost: SCRUM-863's unfinished edits were intact in its lane and its agent was
resumed; the other lanes had not yet written code and were relaunched with a script that
continues from whatever a lane already holds and commits each step.

## State at 04:11 on 12 November

- SCRUM-863 landed (b0b645939, follow-up 0a7a9c7ce: an ordinary group is not asked the
  number on a paired display) and is deployed to both till services and the api; its
  staging proof is running. Ticket in Testing.
- SCRUM-857 is building in lane/dropflow857-20261112, four parts in order: the number
  confirmed, the staff mirror of every family form, the photo on the display, Done
  without the receptionist. Owner's answers: the second number is the form's own field;
  drop-off in the inbox is not needed now; automatic check-in is researched, not built
  (two readings, one question for Maria or Tom, on the ticket).
- SCRUM-862: whoever may register a child may cancel a waiting booking, with a log
  (owner's answer).

## The defect hunt's outcome: SCRUM-864 and its subtasks

Sixteen points confirmed by a second reader, eight set aside (five are prototype rules,
noted for the owner on SCRUM-864).

| Lane | Tickets | What |
|---|---|---|
| lane/salefu865-20261112 | SCRUM-865, 866, 867, 868 | A corrected order after Pay replaces the first sale; the shop lets go of a cleared sale; the payment screen keeps its method; an expired rate confirmation says so |
| lane/displayfu869-20261112 | SCRUM-869, 870 | The paired display holds the order while a price refreshes; it returns to welcome when staff leave the Tickets tab |
| lane/dropfu871-20261112 | SCRUM-871, 872, 873 | Each child written once on a retry; saved children matched; the nanny's name carried |
| lane/historyfu876-20261112 | SCRUM-876, 877 | A party settlement left open can be cancelled; a part-paid food or shop sale can be refunded from History |
| with SCRUM-857 | SCRUM-874, 875 | The family's form survives a connection drop; the screen says why Done is not available |
| not started | SCRUM-878 | A staff session ending in a long shift: plan on the ticket, session length is the owner's decision |

## Second wave, 12 November 13:00 (all on Opus)

| Lane | Tickets | What | Workflow run |
|---|---|---|---|
| dropconfirm857, dropflow857, dropphoto857, dropdone857 | SCRUM-857 (with 874, 875) | Part 1 number confirmation lands first; parts 2 live mirror, 3 the family's photo, 4 the family's Done are joined, reviewed twice and fixed | wf_a4c5373d-1aa |
| settle889-20261112 | SCRUM-889, 890, 891 | An open party settlement resumes on its party page; History says part-paid; one refund status | wf_f18a81db-8c4 |
| printfollow-20261112 | SCRUM-898, 899, 900 | Console station form never opens stale after a save and the server refuses an older version; a printer needs an address; a refund tells the till when a VOID slip could not go | wf_303b010e-e75 |
| lanefollow897-20261112 | SCRUM-897 | After an online drop-off sale, promo usage, wallet credit, the box note and held sales follow where the sale is | wf_324bffac-42f |
| smallui885-20261112 | SCRUM-885, 888 | A just-created member's greeting (prototype first); the Cancel booking button fits at 1680 | wf_b2b1f4cf-74e |
| hunt/xland-20261112 (report only) | none yet | A defect hunt across today's landings, where lanes touched the same files | agent |

Queued behind SCRUM-857 because they edit the same form or till layout: SCRUM-893 (allergies box opens the on-screen keyboard), 894 (short screen keeps the typed field in view), 884 (split view at 1440). Waiting for the owner: SCRUM-878 (session length), 892 (phone QR size), 895 (proved only on the real Pi), 896 (webcam permission choice).

## Third wave, 12 November afternoon (the owner's new items, all on Opus)

| Lane | Tickets | What | Workflow run | State at 16:20 |
|---|---|---|---|---|
| beofill903 | SCRUM-903 | BEO fill Phase A: runs on the whole chat, shows the chat's words per value | wf_10ea937e-f48 | landed 4cdcf5d1b, proof running |
| beofill904 | SCRUM-904 | BEO fill Phase B: every field read from the whole chat | wf_628ff791-10b | building, restart queued |
| beomenu905 | SCRUM-905 | The till's menu picked in the BEO's kitchen and bar plan; Phase C follows | wf_7af2dded-e03 | fix round, restart queued |
| kitchenplan906 | SCRUM-906 | The whole kitchen plan reaches the till | wf_783981c9-4d3 | building |
| (after 906) | SCRUM-907 | A manager or admin edits the kitchen plan on the till and the BEO is updated | none yet | not started |
| twilio908b | SCRUM-908 | WhatsApp test line through Twilio's sandbox | wf_464e50f9-607 | second review |
| xland | SCRUM-909, 911, 912, 913, 916 | Defect-hunt fixes; the bundled Thai font | wf_3d07866e-685 | fix round |
| printfollow | SCRUM-898, 899, 900 | Console station form, printer address, refund slip notes | wf_303b010e-e75 | landed 7cb06ac6c, proof queued |
| lanefollow897 | SCRUM-897 | Promo use, hold sale and held sales after an online drop-off sale | wf_324bffac-42f | landed 079b94314, proof running |
| smallui885 | SCRUM-885, 888 | First-visit greeting; Cancel booking fits | wf_b2b1f4cf-74e | Deployed |
| settleresume889 | SCRUM-889, 890, 891 | Settlement resumes on the party page; Partly paid; one refund status | wf_f18a81db-8c4 | Deployed |

The plans the owner approved, with his words and the findings they rest on:
`docs/progress/plans/beo-inbox/BEO_FILL_FROM_CHAT_2026-11-12.md`,
`docs/progress/plans/beo-inbox/KITCHEN_PLAN_AND_POS_2026-11-12.md` and
`docs/progress/plans/inbox-build/WHATSAPP_TEST_LINE.md`. The main app's go-live
is run by a separate session from `docs/handover/GO_LIVE_MAIN_APP_PROMPT.md`.

How to restart a stopped run: the top block of `docs/progress/STATUS.md` for
12 November 16:20 (exact-copy scripts in `C:/oto-lanes/_resume/`).

Filed from proofs and reviews and not yet being built: SCRUM-901 (a long
check-in label beside Cancel booking), 902 (a part-paid sale names its balance
on Pay and on its History card), 910 (a refunded party's deposit: the owner's
rule), 914 (the number tick returns on the split screen), 915 (the phone till
and a drop-off child on their own), 917 (smaller points from the 889 proof),
918 (add-on cards in the split view), 919 (the Thai font check).

## The money and refund screens lane landed (12 November 20:40, main 963605c97)
Tickets: SCRUM-934, 933, 936, 935, 902, 938 and part of 917. Services: the platform and both tills; no migration; the counter box needs nothing.
Low points left by the reviews: the F&B and Shop panels, History's extra-time block, the phone drop-off child detail, the phone F&B order station, booking redeem and the phone End of Day and Performance tabs still write baht by hand; the tender panel and the display's payment stage always print two places; History treats any sale whose note reads "Party: ..." as a party settlement; each parties-list row makes two platform reads; a nanny fee shared by several children is not named.

### Questions for the owner from this lane (the build uses the first reading in each)
1. Before Settle party, the party page shows the platform's own Settle party price (the package plus add-ons and extras, with a new row "Add-ons and extras"). It replaces the OTO App's bill total whenever the party has a plan. Should a non-zero OTO App total win instead?
2. For a planned party not yet settled, Take balance now opens Settle party instead of the tab's balance window. Is that the flow you want?
3. The parties lists now ask the platform for each unsettled party's price (two reads per row each time a list opens). Is that fine, or should the day's events read carry the figure?
4. On refund rows and item cards the child's name comes first ("Mint · 1 Hour Play · 1 ppl"). Is that order right?
5. A part-paid History card shows "Balance due", the balance, and "of ฿total" on three small lines; on narrow cards the badge sits above the figure. Acceptable?
6. Some new words are not the prototype's: "Add-ons and extras", "Not settled · ฿X", "Take it with Settle party on a counter till's party page.", "What this party owes could not be read from the platform…". Are they all right?
7. A party with an OTO App total of 0 that already has walk-ups or money on its tab: the platform refuses Settle party, so the page reads the tab's bill, which can say Fully paid while the package is unpaid. How should the package be taken for these parties?
8. While the platform cannot price a party, Take balance stays off even if the tab has its own charges (before, those could be taken). Should they stay takeable?
9. Should the tender panel, the display's payment stage, F&B, Shop, End of Day and the booking site move to the same money format (two places only when there is satang)?
10. Should a resumed sale's Pay button show a dash while its balance loads, instead of a stand-in amount?

## The printers and print lines lane landed (12 November 21:04, main d880f8f30)
Tickets: SCRUM-930, 931, 932. Services: the platform, both tills and the Console; no migration; the counter box needs nothing.
Left: the Health page's summary dot for a printer with no address; the phone till counts the drop-off child but does not say "Prints at check-in"; a few comments still say "Credit Grants to Print"; the till's station save sends no Idempotency-Key (older).

### Questions for the owner from this lane
1. The F&B credit prints on the one receipt and the paid screen now says "Credit Grants Issued". Keep it that way, or bring back a separate credit slip per wallet as the prototype printed?
2. The desk till now counts a drop-off child's bracelet and adds the new line "Prints at check-in", matching the customer display; the same line shows for a nanny child and a self-sufficient registered child. Are these words right?
3. The drop-off bracelet printer card shows on ticket tills, drop-off tills and tills with nothing ticked, and is hidden on F&B-only and parties-only tills (its printer is kept when hidden). Should the card show on every till, as the Console's form does?
4. A till save made after someone saved the same station in the Console is refused with "changed since you opened it, close it and open it again". Is that right at the till?
5. The till's printer cards list printers that have no address, while the Console greys them out as unusable. Should the till grey them too?
6. An empty address on a device that is not a printer is now saved as "no address" (before, it was refused). All right?
7. A printer with no address shows red "not set up" in the Console's box drawer. Right?
8. Should staging's Robinson Chalong "Receipt Printer 1" be given an address, or left for you to set?
9. Is the example address 192.0.2.10:9100 all right in the Console's hint and placeholder?
10. On a till that does only F&B or only parties, a save at the till now keeps the kids, adult and drop-off printers whose cards are hidden; before, the kids and adult printers were cleared. For information.

## The family's form lane landed (12 November 21:42, main 03fc3f75f)
Tickets: SCRUM-893, 894, 914, 915, the lock-screen part of 942, and 943. Services: the platform and both tills; no migration. The counter display takes everything from the web deploy; only the lock screen's "The family has pressed Done" line on Till 1 (Pi) needs the counter box's next release.
Left: a lost Done or Ask the team reply still shows the older Retry banner in the page flow; the camera report is marked sent when sent, not when the till takes it; the keyboard is letters only.

### Questions for the owner from this lane
1. On the phone till the family's form opens on the phone itself, handed to the parent, and the parent gives the number-confirmation tick there. Keep?
2. On the phone, the family's Done goes to the next step (Review, or the nanny step), not straight to payment. Do you want straight to payment?
3. A phone till with a display paired to its station keeps the form on the phone, and the display shows "Please follow the staff screen". Keep?
4. The display cannot tell when the till is locked, so "Thank you. The team will be with you in a moment." shows whenever the family's Done is waiting for the till (under a second on an unlocked till). Keep?
5. Do you want the till kept awake while a family fills the form (SCRUM-942), or is the lock screen's line enough?
6. On the paired display a complete number drops the 0 after +66, matching the till's copy and the board; the till's own customer half still shows it as typed with the stored form beside it. Should the half follow the display?
7. Is this staff line right: "The display does not take the photo at this station. Take each child's photo with the family here, in Private child details."? It also shows on Till 1, where the display is never asked for photos.
8. On screens shorter than 700 pixels the form's subtitle is hidden and the keys are slightly shorter (also the first screen's nickname keys). The standing counter display is unchanged. Keep?
9. The on-screen keyboard has letters only: a family cannot type "2 puffs", "peanuts, eggs" or Thai on the counter display. Do you want a fuller keyboard?
10. On the board only a new number is checked against the messaging rule, and the warning appears whenever the number or channel changes. Keep?
11. The automatic resend with no Retry applies only to the family's typing; a lost Done or Ask the team keeps the Retry banner. Keep?
12. On the till's read-only copy Continue is greyed out together with Done, Back and Ask the team. Keep?
13. On the phone the wide button under the family's form reads "Return phone to staff" and only hands the phone back. Keep, hide it until the form is done, or make it register the children when the form is complete?
14. The till's customer half stops at the display's lengths (500 for allergies, 200 for dietary) only when the on-screen keys are on. Cap it with a real keyboard too?
15. On the parent's check-in screen on the phone (a dark screen) with the light staff theme, the camera notice now shows as a pale panel; both lines read. Keep, or keep the old amber look there?

## The split-view lane landed (12 November 22:47, main 013e97348)
Tickets: SCRUM-884 (staff screens fit the split view at 1440 and 1680), SCRUM-918 (add-on cards readable in the split view), SCRUM-901 (a long check-in label stays inside its button), SCRUM-948 (F&B, Shop and the remaining screens write satang to two places), point 1 of SCRUM-917 (no refusal toast on Tickets for a part-paid food order) and the last point of SCRUM-938 (a waiting sibling's family under Upcoming). Service: the till only (both staging tills); no platform change, no migration.
Counter box: nothing is needed for these fixes, except that Till 1's counter display (Pi) takes the payment-stage figure ("฿1605") from the box's next release.
Left and ticketed: the phone family screen cuts lines at the right edge with long child names (SCRUM-956). Left as it was: the F&B payment screen groups "Amount due" (1,605) but not "Order total ฿1605" (as before); the ticket till's add-on price and "each" price are whole baht written by hand.

### Questions for the owner from this lane
1. The split-view layout applies to any till screen 768 pixels or wider whose step column is under 576 pixels. A desk at full width (a window of 1024 or wider) is exactly as before. A full-width till on a tablet held upright (768 to about 980 wide) also gets the readable narrow layout. Is that right, or should a tablet held upright keep the old layout?
2. The phone till's ticket step still cuts add-on names ("F..") and captions; the phone was left exactly as it was. Should the phone get the same readable add-on cards?
3. In the split view the rate cards show the icon beside the words (a smaller icon) so all three fit, and the participant cards show the icon above the words so the captions are whole. Is that acceptable, or would you rather keep the tall cards and scroll?
4. In the split view Back and Confirm Payment Received stay pinned at the foot of the payment panel; the tender (Cash received, Change, Hold sale) scrolls behind them. Keep?
5. The staff tender panel still writes two places ("Balance ฿1605.00", "Change ฿0.00"); the prototype has no tender panel, so it was left. Should it read "฿1605" and "฿0" like Amount Due?
6. The customer display's payment stage now reads "฿1605" as the prototype does, no longer "฿1605.00". Confirm.
7. The party settlement card comes back on the next visit to Tickets after × (SCRUM-889's rule: an open settlement is listed until it is paid or cancelled; × hides it for this visit only). Should × hide it for the rest of the day on that till?
8. An F&B or Shop order left unpaid at the counter till is now left off the Tickets tab entirely (not even a void-only card). Today it can be finished only from History (refund or void) and is seen in End of Day's open sales; the balance cannot be collected anywhere, as before this lane. Should the F&B and Shop counters get their own left-unpaid card (resume, collect the balance, void)?
9. A family with one child in the park and one waiting is listed under both Upcoming and In Park, with the whole card (all children, all actions), because cancel and check-in rules need the whole family. Keep, or should the Upcoming card show only the waiting children?
10. A family with one child checked out and a sibling still in the park (or waiting) is counted under Out but not listed there. Should it be listed under Out too?
11. End of Day and Performance changed on the desk too, not only the phone, because the phone tabs share their parts with the desk. Keep?
12. The button that cancels one child on their own (desk and phone) also wraps its label inside the button; before, a long name ran past the card. Keep?
13. The party page's payment step (Take the balance, the door-fee pass) keeps the prototype's footer; in a window under about 560 pixels high Confirm sits below the window there, as it always did. Should those dialogs get the till's pinned footer too?
14. Menu, shop and modifier prices now go through the same formatter: whole-baht prices are unchanged, a catalogue price with satang would show two places. Keep?

## The split-view lane is proved (12 November 23:45); its follow-up lane started
Proof: docs/qa/proof-2026-11-12/SCRUM-884, eleven points, all passed, at 013e97348. DEPLOYED: SCRUM-884, 918, 901, 948, 917, 938.
Filed from the proof and building now in lane splitfix959 (run wf_7190756c-7a9, the till only): SCRUM-959 (the header tabs stay in view at 1440; a two-line member name still leaves the three rate cards in view; the cut labels on the first screen, the order panel, the paid screen, the F&B and Shop grids, History's search box) and SCRUM-960 (a part-paid food order no longer holds the till on F&B; one overdue rule for the desk and phone boards; the phone's End of Day keeps its width; the discount line on the F&B customer display if the prototype shows one). For each point the prototype is read first; a prototype rule is left alone and reported.

### Further questions for the owner from this proof
1. At full width (customer display hidden) at 1440 by 900 with Cash chosen, "Confirm Payment Received" sits half below the window and needs a scroll; the lane left full width exactly as the prototype has it. Should the full-width payment panel get the pinned Back and Confirm row the split view now has?
2. On the phone, a Check In button names the children only beside a child paid online; a family paid at the till shows "Mark Arrived" and a plain "Check In". Is that what you want on the phone?

## The family form's small-points lane landed (12 November 23:58, main e4989a0d6)
Tickets: SCRUM-954 points 2 to 6 (one Done on the counter display, the reconnecting line under the language button, 44-pixel presses, the age picker in the display's look, the phone gate and form), SCRUM-956 (the phone family screen as wide as the phone), SCRUM-953 points 4 to 6 outside the party pages (History after a refunded settlement and after a code, the door check-in dialog's success line, the phone's refund rows). Service: the till only (both staging tills); no migration.
Counter box: TO VERIFY ON THE PI when it is online: which page its kiosk opens. The lane read the box code as serving the display from the release's own copy (127.0.0.1:8780/display); the install notes pass the staging web address. If it is the box's copy, the display changes of this lane and of the family's form lane before it need the box release (to be repacked from main in any case). Kept on SCRUM-962.
Left and ticketed (SCRUM-962): the printed receipt lists lines after the discount under a Subtotal before it; the language menu's choices are 40 pixels; the phone gate's name box is squeezed; a phone held sideways.

### Questions for the owner from this lane
1. The keys' own button on the counter display now reads 'Hide' (Thai 'ซ่อน', Chinese '收起', Russian 'Скрыть', French 'Masquer') with a keyboard sign, drawn grey like Space, so only the form's Done is blue. The same applies on the first screen's nickname keys. Are those words right, or should it keep the word 'Done' and only lose the blue?
2. While the display is reconnecting, the line stays at the top of the form and the language button is drawn over its right end; on the 600-wide display the line's words wrap onto two lines to keep clear of the button. Is that acceptable?
3. Only the paired display's own form got the 44px presses. The till's own customer half (which is a touch screen if the counter till's own screen is used with ?keyboard=screen) keeps 38px. Should the till's customer half get 44px too?
4. On a display narrower than 520px the form's heading now starts 8px lower to clear the taller language button. The 600-wide counter display is unchanged. Is that acceptable?
5. The age picker now follows the display's dark or light look on the family's form, and also on the returning family's 'Is this still your child?' review on the same display, which I included because it is the same picker in the same flow. Is that right?
6. On the phone till the form's heading, including the language button, now scrolls off the top as the family scrolls down, and comes back at the top of the form. Is that acceptable, or should the language button stay pinned?
7. On the phone family screen, the top bar keeps the prototype's one-line title, so a long single child's name ends in '…' there. The full name now wraps in the body just below it. Keep, or should the bar's title wrap too?
8. A refunded or voided party settlement's deposit row now reads 'Party deposit · Stays with the party' in grey, with its amount. Are those words right?
9. History's item cards now show each line before discounts, as the order panel does (Kids ฿690, Drop-off service ฿225), so they add up to the Subtotal above the code. A sale with service charge or added tax on its lines now also shows each line before those charges, which are listed under the Subtotal. A voucher's free item stays at ฿0, as on the panel. Is that right?
10. The door check-in dialog after a drop-off sale now repeats the success line ('Receipt … • ฿… • Cash') in green under its title. Is that wording and colour right? The party pages' own 'Leave as booked' step (AddAttendeeModal) was left to the party lane.
11. The printed receipt after a code lists each line after the discount under a Subtotal before it, so it does not add up. Should the receipt list lines before the discount, as the order panel and History now do?
