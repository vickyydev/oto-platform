# SCRUM-1038 and SCRUM-1055 on staging, 20 November 2026

The single shift of a former employee, on the old contract. Landed on main at
`9f4dcf9ca8a523d4f4704c533877117e7ba851fa` (app migration 0056,
`single_shift_invitations`); the HR app staging service (`oto-app-staging`) was
deployed by name at that SHA (deploy `dep-dbvrav3m8hqs738otv50`, live
02:53:09Z). Before the check ran, another track deployed the service at
`57b8ac5859f358cb602229f3325f5fc46f69ac76`, a later main that contains this
landing unchanged (the five commits between are the party slips' serving
times); the check ran against that version, which the app answered
(`/api/qa-reports/config`).

Signed in as the staging admin through the launcher. Headless Edge, Bangkok
time, 1440 × 1000 (the schedule picture at 1920 × 1000). Scripts: `proof.mjs`
(the run, record `receipt.json`; the second attempt's record, which stopped at
the dialog's close button, is `attempt-02-receipt.json`) and `picture-2.mjs`
(the schedule picture retaken wide, record `picture-2-receipt.json`). Only ZZ
TEST records made by the scripts were acted on, in the branch "Head Office":
one profile, made through the app and ended in the past through the
offboarding route (resignation, last working day the day before); a ZZ TEST
shift group with one shift row 09:00–15:00; a ZZ TEST kiosk device. No payroll
was calculated, confirmed or paid. No real name is in a picture: the invite
dialog lists the branch's former employees, and every name but the ZZ TEST one
was masked in the page before the picture (one name masked); the schedule
picture is the ZZ TEST row alone.

The casual day rate's pay rule and the service-charge share are the owner's
open answers (N1 and N2 on his page): the "Casual day rate" choice is shown
disabled with its line, and the server refuses it with the same words. Both
tickets go to Testing, not Deployed.

## Result: passed (attempt 3)

| Step | What happened | Picture |
|---|---|---|
| Invite dialog | Scheduling, shifts view, the ZZ TEST row's cell on today, "Invite a former employee": the ZZ TEST profile listed as "Left after 2026-11-19 · no payroll profile" and chosen; "On the old contract" checked; "Casual day rate" disabled with "The pay rule for a casual day rate is being confirmed; use the old contract for now." under it; the no-payroll-profile hint | `1038-1-invite-dialog.png` |
| Invite | "Invite for this shift": 201, pay way `old_contract`, "On the old contract" | — |
| Schedule entry | The cell reads "ZZ TEST faf2 · single shift" (the nickname shortened for the picture and restored after; at 1440 the long ZZ TEST name is cut by the cell as any long name is) | `1038-2-schedule-single-shift.png` |
| Route refuses the casual day rate | `PATCH /api/schedule/single-shift/invitations/:id` with `casual_day_rate` → 400 `CASUAL_DAY_RATE_HELD`, the same words; `POST` a new invitation on it → 400 | on the card |
| Kiosk | `POST /api/kiosk/clock-phone` (the route the tablet calls), with the ZZ TEST device's secret and the ZZ TEST profile's phone: clock-in 200 `IN` and clock-out 200 `OUT`, each with `singleShifts: [{ shiftDate: today, 09:00–15:00, "ZZ TEST 1038 faf2 Morning", branch Head Office, one break 11:30–12:30 }]`; the answer's keys are employee, eventTime, eventType, singleShifts, success (no pay way, no figure) | `1038-3-kiosk-and-route-card.png` |

The pay is not shown on staging. The local check `tests/payroll-single-shift.check.ts`
(embedded Postgres, the app's migrator run twice from empty) pays the same case:
"the former employee is paid one Single shift line: 15,000 ÷ 30 days of
September, taxed and an SSO wage" (500 for the day), with the golden month
unchanged line for line for everyone else.

## Clean-up, and what is left

Removed through the app: the single shift (its assignment, 204), the ZZ TEST
shift row (204) and shift group (204), in each run.

Left on staging, all ZZ TEST, in "Head Office":

- The profile **ZZ TEST 1038 faf2 Former** (employee `586a3c85-…`), resigned,
  LEFT, last working day 2026-11-19, no login. The app keeps a profile that has
  a single shift or a time record for the record (`DELETE /api/employees/:id`
  answers 409 "cannot be deleted: they have 2 time records and 2 single
  shifts"), so it stays: three invitation rows with no shift (one from attempt
  2, two from attempt 3 and the picture retake), and the two time events (IN
  and OUT) of the kiosk check. The profile of attempt 1 was deleted (204): it
  had no shift yet.
- The kiosk device **ZZ TEST 1038 faf2 tablet** (`5961b3ff-…`), switched off
  (`isActive: false`; the delete route answers 500 while time events refer to
  the device). Its secret was shown once and is in no file.

Nothing else on staging was changed: no setting, no real profile, no payroll.
