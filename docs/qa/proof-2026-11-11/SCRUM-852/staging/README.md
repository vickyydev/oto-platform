# SCRUM-852 staging proof: a switch-off still reaches the platform, and Send again refuses when nothing waits

Passed on staging on 12 November 2026 (run 00:25 to 00:26 Bangkok time).

- Source: `70d45d0d18d95d061e4a7abe079d90dbc1932a18`. Deploy `dep-dbqa6nm1egvs73d1eu7g` of oto-app-staging read `live` (finished 00:20:40 Bangkok); the signed-in app reported that same version before the steps.
- Harness: `proof.mjs` in this folder (`node docs/qa/proof-2026-11-11/SCRUM-852/staging/proof.mjs`), the SCRUM-811 method: the staging administrator signs in through the launcher, the login is made with the employee editor's Create Login, and the login is switched off with the panel's own Disable Login button.
- `receipt.json` holds ids and statuses only.

## What staging shows, and what it does not

**Shown on staging:** the change did not break delivery. A switch-off and a leaver's move to pay only both reached the platform on the first try; the Access & Login panel in its normal state carries no notice; the Send again route refuses an event that is not waiting.

**Not shown on staging:** the two things the ticket adds for the bad cases.

- *An outage no longer ends delivery.* Staging's platform was up, and taking it down is not something a proof may do.
- *The line "The platform was not told…" with its Send again button.* It appears only when the platform itself refuses an event six times. The platform refuses a switch-off for the park's last administrator, or for a login it cannot match to an account of this park; a ZZ TEST login is neither, and making one refuse would mean touching a real administrator or writing to the database. No database write was made: none is approved.

Both are proved by the checks at the landed source (`852-05-checks.png`, text in `852-checks.txt`). The parked line and a working Send again can be demonstrated on staging with one hand-parked ZZ TEST event, if a database write is approved for it.

## What was done

Everything was done on one ZZ TEST employee this proof made itself. No real person's profile was opened.

1. **ZZ TEST employee with a login.** Employee created (201); Create Login in the employee editor answered 200 with a platform account, which the Console listed as `active`. No lifecycle events yet.
2. **Switch-off.** Disable Login on the ZZ TEST profile's Access & Login panel answered 200 ("Login disabled successfully"). `GET /api/admin/login-lifecycle` showed one `deactivate` event: `pending` at 0 s and 15 s (no attempt yet, no error code), `delivered` at 30 s, **one attempt, no error code, `parked: false`**. The Console then listed the platform account as `inactive`.
3. **The panel in its normal state.** Opened afresh after the delivery: its own lifecycle read answered 200, the button reads Enable Login, there is no "The platform was not told…" line and no Send again button anywhere on the page.
4. **Send again when nothing is parked.** `POST /api/admin/login-lifecycle/send-again` with the delivered event's id answered **409**:

   > This is no longer waiting: it was already sent again, or the platform has it now.

   The lifecycle read before and after was identical, field for field, and the platform account stayed `inactive`.
5. **Pay only.** Enable Login (200; the platform account stays `inactive`, the app never switches an account back on), then Offboard with a last working day of yesterday (201; the profile read Resigned / Left). The `restrict` event was `delivered` at 30 s, **one attempt, no error code, `parked: false`**. The panel again carried no notice.

## Pictures

All five were opened and checked: only the ZZ TEST profile's panel, no real name, photo, phone or initials; the user menu is masked.

- `852-01-panel-login-on.png`: the Access & Login panel before, with Disable Login.
- `852-02-panel-after-switch-off.png`: the panel after the switch-off was delivered: Enable Login, no notice, no Send again.
- `852-03-profile-after-switch-off.png`: the same on the profile page.
- `852-04-panel-after-offboard.png`: the panel after the move to pay only was delivered: no notice.
- `852-05-checks.png`: the checks. The landing run (6 run, 0 failed), the suite's record of the lifecycle check file (20 of 20; the suite 62), and that file's cases: twenty tries against an unreachable platform never park; a refusal parks after six tries; Send again re-queues once and delivers; two presses at once send one; the panel's line and button.

The case lines in `852-05-checks.png` are the check file's output as kept from the build; its bytes hash to the `stdoutSha256` the landing run's suite recorded for that file.

## Phone number and email

The login's phone number followed the pattern 010 plus seven random digits: the 01 range holds no subscriber numbers in Thailand. Before use it was looked up in the app (support lookup by phone: no record) and on the platform (Login users search: no account). The number is not written in this folder. The email was `zz-test-852-…@example.com`.

## Clean-up, read back

- Platform account: already `inactive` from the delivered switch-off, so the Console's switch was not pressed again; its OTO App link was withdrawn (200). Read back: status inactive, no role assignments, no effective permissions.
- ZZ TEST employee: deleted through the app's own delete (204), read back 404. The login and the person record left with it. No contract was made in this proof.
- Signed out of the app, the launcher and the Console; each then answered 401.

## What stays behind, by design

- The platform account row, inactive and without roles (accounts are never hard-deleted), with its audit entries. It keeps the test phone number.
- Two lifecycle event rows for the deleted login, both `delivered`: the `deactivate` and the `restrict`.
- The app's activity log lines for the profile, kept without the link to an employee.
