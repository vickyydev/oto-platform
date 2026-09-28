# Bench round 1 - staging proof

28 September 2026, 21:23 Bangkok. Staging commit: `b9d68e3`.
[Green CI](https://github.com/vickyydev/oto-platform/actions/runs/36432299165).

The proof used the existing Booth 2 (proof), staging's virtual box and a simulated
receipt printer. This verifies the deployed software; the owner still updates and
checks the physical Pi. Temporary station, staff, PIN and screen settings were
restored. No PIN, pairing code, credential or complete voucher code is recorded.

| Ticket | Staging screenshot | Jira attachment |
| --- | --- | --- |
| SCRUM-448 | SCRUM-448-staging-reveal.png | 10841 |
| SCRUM-449 | SCRUM-449-staging-staff-list.png | 10842 |
| SCRUM-449 | SCRUM-449-staging-pin-pad.png | 10843 |
| SCRUM-449 | SCRUM-449-staging-staff-menu.png | 10844 |
| SCRUM-450 | SCRUM-450-staging-pin-controls.png | 10845 |
| SCRUM-451 | SCRUM-451-staging-checklist.png | 10846 |
| SCRUM-451 | SCRUM-451-staging-spins.png | 10847 |
| SCRUM-451 | SCRUM-451-staging-vouchers.png | 10848 |

`verification.json` records the measured result: queued at the press, print called
6,651 ms later with the result visible, printed, repeated safely, unknown spin 404.
Staff selection and five PIN digits used only Space; the held button opened the
staff menu. Generate and set accepted five digits and persisted expiry; four and
six digits were refused, and the temporary PIN was removed and checked absent.
The printed spin appeared in Spins and Vouchers, and its last four appeared in CSV.
The six checklist steps were visible on the same booth page.

Expiry refusal at the box and branch/date filtering were also exercised by the
local disposable probes described in the session handover. The existing test,
typecheck, lint, migration and build gates passed. No new test suite was added.
