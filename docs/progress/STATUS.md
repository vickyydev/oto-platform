# Current status - read this first when resuming

**5 October 2026, evening - SCRUM-494 food warning follow-up:** A restriction-only child's note was hidden at both F&B screen sizes because the warning rendered only when an allergy/medical note was present. The desktop and phone screens now share a safety banner that shows a restriction even on its own. The existing `s494-food` file passes 10 tests, POS typecheck and scoped lint pass, and the production POS build succeeds. This source fix awaits push, staging deployment and a real restriction-only band screenshot; SCRUM-494 remains Testing. The previous takeover checkpoint follows.

**5 October 2026, evening - SCRUM-493 resumed:** SCRUM-494 remains Testing, SCRUM-493 In Progress. Main is at `e8dd0b1e` and API/POS staging is live at `0c641b7e`; both contain the nine SCRUM-494 changes. Focused existing `s494` checks passed today: POS 58, shared 19, box 12, API 72, database 6 (167 total). A signed-in staging administrator reached Reception Till 1 on the current POS deployment. This is a source and entry check, not completion of the nine staging workflows. Historical real staging screenshots for items 1-5 were located in the prior session's temporary evidence folder; they must be reviewed, redacted where a band credential is visible, and supplemented with current evidence. Items 6-9 still need staging proof. SCRUM-494 cannot move to Deployed yet. The saved End of Day round-2 branch is unreviewed and conflicts with current migration 0057; its new migration must be 0058, and its failed-outbox/disabled-box/receipt edge cases need review before landing. Work continues on clean `feat/till-consistency-493` in `oto-pos-voucher-slip`; the original checkout remains untouched.

**5 October 2026, evening - Lucky Wheel slip and prize QRs:** SCRUM-499 and SCRUM-500 are Deployed for verified staging software, with named screenshots attached (11252-11258) and comments 11515/11516. Physical print/current-POS scan remains an on-site acceptance step. API/Booth/Pi source 7eca6612 passed CI 37289763344; Console 0c641b7e is live and locally/staging verified. Its separate CI 37292071118 attempt 1 hit a print-worker onTaskUpdate timeout; attempt 2 is pending, not called green. The earlier proof-booth draft was restored from its guarded audit snapshot; all temporary QA fixtures are archived.

**5 October, park QR follow-up:** the owner reports the Pi update completed, but a NEW 100 THB spin still printed a QR scanning to the previous URL after an override edit and publish. SCRUM-499 is reopened In Progress for diagnosis. Live version 14 had saved/published plain codes for 100/200/300 THB and the physical box reported running 14; config_apply succeeded. During checking, the owner cleared the 100 THB override and published version 15, now also reported running; no settings were changed by the investigation. Latest observed 100 THB print was 18:34 Bangkok, before version 15. Direct SSH from this environment timed out. A read-only Pi command has been requested to report release path and whether the last eight remembered print jobs contain URLs or plain codes, never actual QR values. Await this evidence; do not assume a restart fixes the cause. Keep the owner's latest draft/prize edits.

Console CI 37292071118 attempt 2 is now SUCCESS; API, Console, Booth, POS and Launcher staging are observed live at 0c641b7e. The CI-packed 7eca661 Pi archive is still correct. SCRUM-500 stays Deployed; its English/Thai terms fields were verified live as enabled multiline controls, 2000 characters each, with Print the terms on in the latest park draft. Physical paper/current-POS acceptance is still not claimed.

FWBooth1 has six exact current-POS QR mappings and bilingual showcase saved as a draft. The approved seventh prize, Kids Pizza, shares the former 300 THB 10% slot: each has 5%; all other chances remain, total 100%. 300 THB stays generated. Published/running version was still 11; do not publish until the park Pi update. The owner is now at the park with SSH to 192.168.0.240 and is copying the package. Physical update, reboot, draft publish and scan have not yet been confirmed.

The green CI-packed oto-box-0.1.0-7eca661.tgz and checksum are on the Desktop; hash verified twice: 970d5340b45f892174de2167ef5806c2858480e3a5239cf031f7a69e4cdf063e. Older 0468c38/d10d78f pairs moved into old-oto-box-releases. Exact CMD/PowerShell copy, Pi install/reboot, five-second polling explanation and static/dynamic QR switching steps are in docs/qa/voucher-slip/update-at-park.md and a Desktop copy. CMD requires %USERPROFILE%, not PowerShell $env:USERPROFILE.

See docs/qa/voucher-slip/README.md for checks, source, fixture cleanup and evidence limits. Six original QRs and twelve printer renders matched exactly; no actual redeemable values are in source, Jira or evidence. Normal publish queues config_apply; the box and TV poll every five seconds. No supported standalone five-second fetch CLI exists. An idle-box service restart reloads published settings. Current-POS redemptions do not update the platform ledger.

_Last updated: 2026-10-02, late night Bangkok (hand-over point from the local
session). Platform lane: main and staging at 9a14af81, CI green, migrations
through 0054. SCRUM-494 (all nine till-consistency items) is in Testing,
with its staging evidence half done. S2-15a End of Day: round 1 is on
staging; round 2 is in flight on wip/eod-round-2-inflight. A hosted
(cloud) session resumes from docs/handover/CLOUD_HANDOVER.md, which gives
the order of work (section 3) and the work in flight (section 10)._


## Active OTO App lane - 30 September 2026

**1 October SCRUM-193 break checkpoint:** oto-app-staging deployment `dep-dauteck1nsns73fl4pkg` is LIVE at exact source `547532f2`; health `200`. Offboarding staged employee create/UI submit `201`, six checklist items and duplicate refusal `409`; Jira screenshot 11227 and exact cleanup of 6 checklist, 3 activity, 1 change, 1 offboarding and 1 employee, final `404`/zero. PIN IN and phone OUT each returned `200`; post-fix Timekeeping Review/Detail screenshots 11225/11226 show the action and correct Phone/PIN labels; no-device/anonymous `401`, forged photo `400`, zero residual rows. The post-fix staff Fix gallery/report/media path passed and screenshot 11228 shows the full preview; its report/original/thumbnail were removed, later reads `404`. Existing timekeeping/offboarding browser specs cannot collect without `fixtures/users.json`; combined production build passed, TypeScript remains at 468 inherited diagnostics and forced scoped lint has no changed-line findings. CI runs for the deployed source were still in progress when this checkpoint was prepared, not called green. SCRUM-193 remains In Progress, not Deployed. The Offboarding Reason field shows raw `personal_reasons`; log it under this ticket. Owner decisions: display-only Ask OTO titles suffice, no title migration; Xero sandbox is not connected, so positive exchange is disabled on staging. Next app work and exact platform dependencies are in the newest SCRUM-193 STOP POINT and closure plan. A safe restricted staging identity is still needed without new setup messages.

**1 October SCRUM-193 tablet and phone-label fixes ready:** app source `bb5ba1c9` shows the full selected Fix photo in its preview tile; `593c72c1` keeps Timekeeping row actions visible at 820px; `e2261837` labels `PHONE_FALLBACK` as Phone rather than Face in detail/session events. The exact combined source build passed. TypeScript retains 468 inherited diagnostics; forced scoped lint has old-file findings, none on the edited lines. Existing Timekeeping browser spec cannot collect because `fixtures/users.json` is absent. New source awaits push/deploy and fresh real staging screenshots. PIN and phone clock staging requests already returned `200`; anonymous/no-device/forged-photo denials returned `401`/`400`, and exact fixture cleanup found zero residual rows. This is not camera-photo or restricted-branch proof. SCRUM-193 remains In Progress.

**1 October SCRUM-193 jobs contract finding:** the platform has `ops_run`/Health/Failures tables and admin routes, but no service-auth register/claim/complete API for OTO App jobs; its runner registers only platform jobs, so a raw app-side write would not make Console retry work. Needs from the platform lane: runner ownership with authenticated OTO invocation or a tenant-aware service job contract with advisory locks, expectations and retry, plus tenant-safe finance/Attention decisions. Exact source finding is in `docs/qa/oto-app-lift/closure-plan.md`; no cross-lane files changed.

**1 October SCRUM-193 Fix staff-path staging proof:** live `0296f26b` uploaded a synthetic image through the normal 820px staff Fix screen (`200`), created a report (`201`), then read its My Reports row, detail and private image (`200`); anonymous detail returned `401`. Three real success/list/detail screenshots are Jira attachments 11222-11224. A guarded exact cleanup removed the report, image and thumbnail; subsequent reads were `404`. The selected-image tile was visibly clipped on its left edge at tablet width, and a small app-owned repair is being prepared. Restricted-staff and wrong-branch staging reads remain unproven with the available admin sign-in. SCRUM-193 remains In Progress.

**1 October SCRUM-193 offboarding duplicate guard:** the tenant/branch guard passed 43 disposable HTTP assertions but revealed duplicate offboarding on repeated POST. Follow-up source `4b557c77` serializes each employee's existence check/insert and returns `409` before side effects on a duplicate. A fresh 47-assertion disposable two-tenant probe passed, including two concurrent manager POSTs yielding one `201`, one `409`, one record and six checklist items; clone dropped. Build passed; 468 inherited TypeScript findings and inherited lint, none on changed lines. Downstream status/history/checklist writes are still outside the insert transaction. Deploy and positive synthetic UI proof remain; no real employee was changed. Needs from the platform lane: a historical duplicate audit and eventual forward-only unique employee constraint if required for data integrity.

**1 October SCRUM-193 Offboarding source checkpoint:** `a80da9fc` guards all seven employee/offboarding/checklist routes by signed-in tenant and branch, with staff limited to own employee reads; unknown/cross-scope IDs fail 404 before writes. Isolated build passed, 469 inherited TypeScript diagnostics and inherited lint findings, none on guard lines. Existing departed test cannot collect due missing fixture; disposable two-tenant HTTP probe is in progress. Do not stage against real employees: positive offboarding mutates status and creates six checklist, one change and activity rows. Exact synthetic cleanup and live screenshot remain. SCRUM-193 stays In Progress.

**1 October SCRUM-193 platform gate re-audit:** committed `origin/main` `e33664e8` still lacks `otoapp_v` POS views/read test, persisted leave approval and CI structure-only restore; shared-key Directory, unowned legacy tables, non-null shift group and OTO App timers outside durable `ops_run` remain BROKEN for the required multi-tenant/operations contract. Source classification and files are in `docs/qa/oto-app-lift/closure-plan.md`. The platform lane owns these migrations/API/POS/CI changes; app lane continues independent module work. A safe pre-existing restricted staging identity has been requested; normal new account provisioning sends SMS. SCRUM-193 cannot honestly transition Deployed yet.

**1 October SCRUM-193 Users action staged:** live `0296f26b` opened Create User at 820px, created a labelled staff user on one branch (`201`), edited its name (`200`), refused an invalid branch (`403`) and returned no password hashes. Reviewed real screenshot attached as 11221. Exact-ID Data Admin cleanup removed the user, access and activity rows (`204` each), final detail `404`, related searches zero. Temporary password existed only in memory; this route has no message sender. Restricted-role/foreign-tenant staging identity and platform Directory remain. SCRUM-193 is In Progress.

**1 October SCRUM-193 Users UI checkpoint:** live `30624922` returned a three-user scoped list and own detail (`200`) with no password hashes, anonymous Users `401`; reviewed real 820px screenshot attached as 11219. That live page had no trigger for its existing Create User dialog and obscured status/actions at tablet width. A small app-owned button/table scroll cue repair now passes build, 469 inherited TypeScript diagnostics with none in the changed page, and scoped lint zero errors/one inherited warning. It awaits push, deploy, reversible synthetic user action and final screenshot. SCRUM-193 remains In Progress.

**1 October SCRUM-193 Check-ins source-live checkpoint:** exact `30624922` is live. Signed-in authorized branch check-ins and nanny availability returned `200`; unknown branch `403`, missing check-in `404`, anonymous check-ins `401`. A reviewed real 820px empty-board capture is attached to SCRUM-193 (11220). This is not a second-tenant staging or positive check-in write claim; the nine-case two-tenant probe was local. No fixture was created. POS coexistence remains a platform decision; SCRUM-193 stays In Progress.

**1 October SCRUM-193 BEO package UI staging checkpoint:** live `30624922` let a signed-in administrator apply a disposable package through the newly mounted birthday editor control; its saved snapshot appeared in the actual Day-of page and BEO API. Two reviewed real 820px images are attached to SCRUM-193 (11217/11218). Guarded exact-ID cleanup removed eight QA rows; final event/snapshot/selection/BEO/kitchen/package reads were `404`, menu absent. The changed `BeoViewOnly` component is unmounted; the live read-only screen uses `BeoDayOfView`. SCRUM-193 remains In Progress for other gates.

**1 October SCRUM-193 Users/permissions source checkpoint:** `15d1efde` scopes User Management and HR login/access paths to the signed-in tenant, validates branch ownership, retains explicit tenant identity for branchless accounts and removes password hashes from management responses. Thirty disposable two-tenant HTTP assertions, storage auto-link and the existing sign-on test passed; build passed. App typecheck has 469 inherited diagnostics and scoped lint inherited findings, none on edited lines. Deactivated-session spec cannot collect due missing repository fixture. Signed-in staging and safe no-SMS user-action proof remain. SCRUM-193 stays In Progress; BEO package UI commit awaits landing.

**1 October SCRUM-193 check-in tenant source checkpoint:** authenticated check-in/nanny routes now use user or kiosk tenant context, confirm branch ownership, and tenant-qualify reservation deletion. The affected existing browser test passed; nine disposable two-tenant HTTP assertions passed and the clone was dropped. App build passed; 473 inherited typecheck diagnostics, none in the edited route; scoped lint has zero errors. Signed-in staging proof remains after deploy. Users/permissions and BEO package UI isolated commits await landing. SCRUM-193 remains In Progress; platform dependencies below still apply.

**1 October SCRUM-193 Supplier media/reply/expiry checkpoint:** live `4baed2aa` served a synthetic labelled PNG to the allowed supplier (`200`), refused the other branch (`403`) and an unlinked image (`404`); supplier and staff comments each saved (`201`) and appeared together. A separate 90-second link validated before expiry (`200`), then naturally expired: validate/list/media `401`, with real denial and admin Expired screens. Four reviewed 820px images are attached to SCRUM-193 (11213-11216). Guarded exact-ID/object cleanup removed one report, two comments, three tokens and the PNG; final report `404`, object absent, branch report count zero and existing branches retained. Supplier portal action/access acceptance is now WORKS; normal staff upload/create remains a Fix report path. The earlier BEO editor image was taken during sheet animation, so the alleged persistent width defect is withdrawn in Jira comment 11419 and QA text. The check-in tenant guard now passes the affected existing browser test, nine disposable two-tenant assertions, build and edited-line lint/typecheck delta; its scratch DB was dropped. Users/permissions and package UI commits are ready in isolated worktrees for landing after this checkpoint.

**1 October SCRUM-193 BEO event-use checkpoint:** on live `4baed2aa`, a synthetic birthday event produced a one-line package snapshot and a submitted set-menu choice; package/selection/Kitchen/BEO readbacks were `200`, and anonymous event/snapshot reads `401`. The reviewed real 820px Kitchen screenshot (11211) shows included/chosen items and “Selections received.” The second editor screenshot (11212) was captured during the sheet animation and is inconclusive for final width; the package component is not mounted. Guarded preflight and transactional cleanup removed exactly eight QA rows; final event/snapshot/selection/BEO/kitchen/package reads were `404` and the menu list omitted its ID. The PDF request in this run timed out; earlier independent BEO PDF proof remains. SCRUM-193 stays In Progress. A separate app-owned check-in tenant repair is under local verification; a Users/permissions scope repair and BEO package UI placement are being built in isolated lanes.

**1 October SCRUM-193 Supplier positive staging checkpoint:** on live `4baed2aa`, two branch-limited QA tokens isolated one disposable Fix report: allowed list one, other branch zero, and wrong-branch detail/comment/close each `403`. The Supplier portal saved a comment (`201`), marked the report Done (`200`), showed zero open/one completed and its resolution, and refused a repeat close (`409`). Revoked tokens returned `401`; guarded exact-ID cleanup removed the synthetic report, comment and tokens, while both existing branches remained and the allowed count returned to zero. Six reviewed real 820px captures are attached to SCRUM-193 (11205-11210). Live media, staff reply and natural expiry remain open. The parent stays In Progress. CI run 36803241985 on source `4baed2aa` completed workspace Typecheck, Lint, Test and Build, but the separate OTO App is outside that Turbo package set and structure-only restore was skipped; app-local baseline checks and the platform restore gate remain distinct.

**1 October SCRUM-193 Packages/Menu positive staging checkpoint:** exact `4baed2aa` remains live. A launcher-signed administrator saved a uniquely labelled package, one line item and a one-item set menu (`201` each); detail/list reads returned the saved records, and a separate anonymous line-item read returned `401`. Two reviewed real 820px screenshots are attached to SCRUM-193 as `scrum-193-package-saved-tablet-2026-10-01.png` (11203) and `scrum-193-set-menu-saved-tablet-2026-10-01.png` (11204). A guarded read-only one-off preflight and transactional exact-ID cleanup both succeeded; final package/line reads were `404` and neither list contained the synthetic IDs. No QA template remains. Event snapshot/selection and signed-in foreign-tenant proof remain open. Parent SCRUM-193 stays In Progress; platform/CI gates remain as recorded below. Supplier positive-path rehearsal is under way.

**1 October SCRUM-193 Organization staging checkpoint:** exact `4baed2aa` is live on oto-app-staging and health returned 200. A launcher-signed administrator created a labelled unassigned operator through the Operators UI at 820px; detail, branches and users returned 200, with zero assignments. A tenant-change PATCH returned 400 and an anonymous detail read 401. The reviewed real `scrum-193-operator-created-tablet-2026-10-01.png` capture is attached to SCRUM-193. Exact-ID delete returned 200, later detail 404 and list had zero matches. Department creation, lower-role/foreign-tenant staging denial and tenant-bearing user assignment remain open; no synthetic operator remains. Parent SCRUM-193 stays In Progress.

**1 October SCRUM-193 Organization source checkpoint:** `5d5b4150` scopes operator and department reads/writes and assignments to the signed-in tenant and permitted branches; operator user responses omit password hashes. A fresh disposable two-tenant database passed 26 HTTP assertions and was dropped. The app build passed with inherited duplicate-key warnings; TypeScript had 473 inherited diagnostics and ESLint had inherited file findings, none on edited lines. Staging action proof awaits deployment: create/read/delete one unassigned synthetic operator with exact cleanup and foreign refusal. Do not create a department on shared staging without an exact delete path. The legacy users table has no tenant key, so user assignment fails closed without explicit tenant-bearing branch access; this needs the platform identity contract. SCRUM-193 remains In Progress.

**1 October SCRUM-193 Knowledge PDF action checkpoint:** a generated one-page synthetic PDF uploaded to Knowledge Files on live oto-app-staging (`201`), reached `indexed`, reported one page and one chunk containing its unique fact. Ask OTO returned `200`, the correct answer, `noMatch: false` and that file ID as a source. Two real 820px captures of the answer and expanded PDF citation were reviewed and attached to SCRUM-193 as `scrum-193-knowledge-pdf-answer-tablet-2026-10-01.png` and `scrum-193-knowledge-pdf-source-tablet-2026-10-01.png`. The exact-ID file DELETE returned `204` and a later read `404`; all probe PDFs were removed. This closes the file-index/search action gap, not lower-role or other AI-helper acceptance. SCRUM-193 remains In Progress for the other module and platform gates.

**1 October SCRUM-193 Activity, Packages and Supplier checkpoint:** on live `dfe71536`, a labelled synthetic employee created one branch-scoped Employee Added Activity Log entry; the reviewed 820px screenshot is attached and both employee/activity rows were removed by exact ID, with final searches empty. Packages and Set Menus signed-in pages each returned 200 and displayed zero templates; two reviewed empty-state screenshots are attached, explicitly not write/use proof. Their tenant-wide DELETE paths only soft-disable rows, so a synthetic template needs a sanctioned exact cleanup path before staging creation. Source 9c0bed04 now guards direct package line-item routes by parent tenant, passed 54 disposable two-tenant local assertions, and is live on oto-app-staging; signed-in missing-parent list/reorder returned 404 and a separate anonymous read returned 401. The positive template save/use walkthrough is still open. Supplier Portal anonymous paths returned 401 and a malformed link showed Access Denied in a third reviewed screenshot. Positive supplier comment/close is pending an exact-ID Fix report cleanup path; A benign read-only Render one-off job succeeded; no Supplier or package fixture has been created. Exact-ID cleanup scripts are in draft and unexecuted. SCRUM-193 remains In Progress; platform gates and the safe restricted test identity in the preceding checkpoint remain.

**1 October SCRUM-193 Org/Attention/break checkpoint:** `13a726f2` limits Org Chart nodes, advisors, edits and salary budgets to the signed-in tenant and permitted branches; 31/31 disposable two-tenant HTTP checks passed and the database was removed. `c2e9768c`, `4b303c48` and `072484c4` scope legacy Attention reads, pause unsafe automatic and manual writes, and show the paused state in the UI until platform tenancy and job ownership exist. `dfe71536` omits generated breaks that cannot fit inside a short shift. The combined build passed; TypeScript remains at 478 inherited diagnostics with none in these module files; Attention's changed page lints clean and existing route lint has unrelated inherited findings. All source is on main and `feat/oto-app-lift`, and exact `dfe71536` is live on oto-app-staging with `/api/status` 200. On live staging, Attention returned `paused=true`, displayed 43 saved alerts and disabled Refresh/Snooze/Resolve in a reviewed real 820px screenshot; Org budget company/branch reads returned 200 with finite totals while invalid scope/branch were refused. Two disposable shifts proved no break in a 10:00–12:00 shift and a valid 12:30–13:30 break in a 10:00–17:00 control before/after row regeneration, with two real My Shifts screenshots and exact fixture cleanup. All three images are attached and named on SCRUM-193; the Org node screen was not opened because GET may insert live rows. GitHub CI run 36799266325 says success but skipped workspace Typecheck, Lint, Test and Build, so it is not a verified full CI pass. Real synthetic BEO event/timeline and private Knowledge File staging actions passed with exact cleanup; their three reviewed screenshots are also attached. The parent remains In Progress. Needs from the platform lane include tenant columns/backfill for Attention and other legacy tables, a lock/durable `ops_run` contract with Health/Failures, POS views/read proof, Directory identity, tenant-safe settings, leave approval persistence, shift-group nullability or approved group contract, and CI structure-only restore rehearsal. A safe non-SMS staging identity is still needed for restricted document/checklist proof.

**1 October SCRUM-193 Org/Activity and module checkpoint:** source `d76c6d2d` (Org Chart budget salary), `071ee9cf` (tenant/branch-scoped Activity Log) and `05888b19` (tablet branch-name containment) landed on main and `feat/oto-app-lift`; exact `05888b19` is live on oto-app-staging. The production build passed; typecheck remains at 478 inherited diagnostics with no new edited-region error, and focused edited-line lint is clear. An isolated two-tenant HTTP probe passed 33 Org/Activity assertions and removed its database. Post-deploy staging Org budget returned 200 with numeric live/draft totals (8 people each), Activity list returned 13 total entries, 30-day summary returned zero, and bogus-branch list/summary returned 404; no chart nodes were read or changed. Three reviewed real 820px captures show the Activity screen and long branch selector without header overlap. They do not prove a generated activity action or real foreign-tenant denial. Separately, the live Nanny reservation lifecycle passed (overlap 409 and invalid reopen 409), Casual Workers create/assign/deactivate/picker removal passed, and a published SOP was revised and opened from Find at 820px. Their real screenshots are attached to SCRUM-193 in comment 11392 and all labelled test rows were deleted. Attention Engine is BROKEN for multi-tenant use pending app guards and platform schema/job contracts; the read-only audit is in `docs/qa/oto-app-lift/attention-engine.md` and Jira comment 11393. A Scheduling shift row without a group returns 500 because its database column is NOT NULL despite route/UI support for ungrouped rows (comment 11391). SCRUM-193 remains In Progress. Needs from the platform lane: `otoapp_v` POS views/read test; tenant-bearing Directory API; tenant-safe settings, policy/catalog/template, Activity Log and Attention item columns/backfills; persisted leave approval; nullable shift-group column or approved group contract; advisory-locked `ops_run`/Health/Failures; CI structure-only restore rehearsal.

**1 October Jira reconciliation for SCRUM-193:** the parent remains In Progress, and its five S2-17b acceptance criteria are still unchecked. Live Jira now shows SCRUM-261, SCRUM-262, SCRUM-453, SCRUM-454, SCRUM-456 to SCRUM-458, and SCRUM-460 to SCRUM-466 Deployed with named staging attachments. The older module paragraphs below record the state when each slice landed; their Testing labels are historical, not the current Jira status. The child proofs cover their specific defects, while the parent still needs the per-module staging action walkthrough, positive contract/letter/BEO PDFs, Health job success/failure evidence, CI restore rehearsal, POS view reads, tenant-safe settings and Directory identity. The current app-owned follow-up is addressing cross-tenant branch resource access and foreign-tenant camp registration removal. Needs from the platform lane: `otoapp_v` POS views and read test, job-run/advisory-lock contract with Health/Failures, CI structure-only restore rehearsal, tenant-scoped settings migration/cutover, and a tenant-bearing Directory API contract.

**1 October SCRUM-193 live tenant and PDF checkpoint:** `60f7256e` is live on oto-app-staging (`dep-dauonbk1nsns73f427kg`). A launcher-signed second-tenant administrator saw only its own branches, could create a branch only inside its signed-in tenant, and received 404 for foreign branch reads, edits, removal and logo removal. Its camp registration attendance edit returned 200 and persisted, direct removal returned 200, and repeated removal and default-tenant attempts returned 404. Four reviewed real staging screenshots are attached and named on SCRUM-193 in comment 11368; the synthetic rows, platform link and active accounts were removed. The Bangkok signed-date correction `5e46b1a1` is live inside `c534c3ea` (`dep-daup0341nsns73f5009g`): fresh contract and letter signatures, signed PDF object downloads and a BEO PDF all rendered with matching 01/10/2026 dates; anonymous/altered-token and altered-object-signature reads were refused, and all synthetic DB/object fixtures were removed. Five final real screenshots and the precise signed-URL proof are in `docs/qa/oto-app-lift/contracts-pdfs.md`; Jira attachment remains. A BEO branch-scope defect and recent event-activity tenant gap are being repaired locally. SCRUM-193 remains In Progress. Needs from the platform lane remain the POS views, job ownership/Health/Failures, CI restore rehearsal, tenant-safe settings and tenant-bearing Directory API.

**1 October SCRUM-193 Tasks/Checklists action checkpoint:** on live `c534c3ea`, a launcher-signed administrator created and completed a task, then created a one-item checklist, uploaded and retrieved exact synthetic image bytes, and completed item and run. Anonymous task/run detail returned 401; all disposable records and media were deleted. Two reviewed real 820x1180 screenshots and precise response evidence are in `docs/qa/oto-app-lift/tasks-checklists.md`. This proves the narrow positive flow, not the module's tenant scope: source still contains many default-tenant task paths. An app-owned task-scope repair and second-tenant staging check remain; the same parent also needs the platform job/Health gate. The local announcements tenant/audience patch passed 15 signed-in checks in a disposable two-tenant/two-branch fixture; it has not landed or been staged.

**1 October SCRUM-193 Policies/Assets action checkpoint:** on `dep-daup0341nsns73f5009g`, a launcher-signed administrator drafted, published and read back a labelled policy and assigned then returned a labelled asset; repeat return was refused. Anonymous reads were 401. Three reviewed real 820x1180 staging screenshots and cleanup evidence are in `docs/qa/oto-app-lift/policies-assets.md`; Jira attachment remains. Restricted-role and branch outcomes are not staged yet. Source inspection found `otoapp.policy_documents` and `otoapp.asset_catalog` have no `tenant_id`, so reliable tenant separation needs an additive platform migration and legacy-row cutover; employee-asset guards are being repaired in the app. The 820px HR header visibly overlaps its navigation labels; a small responsive ModeSwitcher fix is local but not deployed. SCRUM-193 remains In Progress. Needs from the platform lane now also include the policy and asset-catalog tenant columns/cutover.

**1 October SCRUM-193 Scheduling/Leave action checkpoint:** on `dep-daup0341nsns73f5009g`, a launcher-signed administrator saved and read a week, assigned a synthetic employee, read the matching My Shifts rota, submitted annual leave, and created a public holiday. Duplicate leave returned 409 and anonymous module reads returned 401. Four reviewed real 820x1180 staging screenshots and zero-residue cleanup are in `docs/qa/oto-app-lift/{scheduling,leave-holidays}.md`; Jira attachment remains. The 820px navigation blocked branch selection, an auto-generated break appeared after a two-hour shift, and a Bangkok-midnight leave date collided with the previous day's shift; app-owned fixes are local/in progress and require deployment and staging retest. Restricted-branch and approval behavior remain unverified. SCRUM-193 is In Progress; the platform needs listed above remain.

**1 October SCRUM-193 private files checkpoint:** on the same staging deployment, a signed-in administrator uploaded/read/deleted a synthetic employee ID image (exact 4,859-byte private read), then generated/downloaded one header-only bank CSV and a synthetic payslip PDF from an isolated future draft run. Both staged downloads matched their private object bytes; anonymous requests were 401 and generic private paths 404. Two reviewed real 820x1180 screenshots and cleanup checks are in `docs/qa/oto-app-lift/{employee-documents,payroll-files}.md`; Jira attachment remains. Restricted-role and self-service payroll reads remain unverified. A payroll card overflows at tablet width and the draft payslip UI wording is inaccurate; a local UI adjustment needs deployment and repeat proof. The app-owned tenant route repairs passed 72 disposable local checks but are not staged. Needs from the platform lane now also include additive tenant columns/cutover for legacy contract templates and persisted time-off approval columns; approval PATCH fails closed with 503 until schema support exists. SCRUM-193 remains In Progress.

**1 October SCRUM-193 source deployment checkpoint:** app commits `effb350d` (announcements), `7a4f521c` (Tasks), `03626e1f` (Events/BEO, Policies/Assets and time-off), and `858df417` (tablet controls) landed on main after pulling the parallel platform commit. Exact `858df417` is live on oto-app-staging as `dep-daupqp60tbcc73c7ehv0`; `/api/status` returned 200. Disposable local probes passed 15 announcement, Tasks two-tenant, and 72 route assertions with all fixtures removed. The production build passed and event-color checks passed; app typecheck remains red at 479 inherited diagnostics, with no new edited-region error; scoped lint has inherited errors outside changed lines. GitHub CI for this commit is pending, not green. Three independent signed-in staging rechecks are running for Tasks/Announcements, Events/HR and 820px layout; their results and screenshots are not yet claimed. Legacy policy/catalog/template tenant migration and persisted leave approval remain platform dependencies, so SCRUM-193 stays In Progress.

**1 October staging action batch:** app source `60f7256e` is live on oto-app-staging (`dep-dauonbk1nsns73f427kg`), health 200. A launcher-signed administrator created/read a published SOP, a published KB FAQ, and an active one-question training module; an unknown-branch SOP/KB request returned 404. Ask OTO returned the synthetic answer with KB and SOP citations; quiz wrong/right attempts yielded fail/pass and a 100% completion. Seven reviewed real browser screenshots include the resulting screens and an 820x1180 tablet Learn view without blocking overflow. The SOP, FAQ and training fixtures were deleted. These are parent-story action proofs; the linked defect tickets remain Deployed. The separate signed contract/letter/BEO probe and second-tenant branch/camp repeat are still running, and the parent stays In Progress. A PDF signing date mismatch between the Bangkok UI and UTC-rendered signed PDFs was found and is being fixed under SCRUM-193. Needs from the platform lane remain the POS views/test, job-run/Health/Failures contract, CI restore, tenant settings migration/cutover and tenant-bearing Directory API.

SCRUM-193 (S2-17b) is In Progress on `feat/oto-app-lift`, alongside the platform lane. SCRUM-261 and SCRUM-262 are Deployed with named staging cards attached. The contract/letter/BEO PDF (`d7e0156c`), employee-document/Excel-preview (`b3af4e52`), payroll-file (`649735bf`), malformed payslip-ID guard (`54a5d714`) and scheduling/My Shifts (`f0f1bf2f`) slices are live on oto-app-staging. Staging health and anonymous access guards passed; positive authenticated module walkthroughs remain open. Locally, payroll's four CSVs and one PDF round-tripped through MinIO, admin API downloads and all four Exports-screen downloads passed, and staff attempts were refused. Organization/access browser checks passed 9/9; the sign-on contract check passed; HR/attendance checks reached 18/18 after updating three pre-lift test assumptions. Scheduling fixed a Sunday-plan read gap and passed 16/16 existing checks. Tasks, checklists and Fix Board passed 22 existing checks after repairing stale test setup. Events, BEO and camps passed six browser checks plus event-color logic and an isolated archived-reconciliation check. The build passed; app typecheck stays at 578 inherited errors with no edited-line diagnostics, and edited-line lint is clear. The scheduled-job audit is blocked on a platform job-run write contract, advisory-lock ownership and Health/Failures visibility; that need is commented on SCRUM-193. Evidence is in `docs/qa/oto-app-lift/`. Only `apps/oto-app/**`, `docs/qa/**`, and this lane's progress blocks are editable here. Needs from the platform lane: S2-17b POS views, job-run integration and CI restore rehearsal.

SCRUM-453 is Testing under SCRUM-193: staff could read Xero status and finance sync history despite the admin-only analytics screen. The finance guard at `aeccaa7f` is live on staging; health returned 200 and anonymous finance routes returned 401. Locally, anonymous requests returned 401, staff 403 and admin 200; advisor access is blocked by raw role. The build passed, with no new type or edited-line lint diagnostics. A signed-in administrator Analytics screenshot is attached; staging staff refusal and a positive Xero exchange remain, so the defect is not Deployed. The optional Xero, AI, Twilio and SMTP variable names were not listed at the staging service level (inherited groups were not checked), so positive external integrations remain unverified. The app-owned `.env.example` documents variable names only. A local 24-route entry-screen scan found no render error. The platform lane confirmed the staff-voucher screen's “moved to Console” notice is its S2-17b end state; the central ledger is the only active voucher system. Evidence is in `docs/qa/oto-app-lift/`.

Public check-in and the staff board passed an isolated local synthetic flow: invalid QR token 403, missing consent 400, valid registration 201, staff list/status/checkout/revert all 200. The multi-child drop-off form created two child rows with age-based service suggestions; photo and signature bytes round-tripped through storage. All synthetic rows and files were removed. The form now checks the server's 10 MB limit after compression. Staging health and anonymous staff-list/invalid-token guards returned 200/401/403. The signed-in staging walkthrough remains open; see `docs/qa/oto-app-lift/checkins.md`.

The default published drop-off form had mismatched field IDs and lacked working photo/signature controls. The client/server repair maps published fields, preserves allergy and food answers, enforces confirmations, and renders verification controls. A temporary local published-form fixture passed refusal cases and a full browser submission; rows, media and fixture state were restored. The repair at `53c39e95` is live on oto-app-staging (`dep-dau4v7qd0e5s73e95urg`); post-deploy health/anonymous-list/invalid-token guards returned 200/401/403. A positive staging submission remains pending; see `docs/qa/oto-app-lift/checkins.md`.

SCRUM-454 is Testing under SCRUM-193. App-owned check-in record/list, QR-token/image and available-nanny routes enforce branch scope. The two-branch local probe passed staff, manager and kiosk refusals (403), own-branch actions (200), and verified the other branch's row stayed unchanged. Commit `7a167807` is live on oto-app-staging (`dep-dau58kid0e5s73ea8p10`); health and anonymous staff/nanny guards returned 200/401/401. A signed-in Check-ins screenshot is attached; completed check-in and staging cross-branch refusal remain before Deployed; see `docs/qa/oto-app-lift/branch-checkin-access.md`.

The nanny booking slice under SCRUM-193 now checks active nanny role, branch duty and unavailability before assignment; reservations check linked branch, same-day time windows and overlaps, including concurrent requests; status activation requires duty and closed bookings cannot reopen. Temporary isolated kiosk probes passed the refusal, assignment, overlapping reservation, conflict-preserving edit and status-transition cases; all fixtures were removed. The production build passed, app typecheck remains at 577 inherited errors with none in the changed route, and changed-line lint is clear. Commit `aa726625` is live on oto-app-staging (`dep-dau5l11srm7s73asptag`); health/anonymous availability/reservation-write guards returned 200/401/401. Signed-in acceptance remains. See `docs/qa/oto-app-lift/nanny-booking.md`.

SCRUM-456 is Testing under SCRUM-193. The parent invitation renderer now escapes editable text, embeds bounded platform-stored photo bytes, disables Chromium scripts and reads artwork from the built app. A local generated invitation showed its photo and artwork; hostile markup rendered as text, an external photo URL made zero sentinel requests, and concurrent RSVP posts left one record. All synthetic rows and media were removed. Production build passed, typecheck remains 577 inherited errors with no new edited-line diagnostic, and changed-line lint is clear. Commit `428f6bdc` is live on oto-app-staging (`dep-dau5saflot8c739ps8s0`); health, packaged artwork and invalid-token invitation routes returned 200/200/404. A named positive signed-in staging screenshot remains before Deployed. Existing parent/guest links have no expiry until revoked; an expiry policy is an owner decision and would need a platform-lane additive migration. See `docs/qa/oto-app-lift/parent-invitation.md`.

SCRUM-457 is Testing under SCRUM-193. The Fix supplier portal now opens a valid report detail, creates comments and closes once; its media read is token-, report-, tenant- and branch-scoped. Admin token creation validates selected tenant branches and future expiry, while revoke disables the token. A local full-seed probe passed valid reads/actions and refused malformed, expired, disabled, other-branch and other-tenant access; synthetic rows, sessions and media were removed with zero residual fixture counts. The login diagnostic that logged session IDs was removed. Production build passed; typecheck stays at 573 inherited errors with none in the changed supplier/auth region, and changed-line lint is clear. Commit `95d2c0be` is live on oto-app-staging (`dep-dau69degekts73d4pmqg`); health/anonymous token-management/invalid-token routes returned 200/401/401. A signed-in Supplier Access Tokens screenshot is attached; a live token and supplier action remain before Deployed. See `docs/qa/oto-app-lift/supplier-portal.md`.

SCRUM-458 is Testing under SCRUM-193. Training & Quizzes now has tenant/branch-scoped list and detail reads, answer-safe learner questions, quiz scoring, attempts and one completion on passing, plus a Studio authoring screen. Broken learner links, score display and Studio's missing-field crash were repaired. A temporary isolated local probe passed staff/admin scope, fail/pass/retry, zero-question completion, update/delete and cross-tenant refusals; browser checks completed a quiz and created/edited a module in Studio without page errors. Fixture access was restored and synthetic rows/sessions were removed. Build passed; typecheck remains 566 inherited errors with none in the touched training routes/pages, and changed-line lint is clear. Commit `40841060` is live on oto-app-staging (`dep-dau6kntg1s2s73blm5ng`); health and anonymous training guards returned 200/401. Signed-in Learn and Quizzes screenshots are attached; staging attempt, completion and authoring save remain before Deployed. Existing completions remain when quiz questions are edited; a retake policy is not specified. See `docs/qa/oto-app-lift/training-quiz.md`.

SCRUM-460 is Testing under SCRUM-193. SOP list/detail and admin writes now enforce tenant and branch scope, staff see only published articles, and generated SOPs inherit their source file's branch. Find and article links use the registered paths; nullable content and unavailable reads render safely. The production build passed, typecheck remains at 554 inherited errors without SOP-area diagnostics, and scoped SOP lint is clear. A local signed-in server probe was blocked by the command environment; staging health/anonymous SOP guards returned 200/401/401/401. Commit `9531cf41` is live on oto-app-staging (`dep-dau6vmqd0e5s73egt5ug`); a signed-in Find screenshot is attached; publication and branch visibility remain open. Source is at `c93d0e07`; see `docs/qa/oto-app-lift/sops.md`. Next app-owned module: KB and Ask OTO knowledge-file/chunk scoping.

SCRUM-461 is Testing under SCRUM-193. Knowledge Base articles now respect tenant, `SELECTED` branch scope, publication state and staff job-role audience; writes, publish, archive and version reads enforce the same scope. Knowledge files and Ask OTO answer sources/chunks/media are branch-scoped; staff Browse uses the published-article route and safe HTML. Thread messages use existing database columns. The build passed, app typecheck remains at 543 inherited errors with no changed-area diagnostic, and scoped lint is clear. No signed-in local route probe ran because the command environment rejected test-server startup. Commit `8de9d552` is live on oto-app-staging (`dep-dau7bk893c1s73d1fb30`); health and anonymous KB/file/Ask guards returned 200/401. Signed-in KB and Ask OTO screenshots are attached; source-answer and branch-isolation proof remain. Source `d4aa5901`; see `docs/qa/oto-app-lift/knowledge-ask-oto.md`. Needs from the platform lane: a forward-only nullable `otoapp.ask_oto_threads.title` column if conversation titles are required, in addition to the POS views, job-run contract and CI restore rehearsal.

SCRUM-462 is Testing under SCRUM-193. Casual-worker APIs now require manager access and bind reads, scheduling lookup and writes to the signed-in tenant and permitted branches; create/edit validate references, dates and whole-baht daily rate. The page's end-date status is inclusive and its branch label uses the current context field. Production build passed, app typecheck remains at 542 inherited errors with no changed-file diagnostic, and scoped lint is clear. No existing casual-worker test file exists; the local signed-in route probe was blocked by the command environment. Commit `702e184f` is live on oto-app-staging (`dep-dau7hqm0tbcc739u2l10`); health 200 and anonymous casual list/scheduling/detail 401. A signed-in Casual Workers screenshot is attached; worker rate, writes, branch and role cases remain. See `docs/qa/oto-app-lift/casual-workers.md`.

SCRUM-463 is Testing under SCRUM-193. The app-owned vault slice at `a8f5aa8a` binds vault reads and writes to the signed-in tenant, validates branch references, seals new and changed credentials, removes the generic data-admin bypass and makes reveal an audited server action; ordinary detail/write responses exclude the credential. Legacy unsealed rows reseal on first audited reveal. Production build passed, typecheck stays at 542 inherited errors with no vault-area diagnostic, scoped lint is clear, and a disposable crypto probe passed. No existing vault test file exists. Commit `b39d0ed5` is live on oto-app-staging (`dep-dau7p67avr4c7381v260`); health 200, anonymous vault list/detail/reveal and data admin 401. A signed-in Vault screenshot is attached; sealed write, audited reveal and role/branch cases remain. See `docs/qa/oto-app-lift/vault.md`.

SCRUM-464 is Testing under SCRUM-193. Existing in-app task notifications now scope list, unread count and read actions to both recipient and the active tenant; an absent tenant fails closed, an out-of-scope mark-read returns 404 and pagination is bounded. This does not add S2-17c delivery statuses. Source `6f564c64` passed production build, app typecheck remains at 542 inherited errors with no notification-area diagnostic, and scoped lint is clear; no existing notification test file exists. Commit `32d69b3a` is live on oto-app-staging (`dep-dau7t1uk1f9s73anm07g`); health 200 and anonymous list/count/mark-one/mark-all 401. A signed-in notification-panel screenshot is attached; notification read and two-tenant proof remain. See `docs/qa/oto-app-lift/notifications.md`.

The data-admin route gate now matches its global/legacy-admin-only API at source `732bf0fd`; production build passed, app typecheck remains at 542 inherited errors with none in `App.tsx`, and scoped lint is clear. Commit `43a6b1e5` is live on oto-app-staging (`dep-dau7va7lot8c73a1qdk0`); health 200 and anonymous model-index/list 401. The remaining raw model registry still requires production-data review. See `docs/qa/oto-app-lift/data-admin.md`. Needs from the platform lane: additive tenant scope for `otoapp.settings` plus legacy key cutover, and an agreed tenant-bearing Directory API service contract, alongside the existing POS views, job-run contract, CI restore rehearsal and optional Ask OTO title column.

SCRUM-465 is In Progress under SCRUM-193. The first files slice at `36b2b33a` rejects invalid path segments and prevents public caching of authenticated files for both object-store and legacy local responses. Production build passed; app typecheck remains at 542 inherited errors with none in the changed route, scoped lint is clear, and no existing file-route test exists. Commit `0604c536` is live on oto-app-staging (`dep-dau8192d0e5s73el0nd0`); health 200, anonymous private media 401, public missing and invalid paths 404, public cache header present. The 30 September audit identified a specific signed-in Fix media bypass of owning-report tenant, branch and role checks, plus public thumbnail caching; an unverified local patch was reverted before commit or deploy because the available local database lacked the OTO App tables for affected browser checks. Generic authenticated media and public drop-off photo/signature URLs still need record-specific access design and positive proof before files can be called verified. See `docs/qa/oto-app-lift/files.md`.

SCRUM-466 is Deployed under SCRUM-193. Data-admin source `f5c1061f` removes session, Xero OAuth token and password-reset-token models from generic registry access, and strips user password hashes from list/detail/write responses. Auth and Xero module routes remain unchanged. Production build passed; app typecheck remains at 542 inherited errors with no data-admin-router diagnostic, and scoped lint is clear. Commit `75331db7` is live on oto-app-staging (`dep-dau844favr4c73839geg`). Signed-in staging API checks returned 200 for model index, Users list and user detail, 404 for each removed model, and no password field in either Users response. Three reviewed staging screenshots are attached and named on SCRUM-466; operator-admin and wider registry review remain under parent SCRUM-193. See `docs/qa/oto-app-lift/data-admin.md`.

On 30 September, the documented administrator signed in through the suite launcher and reached the OTO App without a second password. Fifteen real staging screenshots now show signed-in Today, Analytics, Check-ins, Supplier Access Tokens, Learn/Quizzes, Find, Knowledge Base/Ask OTO, Casual Workers, Vault, Notifications, and Data Admin index/Users list/detail. Reviewed images are attached to their child tickets and SCRUM-193, with filenames in Jira comments; the earlier labelled test-run cards remain separate. SCRUM-466 is Deployed after direct staging API proof. Other children remain Testing because their staging pages have empty data or lack role/branch/action checks; SCRUM-193 remains In Progress. See `docs/qa/oto-app-lift/staging-screenshots-2026-09-30.md`.

Closure execution resumed: docs/qa/oto-app-lift/closure-plan.md records the remaining module actions, access checks, platform seams and final UI pass. An isolated local oto_app_lift_acceptance_0930 database was migrated and sample-populated; a synthetic admin and the existing Fix checklist-scope test passed 1/1. The full seed cannot start because fixtures/users.json is absent, so use surgical fixtures. Source review still finds POS views, the OTO App job-run contract, CI restore rehearsal, tenant-safe settings and tenant-bearing Directory API missing. Next app-owned slice is SCRUM-465 Fix report/media access.

SCRUM-465 Fix access is live on oto-app-staging at `c7668cc3` (`dep-dauggcad0e5s73flih50`). Report reads/writes and current/legacy media enforce owning-report tenant, branch and reader access; thumbnails are private, direct thumbnail and legacy private-upload paths are closed, and new uploads carry a short-lived user/tenant claim before a report may attach them. Five affected existing Fix browser checks passed against an isolated app database; a disposable cross-tenant/branch probe passed forged-media refusal and cache checks. Build passed, typecheck remains at 542 inherited errors with none in changed code/tests, and edited-line lint has no error. A signed-in staging report submission appeared in the Fix Board and its synthetic 400-pixel photo decoded. Anonymous staging guards returned 401/404 as expected. The screenshot capture service timed out, so this is observed staging proof without a named attachment; the ticket is not Deployed. The owner chose indefinite availability for already-shared raw check-in photo links. New photos need separate private storage and expiring share links; a duration decision is pending. Broader generic-folder access and final signed-in scope evidence remain. See `docs/qa/oto-app-lift/files.md`.

The next SCRUM-465 profile-photo slice is live on oto-app-staging at `9c724c1c` (`dep-dauhfp1srm7s73c9htu0`). Current and legacy filename URLs now require the owning account or a permitted employee record in the signed-in tenant and branch; public legacy upload URLs close. Employee-ID reads and manual uploads check tenant and branch, and My Account refuses a mismatched linked employee. A disposable local probe passed authorized reads, anonymous/branch/tenant refusals, three denied upload or sync cases, and private cache headers, then removed its rows and media. Production build passed; typecheck stays at 542 inherited errors, with no edited-line diagnostic, and edited-line lint is clear against its existing baseline. Staging health and anonymous read guards returned 200/401; the public upload path returned 404. The signed-in My Account and Employees pages opened, but no profile image was available for a positive staging read. Screenshot capture timed out. The existing employee browser spec timed out at its stale `Bangkok` branch fixture before reaching these routes. See `docs/qa/oto-app-lift/files.md`. SCRUM-465 and parent SCRUM-193 remain In Progress pending positive staging proof and the remaining file/module acceptance.

SCRUM-465's next check-in-media slice is live on oto-app-staging at 2e4d8491 (dep-daui12893c1s73eat6dg). New drop-off photos and signatures use separate private folders; the staff board issues a seven-day signed photo link for parent messages while old raw photo links remain public indefinitely. A synthetic full submission and direct probe passed valid, expired/tampered, anonymous, other-branch, private-path and legacy-link cases; all fixtures and media were removed. The existing kiosk camp-checkin test passed 1/1. A synthetic staging public check-in succeeded and its signed 400-pixel photo loaded on the staff board; anonymous private-file guards returned 401/404. Screenshot capture timed out, so the labelled row is retained for follow-up. Production build passed; typecheck remains at 542 inherited errors without a check-in-route diagnostic, and edited-line lint is clear. Seven days is the provisional new-link duration pending the owner's answer. SCRUM-465 and SCRUM-193 remain In Progress pending named staging screenshots, legacy-object proof and the other file/module acceptance; see `docs/qa/oto-app-lift/files.md`.

SCRUM-465's knowledge-file guard is live at `5485154a` (`dep-dauifs7lot8c73b990h0`): generic `knowledge-files` and `test-uploads` reads returned 404, anonymous scoped media returned 401, and health returned 200. Build passed, typecheck remains at 542 inherited errors and edited-line lint is clear. The remaining generic folders include kiosk PIN evidence, checklist/checker media, checkout photos, task photos and camp photos; each needs owner/tenant access without breaking its workflow. See `docs/qa/oto-app-lift/files.md`.

SCRUM-465 kiosk PIN evidence is live at `0dc62f3f` (`dep-daujd2dg1s2s73d5oal0`). Generic reads close; current and legacy image reads require a manager and an owning event/session/attempt in the signed-in tenant and branch. Upload receipts bind the photo to a kiosk device; clock requests reject forged or wrong-device receipts. Timekeeping review and employee event reads also enforce tenant and branch. The existing kiosk authorization and expanded advisor-attendance specs passed 12/12 and 10/10 on a fresh isolated database; build passed; typecheck stays at 542 inherited errors and scoped lint has no new finding. The separate timekeeping-review spec cannot import missing `fixtures/users.json`; the advisor spec covers the relevant manager and branch outcomes. Staging health and anonymous PIN-photo/timekeeping guards returned 200/401; signed-in Timekeeping Review loaded with no records on the selected date. Screenshot capture timed out, so positive staging image proof and checklist/checker, checkout, task and camp media remain. See `docs/qa/oto-app-lift/files.md`.

SCRUM-465 checkout/checklist/task media is live at `ce5b3cd6` (`dep-daukc48jo6nc73dhbj30`). The owner chose permanent signed share links for new check-in photos and indefinite compatibility for already-shared raw links. Checkout images now require an owning check-in in the tenant/branch; checklist uploads and saved URLs bind to an item; task uploads, attachment and reads bind to an owning task. Generic filename access closes for these folders. The existing kiosk/check-in spec passed 2/2 and checklist scope spec passed 1/1; a disposable task probe passed authorized upload/attach/read and wrong-task/branch/anonymous refusals, then removed all fixtures. Production build passed with two inherited warnings; typecheck remains at 542 inherited diagnostics and edited-line lint has no new error. Older task specs remain unstartable without `fixtures/users.json`. Staging health returned 200, anonymous current/legacy media routes returned 401, and the labelled synthetic Check-ins row's permanent signed image decoded at 400 pixels. Screenshot capture timed out; positive staging checkout/checklist/task media, named attachments and camp-photo ownership remain. See `docs/qa/oto-app-lift/files.md`.

SCRUM-465 camp-photo ownership is live at `b96a9652` (`dep-daul1mp42hec73est5g0`). New public and staff uploads bind to a camp event, use private storage, validate JPEG/PNG/WebP bytes and require a short-lived claim before attachment; public upload attempts are throttled. Legacy and new image reads require the owning registration in the tenant/branch, while public lookup and kiosk roster use short-lived signed record previews. The full existing camp/check-in spec passed 3/3; build passed, app typecheck remains at 542 inherited diagnostics and edited-line lint is clear. A disposable staging probe passed upload, registration, public lookup, authorized kiosk current/legacy reads and roster preview, plus anonymous, other-branch, cross-event and tampered-link refusals; it removed all synthetic rows and media. The named HTTP evidence card `scrum-465-staging-camp-media-proof.png` is attached to Jira, but browser screenshot capture still times out, so it is not a UI screenshot. Positive staging reads for the other file routes and named UI evidence remain; SCRUM-465 and SCRUM-193 stay open. The one labelled synthetic check-in photo link exposed during inspection was revoked by clearing only that synthetic photo reference; other links were untouched. See `docs/qa/oto-app-lift/files.md`.

SCRUM-465's camp child-profile follow-up is live at `edd28317` (`dep-daulhk49v7es73a1o570`). Manager child search, duplicate review, history, merge and photo/profile propagation now stay in the signed-in tenant and permitted branches. The existing camp/check-in spec passed 4/4, production build passed, typecheck stayed at 542 inherited diagnostics and scoped lint found no new error. Staging app 200 and anonymous child-list/private-photo guards 401/401 passed. The duplicate queued auto-deploy was canceled; the manual deploy is live. SCRUM-465 is Testing, not Deployed: live authenticated branch proof and a real named UI screenshot remain. The in-app browser screenshot backend times out even on a neutral page; Opera Browser Connector is installed but is not connected to this chat. SCRUM-193 remains In Progress with the recorded platform dependencies. See `docs/qa/oto-app-lift/files.md`.

SCRUM-465 staging screenshot capture now works through the app's existing headless Chromium browser tooling. The attached real staging image `scrum-465-staging-synthetic-child-list.png` shows one labelled synthetic camp child in Central Floresta after launcher sign-in; authenticated child search and history each returned one result, and cleanup removed the registration and event with a zero-result final search. The earlier `studio-children.png` shows the empty entry state. The ticket is still open: restricted-manager branch refusal and positive private-media reads remain. See `docs/qa/oto-app-lift/files.md`.

SCRUM-465 task-attachment follow-up is locally verified, pending staging deployment. Attachment list/upload/delete and file reads now require the owning task in the signed-in tenant and permitted branch; deletion must match the task ID, active content downloads safely, new storage filenames are unique, and the generic file route denies unknown private folders. A disposable two-branch/two-tenant local probe passed 13 access/download checks and cleaned up; the existing camp/check-in spec passed 4/4. Build passed; app typecheck stayed at 542 inherited errors with none on edited routes; scoped lint had no edited-region error. Restricted-manager staging branch/cross-tenant proof and positive private-media reads still gate Deployed. See `docs/qa/oto-app-lift/files.md`.

SCRUM-465 source `24dd9091` is live on oto-app-staging (`dep-daun6v49v7es73a7bdkg`). Health 200, unknown private folder 404 and anonymous task attachment 401 passed. A disposable Central Floresta manager saw only that branch's synthetic child, with other-branch history 404; the real reviewed screenshot `scrum-465-staging-restricted-children.png` is attached and named on Jira. Camps/registrations were removed, app user deleted, platform link removed and account deactivated. SCRUM-465 stays Testing for positive private-media reads and signed-in foreign-tenant proof. That rehearsal uncovered an Events create path that wrote foreign-manager events under the default tenant; all staging fixtures were removed. The OTO App event cluster is now locally repaired under SCRUM-193: a two-tenant probe passed ten checks, existing camp/check-in spec 4/4 and event-color check passed, build passed, typecheck stayed at 542 inherited errors and edited-region lint is clear. Stage this source next, repeat the foreign-tenant probe and attach the real screenshot. See `docs/qa/oto-app-lift/events-camps.md`.

SCRUM-465 staging update, 1 October: source `57e01a9b` is live on oto-app-staging (`dep-daunkt0u01pc738e12lg`). A second-tenant manager signed in through the launcher and saw only its own labelled synthetic child (one versus zero for the default-tenant admin); own history returned 200, cross-tenant history 404. The reviewed real screenshot `scrum-465-staging-foreign-tenant-children.png` is attached and named on SCRUM-465. All synthetic event, user, link, account, branch and tenant fixtures were removed. Direct deletion of the second-tenant registration returned 404 because the older camp route still uses the default tenant; deleting its event removed that registration. A media audit found additional signed-in cross-tenant gaps in HR document/PDF and checklist-media reads; the app-owned repair and final-owner task-object cleanup built successfully, typecheck stayed at 542 inherited errors, and edited-area lint is clear. The existing contracts browser test cannot load the absent `fixtures/users.json`; no pass is claimed. SCRUM-465 stays Testing until the repair is verified live with positive private-file reads. SCRUM-193 remains In Progress. Needs from the platform lane remain POS views, job-run/Health/Failures contract, CI restore rehearsal, tenant-scoped settings and tenant-bearing Directory API.

SCRUM-465 next staging checkpoint: `c8afae1d` is live (`dep-dauo1359fdbs739micbg`). A disposable task attachment returned 200 with matching PNG bytes and `private, no-store`; anonymous access was 401 and the URL became 404 after deletion. The reviewed real screenshot `scrum-465-staging-task-attachment.png` is attached; task and attachment were removed. A synthetic HR document returned 200 to its owner and 404 to an all-branch second-tenant manager; document, employee and second-tenant fixtures were removed. The audit then found pending checklist-media lookup/association and reorder still lacked tenant and record scope. Their app-owned repair built, typecheck stayed at 542 inherited diagnostics and scoped lint has no error; it is awaiting land, staging deploy and signed-URL/refusal proof. SCRUM-465 remains Testing, SCRUM-193 In Progress. The all-branch foreign manager received five branch rows across tenants; that separate org-route gap is tracked on SCRUM-193. Needs from the platform lane remain POS views, job-run/Health/Failures contract, CI restore rehearsal, tenant-scoped settings and tenant-bearing Directory API.

SCRUM-465 is Deployed after final acceptance on 1 October: source `104b319d` is live on oto-app-staging (`dep-dauo7s41nsns73f2bt9g`), health 200. A disposable checklist image was read byte-for-byte through its signed URL (200); the all-branch second-tenant manager was refused its media URL, reorder and delete (404 each). Foreign pending lookup found zero records and association changed zero. The reviewed real screenshot `scrum-465-staging-checklist-media.png` is attached. All synthetic checklist, media, HR, event and second-tenant fixtures were removed. The earlier permanent public check-in photo link was tested live and its `scrum-465-staging-camp-media-proof.png` card is attached; branch-limited, foreign-tenant and Tasks real UI screenshots are also attached and named in Jira closure comment 11362. This meets SCRUM-465's cross-tenant and public-link staging gate. SCRUM-193 remains In Progress for the wider walkthrough, the cross-tenant branch list and foreign camp-registration DELETE. Needs from the platform lane remain POS views, job-run/Health/Failures contract, CI restore rehearsal, tenant-scoped settings and tenant-bearing Directory API.

SCRUM-193 tablet-layout staging checkpoint, 1 October: on live `858df417` (`dep-daupqp60tbcc73c7ehv0`), the branch selector opened and selected normally at 820px on Scheduling, Policies and the blank employee editor. A fresh 10:00-12:00 shift showed “Break schedule needs review” in My Shifts instead of a break outside the shift; this verifies the display warning, not the underlying break-generation rule. The payroll Bank and Journal download controls wrapped inside their cards without horizontal overflow. Five visually reviewed real staging screenshots and exact synthetic-fixture cleanup are in `docs/qa/oto-app-lift/{scheduling,payroll-files}.md`; attach/name them on SCRUM-193 with the evidence push. The ordinary Scheduling create path still sent `approved:true` to an API that cannot persist approval; an app-only follow-up is verified locally but not live. The parent remains In Progress for the complete module walkthrough and platform dependencies.

SCRUM-193 signed-in route staging checkpoint, 1 October: on live `858df417`, a separate tenant manager created, read and completed a task while the park tenant could not read it, and own-tenant other-branch task creation was refused. A targeted announcement published/read in one branch was absent from the park tenant and refused for the manager's other branch. A restricted default-tenant manager read its own event, parent token and BEO PDF but was refused another branch's event, parent token, BEO PDF and recent activity filter. Bangkok-midnight time-off create/edit and shift conflicts returned the intended calendar dates/statuses. Default-tenant policy and asset write/read/return passed again; non-default policy/latest, asset catalogue and contract finalisation returned 503, safely unavailable until platform schema cutover. Nine new real screenshots and exact synthetic-fixture cleanup are in `docs/qa/oto-app-lift/`; attach/name them on SCRUM-193 with the evidence push. The pre-fix explicit `approved:true` time-off POST incorrectly created a row; it was deleted. Source `b20ed05b` is now live: explicit approval POST/PATCH return 503 without writing, and the ordinary Scheduling-shaped request creates one leave row (201) that was removed after proof. The actual UI click-through and persisted approval workflow remain. GitHub run 36793711295 completed successfully but skipped workspace Typecheck/Lint/Test/Build; local app build passed, typecheck retains 479 inherited errors and changed-region lint is clear. Restricted document/checklist-role proof remains; staging platform-account creation uses a delivering SMS provider, so further disposable sign-ins need a safe account path. Prior synthetic account creation may have initiated setup messages; delivery per account was not observed. SCRUM-193 remains In Progress with the documented platform dependencies.

SCRUM-193 parent RSVP staging checkpoint, 1 October: live `b20ed05b` served one labelled public invite. An anonymous parent submitted an attending response through the 820px form, the signed-in event ledger contained exactly one matching row, and the summary reported one attending guest, one child and one adult. A random invalid invite returned 404 on read and write. Three real reviewed form/confirmation/invalid-link screenshots are in `docs/qa/oto-app-lift/parent-rsvp.md`; attach/name them on SCRUM-193 with this evidence push. Route review and the probe found no outbound message action; the event/invite/RSVP rows were removed via event deletion, and former links returned 404. Delivery, edit and language variants remain for full module acceptance.

## Release checkpoint - 30 September 2026 - break checkpoint saved

The current release checkpoint is complete. Stop here and await the next
instruction; do not select another Jira ticket. No current subtasks remain.

Live staging: POS 0683ffd10a859465aaa14c0b09f241edf555e581; API, Console,
Launcher and Booth b31b01b71a3846047a9a7beb3fb273cb4bd02b7d. OTO App remains
c416065. Main includes the source plus subsequent evidence/documentation.
Manual Render deployment was authorised because Actions cannot start. Normal
checksPass/auto-deploy settings are unchanged. Migration 0033 completed in the
API pre-deploy step, followed by working station access and removed routes 404.
There was no direct staging database inspection. Never roll the API back before
85d35e0 after this migration. Exact deployment IDs are in the QA release record.

SCRUM-201 is Deployed with named, reviewed staging screenshots. Foundation
checks passed, followed by 21 food/shop checks and 7 consent checks. The final
POS-only header spacing fix was verified at 1024x768 and 1280x800 without sale
or payment writes. Consent preserves private data and staff authority, retries
the same action after a lost reply, and survives lock/unlock. Current staging
policy requires a real joint photo before Done; that positive completion is
proven locally, not fabricated on staging. Physical display hardware remains
outside this software acceptance. Owned fixtures were archived/revoked; completed
synthetic sales remain for audit. Evidence: docs/qa/separate-display.

SCRUM-206 current payment follow-ups are deployed and verified. A retained
no-response simulation recovered with one original SALE and full reservation;
the known simulator outcome was resolved through an audited staff API action.
A fresh native GHL case passed 11 checks, recorded staff confirmation and
collected the unchanged balance once as cash. Earlier partial-reversal,
disabled-QR and zero-sale follow-ups also pass. Evidence: docs/qa/payment-stage.
The full story stays In Progress: separate To Do SCRUM-269 is required for
offline trading. It has not been started, and neither story has subtasks.
The historical uncertain partial run 0d008153 and its eight setup rows remain
untouched; never replay SALE, invent an acknowledgement or confirm no money.

SCRUM-285 remains Deployed with its 11-check staging card, attachment 10905.
The cloud offline-test guard is verified; full offline till trading is not built.
No other story or old To Do item was selected for this checkpoint.

Existing checks passed: six native browser flows; POS 92, shared 19, box 40,
terminal 33 and DB 43; affected package typechecks/lint, POS production build,
standalone smoke typing and schema verification. The final two-class layout
change passed POS typecheck/lint/build and native staging geometry. No new
test suite or dependency. Build chunk/import notices remain nonblocking.

GitHub runs 36619796693 (base source) and 36621089212 (final POS) ran zero steps
because account billing/spending availability prevented startup. CI is not green.
No new CI-packed Pi archive exists. Desktop keeps oto-box-0.1.0-0468c38.tgz
and its checksum; no physical Pi update was performed in this checkpoint.

Resume rules: read this block, STATUS, CODEX_HANDOVER and AGENTS before acting.
Keep explicit commit file lists, no attribution or secrets, Jira status/comment
with every push and named staging screenshot before Deployed. Use a dedicated
absolute output directory for every temporary browser runner. Excluded dirt
in render.yaml, services/ and MerchCustomerDisplay.tsx is preserved. Remaining
questions, protected evidence and rejected temporary cleanup are recorded in
OPEN_QUESTIONS.md. Wait for the next instruction.

## Previous checkpoint

_Last updated: 2026-09-29 - saved-child display review checked locally._

Main 88140af is pushed and includes SCRUM-201 online saved-child review.
F&B guest display integration is in progress on feat/display-fnb-guest.
This checkpoint adds the finite child_review prompt and display.child_review
actions while preserving StationSessionDocument, StationIntent, actionId,
lastSeenSequence and leaseId. Full SCRUM-201 remains In Progress and NOT BUILT
as a whole; staging acceptance and the remaining display integrations remain.

At ticket step 8, an existing member can select a saved child, edit public
name/DOB/age and Confirm. The authorised till performs the real child PATCH;
only its successful response confirms the slot. Done requires every slot to
be confirmed and returns to staff supervision at step 7. New-child entry and
removal use explicit staff fallback. Private health/food/photo/waiver fields
remain on the till; recorded diagnostics still contain prompt metadata only.
This does not establish registration, check-in or persisted supervision consent.

Visitor, epoch, member, station and saved-child assignment fence late results.
The visit referenceDate drives the age picker and confirmation, within one
calendar day of server time; child confirmation uses the existing 0-17 range.
Lost or timed-out replies retain the original PATCH body/key. Eight seconds
bounds the transport wait; Retry is explicit. Lock/offline pause adoption and
do not repeat the save. Other local child drafts survive polling; dirty edits
invalidate their old confirmation. Oversized/malformed review uses staff fallback.

All 149 affected existing checks pass: shared station 10, box station 32,
API station 50, POS scan-channel 54 and native POS smoke 3. Shared/box/POS
typechecks and full package lint pass; POS build and standalone smoke typing
pass. No new suite, dependency or migration. Native proof uses a fresh seeded
database and separate staff/display contexts, verifies real profile readback,
same-key/body lost-reply retry, both display widths and staff handoff, and
observes no registration/visit/sale/payment POST during review. Its own
processes and database were removed after the run.

Reviewed LOCAL CHECK screenshots on SCRUM-201: 23-local-child-save-pending.png
(10902), 24-local-child-save-retry.png (10903), and
25-local-child-review-confirmed.png (10904). Sanitised results and the exact
business boundaries are in docs/qa/separate-display. Initial browser failures
and the fixed public-step rendering mismatch are recorded there. This is
local evidence, not a staging deployment or physical-device acceptance.

Exact-main CI 88140af run 36589992120 / check 109480274224 ran zero steps
due to GitHub Actions billing/spending availability.
Render's checksPass gate remains intact. Last verified live API/POS/Console/
Launcher/Booth is 0468c38; OTO App is c416065. Render was checked after the
push and has not advanced. No new CI-packed Pi artifact is available yet.

Continue with F&B guest display integration, then shop, under SCRUM-201.
Use captured quoted rows and real payment/completion facts, finite public
projection, retained station state across lock and explicit staff fallback
for unsupported wallet/prepaid/party paths. The scoped plan is saved in the
QA document. Keep live legacy lookup routes until the new POS is deployed;
retire columns only after old API readers retire in a later release.
Rebuild the lost temporary payment/offline proof helpers before post-deploy
verification; the retained simulated partial payment remains untouched.

After every substantial part: update this checkpoint and Jira status/comment
in the same turn as the push. Deployed still requires named, attached staging
screenshots. Pending decisions and operational blockers are in OPEN_QUESTIONS.md.

Current staging: SCRUM-206 online Slice F source `0468c38` is LIVE on
API, POS, Console, Launcher and Booth after green CI 36547262414. OTO App
remains `c416065`. Six native cases pass: cash/change, handheld split/manual,
food QR/reconnect, shop approval, decline/cash fallback and timeout/inquiry/
audited confirmation. Reviewed screenshots are attached to SCRUM-206 as
10868-10881; the final image records failure evidence. See
`docs/qa/payment-stage`. No physical booth, bank charge or printing is claimed.

The checked payment follow-ups and SCRUM-285 guard are assembled on the
latest main checkpoint as five linear source commits: wording `2899439`,
inquiry capability `4817aa1`, partial reversal `f1b122e`, invoice scope
`c215757` and forced-offline guard `346bfae`. Main release checkpoint `fe9c683` landed that
combined source on origin/main; the original work branches remain preserved.
All **305 affected existing-file checks pass**: API terminal 27, gateway 44,
cash 26, sales 58, station session 35 and guarded routes 9; POS writer 58,
shared payments 22 and database migration 26. One local guarded-route suite
hit a PostgreSQL port collision; its isolated rerun passed all nine checks.
API/POS/DB/shared typechecks and full package lint, POS production build,
database schema verification against 0029 and independent combined review pass.
Temporary verification configs are removed. No new suite or dependency.

Shared contract names remain unchanged. Optional `inquirySupported` hides
unsupported GHL card inquiry; optional `reversalPending` retains the original
reservation and blocks abandonment/zero-close until explicit false after a
successful reversal. Forward migration 0029 permits repeated hardware invoice
numbers, keeps device-less gateway invoices unique and fences all five gateway
reads from hardware attempts. It does not rewrite payment rows. Roll forward
after 0029 rather than reverting behind these matching filters.
The offline guard runs before idempotency and refuses trading only for the
authenticated station's persisted forced-offline virtual box. Reporting,
setup, Go online and box callbacks remain available with original permissions.

Exact-main [CI 36565169997](https://github.com/vickyydev/oto-platform/actions/runs/36565169997)
on `fe9c68374449a867254992c0f0e4d869876b6b34` stopped with zero steps.
Check job 109395214284 explicitly reports failed recent account payments or
an insufficient spending limit. This is an external Actions availability
block, not a source-test failure. Render's normal checksPass gate stays intact;
all five platform services were rechecked LIVE on 0468c38. No corrected source
or migration is deployed yet. Restore Actions billing/spending availability,
rerun 36565169997, then deploy its tested source and complete isolated staging
proof, named Jira screenshots and the new CI artifact delivery. Documentation
checkpoints do not change the tested release source. SCRUM-206 remains In Progress
pending SCRUM-269 local till transport and SCRUM-201 separate display acceptance.
SCRUM-285 remains Testing until named staging screenshot evidence is attached.

The original simulated partial outcome is still **BROKEN/unresolved**:
sale `01a0ecb8-f168-7b26-96e4-9ccaabe14cbf`, attempt
`01a0ecb8-f870-798f-b893-37d9871d4bcd`, run `0d008153` on virtual-1.
Its command reports partial approval, but the cloud attempt remains pending
with no rescue VOID. Eight dedicated inventory rows remain retained. Existing
controls cannot retrieve the lost final result after restart or safely replay
it. Do not repeat SALE, fabricate a callback, confirm no money or archive these
records. The logged invoice unique violation and old-migration regressions
support the corrected callback path; they do not establish recovery of this row.

After corrected source is LIVE, prove fresh partial reversal, GHL confirmation,
QR-disabled refusal and zero-price checkout in an isolated report using
`test-results/payment-stage-native-proof.mts`, `--output-dir` and `--only`.
The helper protects the historical records and original report; completion
applies only to requested cases. Then run `test-results/offline-guard-proof.mts`
on independent disposable fixtures, restoring the forced-offline flag afterward.
These proofs must not change the retained historical failure into a success.

The last green CI-packed Desktop pair is `oto-box-0.1.0-0468c38.tgz`
and its `.tgz.sha256`, verified SHA-256
`044edbb9a474a945eadcc91e82598bee86b7b3f472e1630b79dceabcd1fbf1ea`.
Older pairs are in `old-oto-box-releases`. No physical Pi installation was
performed. Download the new exact-source CI artifact only after green CI and
LIVE staging, verify its checksum and replace the Desktop pair as documented.

The earlier releases below are retained as history.

OTO Park has completed the physical Lucky Wheel bench test and shared the
walkthrough. Sprint 2 now resumes in the documented order: SCRUM-391 (QR
routing), SCRUM-388 (pending money reservation), SCRUM-382 (unavailable
tenders), then SCRUM-206 Slice F across the four tills.

The three source changes are on main at `b02f7e0`, with the work branch
`fix/payment-prerequisites` preserved. SCRUM-388
now checks every new tender under the sale lock: accepted money and unresolved
attempts leave only the unreserved balance available. Declined, cancelled and
not-found attempts release their reservation. Outstanding remains the amount
actually unpaid, so a pending attempt cannot close a sale. All 21 existing
cash-suite tests and 23 offline replay tests pass, including simultaneous
presses and cash/manual bypass. API typecheck, changed-file lint and an
independent money/locking review pass.

SCRUM-382 now refuses disabled or archived methods with
`PAYMENT_METHOD_UNAVAILABLE`, including the legacy card alias. A live replacement
wins over archived history; classification fallback remains only for an absent
row. All 23 existing method tests pass. Offline money refused by this rule is
retained in quarantine, with no partial sale; after correction, Console Replay
applies it once. That recovery passes in the existing 23-test sync file.
The shared taken-status list and drawer audit comment follow-ups are included.

SCRUM-391 now dispatches QR using the station's saved gateway/terminal/disabled
setting. POST and polling responses carry the shared attempt vocabulary plus
nullable QR payload, image and expiry metadata. Retries keep their original
route even after routing changes or payment; external gateway calls happen
after the durable attempt commits. The existing gateway and terminal files pass
66 tests, including paid-after-disable and final HTTP idempotency replay.

The three separate commits are reservation `e333994`, method availability
`c0aefae`, and routing `b02f7e0`.
All three tickets are Deployed in active sprint id 3, Sprint 2. Seven existing
API files pass 196 tests; API typecheck, changed-file lint and independent review
pass. No new suite, migration or dependency.

[Main CI 36486990526](https://github.com/vickyydev/oto-platform/actions/runs/36486990526)
and the final branch run 36485272336 are green. One deployment put API, POS,
Console, Launcher and Booth live on `b02f7e0`; the OTO App remains on `c416065`.
All 21 staging behaviour checks passed after the resumed instruction authorised
the scoped proof. Saved QR routing, callback-free recovery, unavailable tender
refusal and pending money reservation work. The dedicated proof configuration
was disabled or archived; test sales remain in audit history. Six reviewed
screenshots and the sanitised [report](../qa/payment-prerequisites/README.md)
are saved. Jira attachments 10855-10860 provide native Console/POS screens and
clearly labelled API test-run cards. The History capture used the native station
picker and reused the passing checks without repeating financial tests.

Main now includes the Slice F foundation and current release batch at `5fb8525`.
Exact-source branch CI 36521169654 and main CI 36521266122 are green. Main passed
on one failed-job rerun after an existing concurrent voucher assertion; no
voucher source or test was changed. One staging deployment put API, POS,
Console, Launcher and Booth live on `5fb8525`; the OTO App remains `c416065`.
The foundation adds the cloud payment client, keeps partial
tenders in the writer's committed state, gives deliberate split parts separate
stable identities, and closes settled payments with explicit `NO_TENDER`.
Late responses are fenced by sale identity and epoch, including cart changes,
reset and unmount. All 38 tests in the existing sale-writer file pass, as do
POS typecheck, package lint and independent review. The foundation is deployed.
SCRUM-387 is Deployed on main: first-transaction response ownership, complete
inquiry/confirmation envelopes and public sale/print responses are implemented;
all 147 tests in five existing files, API typecheck and lint pass. Test print
and reprint now commit their job, command, audit and complete answer together;
six failure/retry cases prove rollback and one effect.
SCRUM-452 is Deployed on main: the Lucky Wheel gets a ten-second default and a
Console draft setting for whole seconds from 2 to 20. Migration 0028 passed
22 existing database tests and DB typecheck/lint; shared and wheel tests and
all touched front-end/API typechecks and lint pass. Existing API booth files
pass 44 tests (84 tests across the spin-duration changes).
SCRUM-387 is committed as `233113e` with atomic print follow-up `5fb8525`;
SCRUM-452 is `3dd57d4`. All six replay checks and nine duration checks passed.
Reviewed evidence is attached to Jira: replay card 10861, duration screenshots
10862-10867. Duration measured 12,015 ms online, 12,006 ms after offline
restoration and 10,002 ms at the default; every print followed the visible
reveal. The wheel proof used native staging assets on an isolated local box.
Dedicated proof inventory was archived; existing booth versions are unchanged.
See [duration evidence](../qa/booth-spin-duration/README.md).

The CI-packed `oto-box-0.1.0-5fb8525.tgz` and its `.tgz.sha256` are on the
Desktop, verified against SHA-256
`f82baa9a6053df514ebfd75a27529aba25b44b33d6ca012aba61b704c61a49f2`.
The older pair is in `old-oto-box-releases`. Update the physical Pi using
[the Update guide](../ops/PI_BOOTH.md#7-checking-and-fixing) before publishing
a non-default duration. This session did not install it over SSH.

The four-screen Slice F UI checkpoint `cf67d86` is pushed on
`feat/payment-stage-ui` under `test-results/payment-ui-worktree`.
The till, handheld till, food station and shop share one controller; the mobile
food-station caller is included. The existing writer suite passes 53 checks;
POS typecheck, package lint and production build pass. The GHL capability guard
permits staff confirmation without offering unsupported inquiry. This separate
source checkpoint has green branch CI 36523891229 and is not deployed;
native staging UI proof is still pending.
Its complete offline and separate-display acceptance
also needs the existing SCRUM-269/285 and S2-08 seams. Real 2C2P sandbox
confirmation still needs credentials; the simulator is available for approved proof.

## Historical checkpoint - 28 September

_Last updated: 2026-09-28, 23:23 Bangkok - physical bench walkthrough captured._

The owner reports the physical Pi update is working. A live Console inspection
at 23:12-23:16 confirmed FortuneWheelBox (booth-1), FWBooth1 (prefix B1), the
reachable Booth Voucher Printer, and published/running wheel configuration 5
with seven active prizes. Today's booth totals match: 24 spins, 24 printed,
zero redeemed. Three 22:57 prints continued while cloud calls failed; all three
are now in the cloud ledger and the box's outbox is zero. Fifteen earlier spins
are unattributed and one has an uncertain-clock flag. A pending draft sort-order
value was left unchanged. See the [15-step walkthrough](../qa/booth-walkthrough/README.md),
also saved on the Desktop as PDF and numbered screenshots. This follow-up under
SCRUM-451 changes only documentation and does not deploy an application.

Bench round 1 WORKS on staging. Four feature commits are on main:
- SCRUM-448: `8df6482`, print when the result is revealed.
- SCRUM-449: `94042b3`, button-only staff selection, five-digit pad and staff menu.
- SCRUM-450: `652d933`, five-digit PIN set/generate/expiry/remove, migration 0027.
- SCRUM-451: `b9d68e3`, Vouchers ledger/CSV, booth Spins and setup checklist.

The stopped `wip/bench-round-1` remains intact. Its useful changes were reviewed
and completed from main `5c0eb91`, rather than merging the unchecked branch.
All four tickets are in sprint id 3, linked to SCRUM-198, and Deployed with
named staging screenshots attached (attachments 10841 through 10848).

[CI 36432299165](https://github.com/vickyydev/oto-platform/actions/runs/36432299165)
is green, including typecheck, lint, existing tests, migration replay, builds,
Pi packaging and Console browser checks. No new test suite was added.
API, POS, Console, Launcher and Booth are live on `b9d68e3` after one deployment;
the OTO App remains on `c416065`. The final documentation push skips deployment.

The staging proof used Booth 2 (proof) and a simulated receipt printer. Staff
selection and all five PIN digits used only Space gestures. The spin returned
queued, and the print call arrived 6,651 ms later with the result visible; it
printed, repeated safely, and refused an unknown spin with 404. Five-digit PIN
generation, setting, expiry storage, invalid-length refusal and removal passed.
The same printed voucher appeared in Spins, Vouchers and CSV. Temporary booth,
staff, PIN and screen settings were restored. Screenshots and the measured report
are in [bench-round-1](../qa/bench-round-1/README.md).

The CI-packed `oto-box-0.1.0-b9d68e3.tgz` and its `.tgz.sha256` are on the Desktop.
Both the download and Desktop copy matched SHA-256:
`ab4f98cff2408f9ac8f5f6b610e82bb46155d52fd27d43e5654d9bce455b3a0d`
The previous Desktop release pair is in `old-oto-box-releases`.

Next is the owner's physical demonstration video, matching a fresh printed slip
to its row in the Console. The owner performed the Pi update; this session did
not install it over SSH. [PI_BOOTH.md, Update](../ops/PI_BOOTH.md#7-checking-and-fixing)
remains the update guide. Counter-issued rows do not record an issuing
station in the existing table; the ledger says so rather than inventing one.

The newest STOP POINT in SESSION_HANDOVER.md is authoritative. The sections below
retain the earlier sprint background; their dated figures are historical.

## Where we are

- **Sprint 1 is complete** and reviewed by the owner (tag `sprint-1`): accounts,
  scoped permissions, audit, idempotency, file storage, members, children, tier
  verification, catalogue, pricing, tax, public booking. Report:
  `SPRINT_1_REPORT.md`.
- **Sprint 2 is being built, and most of it is now live on staging.** The suite
  launcher, the Console, stations and boxes, the box agent's sync core and print
  pipeline, the Lucky Wheel booth, the sales ledger and the F&B/shop lanes, the
  member and booking work are all deployed. On 24 September at 06:29 **137 tickets read
  Deployed** (SCRUM-392, 204 and 202 joined that morning), 2 are In Progress
  (SCRUM-191, 206), none are in Testing and 62 are open (SCRUM-393 was raised
  on the 24th).
- **Money can now be taken.** SCRUM-206 (S2-10a, tenders) is the work of the day:
  six of its seven slices landed — the tender ledger (`3317360`), payment methods
  admin (`8ee9a5d`), the cash tender and part-paid sales (`a232059`+`b616191`),
  the card terminal adapters on the box (`51fd025`), the card tender in the cloud
  (`83ffc36`), the 2C2P QR tender with its signed webhook and gateway simulator
  (`24e608d`), and offline sales replay with the box's own drawer kick
  (`d435db4`). **Slice F — the POS payment stage — is not started**, and
  SCRUM-206 stays In Progress.
- **S2-09 (checkout and sales ledger) is closed — Deployed on the 24th at
  06:27.** S2-09b's two halves are on `main` (`f5e5572` — every screen reads
  members from the platform; `4cad79e` — a shop product carries its sizes, the
  shop screen asks for one, a box scan lands on the shop screen) and proven on
  staging. The one gap found there — a scan never reached the shop screen,
  because the POS site's `/api/*` rewrite holds the station channel's stream
  back — was **SCRUM-392 (High)**, fixed at `003dac7` (the screen polls when
  the stream cannot open) and proven on staging at 06:14; 392, 204 and 202 are
  Deployed.
- **The repository is the suite monorepo**: platform at the root, docs split by
  purpose, `imports/` as the local-only drop zone. Remote:
  `github.com/vickyydev/oto-platform` (private).
- **Everything the park runs has been read**: the three real apps
  (`../architecture/EXISTING_SYSTEMS.md`, `intake-2026-09-19/`), the OTO App
  production dump (structure only), the wheel specification, the previous
  developer's POS rules (`../briefs/POS_BACKEND_LOGIC.md`, reconciled in
  `../architecture/POS_RULES_RECONCILIATION.md`), the proposal document for the
  OTO App (`../briefs/AGENCY_PROPOSAL.md` — what that contract still owes), the
  park's hardware reference and the four gate documents
  (`../architecture/DEVICE_INVENTORY.md`), the Inbox prototype
  (`../features/inbox.md`).
- **The owner's direction of 2026-09-20** (`../briefs/OWNER_DIRECTION.md`) sets
  the sprint: one sprint, in priority order — (1) the POS complete with the Lucky
  Wheel booth, on simulators of the park's real devices and with real QR payments
  through the 2C2P sandbox; (2) the OTO App on the central database with one
  sign-on; (3) Radar live with a per-branch source preference; (4) the Unified
  Inbox data pillars and a styled shell.

## What is next

**The Lucky Wheel booth is the first priority (owner, 24 September, afternoon):**
the Pi as a real box beside the virtual box, voucher redemption at the till,
switched-off prizes off the wheel, staff sign-in by account or PIN with an
admin-set session length, then a closing audit and the owner's bench test. The
plan is `plans/booth/PLAN.md`; the audit behind it is `plans/booth/AUDIT-2026-09-24.md`.
Rounds 1 and 2 landed (`1de320c` the Pi runtime, `13a6e70` the redemption api,
`c4f8b4e` the till, `9673e39` the Console; 398, 399, 400, 207 and the four Bugs in
Testing). The end-to-end proof on staging held at 9673e39 (a real box process on this
machine, the slip decoded from the printer bytes, the voucher redeemed once at the
staging till) and the eight booth tickets are Deployed (03:41). The closing audit's fix
round landed as `79a1c0e`…`4d0e24e` (the eight lanes); its 29 follow-ups are
SCRUM-401…429; the Pi release is packed at `4d0e24e`. The staging proof of the four
big fixes held at `8ffe856` (three small History gaps → SCRUM-430, Low). **READY for
the owner's bench test**: the release `oto-box-0.1.0-8ffe856.tgz` is with him, the
guides are `docs/ops/PI_BOOTH.md`, `BOOTH_SETUP.md` and `COUNTER_VOUCHERS.md`, the
bench steps are in `plans/booth/PLAN.md`. Everything below waits behind the bench.
While he benches, the audit's small follow-ups land as quick rounds (the handover's
"Quick rounds after READY"): SCRUM-409, 411, 413, 414, 417, 418, 424 and 427 are
**Deployed** on staging proof; 420, 429 and 430 are on `main` in Testing (small
remainders → SCRUM-435 and the next quick round); the proof pass raised SCRUM-432–437.
SCRUM-401 (`4dfcb34`) and 402 (`7b360cd`), the two Highs, landed on Opus with gates
and are Deployed with 409–437's screen-facing set on the second proof pass; 406, 408, 431 and
438 are Deployed on the third proof pass (CI fixed at the root in `64d856e`); 439 is Deployed; 403,
444, 440, 442 and 423 are in Testing; 433 is in In Progress with its round running (migration
0025); 443 waits on the owner's choice for the branch chip; 446 and 447 are new from 403's gate. The owner's rule since 25 Sept: small
defects on Fable quick rounds, stories on Opus with full gates.

**Then the recommended order, still the owner's to confirm**, with the reasoning in
`SESSION_HANDOVER.md`:

1. The D↔C2 seam and **SCRUM-391** — a `qr` tender never reaches the gateway —
   then drive D's QR path on staging end to end.
2. **SCRUM-388 (High)** — reserve in-flight tenders, before Slice F.
3. **SCRUM-382** — refuse a disabled or archived tender in the attempt service.
4. **Slice F** — the POS payment stage on all four tills — then SCRUM-206's
   end-to-end Deployed evidence.
5. The Console and box items (378, 381, 385, 386, 387, 389, 390), the promotion
   items (373, 374, 375, 368), the small light-theme and till items (370, 372,
   379, 380), then testing (369, 383).
6. The owner decisions listed below.

## The staging deployment

Render project **OTO Platform** in the Oto dev workspace, environment `staging`:
Postgres 16, and six services — `oto-api-staging`, `oto-pos-staging`,
`oto-console-staging`, `oto-launcher-staging`, `oto-booth-staging`,
`oto-app-staging`. All six auto-deploy on a push to `main`, but only once the
GitHub checks are green. On 28 September at 21:25 Bangkok the first five are live
at **`b9d68e3`** and `oto-app-staging` at `c416065`, which deploys only on its own files. The full account is
`DEPLOYMENT_STAGING.md`; the topology is `../architecture/DEPLOYMENT_TOPOLOGY.md`.

Two rules that cost time today, now recorded in memory `oto-render-staging`:
compare **every** service's live commit before calling a ticket Deployed (one
service's auto-deploy trigger had been off for three days), and anything a screen
cannot work without is converged by `platform-sync`, never left to the demo seed
(SCRUM-384 — staging's payment-method table was empty after a deploy and the till
could not take money).

## Blocked on the owner

1. **Which gateway portal the park holds** — a 2C2P sandbox merchant
   (developer.2c2p.com) or an SCB Developer Portal application — and its sandbox
   credentials into `.env` (`PGW_*`), never into the repository. This is decision
   **O-1**; it blocks only the real-QR half of SCRUM-206, since the gateway
   simulator carries the acceptance.
2. **O-2** — whether offline sales (Slice G, built inside SCRUM-206 today) stay in
   that ticket or become one of their own.
3. **O-6** — the vendor questions for GHL Thailand and Digio, including the TID
   and MID for the park's two PAX terminals, which are not on file.
4. **Policy and scope decisions** raised by today's work: 371 (does the sale
   survive the inactivity lock?), 345 (may a branch carry another branch's product
   or discount code?), 306, 327, 326, 357, 268, and 254's two open questions.
5. The deploy-bot's `render.yaml` entry, which creates a paid service on sync.
6. Later: real dumps of Radar's and the wheel's databases; Pisell/Papaya
   credentials from Replit Secrets (history export before any cancellation); S3
   contents; DNS for the `otoplay` domains; a Raspberry Pi 5 on the desk.

## Build order

S2-01 → S2-02 → S2-03 → S2-17a → **CP1** → S2-04…S2-07 → **CP2** →
S2-08…S2-11 → **CP3, POS play-test opens** → S2-12…S2-15 → **CP4** →
S2-17b/c → **CP5** → S2-18, S2-19 → **CP6** → S2-16 → **CP7**. (The full order
with every lettered part is at the end of `SPRINT_2_PLAN.md`.) The sprint is
inside S2-10 (payments) now, with S2-09b (SCRUM-204) still open beside it. Every
function is committed as it lands; the ticket log in `SPRINT_2_PROGRESS.md` is
updated in the same commit series.

## Known defects

The Sprint 1 list that S2-01 existed to fix is closed: the role-assignment
privilege hole, the lock model, the PII in logs, the proxy trust and the
Postgres-backed throttles all landed, and transactions and the atomic idempotency
claim followed in S2-01b.

The open list is now the one raised during Sprint 2 itself. Twenty-seven tickets
raised today are still open — the payments six (391, 388, 382, 390, 389, 387), the
Console and box four (378, 381, 385, 386), the promotions four (368, 373, 374,
375), the till and light-theme six (360, 371, 372, 370, 380, 379), and the rest
(369, 383, 339, 340, 345, 357, 326). Each is one line with its key in
`SESSION_HANDOVER.md`, and one row with its evidence in
`TICKET_REGISTER_2026-09-23.md`.

## Working rules that are easy to forget

- Nothing under `imports/` is committed except the READMEs. The exports contain
  real credentials and the dumps contain real staff and children's data: structure
  and counts only, never values, never uploaded anywhere.
- Never run `drizzle-kit push` or an imported app's reset scripts against a shared
  database.
- Commits follow `/CONTRIBUTING.md` (no attribution lines). **A commit's file list
  is never filtered by a word** — list every file the work touched, or CI finds
  the one you dropped.
- **A credential is searched for in every encoding**, not only the one it was
  typed in. The vendor void password turned up a seventh time hex-encoded inside a
  sample frame.
- **A reviewer never stashes a shared working tree.** Several slices are usually
  live in it at once.
- Checkpoint the progress file and commit after every substantial step; research
  agents run on Opus and save their output early.
- `services/deploy-bot/` and `render.yaml` belong to a separate session — do not
  touch either.
- To play with what is deployed: `docs/qa/SIMULATION_AND_TEST_CONTROLS.md`.
