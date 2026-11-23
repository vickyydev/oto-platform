# SCRUM-1051: serving times on the till's kitchen and bar slips

SCRUM-1051 "BEO: the time per dish or group on the till's kitchen and bar
slips" is the till's part of the owner's answer of 19 November (ANSWERS.md,
section 5, SCRUM-1033). This page is the recipe for the lane that builds it.

## Staging result, 23 November 2026

Build `bf60a2f36` preserves the adult serving time on the existing billed line. A staged party with the same dish at 12:30 and 13:30 yielded both kitchen entries and one billable line. A park printer check remains open.

## Earlier finding, 20 November 2026

Checked on origin/main a9c955e3a:

- The HR app stores the times on the line itself: `serviceTime` ("HH:MM") and
  `serviceGroup` on each line of `beo_kitchen_plans.menus.kids[]`,
  `.adults[]` and `beo_bar_plans.items[]` (`apps/oto-app/shared/beoServingTimes.ts`).
  A group is the lines of ONE list with the same name, case and spacing
  aside; a group's time is set once for all its dishes.
- The till reads a party's food only through the view
  `otoapp_v.event_packages`, last defined by HR app migration 0052. Its
  `kitchen_plan.lines` and `bar_lines` are built key by key with
  `jsonb_build_object` and name neither key. The platform reads no HR app
  table directly.
- So the till cannot see the times until an HR app migration replaces that
  view. The slips lane was not allowed to change `apps/oto-app`; building
  SCRUM-1051 needs the owner's go for a lane that may.

## The recipe

1. **HR app migration** (forward-only, numbered after the newest on
   origin/main at the time; 0055 today) replacing `otoapp_v.event_packages`.
   Every kitchen line and bar line the view emits carries `service_time`
   (the line's own `serviceTime` when it is a clock time, else null) and
   `service_group` (trimmed, inner spaces folded, else null), in every part:
   the set menu's lines, the kids' lines, the adults' lines, the bar lines.
2. **The same-dish test compares the serving time too.** With "Different for
   adults" on, 0052 drops an adults' line that is the same dish as a kids'
   line: same name, quantity and till code (the set menu's part, the kids'
   part's `same_dish` and adults' note joins, the adults' part's
   `NOT EXISTS`, and the 0048 adults' note joins on the set menu). Every one
   of those comparisons gains "and the same serving time, both none or the
   same clock time". An adults' copy at another time then stays its own line,
   marked `audience: adults`, with its own time; a copy at the same time folds
   into the kids' line as today. Without this, kids' Pizza at 12:30 and
   adults' Pizza at 13:30 print once, at 12:30, and the adults' time is lost
   with no trace.
3. **Platform seam reader** (`apps/api/src/services/otoapp-events.ts`,
   `party-plan.ts`) and the shared types read the two keys; a line of before
   reads null for both.
4. **`composePartySlips`** (`packages/shared/src/party-slips.ts`): bump
   `PARTY_SLIP_COMPOSER` (3 today). A dish with no time of its own prints as
   today, under the party's service time. A group heading is keyed by its
   name, its time and its audience, never by the name alone: the kids'
   "Dessert" and the adults' "Dessert" are two groups when their times differ.
5. **Pins**: one shared dish at two times (kids' Pizza 12:30, adults' Pizza
   13:30, switch on) prints two lines; one group name in both lists at two
   times prints two headings, and at one time folds as today. No price,
   quantity, dish name, tax or total changes on any slip: the print suite,
   the api party-slips tests and the till's slip pins stay as they are.
