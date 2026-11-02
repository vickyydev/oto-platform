# SCRUM-673 approved view-as staging proof

Verified 2026-11-02T22:52:56.548Z. OTO App source `629714f266253c4b6951b68237da7db13c8cf26e`, [CI 41362034249](https://github.com/vickyydev/oto-platform/actions/runs/41362034249). Platform source `7a00aa1ce44af50622d3cde0bd5e84f80607c2a6`, [CI 41532107227](https://github.com/vickyydev/oto-platform/actions/runs/41532107227). No product change was needed.

A separate temporary ZZ TEST platform administrator signed in and approved the exact request. The actor consumed that approval to open an actual write-enabled view-as window. Its subject was a new ZZ TEST app-only manager provisioned through normal Console app linking, with no Console permission. The seeded manager was correctly refused as privileged and its permissions were not changed.

The read-only window refused the write with 403. The approved write window cleared only a new, empty ZZ TEST department for a future week: zero people, assignments and breaks were changed. This made a real Schedule History entry. The native history card visibly says **done by a support administrator viewing as them**. Independent read-only job job-dbkh7nom7kps739597f0 confirms the real actor, subject account, subject app user and window match the stored record. The same ordinary action has no view-as fields. This verifies an actual clear-week history action; no person's shift was moved.

Both windows are ended. Both temporary accounts are inactive and have zero grants; the subject's app user is inactive, and the approver's live Console session returned 401. Both empty test departments, including the one from the earlier guarded attempt, are inactive. The sessions are signed out. No API setting, SMS, real person's data, park device or electronic payment was used.

Early harness stops and the privileged-subject refusal are retained in the receipts. The first checks stopped before fixture creation; the later temporary account and empty department were retired before the successful proof. No refusal was bypassed and no unknown write was retried.

| Service | Live commit | Deploy |
|---|---|---|
| oto-api-staging | 7a00aa1ce44af50622d3cde0bd5e84f80607c2a6 | dep-dbkgtimc6qcc73fpsdu0 |
| oto-console-staging | 7a00aa1ce44af50622d3cde0bd5e84f80607c2a6 | dep-dbkgmspsrm7s73b81gf0 |
| oto-launcher-staging | 7a00aa1ce44af50622d3cde0bd5e84f80607c2a6 | dep-dbkgmspsrm7s73b81gt0 |
| oto-app-staging | 629714f266253c4b6951b68237da7db13c8cf26e | dep-dbjsjmk9v7es73b1lhpg |

Proof: [s673](./s673/). Opened images: `s673-staging-proof.png` and `s673-view-as-history.png`. Keep Testing until those images are attached and the Jira helper walk reads back Deployed.
