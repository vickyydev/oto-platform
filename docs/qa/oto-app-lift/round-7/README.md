# Round 7 staging walkthrough checkpoint - 12 October 2026

**13 October private-file rechecks:** [all recorded file boundaries](private-files.md) now pass. The inspected r7-private-files-release-rechecks-20261013.png records payroll, Fix, drop-off signature and event PDF responses. Exact broader fixture/object cleanup remains.

**13 October further rechecks:** [administration/people/access](administration.md) and all seven [voucher write refusals](staff-vouchers.md) pass their recorded controls. The created person and access policy were removed and read back404. The inspected r7-administration-voucher-rechecks-20261013.png is committed. Remaining private-file rechecks and guarded broader cleanup stay open.

**13 October release update:** the released R7a application now passes the recorded [camp attendance](camps.md), [private payroll](payroll.md) and [form editor save/reload](form-builder.md) rechecks. The two new inspected frames are r7-camp-payroll-release-rechecks-20261013.png and r7-form-reader-reloaded-tablet-20261013.png. Main/staging checkpointd18d3fd8 has the same application code as7402a8da. The table below records the earlier633cae41 observations. Still owed: Data Admin/people/permissions, voucher write refusals, remaining private-file checks and exact fixture/object cleanup.

These inspected 820 x 1180 staging frames and observed requests use live app source 633cae416ff7e4a1c253ec4904cdc22351cf7df1. Launcher sign-in, isolated ZZ TEST records and separate park sessions were used. This is a partial walkthrough checkpoint; new round-7 source is local and its release gate remains open. Final module pages, staged guarded-road rechecks and exact cleanup are owed.

| Module | Observed result | State |
| --- | --- | --- |
| Events, package and BEO | Event/package/line/snapshot 201; other-park reads 404. BEO redirects to a 300-second private PDF, 200 and %PDF, 45,910 bytes; signed-out 401, other park 404, changed signature 403, unsigned 400 | WORKS |
| Menus | Public screen submission 200; owned read 200, other park 404 | WORKS |
| Parent portal and RSVP | Parent/guest links prepared 200; actual RSVP screen submission 200 and exactly one response visible; foreign management/read 403 | WORKS |
| Camps and children | Camp/registration 201; owned history 200, other park 404; owned nondefault-park check-in 404, recorded under SCRUM-516 | BROKEN |
| SOP and KB | Create 201, draft staff read 404, publish 200, owned staff read 200, other park 404 | WORKS |
| Training | Quiz failure and pass each saved 200 with corresponding result; correct answer absent from staff detail, staff edit 403, other park read 404 | WORKS |
| Ask OTO | Thread/message 201, other-park thread 404; own answer cites exactly the two fixture SOP/KB IDs and contains their fact; foreign answer cites neither | WORKS |
| Vault | Metadata excludes value; allowed reveal 200 with value match, staff/foreign reveal 404. Capture shows metadata only | WORKS |
| Payroll files | Four zero-value future-2099 exports generated/downloaded as CSV; private PDF has %PDF signature; signed-out refused, directly linked synthetic staff self-read 200. Other-park export 200 remains assigned to SCRUM-516 | BROKEN |
| Fix and private media | Actual Gallery upload 200 and screen submission 201; own detail/image 200, foreign 404, signed-out media 401. Generated image fixture, no park photo | WORKS |
| Drop-off and nanny | Actual public submission200; staff assignment, entry and checkout200; other-park detail/entry/employee assignment404. Issued shared photo200, unsigned404; private signature own200/foreign404/anonymous401. Synthetic on-duty fixture, no physical clock claim | WORKS |
| Staff voucher entry | Four existing addresses show the Console notice and link; no issue/redemption performed | WORKS |
| Xero unconnected state | Admin status200 connected=false; report400; staff403. Positive sandbox exchange remains unavailable | WORKS for named state |
| Supplier portal | Owned capability/detail/media200, comment201, close200, repeat409, revoke204 and former-link401 | WORKS |
| Form builder | Isolated draft and publication200, public title200; serving builder labels reader returns HTML. Local correction awaits release | BROKEN |

Inspected images committed under docs/qa/jira-comments/attachments/SCRUM-191/: r7-event-tablet-20261012.png, r7-menu-submitted-tablet-20261012.png, r7-parent-portal-tablet-20261012.png, r7-rsvp-submitted-tablet-20261012.png, r7-camp-tablet-20261012.png, r7-sop-tablet-20261012.png, r7-training-completed-tablet-20261012.png, r7-vault-metadata-tablet-20261012.png, r7-payroll-exports-tablet-20261012.png and r7-fix-created-tablet-20261012.png. The payroll image shows the app's existing DRAFT warning; calculation was not run. Setup of the future payroll fixture used Data Admin; the normal period-create screen is not yet verified.

13 October follow-through adds inspected frames r7-dropoff-submitted-tablet-20261013.png, r7-nanny-assigned-tablet-20261013.png, r7-vouchers-console-tablet-20261013.png and r7-xero-unconnected-tablet-20261013.png. See [drop-off/nanny](dropoff-nanny.md), [staff vouchers](staff-vouchers.md), [Xero](xero.md), [supplier portal](supplier-portal.md) and [form builder](form-builder.md) for the exact observed scope.

Remaining walkthroughs: staged form-reader save/reload, Data Admin/people/permissions, camp and payroll ownership after release, voucher write refusals and final private-file rechecks. No Xero sandbox is connected. Cleanup is guarded by exact IDs, parent relations, ZZ TEST labels and object SHA-256 fingerprints in ignored local ledgers. Tokens, secret values and signed URLs remain only in memory. Seeded employees/accounts and existing salary advances are preserved.
