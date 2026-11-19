# SCRUM-1058 and the Leave Types badge on staging, 20 November 2026

The HR app staging service (`oto-app-staging`) was deployed by name at
`90de59969e9373d8f7a64a7b5a3958bde6addb21` (deploy `dep-dbvm2o60tbcc738ucja0`,
live 20:54:21Z on 19 November UTC; 03:54 on 20 November in Bangkok). No
migration in this landing. The app answered that version before the run
(`/api/qa-reports/config`).

Signed in as the staging admin through the launcher (app role
`global_admin`). Headless Edge, 1440 × 1000, Bangkok time. Script:
`proof.mjs`; the passing run's record: `receipt.json`. Only ZZ TEST profiles
made by the script were acted on, in the branch "Head Office". The salary
change is a made-up one on a ZZ TEST profile (10,000 to 11,000). No real
name, phone number or pay figure is in a picture or a receipt: the Activity
Logbook pictures are searched for the run's own words ("ZZ TEST 1058 674f"),
and the script checked every row shown carries them before each picture; the
staff, manager and admin reads of the whole branch are recorded as counts of
salary changes only.

SCRUM-1038 and SCRUM-1055 (a former employee invited to one shift, and its
pay) are not in this landing and were not shown: see the tickets.

## Result: passed (attempt 2)

| Step | What happened | Picture |
|---|---|---|
| Leave Types badge | Policies > Leave Types: Other and Training read "Disabled" with no audience beside it; the active types keep "Staff can see" or "Managers only" | `1058-1-leave-types-badge.png` |
| Set-up | Three ZZ TEST profiles made: Pay (no login), Staff (staff login), Manager (manager login) | — |
| Salary change | The admin changed ZZ TEST Pay's salary through the employee edit (200): the log wrote "ZZ TEST 1058 674f Pay salary changed from ฿10,000 to ฿11,000" | — |
| Staff session | ZZ TEST Staff (app role `staff`), signed in through the launcher: searched for the run's words, 3 entries and no salary change; the "Salary Change" filter, 0; the branch's latest 100 entries, 0 salary changes; the dashboard count, 0 | `1058-4-reads-by-role-card.png` |
| Manager session | ZZ TEST Manager (app role `manager`): the same four reads, all 0 salary changes; on the Activity Logbook screen the search lists the three "Employee Added" entries and no salary change | `1058-2-manager-logbook-no-salary-change.png`, `1058-4-reads-by-role-card.png` |
| Admin | The same search lists the salary change with its figures and the three "Employee Added" entries; the filter and the dashboard count include salary changes | `1058-3-admin-logbook-salary-change.png`, `1058-4-reads-by-role-card.png` |

## Clean-up, read back

- The ZZ TEST staff and manager signed out of the app and the launcher.
- On the Console, both ZZ TEST platform accounts were set inactive (200) and
  their OTO App links removed (200). Platform accounts are not deleted, so
  these two inactive ZZ TEST accounts remain.
- The three ZZ TEST profiles deleted (204 each), each read 404 afterwards; no
  app login with a ZZ TEST 1058 address remains (read back afterwards).
- The admin signed out of the app and the launcher.
- Left in the activity log, as the app keeps it (no route removes an entry):
  attempt 2's salary change and three "Employee Added" entries named above,
  and attempt 1's ("ZZ pay salary changed from ฿10,000 to ฿11,000" and the
  added entries of its three ZZ profiles), with any sign-in or removal
  entries the app wrote for them. All name ZZ TEST profiles only.

## Attempt 1 (kept: `attempt-01-receipt.json`)

The profiles' nickname was "ZZ pay", and the log writes the nickname, so the
search for the run's words did not find the salary change and the run
stopped before any session was made. It cleaned up: three ZZ TEST profiles
deleted (204, then 404), no login reached the platform. Attempt 2 gives each
profile its full ZZ TEST name as the nickname.
