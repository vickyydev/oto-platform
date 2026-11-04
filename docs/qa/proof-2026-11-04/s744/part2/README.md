# SCRUM-744, second part: a locked reload opens on the real park after Unlock

Local proof done on 4 November 2026 on lane `lane/unlock744b-20261104`,
source commit `86401bdee`. The staging proof ran on 4 November 2026, 21:50 to
21:57 Bangkok, on live `2549fefc0` and passed: see [staging/README.md](staging/README.md)
(Jira comment 13475; SCRUM-744 Deployed).

## What happened, and where

Found by the staging proof of the first part (comment 13467, the screen
`../staging/s744-02-desktop-7-finding-park-list-after-unlock.png`). It is the
same cause in another provider.

A reload at the lock screen resumes the session through `hydrate` in
`apps/pos/src/auth/OperatorContext.tsx`. `GET /api/me` and
`GET /api/me/permissions` answer a locked session, so the page comes back
signed in and locked. `hydrate` then loads the catalogue
(`loadCatalogFromApi` in `apps/pos/src/api/catalogBridge.ts`), whose first
request, `GET /api/branches`, is refused with 423 `SESSION_LOCKED`. `hydrate`
swallows a catalogue failure by design, so the catalogue store kept the POS's
built-in sample data, and the platform unlock only cleared the lock. Nothing
asked again, so after Unlock the till showed the sample park "HKT Central"
(its switcher lists "HKT Central" and "HKT Chalong"), its sample tickets and
prices, an in-park count read against no park, no low-stock strip and no
overdue notice. An unlocked reload, or signing out and in, brought the real
park back.

## The change

`apps/pos/src/auth/OperatorContext.tsx` only. A 423 `SESSION_LOCKED` from the
catalogue load inside `hydrate` is "not yet": the provider notes it, and the
next platform unlock reads the whole session again (account, permissions,
park list, payment methods, tiers, packages, holidays, tax, pricing mode,
menu and stock) before the till opens. That is the path a prepared offline
page already takes at its unlock, so the lock screen stays up until the read
is done and the till opens on the real park. The station question from the
first part is asked after that, unchanged.

A lock in the middle of a shift read everything before it locked, so its
unlock reads nothing again: the operator, the station and the sale under the
lock screen are left as they were (unit test, and the first part's station
test). A catalogue failure that is not the lock's refusal keeps its old
behaviour (non-fatal, not re-asked). The box unlock path is unchanged.

## Local proof

Disposable database, real API and till, Microsoft Edge, through the isolated
harness (`apps/pos/e2e/run.mjs`). The till is a ZZ TEST station made on the
seed's Virtual box 1 for each run. The lock comes from the inactivity timeout
itself, reached with the browser clock. Password fields are masked.

The spec is the first part's (`apps/pos/e2e/locked-reload.spec.ts`), extended.
The local seed names the branch "Oto Play Park, Central Floresta", so the spec
reads the session's park name from `/api/me`, checks it differs from the
sample's "HKT Central", and asserts on it in the header. It also asserts on
the park list's own request: refused with 423 at the locked reload, then asked
again and answered 200 after Unlock.

Before the change (the extended spec on the unchanged provider): both widths
fail at "the park list is asked again after Unlock" (no request was made).

| Width | Locked after reload | After Unlock |
|---|---|---|
| 1440px desktop | [locked](local-before-desktop-1-locked-after-reload.png) | ["HKT Central", the sample park, no low-stock strip](local-before-desktop-2-after-unlock.png) |
| 390px phone | [locked](local-before-phone-1-locked-after-reload.png) | [the phone till](local-before-phone-2-after-unlock.png) |

After the change, against the built till as CI runs it (`POS_E2E_BUILT=1`):

| Width | Locked after reload | After Unlock | 15 seconds later |
|---|---|---|---|
| 1440px desktop | [locked](local-after-desktop-1-locked-after-reload.png) | ["Oto Play Park, Central Floresta", the low-stock strip, Membership Check on the till](local-after-desktop-2-after-unlock.png) | [unchanged](local-after-desktop-3-after-15s.png) |
| 390px phone | [locked](local-after-phone-1-locked-after-reload.png) | [the phone till](local-after-phone-2-after-unlock.png) | [unchanged](local-after-phone-3-after-15s.png) |

At 390px the phone bar cuts its start cluster where it runs out of room
(SCRUM-509), and the in-park chip carries the "no gate" mark, so the park chip
is cut off in both runs and the phone screens look alike. The phone run
asserts the same things as the desktop run on the page itself: the park list
refused at the reload and answered after Unlock, the header's park chip naming
"Oto Play Park, Central Floresta", and no "HKT Central" anywhere.

Staging shows the same "no gate" mark: part one's control screens read
"1 in park • no gate" at 1440px
(`../staging/s744-02-desktop-8-control-direct-address.png`) and cut the phone
bar at "1 • no ga" (`../staging/s744-07-phone-7-control-direct-address.png`),
so the park chip is cut off on a staging phone too. The phone till also draws
no low-stock strip and no overdue notice: the strip is part of the desktop
header, and the notice is drawn by the desktop till (on a phone it shows on
the Check-in board only).
The staging plan below therefore names the park, the low-stock strip and the
overdue notice at desktop width only, and checks the phone by what does show
there: the in-park count, and the recorded requests behind it.

Each run also keeps the first part's checks: one station pick after Unlock,
for the ZZ TEST till; the device still remembers it; `/me/station/link` names
it; no picker and no "This session is locked" line, then and 15 seconds later.

## Gates

| Gate | Result |
|---|---|
| `pnpm --filter @oto/pos typecheck` | passed |
| eslint on the three changed source and test files | passed |
| `apps/pos/test/s744-locked-reload-session.test.ts` (3 cases; 2 fail without the change) | passed |
| POS unit files that use the operator provider or the catalogue bridge (29 files, 431 cases) | passed |
| `pnpm --filter @oto/pos e2e e2e/locked-reload.spec.ts`, Vite | 2 of 2 passed (0 of 2 before the change) |
| `POS_E2E_BUILT=1 pnpm --filter @oto/pos e2e e2e/locked-reload.spec.ts` | 2 of 2 passed (desktop and phone) |
| `pnpm --filter @oto/pos e2e` (the smoke flows CI runs first) | 7 of 7 passed, including the F&B and shop sales kept through a lock |

CI already runs the spec in its till end-to-end step; no workflow change.

Rebased onto main at `3f70f3bad` (the board card and display button
landing and its staging proof), with no conflict; the change is `3bf820733`
there. On the rebased lane the typecheck, eslint, the 29 POS unit files
(431 cases), the locked-reload spec under Vite (2 of 2, desktop and phone)
and `pnpm api-types:check` (no api change) passed again.

Rerun: `pnpm --filter @oto/pos e2e e2e/locked-reload.spec.ts`, with
`POS_E2E_EVIDENCE_DIR` naming a folder for the screens and `POS_E2E_BUILT=1`
for the built till.

## Staging proof plan

To run once this commit is on main and the POS web and api are live on it.
No setting, credential or migration is needed. The recipe is the first
part's, with the park checks added.

1. Read the live commit of the POS web and the api and record it.
2. In the Console, make a ZZ TEST till for SCRUM-744 on a ZZ TEST virtual box
   at Oto Play Park, Central Floresta, ready to sell (a receipt prefix, card
   taken by hand, QR not taken here), open to all staff.
3. Desktop, 1440px: sign in as the reception test account and pick the ZZ
   TEST till. Screen it: "Oto Play Park, Central Floresta" in the header, the
   in-park count (1 at the time of the first part's run), the low-stock strip
   and the overdue notice. This is the control.
4. Leave it untouched past the two-minute inactivity timeout. Screen the lock
   screen. Reload, and screen the lock screen again. Record that
   `GET /api/branches` answered 423 behind the lock.
5. Unlock. Expect the ZZ TEST till itself (Membership Check), no station
   picker, no "This session is locked" line, and the same header as step 3:
   "Oto Play Park, Central Floresta" (its switcher lists the real parks, not
   "HKT Central" and "HKT Chalong"), the same in-park count, the low-stock
   strip and the overdue notice. Record that `GET /api/branches` was asked
   again and answered 200. Screen it, and again 15 seconds later.
6. Open Tickets and check the ticket list and prices match an unlocked open of
   the same till (read only: start no sale).
7. Repeat 3 to 5 at 390px phone width. The phone bar cuts the park chip and
   draws no low-stock strip or overdue notice, so the phone checks are:
   - the in-park count after Unlock equals the control's (1 in part one's
     run), where the sample park reads 0;
   - the recorded `GET /api/branches`: 423 at the locked reload, then asked
     again after Unlock and answered 200, its body naming "Oto Play Park,
     Central Floresta";
   - the chip's own poll, `GET /api/branches/<the park's id>/occupancy`,
     running every 5 seconds after Unlock (on the sample park the chip makes
     no request at all), so the count is the real park's even when it is 0.
   Screen the phone till after Unlock and 15 seconds later beside the
   control, and keep the request record with the screens.
8. Archive the ZZ TEST till and the ZZ TEST virtual box, and sign the test
   account and the Console out.

The screens go into the Jira comment beside
`../staging/s744-02-desktop-7-finding-park-list-after-unlock.png` as its
"after".
