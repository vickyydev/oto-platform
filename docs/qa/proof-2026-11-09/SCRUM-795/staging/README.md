# SCRUM-795 on staging: OTO App staff sign in on the launcher with their app password

Proved on 9 November 2026 (times are UTC) against staging: api at `8250eca8f`, OTO App at `6fe36b12b`, launcher and Console at `9d79b31fb`. Repository head `82c743c0c`. Nothing was committed, and no setting or deploy was changed.

## What was proved

An OTO App user who has no platform account gets one from the provisioning job, linked to their app user and carrying their phone number. That account has no platform password yet. The first time the person signs in on the launcher, the password they type is checked against the OTO App's own record of their password and, if it matches, kept as their suite password.

The test user was on a temporary password, as every new app user is. So the launcher accepted that password once and then asked for a new one before opening anything. After the change, only the new suite password works. The old app password is refused.

The whole run used one ZZ TEST user. No real person's account or password was touched, and no SMS was sent: the test phone is unverified and no code was ever asked for.

## Result: PASS on every step

| Step | What happened | Answer |
|---|---|---|
| 1. Create the test user | The staging admin (global admin in the app) went from the launcher into the OTO App and used the app's own "create user" route to make **ZZ TEST 795 Staff mw8zeis6**: staff, Robinson Chalong, phone +66900000795, temporary password, "must change password" on | 201 |
| 2. Dry run | The provisioning job found exactly **one** person to provision: this staff user. Every other count matched a baseline dry run taken before the user existed | 1 provision |
| 2. Apply | Run with `--apply --actor 01a0bbdc-8c64-7283-aa3b-2af7e79c525d` | 1 provisioned, 0 failed |
| 2. Read back in the Console | One account on +66900000795: active, "must change password" carried over from the app, phone not verified. It is linked to the test app user, the app user carries the account's id, and the only access is the OTO App tile (operator-wide) | as expected |
| 3. First sign-in | Launcher, +66900000795 and the temporary **app** password | 200, change asked |
| 3. Before the change | Opening the OTO App was refused | 403 `MUST_CHANGE_PASSWORD` |
| 3. Change password | New ZZ TEST password set on the launcher's "Choose your own password" screen | 200 |
| 3. OTO App tile | The launcher opened the OTO App, which signed in as the test user (role staff, Robinson Chalong) | 200 |
| 4. Sign out | Launcher sign-out also ended the OTO App session | 200, then the app answers 401 |
| 4. Second sign-in, new password | | 200, no change asked |
| 4. Sign-in with the old app password | Refused with the same message as any wrong password | 401 `INVALID_CREDENTIALS` |
| 5. Clean-up | See below | all done |

The database confirms the trail (read-only check): exactly **one** `account.password_adopted` record, written in the same request as the first sign-in and holding ids only. The second sign-in adopted nothing. The account's password is now stored as an argon2id hash. The old-password attempt is recorded as `bad_password`.

## Counts from the provisioning job

| Outcome | Baseline (before the test user) | Dry run | Apply |
|---|---|---|---|
| app users read | 79 | 80 | 80 |
| provision | 0 | **1** (staff) | **1** (staff) |
| inactive | 13 | 13 | 13 |
| already_linked | 52 | 52 | 52 |
| no_phone | 13 | 13 | 13 |
| phone_taken | 1 | 1 | 1 |
| global_admin, unknown_role, other_park_group, phone_shared, employee_held, failed | 0 | 0 | 0 |

For the one person provisioned:
- the phone came from the user's own `phone_e164`;
- the phone was counted as unverified, so no SMS reset is possible;
- the forced password change was carried over (1);
- no employee record carries the user;
- access is the OTO App tile only.

## Pictures

| File | What it shows |
|---|---|
| `01-first-signin-filled.png` | The launcher's sign-in form with the test number and the temporary app password. The browser masks the password as dots |
| `02-change-password-asked.png` | Right after that first sign-in: the launcher's "Choose your own password" screen |
| `03-launcher-home-oto-app-tile.png` | After the change: the launcher home for +66900000795 with the OTO App tile, and nothing else on its access |
| `04-oto-app-first-screen.png` | The OTO App opened from the tile: its Today page at Robinson Chalong, initials "ZT". No real names are on screen, so nothing needed masking |
| `05-oto-app-user-menu.png` | The same page with the account menu open, showing the session is the test user (ZZ TEST 795 Staff mw8zeis6, its example.invalid email) |
| `06-second-signin-new-password-home.png` | After signing out and back in with the new suite password: the launcher home again |
| `07-old-app-password-refused.png` | After signing out again, the old temporary app password typed in: "Phone or password is incorrect" |

## Everything created, and how it was cleaned up

| What | Id | Clean-up | Read back |
|---|---|---|---|
| OTO App user | `57b8850c-9575-4d73-a41b-121e5ba91887` | Deleted through the app's own route (`DELETE /api/users/:id`, 204) | 404, no row left |
| Platform account | `01a1bf62-22b0-711e-ad7f-2de9eab6854a` | Deactivated in the Console (`PATCH /api/accounts/:id {status: inactive}`), which also ended its sessions and switched the app user off | inactive; a sign-in is refused |
| OTO App link | `01a1bf62-22be-759e-a615-6dc5bda432ea` | Unlinked in the Console (`DELETE /api/admin/apps/oto_app/users/:accountId`), access revoked | none left |
| OTO App tile grant | `01a1bf62-22c2-700e-8487-7941068a362a` | Withdrawn by the unlink | 0 role assignments |
| Sessions | two launcher sessions, one app session, the admin's sessions | Everyone signed out of the launcher and the app. The launcher sign-out also closed the Console sessions | 401 everywhere |

Still on staging, by design:
- **The inactive account still holds +66900000795.** Accounts are never hard-deleted, so a later proof that needs this number must free it first or use another test number.
- Audit rows for every step. The platform's audit log is append-only.
- The OTO App's own activity rows for creating the user.

## How the passwords were handled

The temporary app password and the new ZZ TEST password were generated inside one proof process and kept only in its memory. That process wrote every result through a filter that removes them, and it cleared them when it stopped. No password, token or hash is in `receipt.json` or in any picture. The only phone number in this folder is the ZZ TEST number.

## Two things worth knowing

- **The launcher greets the person at Central Floresta, not Chalong.** The account's only grant is the operator-wide OTO App tile, so the launcher seats it at a branch of its own choosing. Its line under the greeting reads "Oto Play Park, Central Floresta", while the OTO App itself opens at the person's app branch, Robinson Chalong. Nothing is refused because of it, but a Chalong staff member will see another park named on the launcher.
- **14 active app users are still without a suite account** (11 staff and 3 managers). They had none before this proof and still have none: 13 have no usable phone and 1 has a phone another account already holds. This proof did not touch them.

`receipt.json` lists every write with its time, answer and ids, every check, and the clean-up.
