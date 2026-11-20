# The BEO editor's finish points on staging (SCRUM-1029)

oto-app-staging, signed in through the launcher as the staging administrator
(a manager role), on main `f986953f9` (the lane `lane/beo1029b-20261120`
landed on 20 November 2026), deployed by name at that commit and live at
02:28:54 UTC on 20 November. Only the party "ZZ TEST 1028 Staff BEO"
(Central Floresta, 10 December 2026, 11:00 to 14:00) was opened or changed.
Each picture was looked at before it was kept; the events board behind the
editor's sheet is hidden in every picture, and no staff name is on them.

## What was tried, through the editor's own controls

- The editor at 768x1024 (a tablet upright) and at 1440x900 (a desk screen):
  Event Info and Food & Drinks opened alone. The sheet is 672 px wide at both,
  so the two sizes look alike; measured at both: nothing inside the sheet is
  wider than the sheet, no sideways scroll.
- The Bar service time: its box showed 11:30 (as stored). 13:45 typed into
  the box, Save (02:30:56 UTC, answered 200), the BEO opened again: the box
  shows 13:45 and the Bar line reads "Service 13:45"; the stored BEO read
  13:45 through the app's own route. Then 11:30 typed back, Save (02:31:19
  UTC, answered 200), opened again: 11:30 in the box and in the stored BEO.

## The pictures

- `scrum-1029-finish-staging-editor-768x1024-event-info.png` and
  `-1440x900-event-info.png`: Event Info. Start Time and End Time are one
  plain time box each (11:00 and 14:00); Kid Turning Age ("6") reads and is
  typed as the fields around it.
- `scrum-1029-finish-staging-editor-768x1024-food-drinks.png` and
  `-1440x900-food-drinks.png`: Food & Drinks as the BEO opens it: Setup /
  Table ("Ready by 10:30 · ZZ TEST Setup team", "2 tasks"), the kitchen's
  own fields ("No food for this party", Kitchen Notes), Kids Menu ("Set
  Central · Service 11:45", "18 dishes"), Adults Menu ("Service 12:15", "15
  dishes"), the cake with its time box, Bar ("Service 11:30", "3 items"); the
  four lines folded.
- `scrum-1029-finish-staging-editor-768x1024-food-drinks-bar-open.png` and
  `-1440x900-food-drinks-bar-open.png`: the Bar line opened (the other three
  folded): its service time box, the three drinks with their notes under
  their names, the price boxes and the till's words.
- `scrum-1029-finish-staging-bar-time-kept-after-reload.png`: the Bar line
  after the Save and a reload: "Service 13:45" on the line and 13:45 in the
  box.

No "Mark POS / Setup / Kitchen Done" button is anywhere in the editor.

## What is left on staging

- "ZZ TEST 1028 Staff BEO": as before this check; the Bar time is 11:30
  again. The two Saves wrote the BEO twice with the same content apart from
  the Bar time.
