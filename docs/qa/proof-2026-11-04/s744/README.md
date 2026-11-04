# SCRUM-744: a locked till that is reloaded unlocks onto its own station

Local proof done on 4 November 2026 on lane `lane/unlock744-20261104`,
source commit `c8cc4c15e`. The staging proof is still to come and follows
the plan at the end of this page once the change is on main.

## What happened, and where

It was the platform path, not the box path, and no display lease was
involved.

A reload at the lock screen asks `/me`, which answers for a locked session
and says `sessionLocked: true`, so the page comes back locked. The station
provider then asked its station question straight away, while still locked:
`GET /me/stations` and then `PUT /me/session/station` for the station this
device remembers. The API refuses business from a locked session with 423
`SESSION_LOCKED` ("This session is locked — unlock to continue"), and the
provider kept both refusals as answers: the list's as the red line with Try
again, the remembered pick's as the amber line, and an empty list, which is
"No station here is yours to work". The unlock changes no account, so nothing
was asked again. Try again re-read the list only, so the stations appeared
but the amber line stayed and the remembered station was never taken back.
Opening the address directly worked because that reload was unlocked.

SCRUM-728's locked-reload change applies only when `/me` cannot be reached
at all (a prepared device in an outage). On staging `/me` answered, so that
path did not run.

## The change

`apps/pos/src/station/StationContext.tsx` only. A 423 `SESSION_LOCKED` from
the station list or the remembered pick is no answer: the till stays
unresolved behind the lock screen and asks the whole question again at the
unlock, which takes the remembered station back. A list re-read refused the
same way is read again at the unlock and leaves no line. The lock, the unlock
and the lock screen are unchanged, and a lock in the middle of a shift asks
nothing, so the sale kept under the lock screen and its station stay as they
were.

## Local proof

Disposable database, real API and till, Microsoft Edge, through the isolated
harness (`apps/pos/e2e/run.mjs`). The till is a ZZ TEST station made on the
seed's Virtual box 1 for each run. The lock comes from the inactivity timeout
itself, reached with the browser clock. Password fields are masked.

Before the change (the same spec on the unchanged provider):

| Width | Locked after reload | After Unlock |
|---|---|---|
| 1440px desktop | [locked](local-before-desktop-1-locked-after-reload.png) | [picker with the locked line twice and "No station here is yours to work"](local-before-desktop-2-after-unlock.png) |
| 390px phone | [locked](local-before-phone-1-locked-after-reload.png) | [the same on the phone](local-before-phone-2-after-unlock.png) |

After the change, against the built till as CI runs it (`POS_E2E_BUILT=1`):

| Width | Locked after reload | After Unlock | 15 seconds later |
|---|---|---|---|
| 1440px desktop | [locked](local-after-desktop-1-locked-after-reload.png) | [Membership Check on the till](local-after-desktop-2-after-unlock.png) | [still the till](local-after-desktop-3-after-15s.png) |
| 390px phone | [locked](local-after-phone-1-locked-after-reload.png) | [the phone till](local-after-phone-2-after-unlock.png) | [still the till](local-after-phone-3-after-15s.png) |

Each run also checks that after the unlock the till sent exactly one station
pick, for the ZZ TEST till, that the device still remembers it, that
`/me/station/link` names it, and that no "This session is locked" line is on
the screen.

## Gates

| Gate | Result |
|---|---|
| `pnpm --filter @oto/pos typecheck` | passed |
| eslint on the three changed source and test files | passed |
| `apps/pos/test/s744-locked-reload.test.ts` (4 cases; 3 fail without the change) | passed |
| POS unit files that read the station or lock state (16 files, 275 cases) | passed |
| `pnpm --filter @oto/pos e2e e2e/locked-reload.spec.ts`, Vite and built | 2 of 2 passed both ways |

CI's till end-to-end step now runs the spec as well, after the paid
drop-off spec.

Landing rebase, 4 November 2026 about 19:20 Bangkok: the lane was rebased
onto main at 2cb74ada1 with no conflicts (the counter box scanner change to
`apps/pos/src/api/bridge.ts` landed in between; this lane does not touch it).
On the rebased tree `pnpm --filter @oto/pos typecheck`, eslint on the three
changed files, the ten POS unit files that use the station context (316
cases), `POS_E2E_BUILT=1 pnpm --filter @oto/pos e2e e2e/locked-reload.spec.ts`
(2 of 2, desktop and phone) and `pnpm api-types:check` all passed.

Rerun: `pnpm --filter @oto/pos e2e e2e/locked-reload.spec.ts`, with
`POS_E2E_EVIDENCE_DIR` naming a folder for the screens and `POS_E2E_BUILT=1`
for the built till.

## Staging proof plan

Run on staging on 4 November 2026, 20:00-20:13 Bangkok, on live a671f7bd: see [staging/README.md](staging/README.md). The station part passed at 1440 and 390 px; one finding (the park list is not asked again after Unlock, so the till keeps the built-in sample catalogue) keeps SCRUM-744 at Testing.

The second part, which asks for the park list and the catalogue again at the Unlock, is in [part2/README.md](part2/README.md), with its own local proof and staging plan.

To run once this commit is on main and the POS web and api are live on it.
No setting, credential or migration is needed.

1. Read the live commit of the POS web and the api and record it.
2. In the Console, make a ZZ TEST till for SCRUM-744 on a virtual box at the
   staff branch, ready to sell (a receipt prefix, card and QR taken by hand).
3. Desktop, 1440px: sign in as a reception test account, pick the ZZ TEST
   till, and leave it untouched past the two-minute inactivity timeout.
   Screen the lock screen.
4. Reload. Screen the lock screen again.
5. Unlock. Expect the ZZ TEST till itself (Membership Check), no station
   picker and no "This session is locked" line. Screen it, and again 15
   seconds later.
6. Repeat 3 to 5 at 390px phone width.
7. Opening the till's address directly still opens it on its station
   (the control from the report).
8. Archive the ZZ TEST till and sign the test account out.

The screens go inside the Jira comment as the before and after of
`docs/qa/proof-2026-11-03/s732/staging/finding-repro-1..4`.
