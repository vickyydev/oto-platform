# The BEO editor in four sections and its new fields, on staging (SCRUM-1029 to 1035, 1042, 1050)

oto-app-staging, signed in through the launcher as the staging administrator
(a manager role). Three deploys, each by name at the pushed commit of main:

- `cc500e844` (the lane), live 22:22 UTC, 19 November 2026;
- `97201a4b4` (the first look fix), live 22:54 UTC;
- `b95813a4f` (the look fix as kept), live 23:08 UTC.

The two fixes change only the editor's screen (the EXTRA price box and the
till's words beside it), so the prints, the saved values, the AI Fill review
and the deposit picture taken on the earlier deploys stand. Every editor
picture below was taken on `b95813a4f`.

Only ZZ TEST parties were opened, changed or printed. Each picture was looked
at before it was kept. Staff names are covered (dark boxes), on the screens
and on the prints.

## What was typed, through the editor's own controls

On "ZZ TEST 1028 Staff BEO" (Central Floresta, 10 December 2026, 11:00 to
14:00), made for the timeline proof, then Save (22:26 UTC, answered 200):

- expected extra guests +2 children, +3 adults; socks "Other / Custom" with
  the note "ZZ TEST two pairs each, paid at reception";
- Kitchen Notes "ZZ TEST no peanuts anywhere in the kitchen; cut the grapes in
  half for the little ones";
- a serving time 13:00 and the group "ZZ Dessert" on Fruit skewers, and Mini
  waffles joined to the same group;
- two members of staff on "ZZ TEST Bubble show"; the role "Entertainer" with
  the number 2 and the note "ZZ TEST bring the treasure map and the gold coins"
  on "ZZ TEST Treasure hunt" (both written at once, as the rows do).

Read back through the app's routes after the Save, and seen again in every
editor picture (each taken after the BEO was opened afresh): all of it stored.
Nothing the form did not touch changed, except what the editor already did
before this work: a dish or drink stored with no count is saved as 1, and a
party saved for the first time from the editor stores a deposit of 0.

Then the party's set menu, the way a family gives it: the editor's Set Menu
switch and template "Set Central", Save, "Get Parent Link", and the parent's
own menu page filled (Mini Waffles in "Sweets x2", the first choice elsewhere)
and sent (22:29 UTC, answered 200). The party has no inbox conversation, so
nothing went to any chat.

## The pictures

The editor, each of the four sections and Billing opened alone and pictured
in full, at five window sizes. The editor opens as a sheet 672 px wide at
every one of them, so the sections look alike; `-opens` is the window as it
opens. Measured at every size: nothing in the sheet is wider than the sheet.

- `scrum-1029-staging-editor-<size>-opens.png`, `-event-info.png`,
  `-food-drinks.png`, `-entertainment.png`, `-internal-notes.png`,
  `-billing.png`, for 768x1024, 1024x768, 1133x744, 1366x1024 and 1440x900.
  - Event Info: the party's details, Party Host, Package, "Extra guests and
    socks" (the amber box and the socks choice with its note), POS with the
    hand-typed deposit.
  - Food & Drinks: Setup / Table, Food with "No food for this party", Kitchen
    Notes, the menus with the set menu ("Sweets x2 -> Adult Waffles", the
    resolved line "Adult Waffles"), the additional dishes (each "Price ฿" on
    one line, the till's words in one column, the names in one column, the
    two dessert dishes "Served at 13:00 · ZZ Dessert"), the cake, the bar.
  - Entertainment & Program: the activities with their people (two staff, a
    "2 × Entertainer" chip with its steppers), the note, "Other timed steps"
    with "1 step", and the timeline as saved.
  - Internal Notes; Billing (unchanged).
- `scrum-1029-staging-zz-party-staff-beo-page1-of-1.png`: the Staff BEO
  printed after the Save (22:27 UTC). Header: "Socks arrangement: Other /
  Custom: ZZ TEST two pairs each, paid at reception" and "Expected extra (add
  to POS on arrival): +2 children · +3 adults". Kitchen opens with "Kitchen
  Notes: ...". Fruit skewers and Mini waffles carry "ZZ Dessert · 13:00"; the
  timeline has "13:00 Kids' menu served ZZ Dessert". Entertainment: Bubble
  show with its two people (covered), Treasure hunt with its note and "2 ×
  Entertainer"; the timeline says the same. Each EXTRA with no till price
  carries "*", and "* Price unresolved - not charged" prints once under the
  Kitchen and once under the Bar.
- `scrum-1029-staging-zz-party-staff-beo-set-menu-page1-of-2.png` and
  `-page2-of-2.png`: the same party after the parent's menu (22:29 UTC):
  "1x Adult Waffles (Sweets x2)", the set menu's group labels beside each
  dish ("Hawaii (Pizza 1)"), "French fries x3" with no "1x" before it, the
  hand-typed "Mini waffles" keeping its own name, the words under the list
  once, at the end of the Kitchen on page 2.
- `scrum-1034-staging-manager-types-deposit.png`: as a manager, the deposit
  box takes a typed 500 (thrown away: the BEO was opened again without Save;
  the stored deposit read 0 before and after). Nothing requested or sent.
- `scrum-1034-check-non-manager-refused.png`: a labelled card of the check
  that refuses anyone else's deposit change. No staging sign-in that is not a
  manager can enter the HR app (the seeded reception sign-in is refused at the
  hand-over, 403), so no screen can show it.
- `scrum-1035-staging-ai-fill-review-whole.png`, `-kitchen-notes.png`,
  `-timeline-entertainment.png`: AI Fill, one press (22:46 UTC), on a short
  made-up ZZ TEST exchange pasted into the editor: the family agrees "please
  cut the grapes in half for the little ones" and says the guests arrive at
  11:00 and the cake at 13:30; the team's last line asks about a face painting
  add-on, never answered. The review proposes the grapes wish for Kitchen
  Notes beside what the form holds, proposes no package, no entertainment and
  no add-on, and no timed step ("The chat gives no timed steps"). Closed by
  its close button; nothing approved.
- `scrum-1050-staging-older-party-editor-1024x768-opens.png` and
  `-food-drinks.png`: an older party, "ZZ TEST 827 pasted party", opened in
  the new editor; its stored BEO read the same before and after; nothing saved.
- `scrum-1050-staging-older-party-staff-beo-page1-of-1.png`: its Staff BEO
  (22:56 UTC): "1x Hawaii (Pizza 1)", "French fries x3" without "1x", the
  rows the assistant stored earlier beside the system's steps (as answered),
  and the till's own figures as before.
- `scrum-1050-staging-day-of-first-tick.png`: a new party made for this,
  "ZZ TEST 1050 Day-of first tick" (11 December 2026, 15:00 to 17:00), its
  BEO never saved (no stored step): on its Day-of view "Guests arrive" was
  ticked at once (23:15 UTC, answered 200) and is stored ticked.

## What is left on staging

- "ZZ TEST 1028 Staff BEO": the values above, the set menu "Set Central" with
  the parent's choices, two staff and a role on its activities.
- "ZZ TEST 1050 Day-of first tick": new, no BEO saved, its "Guests arrive"
  step ticked.
- "ZZ TEST 827 pasted party": opened and printed, unchanged.
