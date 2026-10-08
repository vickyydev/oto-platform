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

---

# Closing retake, 8 Oct 2026, about 07:15 to 07:30 Bangkok time

Staging on `c6194664` (all six services read back as live from `render.mjs status`
at the start of the run). This is the picture the first pass could not take.

## What was done, and how far it went

Signed in as the seeded platform admin on a fresh browser at 1600 wide. A fresh
sign-in lands the account on its default park, "Oto Play Park, Central Floresta".
The till header only exists once a station is taken, so the one station that
belongs to neither the payment run nor the booth was taken ("Counter 2", on
Virtual box 2, which reads "not registered yet" in the picker). Nothing was
sold, scanned, opened or edited there; the header was photographed and the
session was ended with "Sign out and hand over the till" on the lock screen. A
read of `GET /api/me` afterwards answered 401 (text read-back, not pictured).

CORRECTION from the independent check: taking a station is NOT read-only. By the
code (`PUT /me/session/station` into `pickStation` in `apps/api/src/services/fleet.ts`)
it sets the session's station, mints a shift token for that station when the
deployment has a staff-token key, and writes an audit row `session.station_pick`
against Counter 2 with Central Floresta as its branch. So this run did write at
Central Floresta (a session row, possibly a token, an audit row), which is exactly
the thing the first pass called "out of bounds" for a Central till; sign-in and
sign-out rows come on top. Nothing else was written there (no sale, scan, open or
edit). The picture itself shows only the header and nothing being driven.
An earlier throwaway session of the same run, made while finding the sign-out
control, was not signed out by hand and expires on its own.

## Shot (file name starts `SCRUM-443-staging-`)

| File | What the viewer sees | What was done |
|---|---|---|
| `till-header-1600-wide-central-floresta-park-name-two-lines.png` | The top strip of the till at 1600 pixels wide: the test-harness banner, the Oto logo, "0 in park / no gate", the park chip reading "Oto Play Park," on its first line and "Central Floresta" on its second, with its chevron, then Tickets, F&B, Shop, Events, Check-in, a clipped icon, Cash, "Weekday pricing", "Counter 2" and "Khun Anan". The park name is whole on its two lines, sits tight against the chip's top and bottom edges, and the chip overlaps no neighbour. NOT "nothing is cut", though: the nav pill's last item, a small receipt icon, sits on the pill's right edge and is cut by it (the first pass's Demo Branch 2 header has no such icon and its pill ends cleanly after Check-in). The picture does not show whether the two-line chip causes that. TEXT READ-BACK (not pictured): the chip is 174 by 32 pixels and its text occupies two line boxes. | Station "Counter 2" taken at Central Floresta, header cropped to its top 112 pixels. |

Not claimed: the upright-tablet width (SCRUM-505) and the phone bar at Central
Floresta were not looked at. The first pass's three Demo Branch 2 pictures stay
in this folder (a one-line chip), they are not replaced.
