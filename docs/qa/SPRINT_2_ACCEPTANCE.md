# S2-17b OTO App acceptance index

SCRUM-193 is **In Progress**. This index tracks the [S2-17b acceptance contract](../progress/SPRINT_2_PLAN.md#s2-17b--the-whole-live-oto-app-lifted-every-module-working-on-render-against-otoapp-pos-seams) against the [closure plan](oto-app-lift/closure-plan.md). It is a checklist of evidence still needed, not a claim that the full live app has passed on staging. **WORKS** means the named, narrow behavior has direct staging proof; **Testing** means the module exists but its complete staging walkthrough is open; **BROKEN** means a required multi-tenant contract is known to be unsafe; **NOT BUILT** means a required platform integration is absent. A signed-in page-entry image alone does not prove an action or access rule.

For each Testing module, record one real staging write or action and resulting state, one relevant denied role/branch/tenant case, and a named screenshot or test-run card on its Jira ticket. Check empty, loading, error and park-tablet states where they affect the flow. The [signed-in screenshot register](oto-app-lift/staging-screenshots-2026-09-30.md) identifies entry captures already attached; the linked module notes distinguish local checks from staging proof.

| Module | State | Current evidence and next staging proof |
| --- | --- | --- |
| **Identity and people** | | |
| Launcher sign-on | WORKS | The administrator entered Today through one suite sign-on; [staging capture](oto-app-lift/staging-screenshots-2026-09-30.md). Verify additional roles during module walks. |
| Users and permissions | Testing | [Local access checks](oto-app-lift/org-hr-verification.md) passed; create/change access on staging and prove a lower-role refusal. |
| Organization: branches, departments, operators | Testing | [Local access checks](oto-app-lift/org-hr-verification.md) passed; save each on staging and verify cross-branch/tenant isolation. |
| HR employees | Testing | [Local HR checks](oto-app-lift/org-hr-verification.md); create/edit an employee on staging and verify a denied branch read. |
| Contracts and e-sign | Testing | [PDF and scoped-storage checks](oto-app-lift/contracts-pdfs.md) passed locally; sign on staging, open the stored PDF through scoped access, deny another session. |
| Contract templates | Testing | [Existing local browser checks](oto-app-lift/contracts-pdfs.md); save a template and generate its result on staging. |
| Policies | Testing | Entry screen only in the [local route scan](oto-app-lift/module-entry-smoke.md); publish/read and deny an unauthorized edit on staging. |
| Letters and e-sign | Testing | [PDF storage check](oto-app-lift/contracts-pdfs.md) passed locally; sign a letter and open its scoped PDF on staging. |
| Employee documents | Testing | [Upload/download/delete check](oto-app-lift/employee-documents.md) passed locally; round-trip a document on staging and deny another employee path. |
| Assets | Testing | Present in the lifted app; create/assign/return an asset on staging and verify role/branch limits. |
| Offboarding | Testing | [Local departed-account check](oto-app-lift/org-hr-verification.md); execute an offboarding action on staging and verify resulting access. |
| Org chart | Testing | [Local route entry](oto-app-lift/module-entry-smoke.md); change an employee relationship and verify the chart on staging. |
| Activity log | Testing | [Local route entry](oto-app-lift/module-entry-smoke.md); generate a trackable action and verify visibility and restricted access. |
| **Attendance and operations** | | |
| Kiosk devices and reception | Testing | [Kiosk security proof](oto-app-lift/README.md) and [camp reception checks](oto-app-lift/events-camps.md); complete a configured-device action and unauthorized refusal on staging. |
| Face, PIN and phone clock policy | Testing | [Kiosk and PIN-evidence checks](oto-app-lift/files.md); verify each enabled clock method and evidence access on staging. Face enrolment depends on the owner decision in [closure plan](oto-app-lift/closure-plan.md). |
| Timekeeping | Testing | [Local HR checks](oto-app-lift/org-hr-verification.md) and [PIN-evidence review](oto-app-lift/files.md); record/review a shift on staging and deny another branch. |
| Scheduling | Testing | [Existing 16-check batch](oto-app-lift/scheduling.md) passed locally; publish a rota and verify My Shifts on staging. |
| Leave and holidays | Testing | Present in the lifted app; submit/approve leave and verify a holiday conflict and denied role on staging. |
| Tasks and ops board | Testing | [Existing local batch](oto-app-lift/tasks-checklists.md) passed; create/complete a task and check assignee/branch visibility on staging. |
| Checklists and media | Testing | [Existing local batch](oto-app-lift/tasks-checklists.md); complete an item with media on staging and deny an unrelated record read. |
| Announcements | Testing | Present in the lifted app; publish/read an announcement and verify audience/branch filtering on staging. |
| In-app notifications | Testing | [Tenant-scoped routes](oto-app-lift/notifications.md) deployed and [empty panel captured](oto-app-lift/staging-screenshots-2026-09-30.md); create/read a notification in two tenant contexts. |
| Attention engine | Testing | [Local route entry](oto-app-lift/module-entry-smoke.md); trigger an attention item and verify its assignee/result on staging; job ownership is an open platform gate. |
| Fix reports | Testing | [Scoped report and media checks](oto-app-lift/files.md), including a positive staging submission and decoded image; attach named screenshot and prove wrong-branch/tenant refusal on staging. |
| Supplier portal | Testing | [Local token, image, comment and close probe](oto-app-lift/supplier-portal.md); perform those actions through a staging link and capture the result. |
| **Park, events and check-in** | | |
| Events core | Testing | [Existing local event checks](oto-app-lift/events-camps.md); create/edit an event on staging, verify branch scope and POS view once supplied. |
| BEO | Testing | [Local PDF render](oto-app-lift/contracts-pdfs.md); create a BEO and open its stored, scoped PDF on staging. |
| Packages and menus | Testing | [Existing local set-menu check](oto-app-lift/events-camps.md); save a package/menu and verify the BEO result on staging. |
| Camps and children | Testing | [Existing local camp checks](oto-app-lift/events-camps.md) and [live photo route probe](oto-app-lift/files.md) cover a disposable registration, lookup, kiosk roster and other-branch photo refusal; complete the signed-in camp/children UI and attendance actions with named screenshots. |
| Parent portal and RSVP | Testing | [Local invitation and concurrent RSVP probe](oto-app-lift/parent-invitation.md); generate a staging invitation, RSVP and verify denied/invalid link. |
| Drop-off and staff check-ins | Testing | [Local end-to-end check](oto-app-lift/checkins.md), [branch guard](oto-app-lift/branch-checkin-access.md), and a positive staging public submission/photo view in [media notes](oto-app-lift/files.md); capture named result and staging cross-branch refusal. |
| Nanny booking | Testing | [Local duty/conflict probe](oto-app-lift/nanny-booking.md); assign, reserve and change status on staging, including a conflicting reservation. |
| Public drop-off form builder | Testing | [Published-form local check](oto-app-lift/checkins.md); publish a changed form, submit it publicly and verify persisted answers on staging. |
| Staff vouchers | Testing | The OTO App intentionally shows the Console handoff in the [route scan](oto-app-lift/module-entry-smoke.md); verify the central Console ledger and till redemption as the one active contract. Legacy rows are read-only history. |
| **Knowledge, administration and finance** | | |
| SOP and Find | Testing | [Scope and navigation notes](oto-app-lift/sops.md), with an empty staging entry capture; publish an SOP and prove staff/branch visibility. |
| Knowledge Base and files | Testing | [Scope and file checks](oto-app-lift/knowledge-ask-oto.md), [generic-file closure](oto-app-lift/files.md), and empty staging entry capture; publish, read and deny another branch's article/file. |
| Training and quizzes | Testing | [Local attempt/completion/authoring probe](oto-app-lift/training-quiz.md) and empty staging captures; save a module, pass/fail a quiz and verify completion. |
| Ask OTO and AI helpers | Testing | [Scoped source/thread notes](oto-app-lift/knowledge-ask-oto.md) and empty entry capture; obtain a sourced answer, inspect an inaccessible-source refusal and verify effective AI configuration. Persisted titles need a platform migration only if required. |
| Casual workers | Testing | [Manager/branch/date controls](oto-app-lift/casual-workers.md) and zero-row staging capture; create a worker, verify rate/status and lower-role refusal. |
| Payroll | Testing | [Local exports/payslip object and UI checks](oto-app-lift/payroll-files.md); generate/download on staging and deny a staff account another run's file. |
| Xero sandbox | Testing | [Admin-only finance guard](oto-app-lift/finance-access.md) and unconnected staging Analytics capture; complete a sandbox exchange and staging staff refusal once configured. Production Xero is excluded. |
| Vault | Testing | [Local seal/reveal and scope probe](oto-app-lift/vault.md), zero-row staging capture; save/reveal an item with audit evidence and deny wrong role/branch. Do not capture credential content. |
| Directory API | BROKEN | Existing routes lack tenant-bearing identity; [contract review](oto-app-lift/directory-settings.md). Platform contract first, then same-tenant results and cross-tenant refusal. |
| Data Admin | Testing | The credential-model exclusion is **WORKS** with three named staging screenshots and API checks, [SCRUM-466 evidence](oto-app-lift/data-admin.md); operator-admin denial and wider registry review remain. |
| General files and private media | Testing | [Object-path, Fix, profile, check-in and KB slices](oto-app-lift/files.md) have local/staging checks. Camp photo access has positive and denied live route proof; PIN, checklist/checker, checkout and task ownership still need positive staging reads and named UI images. Existing raw and new signed check-in photo links remain valid indefinitely. |
| Settings | BROKEN | Global key storage is not tenant-safe; [contract review](oto-app-lift/directory-settings.md). Additive platform migration and legacy-key cutover first, then separate-tenant reads/writes. |

## Cross-module release gates

| Gate | State | Proof required |
| --- | --- | --- |
| Object storage and PDFs | Testing | [Local PDF checks](oto-app-lift/contracts-pdfs.md), [employee-document checks](oto-app-lift/employee-documents.md) and [payroll checks](oto-app-lift/payroll-files.md) exist. On staging, sign contract and letter, generate BEO, open only through scoped short-lived access, reject unauthorized reads, and verify the object-store round trips. |
| Scheduled jobs and Health/Failures | NOT BUILT | Platform-lane job-run/advisory-lock ownership and Health/Failures visibility are required. Show two last-success times and one forced failure in named staging evidence. |
| POS read seams | NOT BUILT | Platform-lane `otoapp_v.events`, `otoapp_v.employees` and `otoapp_v.children`, plus a POS read test against the views and no direct OTO App table reads. Record check-in ownership alongside POS S2-13. |
| Structure-only restore rehearsal | NOT BUILT | Platform-lane CI script restores the sample into a scratch database, renames the schema and checks row counts. Do not call CI green without a run log. |
| Final desktop/tablet pass | Testing | Every module's action, denial, empty/error/loading state and park-tablet interaction need a recorded pass; named staging screenshots must be attached before a child or SCRUM-193 moves to Deployed. |

The platform requests are tracked on SCRUM-193 and in the [closure plan](oto-app-lift/closure-plan.md). Current positive staging screens and attachments are in the [screenshot register](oto-app-lift/staging-screenshots-2026-09-30.md); they should not be relabelled as full module acceptance.
