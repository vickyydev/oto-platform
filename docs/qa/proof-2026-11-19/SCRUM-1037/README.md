# SCRUM-1036 and SCRUM-1037 on staging, 19 November 2026

The HR app staging service (`oto-app-staging`) was deployed by name at
`209b452510e5ae5c2c29af3078b58c8794e29eb1` (deploy `dep-dbvg8re0tbcc73el20s0`,
live 14:18:43Z). Its pre-deploy migrator applied migration 0053. The app
answered that version before the run (`/api/qa-reports/config`).

Signed in as the staging admin through the launcher (app role
`global_admin`, a manager rank). Headless Edge, 1440 × 1000, Bangkok time.
Script: `proof.mjs`; the final run's record: `receipt.json`. No real name,
phone number or pay figure is in a picture or a receipt: Scheduling is
filtered to the ZZ TEST names, and the department used held nobody else in
that branch (checked before any drag; a drag was also blocked in the browser
unless every id it would save was one of the ZZ TEST profiles made here).

## Before the deploy (read only)

`before.mjs` read the staging admin's park group's leave types at 14:14Z,
while staging ran `b297dd064`: all seven built-in types were active, and the
`managersOnly` field did not exist yet (`before.json`).

## What migration 0053 did on staging

Picture `1037-0-types-before-after-card.png`, read before and after:

| Code | Name | Active | Who sees it |
|---|---|---|---|
| ANNUAL | Annual Leave | on → on | staff can see |
| CHANGE_DAY_OFF | Days Off | on → on | staff can see |
| BUSINESS | Business Days | on → on | managers only |
| SICK | Sick Leave | on → on | managers only |
| UNPAID | Unpaid Leave | on → on | managers only |
| TRAINING | Training | on → **off** | (switched off) |
| OTHER | Other | on → **off** | (switched off) |

No type was deleted or renamed; codes are unchanged. Only the staging admin's
own park group was read.

## Result: passed (attempt 6)

| Step | What happened | Picture |
|---|---|---|
| 1037 leave types screen | Each type shows "Managers only" or "Staff can see" beside Active/Disabled; Training and Other read Disabled | `1037-1-leave-types-screen.png` |
| 1037 the setting | Sick Leave's edit dialog has the "Managers only" switch, on | `1037-2-sick-leave-managers-only-switch.png` |
| Set-up | Three ZZ TEST profiles made in Head Office, department "Maintanance" (no other person shown there): places 8, 9, 10, after the park group's last (SCRUM-1036: a new employee goes to the end) | — |
| 1036 before | Scheduling, filtered "ZZ TEST 1036": ZZ a above ZZ b | `../SCRUM-1036/1036-1-before-drag.png` |
| 1036 drag | ZZ b dragged above ZZ a: one reorder request, 3 ids, all ZZ TEST, answered 200 | — |
| 1036 after | Page reloaded: ZZ b above ZZ a; stored places b 0, a 1, staff 2 | `../SCRUM-1036/1036-2-after-drag-and-reload.png` |
| 1037 staff session | ZZ TEST 1037 Staff (app role `staff`) signed in through the launcher with a suite sign-in; the server offers Annual Leave and Days Off; Training and Other come back switched off; Sick Leave, Business Days, Unpaid Leave are not in the list | `1037-3-staff-session-card.png` |
| 1037 staff try | The staff session posts Sick Leave for itself: 403 "Insufficient permissions"; 0 time-off rows for the person afterwards | `1037-3-staff-session-card.png` |
| 1037 manager | Admin opens the person's Thursday cell in Scheduling: Leave / Holiday, Business Leave, Off, Sick Leave, Unpaid Leave (no Training, no Other) | `1037-4-manager-time-off-choices.png` |
| 1037 manager records | Sick Leave recorded for the ZZ TEST person: 201; the cell reads "Sick" | `1037-5-sick-leave-recorded.png` |

## Clean-up, read back

- The ZZ TEST time-off row deleted (204).
- The ZZ TEST staff signed out of the app and the launcher (200, 200).
- On the Console, the ZZ TEST platform account was set inactive (200) and its
  OTO App link removed (200). Platform accounts are not deleted, so one
  inactive ZZ TEST account per run that reached the suite sign-in remains
  (attempts 4, 5 and 6: three).
- The three ZZ TEST profiles deleted (204 each), each read 404 afterwards.
- The admin signed out of the app and the launcher.

## Earlier attempts (kept: `attempt-0N-receipt.json`)

1. Profiles made with no department: Scheduling draws only real
   departments, so the drag handles never showed. Cleaned up by the script.
2. The drag's response wait timed out before it was awaited and ended the
   process before the clean-up: three ZZ TEST profiles were left and removed
   at once by `cleanup.mjs` (`attempt-02-cleanup.json`: 204, then 404).
3. The drag sent its request (3 ZZ TEST ids) but the wait for its answer did
   not see it; the run stopped and cleaned up. The page's own response event
   is used from attempt 4.
4. The staff session's reads answered 401: the script read before the app's
   hand-off settled. Cleaned up.
5. A Scheduling cell was re-drawn while being clicked. Cleaned up.

Every attempt removed what it made; only the inactive platform accounts of
attempts 4 to 6 remain, as the platform keeps accounts.
