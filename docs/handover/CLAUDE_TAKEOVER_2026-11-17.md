# Claude takeover handover - 17 November 2026

## 1. Authority: read and study first, then obtain approval

The owner requested a complete handover so the next session can **read, study and verify**, explain the current state and propose the next work for approval. **Do not automatically resume a queue, repair CI, run tests, deploy, send messages, create payments or change real staff/settings.** The approved feedback round is closed for owner review. Deployed is not final owner acceptance; never move tickets to Done based on this document.

This consolidates repository evidence and dated checkpoints. It is not a fresh whole-product acceptance run. Newer governing notes supersede older pending/broken statements, but do not erase original failures or coverage limits. Read-only snapshots below were collected on 17 November 2026 around 13:56-13:58 UTC. No feature, test, deployment or staging mutation was performed for this handover.

Read in this order:

1. AGENTS.md, then the newest resume note in docs/handover/CODEX_HANDOVER.md.
2. Newest docs/progress/STATUS.md block: operational state wins over older plans/queues.
3. docs/progress/OPEN_ITEMS.md: defects, owner rulings and remaining holds.
4. docs/progress/plans/super-admin-console/PLAN.md, then docs/progress/plans/otoapp-lift/PLAN.md, as required by AGENTS.
5. CLAUDE.md governing header and CONTRIBUTING.md. Consult docs/briefs/OWNER_DIRECTION.md and PROJECT_CONTEXT.md for product decisions.
6. This document, CLOUD_HANDOVER.md section 2, then the relevant evidence and plans cited below. Recent plans are docs/progress/plans/takeover-2026-11-13/PLAN.md, codex-till-round/PLAN.md and tom-feedback-20261116/{PLAN.md,owner-decisions.json}.

The owner's 14 November workflow ruling superseded older CI-wait/main-red release blocks for already approved delivery: meaningful local gates and source review, normal landing, immediate explicitly named staging deployments, bounded proof/cleanup, CI watched/repaired in the background. “Force push Render” meant trigger a Render deployment, **never force Git history**. The current read-only owner-review halt prevails; historical delivery authority does not authorize another unit now.

## 2. Current source, runtime and unresolved hosted CI

Main inspected before this documentation handover: **382080a5e3d01eb6c2006a3f43a3572c2757bbb8**. Previous closeout evidence push: **1b772c8e6697da237823d5c34ac1c77702064436**. Live app/API/Inbox/Console product: **0bc4be94abdbf982c3a06146062e96f0bb7b28fb**. After 0bc through 382, only the reviewed every-field test fixture and proof/docs changed. The takeover commit is documentation only; its full SHA is supplied in final delivery and the Jira 993 handover comment. Fetch/read Git before assuming any cached SHA remains latest.

Latest named Render deployment entries were independently read:

| Staging service | Full SHA | Deployment | Status |
|---|---|---|---|
| oto-app-staging | 0bc4be94abdbf982c3a06146062e96f0bb7b28fb | dep-dbtkmkuc6qcc73c0pvl0 | live |
| oto-api-staging | 0bc4be94abdbf982c3a06146062e96f0bb7b28fb | dep-dbtkmljl550s73disbng | live |
| oto-inbox-staging | 0bc4be94abdbf982c3a06146062e96f0bb7b28fb | dep-dbtkpd9srm7s73eh64a0 | live |
| oto-console-staging | 0bc4be94abdbf982c3a06146062e96f0bb7b28fb | dep-dbtkpdu1egvs73b8989g | live |
| oto-pos-web-staging | 20c34493fb0aa2d0c33d98df9f6b6053cfc56d94 | dep-dbtjk28m7kps73b6ehk0 | live |
| oto-pos-staging | 20c34493fb0aa2d0c33d98df9f6b6053cfc56d94 | dep-dbtjk1psrm7s73edpu8g | live |
| oto-launcher-staging | 10e73db6c446226e60ae5e8979236ac6d5b351b1 | dep-dbtik968bjmc73fpg5a0 | live |
| oto-radar-staging | 608b1fd1ae6b95113cb4d353d5a96304bfd1c560 | dep-dbckuuss728c73fd0dtg | live |

These are service identity/status reads, not fresh user journeys or configuration acceptance. Booth and physical hardware were not queried. Latest rollout started app and API together, then Inbox and Console after exact API LIVE. Do not redeploy unrelated services just to make their SHAs equal.

**Hosted CI is red. No all-green release claim is made.** Workflow .github/workflows/ci.yml ignores docs/** and imports/** for push/PR triggers. No run is returned for docs-only 382; absence is not a pass. Nearest code/test-bearing checkpoint 1b772 has completed run **43934499470**:

- Main ci, POS and API shards 2/3: success.
- App job **133539411086** fails “The app's AI fill corrections checks”, command npx tsx tests/beo-fill-corrections.check.ts. Fifteen of 18 checks pass. choicesFromTheChatAreNotSelectionsReceived lacks the expected chat-recorded pizza choice; theDepositBoxSaysTheDepositTheBeoAsks gets 409 from stale-review protection; theToastNamesOnlyWhatWasWritten returns broad fallback Saved text instead of kitchen-only. The 409 is consistent with freshness protection, but these causes are **not reproduced or established here**. Do not label all three harmless stale fixtures or product regressions without investigation.
- API shard 1 job **133539411549**: one failure, 2520 passes, 106 skips; 178 files pass, one fails and two skip. test/s220-e5-review-2.test.ts:756, D1 replay-store route census, expects assistant asks and event check-in only, but also receives POST /accounts/:id/inbox-access/preview and PUT /accounts/:id/inbox-access. This demonstrates exact-inventory drift after the approved access routes. A correct replacement still needs actual guard inspection and whole-file reproduction; no assertion changed here.

Original 0bc run **43929126898** also completed failure: app every-field, main Test and API1 failed; POS/API2/API3 passed. Its app fixture was repaired as test-only main source **ffde7d155b8035b53072a9e0e020db913e9c07ac** (original lane 4af191b6). The whole 10-case file passes on exact 0bc product: informational paid:true preserved, notWritten.deposit.reason=chat_claim, no requested/received amount/date write, stale 409/no mutation, fresh review before second approval. Original CI RED and first local 9/10 RED remain with final 10/10 GREEN. This does not prove the later corrections suite passes.

**First proposed next task, subject to owner approval:** bounded triage of the two 1b772 failures. Do not repair/rerun/dispatch on takeover. Snapshots/excerpts are under docs/qa/proof-2026-11-17/claude-takeover/: ci-status-snapshot.json, ci-failure-fingerprints.json and the two job-*-bounded-failure.txt files. Raw remote logs were not committed. Historical hidden watcher PID 129340 targeted docs-only 382 for 110 minutes; do not assume it is still running. No new watcher or CI wait was started for this docs-only handover.

## 3. Project concept, stack and navigation

OTO is a multi-park operations platform for admission/wristbands, members/guardians/children, F&B/shop, parties/BEOs, drop-off/care, staff operations/payroll, unified messaging, administration, reporting and booth games. It rebuilds/lifts the approved prototype and existing OTO App; preserve existing approved behavior rather than inventing business rules. Cloud is system of record, station box system of action and iPad/browser the screen. Simulator/offline adapters do not establish physical acceptance.

Repository: https://github.com/vickyydev/oto-platform. Node 22, pnpm 10/Turborepo, TypeScript, Fastify 5, PostgreSQL 16/Drizzle, React/Vite, Linux/Raspberry Pi box agent. apps/oto-app has an independent npm lockfile/toolchain and migrator; it is outside root pnpm/ESLint coverage. Radar is another lifted surface. API/shared schemas, generated API contracts and UI wrappers must agree.

Code map: apps/api platform service; apps/pos desktop/phone till and display; apps/console administration; apps/inbox unified Inbox; apps/launcher sign-on; apps/oto-app staff app/BEO/payroll; apps/radar. Shared administration is packages/admin-screens; schemas/contracts packages/shared and packages/api-types; schema/test DB packages/db; Inbox AI includes packages/assistant. docs/features/ contains pos, console, inbox, oto-app, oto-inbox-ai, oto-radar, booth and qa-assistant maps. These module specifications are not fresh proof every feature works. docs/architecture/ covers topology, devices, offline, pricing and payment design; docs/README.md indexes the wider archive.

imports/ is local reference only; never commit raw exports. Do not commit services/ or .env. Credentials/sign-ins remain in existing local env/seed/helper mechanisms; use locations and variable names only. Never print passwords, tokens, PINs, database URLs, box secrets, recipient numbers or sandbox join codes. No attribution trailers or commercial-arrangement names in history/files.

## 4. Working process and environment

Canonical delivery worktree: **C:/oto-lanes/tom-feedback-coordination-20261116**, branch lane/tom-feedback-coordination-20261116. Desktop C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos is the helper/environment entry point and an **older local main checkout**, not the current delivery source. Do not reset it to tidy history. Local work/oto-decisions/ contains completed publication/runtime helpers with canonical receipt paths, not a queue to execute.

Use isolated lane worktrees under C:/oto-lanes. Before later authorized landing, read newest state/slot, fetch/rebase, ground-truth the own commit list, resolve without blind continue/skip, commit explicit files and push normally. No force push, reset/clean or blanket deploy. Same-push Jira status check/comment and inspected staging evidence are required. Keep Deployed pending owner acceptance.

Docker stays **off**. API/DB tests use packages/db/src/testing embedded PostgreSQL. App checks use a fresh migrated app schema and drop/stop their own server. One heavy DB/compiler/build at a time. Read compiler output whole; platform API requires zero diagnostics. App ratchet is **413/413 in 54 files**, tightened from historical 418; never restore 418 as headroom. Root lint excludes app files: use appropriate forced/scoped accounting with no introduced errors. Never use vitest -t on serial suites or weaken timeout/assertion gates. Current takeover does not authorize test execution.

Migration chains are separate and immutable once applied. Current platform journal ends 0127_party_additional_bills, 0128_inbox_access, 0129_party_bill_fk_indexes; app ends 0050 historical view, 0051 SET-audience provenance, 0052 BEO bar-charge provenance. Platform 0125 is retained-deposit reliability, 0126 prebooking. New lanes use provisional numbering, reconcile journal/snapshot against landed main and compare SQL identity when renumbering. 0129 intentionally adds indexes instead of editing applied 0127. Older numerical baselines in plans are historical.

Helpers: scripts/agent/jira.mjs, render.mjs, watch-ci.sh, evidence.mjs; env loading stays private. Render operations use explicitly named staging services/full SHA, never all, production or the QA worker. Automatic deploys can race an ordered rollout; record actual before/after runtime. Repository automated tests are distinct from UI-control automation; follow the next environment's browser instructions. No UI mutation, test or device operation is part of this takeover.

## 5. Earlier audit and till round

SCRUM-985's 13 November takeover preserved and reconciled prior work. docs/qa/takeover-2026-11-13/ contains AUDIT.txt, ticket-census.json, open-work-assessment.json, jira-reconciliation-receipt.json and checkpoint-preservation.json. The historical report covers 784 tickets and 75 remaining-item assessments: ticket traceability/targeted code/proof inspection, **not fresh acceptance of all 784**. It reported 639 Deployed tickets with naming source/tool/workflow commits, images on 679 of 682, related-ticket proof for 205/211/303, and 40 staging images without byte-identical current tracked copies plus three intentionally archived production images. Reconcile Git/renames/encoding/local originals before calling proof lost or revoking delivery.

Approved order: 979 -> 977/975 -> 978/976 -> 982/scoped981 -> stage3 (844/983/relevant945/966/968/910), then owner review. Recorded outcomes:

| Unit | Recorded delivery | Current live Jira |
|---|---|---|
| 979 API recovery | 0ea85faaf5b4e62204eaabdda5d691dd2b9a248c, API dep-dbrevcgu01pc73b1vjp0; 406 tests; simulator card once, real waiting-tender Health count, exact VOID/fixture/session cleanup. docs/qa/proof-2026-11-13/SCRUM-979/. | In Progress for other points/holds. |
| 977 plus scoped975/979 | Till 239ef48248d7ec1af739f432db7c91dda778c2c0; 733 tests/50files, POS types/build/lint. Native rotation retained form/cart, reconnect resent same action ID, real simulator refusal reason survived reload; Cancel voided. Devices/display/sessions retired. SCRUM-977/README.md and jira-proof.json. | 977 Deployed; 975/979 In Progress. |
| 978/976 | App 1916bfbd73ebcfcba2dbe85c7a7a9d2bf63e9152, dep-dbrabs2vcj2c73emo4eg; 23 preserved images inspected, fresh third AI read retained Different-for-adults and coded adult EXTRA, privacy and interrupted-fixture cleanup. SCRUM-978/README.md distinguishes WORKS/PARTIAL/BROKEN then. | 978 Deployed; 976 Testing; 966/968 In Progress. Later983 fixes named defects, not all held pricing. |
| 982/scoped981/964 | 3e29803bf0d2c935a9a0c23f76c60c4182bcc104, six-job CI43489637902; 3902 POS tests/274files, seven built-browser and eight fresh native staff-handover cases across ticket/F&B/shop/phone. True tender/seller retained, no duplicate sale, cart correction possible. Evidence 3ba37114323fb1daa752b4bf831ee512b9890e51; SCRUM-982/native-jira.json and jira-proof.json. | 982/964 Deployed; 981 In Progress. |

982 cleanup recorded seven final paid refunds totalling 492500 satang, two unpaid voids, six old/final stations, both displays, simulated terminal and both synthetic staff retired, no active sessions. Older memory saying only one native case passed is superseded by the later checkpoint; do not rerun an already-closed matrix.

The 11 November codex-till-round plan's eight units now have Deployed status: (1)800/801 phone Pay/Back/Cancel and 375px; (2)809 reused receipt prefix; (3)802 History and783 shown/staff phone labels; (4)807 Golden Ticket drop-off; (5)819 paired display false Offline; (6)778/781/810 login retry storm; (7)784/785 SOP/model checks; (8)748 browser photo/video upload queue. Detailed dated proof is in CODEX_HANDOVER and docs/qa/proof-2026-11-11/. This fresh status read is not re-execution. 953 remains Testing; recorded local party-layout proof is not new native acceptance.

Preserve CODEX_PAUSED_2026-11-04_S747_746.md and scanner/till-code branches as historical recovery records. Live736/746/747 now read Deployed, so old paused memory does not authorize resumption; physical acceptance still needs its actual evidence. SCRUM-223 remains In Progress with the bench/Pi/gate story explicitly frozen.

## 6. Stage3 BEO/money: scoped fixes and remaining holds

Original local source-only audits: C:/oto-lanes/audit-takeover-20261113/beo-stage3-audit.md, beo-stage3-partition.md and deposit-910-audit.md. These proposed faults/ownership; later committed proof supersedes their incomplete-state statements.

- **844:** historical 14 November app c3186fee7ab0ea034a8adefc8da90e6c23a2eced / dep-dbronrs9v7es73ch6s30 proved requested-vs-received legacy handling and fresh staff confirmation. **Final988 supersedes that AI receipt-application behavior:** paid claims now informational across structured/legacy/fallback/Fetch; direct manual Billing/hydration unchanged. 844 stays Deployed, cross-reference14865 covers only this path. docs/qa/proof-2026-11-14/SCRUM-844/README.md is historical, not current permission to apply AI-paid money.
- **910 +966point2:** owner ruled full refund returns till-taken money only; original deposit stays with the party for later settlement. Returned historical money cannot be credited again; zero-money closure cannot invent a positive refund. API/Console d37ea80c25448a9d796a4632f7f04674e27be3f9, tills5bf409ee4198fa72d0d55a2b400aff5b29a69ca5. Whole/partial/repeated settlement, zero closure/replay/replacement, exact engine named-extra contribution and receipt conservation proved. Original five-sale cash29800in/out netzero; separate fresh zero-cash phone case. Exact fixtures retired/history retained. Lost old cookies were unavailable: exact retirement, not old-cookie401, was claimed; fresh sessions401. 910 Deployed comment14768/images13530-13534;966point2 comment14770/images13535-13537. SCRUM-910/{README.md,staging-results.md,financial-reconciliation.json,jira-staging-proof.json} under14November.
- **983/scoped968:** app7455bb8adf83f1466c2baab178ece6e72a840958 / dep-dbs280rbc2fs73acbtgg;135backend,54frontend,23review pins, app413/413/build. Native text2 increment became3, missing quantity1, real PDFs no nullx, persisted park date survived Honolulu browser clock, adult line/switch retained. Event archived, old parent GET/POST404 after rotation, sessions401. Mixed tickets remain In Progress. SCRUM-983/{README.md,validation.json,independent-source-review.md}.
- **945/981point9:** forward-only0051; e4e7bca46d5cb20ba5333af17887107f23c0be78 / dep-dbs2kod6e07s738lfh3g. Genuine kids-only SET preserved; same-name kids EXTRA cannot relabel base SET; adults retain own count/code. Actual till/API41158d2310ba4776dc2e1d03e435a8716d76556c.71combined checks +4release pins and actual migratedSQL controls; cleanup complete.945 comment14788/images13553-13555;981 comment14789/images13556-13558; both In Progress. SCRUM-945/{README.md,jira-staging-readback.json}.
- Scoped966/945 slip and983/968 reliability partitions are complete in the14November checkpoint, not full-ticket closure. Historical review-fingerprint-only maintenance39f02c58d8e7c5c7970b0841e6f025fa58fcd034 passed65/65 locally; comments14793/14794/14795 in SCRUM-983/ci-storage-pin/jira-final-repair-readback.json. Do not turn then-pending CI into a green claim.

Remaining holds include historical adult-menu interpretation, Q17/Q18, kitchen-required/after-settlement rules, holiday/coded-item exposure, TEXT-price normalization, shared End-of-Day composer, service-inclusive pricing and other numbered choices. Read matching plans/current behavior before asking; never silently choose a rule or rewrite historic charges. 966point6 was later resolved only by990 separate bills; comment14866 leaves966 In Progress and all other holds intact.

## 7. Maria's read-only pricing findings

Primary local report: C:/oto-lanes/audit-takeover-20261113/maria-modifiers-tax-audit.md, with maria-tax-runtime.json and a small engine check. Verified13November, not re-read today; no source/catalogue/settings/Jira/sale mutations and no broad pricing acceptance suite.

At that audit, Central Floresta **staging** had7%inclusiveVAT/0%service. Enter200 -> customer pays200, VAT13.08/net186.92 separated. Hypothetical8%service is additive ->216, not all-inclusive200. Automatic all-inclusive service was NOT BUILT at inspected source; numeric tax-rate overrides were unwired in the inspected sale path. Production/other branches were unverified. Do not implement a new pricing feature from this explanation.

Modifier weekday/weekend values are customer surcharges; Cost is internal. F&B Console exposes setup; engine supports shop modifiers but Shop editor did not expose it. Fixed prices require the same value in both editable boxes; clearing Weekend made zero, not inheritance. Recorded/offline sales retain their own tax snapshot. Explain later findings briefly with arithmetic, environment and date; do not generalize staging values to production.

## 8. WhatsApp sandbox, real proof and Tom's scope

908 currently reads **Testing**, not final acceptance. The integration reused one operator-wide General sandbox test line, not a new production line or inferred Birthdays/branch/team route. Only variable names such as INBOX_TWILIO_ALLOWED_NUMBERS_SANDBOX belong here. Contact numbers, join codes, credentials and provider/customer identifiers are intentionally omitted.

Recorded16November product d25f459d2e81fb3379d07b40aadc902ad212ccc7 was LIVE on API dep-dbtc51hsrm7s73ars0mg and Inbox dep-dbtc079srm7s73arfdfg. The owner confirmed a real incoming opening-hours question and the AI answer reaching WhatsApp; actual answered hours turn and READ outbound agree with source-bound provider/database receipts. Later the owner confirmed a real staff reply arrived: non-null staff author, providerREAD/noerror and aiState=person_replied bind STAFF_ACTED hold. No AI outbound followed in the bounded timeline. No later inbound challenged it; explicit Pause was not pressed. Neither a separate pause/re-entry journey nor an automated native staff screenshot is claimed.

Last configuration proof allowed only the owner and Tom as explicitly approved recipients. Tom's actual join/first incoming message remained unobserved. This pending external action is not permission to contact him, widen recipients or send an outbound test. Preserve the real owner/customer thread; synthetic cleanup never authorized erasure of it. Current credentials/allowlist were not re-read for this handover; verify privately/read-only if later requested.

Separate synthetic guard proof denied unknown senders with zero contact/conversation/message/AI-turn/send side effects, not real outbound acceptance. Seeded Reception403 remained an existing limitation; no grant was added. GenericSMS settings were preserved. Proof lives under docs/qa/proof-2026-11-16/SCRUM-908/: RESUME.md, runtime-ready.json, live-opening-hours-result.json, live-twilio-readback.json, staff-takeover-result.json, staff-ai-state.json, staff-provider-receipt.json, staff-tom-state-result.json, two-recipient-runtime-result.json and ci-repair-final-state.json. RESUME's earlier pending takeover wording is superseded by the later CODEX note. Attachment13559/comment14801 is historical backend/setup evidence. Do not dump files containing personal/provider IDs.

Earlier2048MiB API compiler OOM and app/compiler-capacity repairs retain original RED and reviewed4096MiB receipts. Those fixes do not prove all later hosted checks green.

## 9. Approved feedback987-993: implementation and recorded gates

Approval: docs/progress/plans/tom-feedback-20261116/{PLAN.md,owner-decisions.json}. Reusable BEO-only dishes and point3 separate post-settlement bills were explicitly approved. Multiple parties at the same park/date/start time are allowed with staff capacity checks; no same-slot/full-day exclusivity. Paid drafts never automatically reserve/create bookings.910 deposit retention remains. No new manual amount authority, initial real staff restrictions or production release was inferred.

All987-993 currently read **Deployed for owner review**. Counts below are named historical gates, not one fresh whole-system run.

| Ticket | Delivered scope | Recorded checks/proof |
|---|---|---|
|986 prerequisite|Unsent method/partial-cash input survives same new-sale write only with unchanged balance, no attempts/settlements and enabled method. Recorded money remains authoritative.|3920POS,7new regressions,11API,3compilers, original native file1/1. CI43897011630 green at10e73db6c446226e60ae5e8979236ac6d5b351b1. Served-bundle staging check is separate from new payment proof.|
|987|Full original gateway-confirmed requested deposit before explicit staff booking. Simulator labels; no autoevent. Same-slot parties permitted; one original receipt/credit, retry/concurrency safe. Current resource/park/action before cached replay.0126.|39inputs; original211API corpus194unchanged +17/17repaired, original210/211 retained;468Inbox;directory10/floor6/BillingUI11; types/build/schema/contracts. Two1-baht simulator payments created no events until staff Book date; both parties/chats archived, sessions401, histories kept. Initial productcaa85d054536b04bbb6afb02c776485195e28424.|
|988|Reviewed/source-labelled extraction; stale-save/manual preservation; unknown requests/prices unresolved. Paid claims informational through structured, legacy, fallback and Fetch; never received money/date/mark or a new asked amount from a paid claim. ManualBilling/hydration unchanged. Unknown shows retain time/notes without acts.|34appfollowup inputs/41fingerprints; D1DB7,receiptUI5,manual7,fill15,catalogue22,Fetch16,prefillUI14,FetchUI12;app413/413/54files/build; inheritedlint7->7/nointroduced. Separate every-field10/10 repair does not prove later corrections suite.|
|989|Reusable BEO-only dishes in proper Kitchen/Bar choices, outside ordinary POS selling. Plans/orders/preparation/payment remain distinct.|Native picker codes; saved prices separate. Cross-party reuse/boundary edges local coverage, not newly staged cross-party acceptance.|
|990|Extras explicitly linked to same party, not phone match. Separate post-settlement bills preserve old receipt; only new source-quantity delta charged. Durable retry/source checks; delayed callback updates both menu mirrors without overwriting newer edits.0127/app0052;0129FKindexes.|49settlement checks and recorded app/POS types/build/component gates. Two simulator additional bills1001satang each: first1000then1, second1001; replay same result. Five approved receipts total1694205satang, original receipt/11lines/main payments unchanged.|
|991|Saved quantity/unit selling price/total, explicit included/free vs unresolved, private costs. Parent confirms choices only, not charges.|Parent unresolved controls then saved quantity4 x10.01=40.04, same party/financial rows unchanged; old link404 after cleanup.|
|992|Per-viewer unread separate from next action; OTO contrast/selection, honest staff/queuedAI/actualshadow/sent/waiting states; failures, pause/takeover not hidden by stale turns. Ordering/routing unchanged.|465Inbox,10DB,13shared,12markup/types/build/lint. Live100row state census and actual waiting/AI-sent labels, masked theme view/no saved preference/no opened thread. Other edges local. Productea7212974dfdb8c2062cf34b2448859939ec406d.|
|993|Existing drawer category/channel limits intersect operator/branch/team/action scopes across direct/search/count/media/replay/AI context. FreshDB eachrequest, authorization before cached answers, versionCAS, ownoperator/platform admin exception, no branch-global write/no initial real staff grants. UI epochs/conservative equal-version cache/dashboard fence.0128.|46inputs/68logs plus9input/14log delta. Initial API417/422 then repaired wholefiles, not single greenbatch; DB61/61; actual129schema;seam10/10;6finalcompilerszero;admin197/Inbox477/Console671+3TODO/builds. Historical staticreview14pass/51runtime skips retained.|

993 native Console shows the **already retired** own account/default limits and preview/cancel without policyPUT. The labelled HTTP/DB card independently proves same-session category/channel revocation: direct detail/messages404, forbidden lists/search/count/dashboard/contact options gone, action capabilities unchanged; category restore permitted it again, channel revoke denied it.

Original manifests remain historical. Do not pretend46-input bindings match later roles/journal changes. SCRUM-993/ci-status-followup/repair/{delta-manifest.json,validation.json,prior-sql-baseline.json} binds the9-input delta,129 unchanged prior SQL files and128->129 lineage. App followup source review/logs are under SCRUM-988/followup/. Seam repairs use exact generated types, actual machine callers and reviewed hash/census changes, not weakened runtime types/assertions.

## 10. Final staging cleanup and published Jira receipts

Final988 attachments: docs/qa/jira-comments/attachments/SCRUM-988/{988-final-derived-review-ui-only.png,988-final-live-api-cleanup-card.png,988-final-staging-proof.json}. First image is explicitly reconstructed extraction-derived UI-only on actual live app, **not original-response replay or a new model run**. Separate fresh/minimal live API returned chat_claim, preserved original1-baht receipt/quantity4/existing requests/time/notes and refused stale409. Final retest made zero model/payment calls.

BEO final cleanup archived the exact party/thread, retired both BEO-only products, made old link404 and left no active own sessions, queued messages or pending device work. Original receipt fingerprint and two paid additional bills remain; financial/audit history, inactive products and parent selection are retained. The older additional-bill card said fixture retained for retest; **final988 addendum closes that retention**. Old review-current-proposed-source.png is20c diagnostic only, not final fixed proof.

993 attachments: own-account-inbox-controls.png, own-account-review-current-after.png, same-session-policy-test-run.png and inbox-access-staging-proof.json in its attachment folder. Role removed, account inactive/roleless, default limits restored, thread archived, sessionszero/oldcookies401. **One unarchived synthetic employee remains**, linked to inactive account, with synthetic contact/default policy/audit retained. No supported employee archive endpoint exists; no invented flag/SQL bypass. Do not claim all synthetic records deleted. No real staff grant/customer outbound/model/payment was created by993.

| Ticket | Final comment | Inspected attachment IDs |
|---|---|---|
|988|14860|13566 derivedUI;13567 liveAPI/cleanupcard|
|989|14861|13568Kids;13569Bar;13570parentprices|
|990|14862|13571linkedpaidbills;13572test-run|
|991|14863|13573parentprices;13574quantity4|
|993|14864|13575controls;13576review;13577same-sessioncard|

987 remainsDeployed with13563-13565/comment14839;992 with13561/13562/comment14825.844comment14865 keepsDeployed;966comment14866 keepsInProgress. Final382 documentation push has993checkpoint14867 readback verified; private desktop receipt work/oto-decisions/final-993-checkpoint.json. Canonical committed records: docs/qa/proof-2026-11-16/{final-jira-publication.json,final-publication-manifest.json,jira-feedback-cross-references.json}. Publication is complete: do not rerun helpers/create duplicate posts. All987-993 Deployed, neverDone.

Real merchant/bank acceptance, native POS additional-bill selector/mobile collection, physical printing/devices and fiscal issuance remain unverified. Some native crops clip prices/payment sections; separately labelled cards/API/financial fingerprints provide the named evidence, not invented native coverage.

## 11. Preserve local lanes; do not resume stale checkpoints

Selected metadata only: docs/qa/proof-2026-11-17/claude-takeover/worktree-snapshot.json. No tracked modifications existed in selected lanes at inspection; intentional untracked helpers/proof remain. Canonical old990watch logs and992screens are untouched. New takeover receipts were the only new canonical scope. Desktop main is older26c308ed..., not origin/main/current delivery.

- C:/oto-lanes/codex-inbox-feedback-20261116, lane/codex-inbox-feedback-20261116,2796fbae...: original993/final9-input repairf5cb00e...; equivalents landed already.
- C:/oto-lanes/codex-app-every-field-20261117,d7c9b00e...:4af191b6test/proof; mainffde7d155/011ea3070 already integrated.
- C:/oto-lanes/tom-beo-approved-20261116,d1084086... and local tools: integrated BEO/final988. Preserve untracked helpers; no archived-fixture setup replay.
- C:/oto-lanes/tom-deposit-gate-20261116,af355261...: integrated source, many retained local proof files/ledgers.
- C:/oto-lanes/codex-payment-handover-20261113,f7df3150...: earlier982 history, not currentmain.
- C:/oto-lanes/audit-takeover-20261113 is an ordinary preserved directory, **not Git**. C:/oto-lanes/takeover-preserved-20261113 holds bundles/harnesses. Do not delete them.

Some node_modules installations are junctions to another lane. Verify source/dependency identity before later authorized tests; never run new expectations on old product. Do not reset/clean user work, churn dependencies or delete retained audit/financial data. A clean tracked tree does not include ignored private scratch/environment state.

## 12. Remaining work is a proposal, not execution authority

Fresh52-key status receipt: docs/qa/proof-2026-11-17/claude-takeover/jira-status-snapshot.json; it is not a fresh784-ticket audit. Current key holds:908/953/976/985Testing;945/966/968/975/979/981/983InProgress;223InProgress/frozen.191 and679-684Deployed. Admin679-684 historical30October acceptance bound522294a737db2d10dd6a78d0756dd1ce498517e7/CI40972211455,66default nativeviews/653responses, explicit undeclared/unsupported-schema limits. Broader672-675/Q27/data-tool/banner/payment-kill-switch issues were outside that acceptance. See docs/qa/admin-console-repairs-2026-10-29.md and its plan.

Propose to the owner, after study:

1. Bounded CI triage for the two1b772 failures, separating route inventory, stale workflow and possible product regression; exact proposed whole-file checks/repair require approval first.
2. Prioritize mixed-ticket holds only after inspecting existing behavior/evidence. Do not invent rules or revive superseded paused work.
3. Distinguish proved owner WhatsApp inbound/AI/staff reply from pending Tom join/first message and untested hold-after-new-inbound/Pause. No unsolicited contact.
4. For real gateway/hardware/mobile/production requests, propose a bounded environment/credentials/side-effect/cleanup plan first. Simulator proof is not merchant readiness; financial history stays.

Use Sol for economical routine work if available in the new environment; do not assume Claude can select Codex models. No broad rerun, agent fan-out or new audit is required merely to understand this handover. Report what is current verified, older recorded evidence, uncertain/broken/not built, and the small next-task plan. Obtain owner approval before execution. The word takeover does not lift the owner-review halt.
