# Current status - read this first when resuming

_Last updated: 2026-10-01, evening Bangkok. M2 is complete: the offline cluster's
five rounds plus the polish are landed and proven on staging (SCRUM-269, 270, 271,
295, 206 and story 205 all Deployed — the park sells cash and card with the
internet down, and every sale lands exactly once after reconnect). The booth
dashboard (SCRUM-468) and the Twilio Verify adapter (SCRUM-455, adapters still on
console until the owner flips one) are Deployed. The Testing queue is cleared:
ten OTO App tickets closed on staging evidence, with only SCRUM-461 left waiting
on the owner's AI key; the staff-refusal proofs rode a provisioned non-admin user,
and the provisioning gap they exposed is SCRUM-469. Next build: arrival, SCRUM-209 / S2-12, from
`docs/progress/plans/arrival/PLAN.md`. The newest STOP POINT block in
SESSION_HANDOVER.md carries the detail._


## Active OTO App lane - 30 September 2026

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
