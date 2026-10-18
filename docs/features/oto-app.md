# OTO App ("OTO Suite")

**13 October 2026, current acceptance status:** SCRUM-191 and all twelve child tickets are **Deployed**. The eleven linked lift items remain Deployed. The owner reserves **Done** for acceptance after the full final test suite. Implementation, the recorded release gate, named staging proofs and exact cleanup are complete; their results and limits remain valid. Final owner acceptance is pending. The earlier 17:43 Done checkpoint below is historical and does not represent the current ticket status.

**Historical 13 October staging checkpoint (superseded by the release record below):** All six services are now observed live at4dcc6664. The read-only census confirms app0010 and all four required document owners. Settings, Activity and Attention named actions pass; all twelve Directory reads/refusals pass with both temporary credentials removed; the seeded POS event list/detail and two branch/park refusal cases pass. Four inspected cards are indexed in [13 October platform controls](../qa/oto-app-lift/round-7/platform-controls.md). Historical job success and Retry records are recovered. Current job completeness reports only the retained practice park without a job credential; final practice cleanup, empty employee-view census and Retry remain before the jobs gate can close. R8 main and the final feature candidate are still completing their full hosted checks.

## What it is for
The park's day-to-day management system, used by all staff every day since about
May 2026: HR records, contracts and letters with e-signature, timekeeping kiosks,
scheduling and leave, payroll, tasks / checklists / ops board, announcements,
SOPs and the "Ask OTO" assistant, fault reports with a supplier portal, events
and birthdays (event orders, packages, parent portal, RSVP), camps, drop-off and
nanny check-in, staff vouchers. The 19 September intake counted 72 login users, 69 employees and 3 branches; those are historical source counts.

## Intake
- **Source:** `imports/oto-app/` — Replit export of 2026-09-19 (last commit
  2026-09-15; 2,920 commits, 37 in the last 30 days — still actively edited).
  Detailed notes: [`01-oto-app-backend.md`](../architecture/intake-2026-09-19/01-oto-app-backend.md),
  [`02-oto-app-frontend.md`](../architecture/intake-2026-09-19/02-oto-app-frontend.md).
- **Real or mockup:** **live, with production data.** Two earlier Replit apps
  ("OTO HR", "OTO Core") merged, plus "Studio" pages. Deployed on AWS App
  Runner via Pulumi; the environment named `staging` is production.
- **Stack:** React 18 + Vite 7 + Tailwind 3 + shadcn (122 routes, ~129k lines);
  Express 4 monolith (796 routes; `routes.ts` 25.5k lines, `storage.ts` 12.2k);
  Drizzle on `pg`; Passport-local with scrypt hashes; sessions in Postgres;
  uploads on S3 (two buckets) with some writers still on local disk; Puppeteer
  for PDFs; Twilio Verify; OpenAI; AWS Rekognition for face clock-in; Sentry.
  No unit tests; 48 Playwright specs.
- **Its tables:** all 184 in the dump (`imports/_db/`), 65 enums, 519 foreign
  keys. 93 tables hold data (~46.8k rows). Busiest: `time_events` 8,116,
  `kiosk_auth_attempts` 7,814, `checklist_run_items` 4,049,
  `schedule_assignments` 3,354, `service_checkins` 2,038, `dropoff_checkins`
  1,332. Empty today: payroll, SOP / KB, Ask OTO, vouchers, assets, Xero.
- **Export vs production:** zero drift — all 184 tables, 2,319 columns and 370
  indexes match the code. Schema is managed with `drizzle-kit push --force`, not
  migrations. Known defect: four finance tables lack the primary keys their
  upserts rely on, so the Xero sync cannot work.
- **Shared entities it touches:** tenants, operators, branches; users, people,
  employees, roles, branch access, per-user module switches. **No customer,
  member or child table** — parents and children are free text across seven
  tables.
- **Replit-specific dependencies to replace:** cookie `secure` flag keyed on
  Replit env vars; `replit_integrations/` storage module; `AI_INTEGRATIONS_*`
  naming; Xero redirect hard-coded to the Replit host; Nix Chromium path; three
  Replit Vite plugins.
- **Secrets found in the export:** yes — `temp-env` (26 variables), `k8s/app.yaml`,
  `.replit` (seed admin), a Sentry DSN, `cookies.txt`, plus uploaded personal
  files. All excluded from git here (`imports/` is ignored); all to be rotated.

## Original integration plan (historical)
This records the intake design. The module status and live release gates below
supersede its proposed implementation details.

- **Deployable:** one Docker service serving UI and API together (its browser UI
  makes ~660 same-origin `/api` calls). Existing `Dockerfile`; ≥2 GB RAM for
  Chromium; exactly one always-on instance (in-process timers: 00:01 auto
  clock-out and recurring tasks, 03:00 reconciliation, 10-minute no-show alerts);
  `TZ=UTC`; health check `/api/status`; same region as the database.
- **Login:** an adapter before `passport.session()` validates the platform
  cookie, maps it to the local `users` row via a new `platform_user_id`, and
  calls `req.login()`. All handlers stay unchanged. scrypt hashes are imported
  and re-hashed on first sign-in. User, permission and password screens
  (~15 credential-writing routes) are re-pointed to the Console. Kiosk bearer
  tokens and public token links stay outside the sign-on.
- **Data:** schema `oto_app` via `ALTER ROLE … SET search_path` (Drizzle emits
  unqualified names, so no code change). Load path: restore the dump into a
  scratch database → `ALTER SCHEMA public RENAME TO oto_app` → dump across.
  Post-import script: add `platform_user_id`, mirror accounts / branches / staff
  into `core`, rewrite stored bucket paths, apply the clock-in decision. Never
  run `drizzle-kit push --force` or the reset scripts against the central
  database.
- **Files:** one bucket; merge the second (checklist media) into it; add bucket
  CORS for browser uploads; move the four local-disk writers (employee
  documents, unsigned contract PDFs, payslips, payroll exports) to object
  storage.
- **Seams to the rest of the suite:** `beo_event_billing.pos_order_ref` and
  `studio_event_bookings.pos_reference` become real links to POS orders;
  check-ins, camps and events gain a member id; staff vouchers become redeemable
  at the POS (the server endpoints exist, but the exported UI did not call them);
  the Directory API (`/api/directory/*`) served staff identity to other systems.
- **Launcher tile:** "OTO App" (or "Team"), shown with `app:team:access`.

## Environment variables (names only)
| Purpose | Variables |
|---|---|
| Required to boot | `DATABASE_URL`, `APP_ENV`, `STORAGE_ENV_PREFIX`, `OBJECT_STORAGE` |
| Runtime | `PORT`, `NODE_ENV`, `TZ=UTC`, `LOG_RESPONSE_BODY=false` |
| Sessions and token schemes | `SESSION_SECRET`, `SESSION_PEPPER`, `KIOSK_CODE_PEPPER`, `PIN_FINGERPRINT_SECRET`, `KIOSK_IDENTIFICATION_TOKEN_SECRET` |
| Object storage | `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (`AWS_S3_BUCKET`, `AWS_S3_REGION` only until the buckets are merged) |
| PDFs | `PUPPETEER_EXECUTABLE_PATH` |
| SMS codes | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` |
| AI features | `AI_INTEGRATIONS_OPENAI_API_KEY` (leave `_BASE_URL` unset off Replit) |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` |
| Optional | `HR_DIRECTORY_API_KEY`, `SENTRY_DSN`, `VITE_SENTRY_DSN`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` |
| Local only (refused on every deployment; read only by the dev-only `POST /api/seed`, nothing seeds at boot) | `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` |
| Legacy face-clock settings (module off on staging) | `USE_AWS_REKOGNITION`, `AWS_REKOGNITION_COLLECTION_ID` |

New values for the session and token secrets mean: reprint the branch check-in
QR posters, re-activate every kiosk tablet, reset advisor PINs. Everything else
(signing links, parent portals, supplier links) survives.

## Security scope during the lift
The export review identified public children's-data lookup by phone, signed
contract PDFs served without login, weak kiosk clock and upload authorization,
plaintext credential storage, response-body logging, and exposed development
artifacts. The deployed repairs and remaining checks are recorded per module
in the [S2-17b acceptance index](../qa/SPRINT_2_ACCEPTANCE.md). This intake
list alone is not proof that every path has passed the staging access checks.

## Status - 13 October 2026

[Current app-job recovery](../qa/oto-app-lift/round-8/jobs-recovery.md) and the [registered lift/feature cleanup](../qa/oto-app-lift/round-8/cleanup.md) are complete. The latest release and ticket states follow.

**Historical checkpoint - 13 October 2026, 17:43 Bangkok (ticket status superseded above):** SCRUM-191 and all twelve child tickets are Done. Eleven linked lift items remain Deployed with images. All six services were observed live on main `2850d89178232f421fbea18cbc4ea583cf3c1910`; the app deployment completed at 16:37 Bangkok. All six main jobs passed in [run 38374525197](https://github.com/vickyydev/oto-platform/actions/runs/38374525197): 4,033 API tests, 32 scheduling controls, 89 feature runtime controls and 30 Console browser checks, plus build and genuine hosted restore/replay. Whole workspace/API compiler output is clean. The app remains at 442 diagnostics across 59 files and 118 file/code buckets, with the 457 ceiling retained. App migrations remain through `0015`.

[Scheduling acceptance](../qa/oto-app-lift/round-8/scheduling-scope.md) records own saves/edits and all ten foreign/mixed/replay refusals with unchanged readbacks. The inspected labelled API card is attached to SCRUM-523 and SCRUM-191. Exact cleanup `job-db70ka4s728c73d239u0` removed 13 temporary records and one app session, confirmed absence and preserved the existing park and seeded platform identity. The former session returns 401 after cleanup. Supported unlink alone had retained that active app session; SCRUM-288 now records this additional access-lifecycle case. This cleanup is separate from the earlier 297 content rows, ten files, seven parents and two sessions.

No additional feature-scope answer is pending; final owner acceptance remains pending as stated above. Recorded feature limits remain: face mode off, no positive Xero sandbox exchange, repeated import Apply unproven, no deleted-SOP recovery, staff-inbox delivery only, saved-family API save after UI verification, and existing employee approval rules. The owner decision document is separate from final test-suite acceptance. Next is OPEN_ITEMS section 2, beginning with SCRUM-276. Local databases remain off; SCRUM-223 stays paused.

**WORKS** describes only the named observed action and access case. Historical observations retain their dates; the current scheduling boundary is evidenced below. Face clock remains off, and positive Xero exchange remains unavailable until the sandbox is connected. Broader variants and device-specific limits remain beside each proof. Original app behavior is the default for the numbered owner questions.

The [acceptance index](../qa/SPRINT_2_ACCEPTANCE.md) owns the final checklist and [closure plan](../qa/oto-app-lift/closure-plan.md) records completed acceptance and retained limits. Earlier dated module observations remain historical where newer linked evidence supersedes them.

| Module / contract | Evidence-backed outcome | Named proof and remaining limit |
| --- | --- | --- |
| Launcher sign-on | WORKS | All round 5/6/7 staff sessions entered through the launcher; [round 6 sessions](../qa/oto-app-lift/round-6/README.md). The old password form remains disabled on staging. |
| Users, people and permissions | WORKS for the named ownership and access-policy controls | [13 October administration recheck](../qa/oto-app-lift/round-7/administration.md): own person create/read, selected-branch policy and bulk update; foreign reads/writes/deletion refused, foreign branch replacement 403, foreign bulk update skipped. Exact person/policy cleanup completed. Shared-role choices Q54/Q56/Q57 remain explicit. |
| Branches, departments, operators | WORKS for recorded branch, operator and department actions | [Organization evidence](../qa/oto-app-lift/org-hr-verification.md): 13 October real department create/edit/reload/deactivate and exact two-row cleanup are now evidenced. Specific lower-role/operator variants remain outside the named cases. |
| HR employees | WORKS for demo create/edit/reseat and owned detail refusal | [Round 2 HR frames](../qa/jira-comments/attachments/SCRUM-191/r2-hr-01.png), [round 2 status](../progress/STATUS.md), [round 5 employee-detail refusal](../qa/oto-app-lift/round-5/timekeeping.md). This does not cover every import/login toggle. |
| Employee copy and benefits link | WORKS | [Round 2 Health](../qa/jira-comments/attachments/SCRUM-191/r2-con-05.png), [round 2 status](../progress/STATUS.md): created 8/adopted 4, subsequent updated 4, then no changes; Nok's existing override preserved. Q21 verified-phone and app-only-branch effects stay explicit. |
| Contracts and e-sign | WORKS | [Signing/private PDF](../qa/oto-app-lift/round-6/contracts.md): signing 200, private object 200, other-park/signed-out/changed-signature refusals. Q50 in-park branch behavior remains; do not expand this to every contract action. |
| Contract templates | WORKS | [Save/use/refusals](../qa/oto-app-lift/round-6/templates.md): staff create 403, other-park read 404.  |
| Policies | WORKS | [Separate-park publication](../qa/oto-app-lift/round-6/policies.md): publish/read 200, foreign 404. Contract acknowledgment is not established. |
| Letters | WORKS | [Resignation signing/private PDF](../qa/oto-app-lift/round-6/letters.md). Other letter types remain outside the case. |
| Employee documents | WORKS | [PNG upload/read/delete](../qa/oto-app-lift/round-6/employee-documents.md): exactly 12,219 bytes, foreign list 404, final file 404. Self-download and other types remain unverified. |
| Assets | WORKS | [Assign/return/repeat](../qa/oto-app-lift/round-6/assets.md):201/200/400, staff 403 and foreign 404. Own-employee asset view is not established. |
| Offboarding | WORKS | [No-login resignation](../qa/oto-app-lift/round-6/offboarding.md): one record/six checklist items, repeat 409, foreign 404. This case does not prove linked-login deactivation. Q47 and the separate platform-login item remain. |
| Org chart | WORKS | [Isolated vacancy](../qa/oto-app-lift/round-6/org-chart.md): create/read, foreign edit 404 with title unchanged. Reporting-line changes and Q52 concurrency are not established. |
| Activity Log | WORKS for the named per-park cases | [13 October platform controls](../qa/oto-app-lift/round-7/platform-controls.md): owned employee query 200/one entry, other-park employee filter 200/zero, other-park branch 404. Exact synthetic entries removed in the guarded combined cleanup. |
| Kiosk devices/reception | WORKS | [Activate/exchange/rename](../qa/oto-app-lift/round-5/kiosk-reception.md), signed-out 401 and foreign activation 404. The reception board was empty; no guest check-in was changed by this case. |
| PIN/phone and face-off policy | WORKS | [Clock policy](../qa/oto-app-lift/round-5/clock-policy.md): PIN IN/PHONE OUT 200, no device 401, forged photo 400, face 403; no FACE event. Face remains off by direction; physical camera capture is not established. |
| Timekeeping | WORKS | [Two raw events and selected-branch reads](../qa/oto-app-lift/round-5/timekeeping.md), foreign 404/unselected branch 403. Full scheduled-shift calculation and the separately recorded issue-review path are outside this case. |
| Scheduling | WORKS for the named grouped saves and park-group boundaries | [Current own/foreign/replay proof](../qa/oto-app-lift/round-8/scheduling-scope.md): own saves and edits succeeded; all ten foreign/mixed/replay requests returned 404 with unchanged readbacks. SCRUM-523 is Deployed, with exact cleanup complete. The round 5 record remains dated history; existing within-park branch behavior remains the default. |
| Leave/holidays | WORKS | [Sick day/duplicate/holiday](../qa/oto-app-lift/round-5/leave-holidays.md). Existing approval action remains; no stored approver history is claimed. |
| Tasks/Ops | WORKS | [Create/complete/refusals](../qa/oto-app-lift/round-5/tasks-ops.md). Round 3 records the scheduled recurring task; current app-job recovery and the separately dated failure/Retry cases are indexed in [job evidence](../qa/oto-app-lift/round-8/jobs-recovery.md). |
| Checklists/media | WORKS | [Completed 1/1 and private bytes](../qa/oto-app-lift/round-5/checklists-media.md), foreign 404/unselected branch 403. |
| Announcements | WORKS | [Selected-branch publication](../qa/oto-app-lift/round-5/announcements.md), foreign list omission/unselected branch 403. Scheduled-delivery variants are outside this case. |
| In-app notifications | WORKS | [Actual Mark read](../qa/oto-app-lift/round-5/notifications.md), foreign omission/direct 404. [Inbox delivery evidence](../qa/oto-app-lift/round-8/feature-inbox-delivery.md) separately records Pending/Delivered/Failed, exact replay and actual Retry. Delivery means availability in the staff inbox; read/unread remains separate. |
| Attention | WORKS for the named Refresh/Snooze/Resolve cases | [13 October platform controls](../qa/oto-app-lift/round-7/platform-controls.md): each owned action 200, other-park resolve 404 and final resolved read-back. Current scheduled-job last-success evidence remains separate. |
| Fix/private image | WORKS | [Actual Gallery upload/create](../qa/oto-app-lift/round-7/fix.md), own 200/foreign 404/signed-out 401. [Recipient preview](../qa/oto-app-lift/round-8/feature-fix-preview.md) is also delivered, with member/count and empty-state proof before Save; preview sends no notification. |
| Supplier portal | WORKS | [Capability lifecycle card](../qa/oto-app-lift/round-7/supplier-portal.md): comment 201, close 200, repeat 409, revoke 204/former-link 401. No outgoing delivery is claimed. |
| Events | WORKS | [Create and foreign 404](../qa/oto-app-lift/round-7/events.md). [POS seam evidence](../qa/oto-app-lift/round-7/platform-controls.md) records the seeded event read and branch/park refusals. Wider event editing remains outside these cases. |
| BEO | WORKS for the named private PDF | [BEO walkthrough](../qa/oto-app-lift/round-7/beo.md) and [13 October private-file card](../qa/oto-app-lift/round-7/private-files.md): own 302/download 200, 49,106-byte PDF; foreign 404/anonymous 401. Exact registered cleanup is complete; see the [cleanup record](../qa/oto-app-lift/round-8/cleanup.md). |
| Packages | WORKS | [Create/line/apply and foreign 404](../qa/oto-app-lift/round-7/packages.md). [Labelled recorded-request card](../qa/jira-comments/attachments/SCRUM-193/r7-recorded-module-requests-20261013.png) indexes the 12 October package application. The event image is contextual; no new package-editor capture is claimed. |
| Menus | WORKS | [Actual public submission](../qa/oto-app-lift/round-7/menus.md), owned 200/foreign 404. Repeat/edit variants remain outside the case. |
| Camps/children | WORKS for the named attendance journey | [13 October camp recheck](../qa/oto-app-lift/round-7/camps.md): second-park check-in/out 200, foreign checkout 404, attendance owned by that park. [Children history](../qa/oto-app-lift/round-7/children.md) retains its separate evidence. [Returning-family verification](../qa/oto-app-lift/round-8/feature-family-verification.md) separately records actual SMS receipt, screen verification/prefill and saved-registration API controls. Exact registered cleanup is complete; see the [cleanup record](../qa/oto-app-lift/round-8/cleanup.md). |
| Parent portal/RSVP | WORKS | [Portal opening](../qa/oto-app-lift/round-7/parent-portal.md), [actual response](../qa/oto-app-lift/round-7/rsvp.md) and foreign 403. Outbound delivery and language/edit variants remain outside the cases. |
| Drop-off/staff check-ins/nanny service | WORKS | [Public submission, assignment, entry, checkout and private media](../qa/oto-app-lift/round-7/dropoff-nanny.md). Synthetic presence establishes service flow, not physical clock-in. |
| Nanny reservations | WORKS for the earlier reservation lifecycle | [Reservation/overlap/completion](../qa/oto-app-lift/nanny-booking.md). New R7 nanny service proof is a service check-in journey; do not treat it as proof of every reservation variant. |
| Public form builder | WORKS for isolated publication and editor save/reload | [13 October editor recheck](../qa/oto-app-lift/round-7/form-builder.md): displayed version saved 200, title persisted after reload, own JSON 200/foreign 404. Existing published-version editing behavior retained. Exact registered cleanup is complete; see the [cleanup record](../qa/oto-app-lift/round-8/cleanup.md). |
| Staff vouchers | WORKS for Console entry and legacy write refusal | [Entry and 13 October mutation recheck](../qa/oto-app-lift/round-7/staff-vouchers.md): four old addresses show the Console handoff; all seven old mutation routes return 409/vouchers_moved. No voucher was issued or redeemed in this case; the Console/till remains the active contract. |
| SOP/Find | WORKS for publication/read scope | [Draft refusal and published staff read](../qa/oto-app-lift/round-7/sops.md); [earlier Find screen](../qa/oto-app-lift/sops.md). [SOP revision/history/archive/restore](../qa/oto-app-lift/round-8/feature-sop-history.md) is also delivered. Restoring content preserves the current publication status and branch scope; deleted-article recovery is outside that feature. |
| Knowledge Base/files | WORKS for publication/read scope | [Round 7 KB requests](../qa/oto-app-lift/round-7/knowledge-base.md); [earlier exact file/PDF indexing](../qa/oto-app-lift/knowledge-ask-oto.md). [Labelled recorded-request card](../qa/jira-comments/attachments/SCRUM-193/r7-recorded-module-requests-20261013.png) indexes the 12 October publication results; no KB-specific screen capture is claimed. File-type/lower-role cases remain explicit. |
| Training/quizzes | WORKS | [Real failed/passed attempts](../qa/oto-app-lift/round-7/training.md), staff edit 403/foreign 404 and answer omitted from staff detail. |
| Ask OTO | WORKS for recorded conversation/source scope | [Thread/message/answer/citations](../qa/oto-app-lift/round-7/ask-oto.md), foreign thread 404 and no foreign fixture citations. [Labelled recorded-request card](../qa/jira-comments/attachments/SCRUM-193/r7-recorded-module-requests-20261013.png) indexes the 12 October results; it is not a new screen capture. Other AI helpers remain unverified. |
| Casual workers | WORKS | [Create/grouped assignment/deactivate](../qa/oto-app-lift/round-5/casual-workers.md), foreign 404.  |
| Payroll | WORKS for the named private files and park boundary | [Synthetic exports/self-read](../qa/oto-app-lift/round-7/payroll.md) and [13 October complete file recheck](../qa/oto-app-lift/round-7/private-files.md): four CSVs and payslip own 200/foreign 403/anonymous 401. Other-park generation 403 is recorded. Zero-value 2099 fixtures do not establish normal calculation; SCRUM-276 remains in the fix block. Exact registered cleanup is complete; see the [cleanup record](../qa/oto-app-lift/round-8/cleanup.md). |
| Xero | WORKS for unconnected state/refusal | [Status 200 connected=false/report 400/staff 403](../qa/oto-app-lift/round-7/xero.md). Positive OAuth/sync waits for the sandbox; local ownership/replay tests are not that exchange. |
| Vault | WORKS | [Metadata/reveal/refusals](../qa/oto-app-lift/round-7/vault.md). No secret shown; no additional manager behavior inferred. |
| Directory HR API | WORKS for twelve named read/refusal cases | [13 October platform controls](../qa/oto-app-lift/round-7/platform-controls.md): six owned readers 200, other-park employee/roster 404, other-park department filter 200/empty, missing scope 403, missing key 401 and disabled shared-key 403. Both temporary credentials revoked, refused and removed. |
| Data Admin | WORKS for the named writer and access refusals | [R7a owned asset writer](../qa/oto-app-lift/round-7/r7a-release.md) and [13 October administration controls](../qa/oto-app-lift/round-7/administration.md): owned create/read, foreign read/update/delete refused; exact new writer/person/policy cleanup completed. [Credential exclusions](../qa/oto-app-lift/data-admin.md) retain their earlier proof. Wider registry editor cases are outside these checks. |
| General files/private media | WORKS for the named private readers | [13 October private-file recheck](../qa/oto-app-lift/round-7/private-files.md): Fix image and drop-off signature own 200/foreign 404/anonymous 401; payroll CSV/PDF own 200/foreign 403/anonymous 401; BEO 302/download 200, foreign 404, anonymous 401. [Checklist](../qa/oto-app-lift/round-5/checklists-media.md) and [employee document](../qa/oto-app-lift/round-6/employee-documents.md) proof remains. R7 object/record cleanup is complete; issued public photo sharing keeps its existing contract. |
| Settings | WORKS for separate-park save/read-back | [13 October platform controls](../qa/oto-app-lift/round-7/platform-controls.md): the same isolated key held distinct values in two parks, each read only its own value. Exact fixture keys removed in the combined cleanup; Q28 fallback remains unchanged. |

## Original feature delivery

All seven items are delivered; their parent and child tickets are Deployed. Each row retains the observed journey and its limit; the delivered feature scope does not imply every possible variant was exercised.

| Ticket / scope | Verified delivery | Remaining limits |
| --- | --- | --- |
| SCRUM-518, employee import | **Deployed.** [Preview, selected-row Apply and re-preview](../qa/oto-app-lift/round-8/feature-import.md) showed the expected New, Changed, Unchanged, Invalid and Matched outcomes. | The re-preview proves resulting classification; repeated Apply idempotency was not established. Existing matching and selection behavior remain. |
| SCRUM-517, Fix recipient preview | **Deployed.** [Recipient preview evidence](../qa/oto-app-lift/round-8/feature-fix-preview.md) records the staff list/count, empty state and access boundaries before Save. | Preview does not send a notification or establish supplier-message delivery. |
| SCRUM-519, SOP history | **Deployed.** [Versioned edit, history, archive and restore](../qa/oto-app-lift/round-8/feature-sop-history.md) record replay handling, original content restored with the current archived status and branch scope preserved, and other-park/staff refusals. | Restoration follows current editing permission and publication choices; deleted-row recovery is outside this feature. |
| SCRUM-520, attendance evidence | **Deployed.** Optional attachment input, private issue-bound storage and manager reader are live. [Evidence](../qa/oto-app-lift/round-8/feature-attendance-evidence.md) records face-off refusals, reviewer reads and inspected hosted-control proof. | Q9 remains unchanged: face mode is off. A successful face-enabled staging upload, its private attachment read and approval were not observed. The reviewer screen had no Pending Approvals; no Approve action was performed. |
| SCRUM-521, inbox delivery | **Deployed.** [Delivery and recovery evidence](../qa/oto-app-lift/round-8/feature-inbox-delivery.md) records the current inbox delivery states and retry controls. | Delivery means the existing staff inbox. It does not establish SMS, email or push delivery. |
| SCRUM-522, returning-family SMS | **Deployed.** [Actual SMS receipt, screen verification/prefill and saved-registration API controls](../qa/oto-app-lift/round-8/feature-family-verification.md) passed, including consumed-grant and other-park boundaries. | The saved-registration write used the API after real screen verification; the normal screen Submit action was not exercised. Existing signature/consent fields were retained, with no new consent or signature claimed. |
| SCRUM-194 / SCRUM-516, review and movement history | **Deployed.** [Explicit manager Complete, terms Save and transfer](../qa/oto-app-lift/round-8/feature-employee-history.md) passed on the disposable employee, with replay and ownership controls. Reload retained the saved changes; actor/time were present in the API. | Existing immediate actions and contract prompts remain. No additional approval stage or contract generation was exercised; the history screen itself does not display the actor. |

## Cross-module delivery

| Cross-module gate | Verified evidence | Still required |
| --- | --- | --- |
| Signed PDFs and private files | [Round 6 contracts](../qa/oto-app-lift/round-6/contracts.md), [letters](../qa/oto-app-lift/round-6/letters.md) and [round 7 private files](../qa/oto-app-lift/round-7/private-files.md) record signed/private reads and refusals. All ten recorded R7 objects were removed with absence verified after exact DB cleanup. | Preserve the limits of each linked reader case; no remaining object cleanup for that manifest. |
| Platform jobs | [Current recovery and last-success proof](../qa/oto-app-lift/round-8/jobs-recovery.md): four sequential 200/ok retries, fresh Health and independent five-job readback with zero failed/unkeyed parks. Historical forced failure/Retry is separately dated. | Complete for the named app jobs; the historical demo.fail row is not an app-job failure. |
| POS reads and ownership | [13 October platform controls](../qa/oto-app-lift/round-7/platform-controls.md): seeded event list/detail 200; another permitted branch 404; foreign event under owned branch 404. Source controls establish view-only reading. [Decision 25](../architecture/ARCHITECTURE.md) records current ownership. | Complete for the named seam. Future Stage B offline ownership remains undecided and outside this proof. |
| Structure-only restore | R8 main [run 38307445025](https://github.com/vickyydev/oto-platform/actions/runs/38307445025) passed the full restore/replay: 184 source tables/1108 rows, 76 platform and 11 app migrations, 187 resulting tables/five views, identical counts/journals and scratch cleanup. Final feature main [run 38309414401](https://github.com/vickyydev/oto-platform/actions/runs/38309414401) also passed restore/replay. | Complete for the recorded release gates. |
| Compiler and CI | Main 2850d89178232f421fbea18cbc4ea583cf3c1910 passed all six jobs in [run 38374525197](https://github.com/vickyydev/oto-platform/actions/runs/38374525197): 4,033 API tests, 32 scheduling controls, 89 feature controls and 30 browser checks; workspace/API zero; app 442 diagnostics/59 files/118 buckets unchanged; build and hosted restore/replay complete. All six services are live through app 0015. | Complete for this source. Preserve the 457 ceiling and named limits. |
| Desktop/tablet and cleanup | Named rounds 5-7 actions, tablet frames and feature evidence; [cleanup](../qa/oto-app-lift/round-8/cleanup.md) removed 297 content rows, ten files, seven parent rows and two sessions with exact absence checks. | Preserve each named scenario limit. SCRUM-523 has a separate completed manifest: 13 records and one session removed, with final former-session 401. The later Som fingerprint observation is recorded without a cause or unchanged-after-cleanup claim. |

Settings, Activity, Attention actions, Directory HR and the POS seam are complete for the named cases in [platform controls](../qa/oto-app-lift/round-7/platform-controls.md). Current Health/Failures evidence is indexed in [jobs recovery](../qa/oto-app-lift/round-8/jobs-recovery.md). The completed department action and its exact two-row cleanup are recorded in [organization evidence](../qa/oto-app-lift/org-hr-verification.md).

SCRUM-191 and all twelve children are Deployed. The separate OPEN_ITEMS fix block begins with SCRUM-276; SCRUM-223 stays paused. Preserve all named module limits and the later unattributed Som observation.
