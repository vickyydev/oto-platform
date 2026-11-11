# SCRUM-811 staging proof: Onboard Again says the roles withdrawn on the platform stay withdrawn

Passed on staging on 11 November 2026 (run 23:15 to 23:16 Bangkok time).

- Source: `98e269843f8887303839366bc8c07f58745d21db`. Deploy `dep-dbq95qom7kps738p9ldg` of oto-app-staging read `live` (finished 23:10:39); the signed-in app reported that same version before the steps.
- Harness: `proof.mjs` in this folder (`node docs/qa/proof-2026-11-11/SCRUM-811/staging/proof.mjs`), the SCRUM-784 method: the staging administrator signs in through the launcher, the login is made with the employee editor's Create Login, and Onboard Again is pressed on the profile page.
- `receipt.json` holds ids and statuses only.

## What was done

Everything was done on ZZ TEST employees this proof made itself. No real person's profile was opened.

1. **ZZ TEST employee with a login.** Employee created (201); Create Login in the employee editor answered 200 with a platform account.
2. **Offboard, last working day yesterday** (the Offboard dialog's own route, 201). The profile read Resigned / Left.
3. **The platform had the restriction.** `GET /api/admin/login-lifecycle` showed the newest `restrict` event `delivered` on the first read (one attempt, no error code, settled about one second after it was queued).
4. **Onboard Again on the profile page**, start date left as prefilled (today), a contract template chosen. The route answered 201 with `started: true`, `login: "already_on"`, `platformRestrictionDelivered: true`. The toast read:

   > **Onboarded again** — The new employment has started. Their till and Console roles were taken back when they left; a Console administrator gives them back on Login users.

   Afterwards the lifecycle list was unchanged: nothing new was asked of the platform.
5. **Control: a second ZZ TEST employee with no login**, offboarded and onboarded again the same way. The route answered 201 with `started: true`, `login: "none"`, `platformRestrictionDelivered: false`. The toast read only:

   > **Onboarded again** — The new employment has started.

## Pictures

All six were opened and checked: only ZZ TEST profiles, no real name, photo, phone or initials; the user menu is masked.

- `811-01-onboard-again-dialog.png`: the Onboard Again dialog as confirmed.
- `811-02-toast.png`: the toast with the new sentence.
- `811-03-toast-on-profile.png`: the same toast on the ZZ TEST profile.
- `811-04-control-dialog.png`, `811-05-control-toast.png`, `811-06-control-toast-on-profile.png`: the control, the toast without the sentence.

## Phone number and email

The login's phone number followed the pattern 010 plus seven random digits: the 01 range holds no subscriber numbers in Thailand. Before use it was looked up in the app (support lookup by phone: no record) and on the platform (Login users search: no account). The number is not written in this folder. Emails were `zz-test-811-…@example.com`.

## Clean-up, read back

- Platform account: switched off on the Console, its OTO App link withdrawn. Read back: status inactive, no role assignments, no effective permissions.
- Both draft contracts Onboard Again made: deleted, read back 404.
- Both ZZ TEST employees: deleted through the app's own delete, read back 404. The login and the person record left with the first one.
- Signed out of the app, the launcher and the Console; each then answered 401.

## What stays behind, by design

- The platform account row, inactive and without roles (accounts are never hard-deleted), with its audit entries. It keeps the test phone number.
- Two lifecycle event rows for the deleted login: the `restrict` event (`delivered`) and a `deactivate` event from the clean-up (`superseded`, `LOGIN_DELETED`).
- The app's activity log lines for the two profiles (created, offboarded, onboarded again), kept without the link to an employee.
