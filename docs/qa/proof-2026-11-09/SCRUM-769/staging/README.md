# SCRUM-769 on staging — proof, 9 November 2026

Live build: commit `61e6c8d8` on oto-app-staging and oto-api-staging (live since 21:50 Bangkok). The app's `/api/qa-reports/config` answered version `61e6c8d8747437bd39d81b35e7d400856a699804`. The same deploys were live before and after the run.
Run from 22:01 to 22:12 Bangkok, signed in as the staging admin through the launcher (app role `global_admin`). Browser: headless Chromium, 1440×900, Bangkok time.
No SMS was sent: the suite sign-in hands back a temporary password, so no code went out. No setting was changed and nothing was deployed, restarted or committed. No real name or phone number appears in any picture or in `receipt.json`. Every call, with its time, answer and ids, is in `receipt.json`.

What was made for the proof, and removed afterwards:
- A ZZ TEST profile, "ZZ TEST 769 Leaver", in Reception at Robinson Chalong. It started on 9 October and has an app login.
- A ZZ TEST phone number for that profile.
- A platform account for the login, made by the OTO App's own suite sign-in route.
- An extra **reception** role at Robinson Chalong on that account, so the restriction had a role to take back.
- A ZZ TEST kiosk device at Robinson Chalong.

## Result: passed

| Step | What happened | Result |
|---|---|---|
| 1. Make the leaver | Profile created with a login (201). Suite sign-in given (200). Reception role added on the Console (200). | Login **on**, `accessMode` **full**. Platform account **active**, with two roles: OTO App access and reception at Robinson Chalong. |
| 2. Before the last day | The person signs in on the launcher with the temporary password, chooses their own password and opens the OTO App. | The whole app opens on Today (picture 01). Their own profile route answers 200. |
| 3. Kiosk before | Phone clock-in, then clock-out, on the ZZ TEST kiosk. | **200 IN**, then **200 OUT**. Both clock events were then deleted (204, 204); 0 left. |
| 4. Offboard, last working day 8 Nov (yesterday, Bangkok) | POST offboarding → 201 | The profile reads **resigned / LEFT** and the badge says **Left** (picture 02). The login **stays on** (`isActive` true), with `accessMode` **pay_only**. |
| 4b. The platform side, at once | The app queued a `restrict` event at 22:02:58 and the platform settled it as **delivered** at 22:03:03 (first attempt). | The account stays **active**. The reception role was **withdrawn**, and only `app_access_oto_app` (operator-wide) is left, so effective permissions went from 62 to 1: `app:oto_app:access`. The open launcher session **ended**. The audit row reads `rolesWithdrawn 1, sessionsEnded 1, accountStatus active`. The person's open app session then answered 401. |
| 5. Kiosk after | The same phone clock-in, by API and on the kiosk page | **403** `EMPLOYMENT_ENDED`, "Employment ended; see reception". The kiosk page shows that line (picture 03). Nothing was written: 0 time events. Two failed attempts are on record with reason `employment_ended`. |
| 6. The leaver signs in again (fresh browser) | Launcher sign-in → 200; OTO App hand-off → 200 | The app lands on **/payroll/me/payslips**. It shows "Your employment has ended; your pay information stays available here." The header holds only **My pay** and **Logout** (picture 04). |
| 6b. Deep links | /employees, /core/today and /hr/schedule were opened by URL | Each one landed on /payroll/me/payslips (picture 05). |
| 6c. The server's fence, as the leaver | | Who am I: 200, `pay_only`. Own payslips: 200 (their own profile, 0 payslips). The employee list, My Account, notifications and today's checklists: each **403** `EMPLOYMENT_ENDED` in words. The launcher refused the till hand-off: **403** "Missing permission app:pos:access". Logout → 200, after which `/api/user` answers 401. The launcher signed out and `/me` answers 401. |
| 7. Console | Login users page, Effective permissions, Sessions | The account reads **active** (picture 06). Its only role is `app_access_oto_app` and it has one effective permission (picture 07). Both sessions are **ended** (picture 08). |
| 8. Onboard Again, start date today (9 Nov) | POST onboard-again → 201, `started: true` | The profile reads **active / ACTIVE**. The login is on, with `accessMode` back to **full**. The person signs in again and the whole app opens on Today (picture 09). My Account, checklists and notifications answer 200. They were then signed out (app 401, launcher 401). |

## Clean-up, read back

- The platform account was **deactivated** on the Console (200) and its OTO App link removed (200). It was not deleted.
- The ZZ TEST profile's first delete answered 409, because the draft contract that Onboard Again made counts as a contract. That draft deleted with **204** this time, and the profile then deleted with **204**. Its login went with it.
- The ZZ TEST kiosk device was deleted (204).
- A read-only check of the database afterwards found 0 rows left for:
  - the app user, the profile, the person record, contracts and engagements;
  - time events, kiosk attempts, the presence row and the kiosk device;
  - role assignments, live sessions and app links on the account.
- The platform account reads **inactive**. Its platform employee record reads **archived**. A sign-in on it with the ZZ TEST password answers **401**.
- The admin is signed out everywhere: app `/api/user` 401, Console `/me` 401, launcher `/me` 401. Every ZZ TEST browser was closed after its own sign-out.
- **One ZZ TEST row is left: see finding 1.**

## Findings to act on

1. **A clean-up leaves a `deactivate` event that can never be delivered.** When the Console switched off the ZZ TEST account, the platform switched the app login off too. The app's trigger then queued a `deactivate` event back to the platform. Once the login was deleted, the platform refuses that event: the login is gone, so the answer is `PLATFORM_HTTP_REFUSED`. The event stays **pending**, and the app retries it every 30 seconds (6 tries by 22:12).
   The SCRUM-795 proof's clean-up left the same kind of row at 15:20 today, and it has been retried 839 times. Those two are the only pending rows in the queue.
   This is not part of SCRUM-769, but it is noise in the transport's warnings. No route removes the row. A fix could be either of these:
   - the platform settles an event whose app login no longer exists as superseded;
   - the app drops pending events when it deletes a login.
2. **The screen does not say Onboard Again left the platform roles withdrawn.** After Onboard Again the reception role stays withdrawn, which is deliberate in the code. The route's answer carries only `platformDeactivationDelivered: false`. It does not carry the `platformRestrictionDelivered` that the code computes, so the manager's toast says nothing about it.
   Only the activity log line says it: "The platform had withdrawn the suite roles outside the OTO App …; a platform administrator gives them back on the Console's Login users page." A manager will not see that unless they open the log.

## Notes

- Face clock-in is off on staging, so each of the three face tries on the kiosk page answered "no match" and sent the tablet to the phone road. The face road's own refusal was not run on staging. The test browser held back the phone fallback's photo upload, so no picture was stored.
- Picture 05 looks the same as picture 04, because a headless picture has no address bar. `receipt.json` records each address opened and where it landed.
- In picture 01, "Chalong" in the branch name is blacked out. The word also appears in a staff name, so the masking caught it. Picture 09 shows the branch name in full.

## Pictures

- `769-st-01-zz-full-app-before-last-day.png` — the leaver before the last working day: the whole app (Today, Check-ins, Fix, Ask OTO).
- `769-st-02-profile-left-after-offboard.png` — the profile just after Offboard with a last working day of yesterday: badge **Left** and the **Onboard Again** button.
- `769-st-02b-profile-page-full.png` — the same page whole, as the admin sees it. The admin's name in the corner is masked.
- `769-st-03-kiosk-refuses-ended-employment.png` — the kiosk page at Robinson Chalong after the phone number is entered: "Employment ended; see reception".
- `769-st-04-leaver-lands-on-my-pay.png` — the leaver's app after sign-in: My pay and Logout only, the one-line notice and their own (empty) payslips.
- `769-st-05-employees-link-sends-leaver-to-my-pay.png` — after opening /employees by URL: the same My pay page.
- `769-st-06-console-login-users-zz-account.png` — the Console's Login users page filtered to the ZZ TEST account: **active**. The phone is blacked out.
- `769-st-07-console-permissions-only-oto-app.png` — Effective permissions: one role, `app_access_oto_app` operator-wide, and one permission, `app:oto_app:access`.
- `769-st-08-console-sessions-ended.png` — Sessions: both of the account's sessions **ended**. The first one ended at 22:03, when the restriction was delivered.
- `769-st-09-onboard-again-whole-app-back.png` — after Onboard Again, the same person's whole app (Today) is back.
