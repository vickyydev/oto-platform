# Hosted session handover — the platform lane

_For a Claude Code session running on a hosted (cloud) machine with a fresh
clone of this repository. It carries everything the local session knew that
is not already in the repo: where the work stands, the order of work, how
work is landed and proven, and the tools. Kept current at every landing._

## 1. Read first, in this order

1. `CLAUDE.md` (repo root): the standing brief. Sections 3, 7 and 8 and the
   header block are in force.
2. This file, all of it.
3. `docs/progress/STATUS.md` (top paragraph) and the newest blocks of
   `docs/progress/SPRINT_2_PROGRESS.md`.
4. `docs/briefs/OWNER_DIRECTION.md` (owner decisions; newest wins).
5. The plan of the story you are on (section 3 names it).

## 2. Where the work stands

**13 October 2026, R7a live writer and SMS service evidence:** The app is live on Render at `7402a8da2614214c41085277a86b0c4637abff66` (deployment dep-db6j2btg1s2s739gqjcg), after all jobs in CI38294258814 passed. The read-only staged census reports ten app journal entries through0009, with zero unplaced templates, policy documents, asset catalog entries or leave policies. The second park's new Data Admin asset writer returned201 with its correct owner; own read200 and another park's read404. Its exact ZZ TEST row was then removed204 and read back404. The inspected `r7a-document-writer-staging-20261013.png` records this prerequisite. R7b/0010 may now proceed through its release gate. Other recorded R7 acceptance rechecks and full fixture cleanup remain.

Twilio runtime status now reports configured=true, enabled=true, twilioConfigured=true and sessionSecretConfigured=true. The inspected `sms-provider-config-staging-20261013.png` records configuration only. The controlled receiving number is present in the local environment; no SMS has been sent. SCRUM-522 is now Testing with built source `cb27d078` in PR8 and23 focused controls passing. The feature itself is not yet live. Real receipt, code entry and verified family access remain release acceptance.

Updated source checkpoints: Fix PR4/a347b853 includes the captured-result compiler guard; SOP PR5/5924faac has16 passing controls and clear touched lint after R7 integration; attendance PR6/aeab3a23 has nine controls, actual multipart proof and its app CI step; presence PR7/f077aaea has eight controls and retains unconfirmed retry identity independently of browser clock. Attendance reviewer consistency is committed at01bf0fa5 with six real handler/database scenarios plus six house pins, pending integration and hosted checks under SCRUM-516. Original manager approval/history scope remains the existing explicit actions; its bounded consistency work continues separately.

The owner needs workstation memory: Docker may be stopped; all local DB checks have finished, their fixture databases were removed, and the coordinator's native15433 helper was shut down. Do not start local database processes or broad suites until the owner makes them available. Continue source integration and hosted CI. Main isd18d3fd8 with its full-SHA run38296316898 in progress; app/workspace/POS jobs passed at this checkpoint. Preserve test outcomes and label unrun or interrupted work honestly. SCRUM-223 remains paused.

**13 October 2026, published feature batches and SMS configuration:** R7a landed on main at `7402a8da2614214c41085277a86b0c4637abff66`; PR1 is merged with its individual commits preserved. Main CI38294258814 passed all six jobs. App deployment dep-db6j2btg1s2s739gqjcg has started on that exact SHA; runtime confirmation remains pending. Staging app remains633cae41, with app migrations through0008 last observed. No new live release is claimed.

Five feature batches are published and Testing: employee import PR3/db51ee5c; Fix preview PR4/3af75edd with its R7 canonical-person integration complete and seven focused controls; SOP history PR5/5924faac with 16 controls and all touched-file lint passing after R7 integration; attendance evidence PR6/9e79dacc with nine controls, actual multipart and browser checks; presence inbox delivery PR7/7c911c02 with eight real-route/database controls. Final migration numbering, combined release checks and staging proof remain. SOP R7 integration is complete; its provisional migration SQL is unchanged. Preserve applied migrations and R7a/new-writer/R7b release order.

SCRUM-522 returning-family SMS verification is building. The owner provided the three existing Twilio settings in the root environment; a read-only provider request returned200 with matching account/service and six-digit codes. Those settings are saved on oto-app-staging and their readback matches. The running instance still reports SMS unconfigured until an eligible deployment activates the saved settings. No SMS was sent. The owner authorized one controlled delivery test and will provide TWILIO_TEST_RECIPIENT in the local environment; do not copy that test-only setting into the service. Real receipt/code entry and saved-family read/write acceptance remain owed.

Original item7 is implemented by existing explicit manager Complete/Save Changes/Transfer Employee actions and actor/time history; no second approval stage is inferred. Its staged journey remains owed. Source review identified bounded attendance-reader and employee-history consistency work, recorded under SCRUM-516 in OPEN_ITEMS and the feature plan. Attendance integration preserves existing approval intent and the face switch. SCRUM-191/193/194/516/522 remain In Progress; SCRUM-223 stays paused.

**13 October 2026, R7a main release checkpoint:** the complete Linux gate passed in CI38291346882 on67eadb261f8220444dc2cfa336339aff0003425c, including all API shards and app ownership/migration jobs. Later source is identical; final API compiler output is zero bytes and six historical reruns passed228 controls. The older local full runs were stopped with partial logs preserved. R7a carries0009 and nullable document ownership; watch the actual landing SHA and observe new document writers on staging before R7b/0010. App633cae41 is still the last observed deployment. New feature lanes continue separately; detailed source and gate evidence are in newest STATUS.

**13 October 2026, visible feature batches:** draft PR1 R7, PR2 R8, PR3 employee import and PR4 Fix recipient preview are published. SCRUM-518 is Testing; SCRUM-517 still requires R7 canonical-person integration. SCRUM-519 SOP history and SCRUM-520 attendance attachments are locally built and in focused review. SCRUM-521 presence delivery is building for the staff in-app inbox, following the owner's Q3 answer. Preserve individual commits and publish frequent PRs with one coordinator. The newest STATUS block names exact source and verification; no new release is live yet.

**13 October 2026, development-first delivery:** Read the new [delivery board](../progress/plans/otoapp-lift/DELIVERY.md) for completed source by feature and ticket. The owner requested focused checks during implementation and consolidated release verification, with visible development checkpoints. Finish independent approved batches while existing checks complete; do not restart broad suites for documentation or repeat passing checks without a relevant change. R7 application development is on its published lane, R8 tooling is prepared separately, and SCRUM-194's seven original items are being reconciled into concrete implementation batches. Main/staging remain unchanged. Preserve R7a/new-writer observation/R7b/R8 order, the landing gate and exact cleanup. The newest STATUS block wins.

**13 October 2026, final build checks and nanny walkthrough:** The frozen API typecheck passed with zero diagnostic lines; all15 changed API test-file hashes stayed unchanged during that run. App production build passed including all three telemetry files. Forced lint covered all39 touched JS/TS files with zero errors,472 existing no-explicit-any warnings and no ignored files. The complete app compiler remains457 diagnostics/61 files, with no per-file/code increase. Six historical review files now preserve their original migration boundaries as0009 follows; source scans prune dependencies before descent. The full277-file API battery is still running, with focused historical, interrupted and timing reruns required before landing. These checks do not yet establish a green full battery.

Staging nanny assignment, entry and checkout each returned200 using the isolated ZZ TEST employee and disposable on-duty fixture; the Out screen showed completion. Issued drop-off photo200 without capability404; private signature own200/foreign404/anonymous401. Four old voucher addresses displayed the Console notice. Xero status200 connected=false, report400 and staff403; no sandbox connection or positive sync is claimed. Three additional inspected frames and module pages record these results. Exact cleanup remains owed. Main and live app remain unchanged; R7 is on its published lane. SCRUM-191/193/516 remain In Progress, SCRUM-223 paused. Next: finish/recheck the battery, landR7a and observe its owning writer, thenR7b and the staged ownership rechecks. No owner answer blocks that work.

**13 October 2026, round-7 release checks and drop-off evidence:** The final whole app compiler read measures 457 diagnostics across 61 files, down from the inherited 467. No file or file/code bucket increased; the final reader batch removed five more permission-context diagnostics. Applied app SQL and snapshots 0000..0008 are byte-identical to main; 0009 alone is new, and the four document ownership columns remain nullable for the first release. Platform migrations are unchanged.

The DB cleanup and POS header checks both passed their focused whole-file reruns (7 and 75 tests). Booth and box suites passed; box reports 740 tests. The full API battery continues. Historical round-4/5/6 migration/source expectations require their original release boundaries to remain explicit now that 0009 exists; the separate print timing check requires a focused rerun after the heavier work. Main remains a81fcb899e8376dd84bbe0bdf1320d3ce2d52368 with green CI 38240328400. R7 remains on its published lane, not deployed.

On staging app633cae41, the isolated public drop-off screen submitted200 and showed its success screen. The resulting age-five nanny registration appeared in its park's list only. Owned detail200; other-park detail, entry and nanny assignment each404. The inspected frame is r7-dropoff-submitted-tablet-20261013.png. It uses synthetic ZZ TEST guardian/child details, a labelled generated photo and a test signature. Nanny assignment/completion and exact new record/object cleanup remain owed. No owner answer is blocking the current release. SCRUM-191/193/516 remain In Progress; SCRUM-223 stays paused.

**12 October 2026, final round-7 reader and payroll review saved:** The coordinator recovered the saved lanes after service-capacity interruptions and completed the recorded correction batch. Integrated payroll review passed all24 checks; the seven prescribed ownership cases are now passing pins, including zero-value private exports and direct staff self-read controls. The form/home-branch review first recorded two expected failures, then passed all4 checks after the fixes: owned version saves, refused foreign replay, checked draft/published translations, owned home-branch selection despite historical foreign links, and missing-context refusal. Client saves now send the displayed version and refresh its translation cache. Source is local on lane/s217b-r7, not landed or deployed.

The current staging supplier test passed validate/detail/media200, comment201, close200, repeat409, revoke204 and former-link401; its inspected labelled card is committed. The isolated ZZ TEST form saved/published200 and its public read200 retained the English title; its inspected publication frame is committed. The builder's stored-label screen recheck remains owed after release. Exact fixture/object cleanup is still owed. Main remains a81fcb899e8376dd84bbe0bdf1320d3ce2d52368 with green CI38240328400; app remains633cae41. The previously completed whole compiler read was462 diagnostics/62 files with no per-file/code increase; the final reader batch's compiler/build is next. Platform typechecks passed, including API zero diagnostic lines. Local batteries passed the shared/print/telemetry/payments and Console suites; DB236 assertions and POS1365 assertions passed, with one DB cleanup deadline and one POS header navigation deadline requiring focused whole-file rechecks. Full API battery and remaining booth/box suites are next. Docker was reopened by the owner and its local5433 connection is verified; current checks finish on the shared local PostgreSQL16 instance at15433. All seven original SCRUM-194 items remain the working scope in its new coverage plan; only concrete behavior/provider questions remain. SCRUM-191/193/516 remain In Progress; SCRUM-223 stays paused.


**12 October 2026, round-7 review checkpoint published on the lane:** Main remains a81fcb899e8376dd84bbe0bdf1320d3ce2d52368, with CI 38240328400 green. This checkpoint is on lane/s217b-r7 for review; it is not a main landing or a deployment. Rounds 5 and 6 evidence and cleanup are complete. Ten inspected round-7 staging frames now record events, menus, parent/RSVP, camps, SOP, training, Vault, payroll exports and Fix on app 633cae416ff7e4a1c253ec4904cdc22351cf7df1. The walkthrough index records the exact actions and limitations. Camp attendance and payroll foreign-export cases remain BROKEN on staging until release and recheck.

Three approved isolated lanes continue: access/payroll delivery, independent payroll review, and restore/typecheck tooling. Finance imports, Xero placement, administration, people, camp, permission replacement and payroll file guards are built locally. The independent permission/private-photo recheck passed all 15 bounded pins against cf6c21a4884de26822fdc4a7bf03b34b99e569b7; shared-role question Q54 alone stands. Payroll review covers all 45 registrations and records seven ownership findings; prescribed parent/context guards are being applied together under SCRUM-516. No payroll calculation or existing salary advance was changed. R8 has 17 green tooling pins; its genuine final 11-migration restore rehearsal is running separately. The last access compiler measured 463 diagnostics, four fewer than the inherited 467; the coordinator still owes the whole integrated output and per-file comparison before tightening the ratchet.

Release order is R7a (0009, nullable document columns and new owning writers), then R7b (0010, document placement replay and NOT NULL) only after those writers are observed live, then R8. This protects the still-serving round-6 Data Admin writer during pre-deploy. Independent R7b rerun passed four migration pins, including nullable gate failure and successful retry/replay. Platform next migration remains 0076; staging app remains applied through 0008. Final integrated battery, typechecks, touched-file lint, rebase, main push, full-SHA CI and staged rechecks remain owed. Exact ZZ TEST record/object cleanup, including the shared practice park/user, remains owed before closure. SCRUM-191, SCRUM-193 and SCRUM-516 remain In Progress; SCRUM-194 remains To Do pending its existing scope decision, and SCRUM-223 stays paused. No owner answer is required for the current release work. After the lift, follow OPEN_ITEMS section 2 in its worked order.

Read the newest CODEX_HANDOVER resume note for exact continuation. The shared practice park/user and round-7 fixtures require guarded cleanup before closure. Preserve seeded accounts and Som's 14 October sick day.

## 3. Order of work (owner priority, 9 October - supersedes 2 October)

1. **Finish S2-17b**: land round 6 on its final recheck's MERGE (the lane
   state and deploy order are in section 2), then rounds 7 and 8 per
   PLAN.md section 8, each as a lane build-review cycle with the same gate.
2. **Then the FIX BLOCK**: every verified-open defect and small task, in
   the worked order of docs/progress/OPEN_ITEMS.md section 2 (money and
   safety first; pairings as marked). The owner ruled this comes BEFORE
   any new story.
3. Only then the next story (S2-18 Radar, S2-19 Inbox, S2-22 data,
   S2-23 Console, S2-16 acceptance; S2-24 bench when hardware time is
   scheduled - it is paused at the bench freeze, brief in AGENTS.md +
   docs/handover/CODEX_HANDOVER.md).

## 4. How behaviour is decided

- **The approved design is the prototype's code**, at
  `imports/oto-pos/artifacts/oto-till/src` (reference only, never committed;
  the setup script clones it, see section 8). Port its rules as they are,
  including its edge cases and its visible words and layout.
- The platform adds only data reliability on its own authority: the branch's
  own records, the branch's business day, real ids, money in satang,
  persistence, sign-in and permissions, audit, idempotency, offline boxes
  and real devices.
- Any other difference is a rule choice. Do not build it. Add it to SCRUM-497
  as a short question with the design's behaviour as the default, and keep
  building to the design.
- Where the design has nothing, the story's own acceptance criteria apply.
- Code comments state constraints only. Never describe earlier platform
  behaviour as a bug or a mistake.

## 5. How work is built and landed

- **Plan, build, focused review, fix, re-review.** Larger units use
  subagents or workflows, with an explicit list of files each one owns so
  parallel builders never edit the same file. Every subagent or workflow
  agent runs on `claude-opus-5-5`.
- **Before landing**, run these yourself:
  - `npx tsc -p tsconfig.json --noEmit` inside every package touched (the
    only trusted typecheck);
  - `npx eslint <every file landing>` from the repo root;
  - the relevant tests with `TEST_DATABASE_URL=postgres://oto:oto@localhost:5433/oto`
    (packages/db migration suites need `--no-file-parallelism`).
- **Migrations**: the next free number after main's highest (0054 is the
  latest on main), add-only, journal entry ordered after the previous one.
  Never edit an applied migration.
- **The landing list** is built by comparing files with `origin/main` by
  content, never from memory.
- **Landing**: on a working branch, `git fetch origin && git rebase
  origin/main`, re-run the checks, then `git push origin HEAD:main`
  (fast-forward). Another lane may also push to main, so always rebase first.
  If pushing to main is refused, push the branch and merge it with `gh pr
  create` + `gh pr merge --rebase`.
- **The progress update rides in the same commit**: a short checkpoint block
  at the top of `docs/progress/SPRINT_2_PROGRESS.md`, and section 2 of this
  file updated.
- **Commits** follow `CONTRIBUTING.md`: `type(scope): summary`, a bullet
  body, a `Refs: SCRUM-n` footer. No attribution or co-author lines of any
  kind. Write about the system, never about the commercial arrangement.
- **CI**: after every push, `scripts/agent/watch-ci.sh <full-sha>` in the
  background. A red run is diagnosed and fixed in the same turn, and the
  ticket is told plainly.
- **A problem found** is fixed now, or becomes a Jira ticket with its plan,
  or gets a workflow launched. Never only noted.
- **Answering "is X built?"**: read the code and drive staging. The three
  answers are WORKS, BROKEN or NOT BUILT.

## 6. Jira and staging evidence

- Helpers: `node scripts/agent/jira.mjs status|comment|walk|attach|images`
  (library functions in the same file, including `createSubtask`).
- Statuses go To Do, then In Progress (work starts), then Testing
  (committed), then Deployed (live on staging **with a screenshot**). Done
  belongs to the owner.
- **Same turn as every push**: a plain-words comment for a non-engineer
  (what a person at the park can now do; no file names or internal tools)
  and the status move. Re-read the status afterwards.
- **Deployed needs a staging screenshot** attached to the ticket and
  referenced in the comment, showing the change as a person sees it. Use
  `scripts/agent/evidence.mjs` (`posSignIn`, `card`). Open every image
  before using it. Commit the PNGs under
  `docs/qa/jira-comments/attachments/SCRUM-<n>/`. `walkTo(key,'Deployed')`
  refuses without an image.
- **Staging deploys do not follow main by themselves.** Deploy with
  `node scripts/agent/render.mjs deploy all <sha>`, then confirm with
  `node scripts/agent/render.mjs status`. The api's pre-deploy runs
  `pnpm db:migrate && pnpm db:platform-sync`. Sites:
  `https://oto-pos-staging.onrender.com`,
  `https://oto-console-staging.onrender.com`.
- **Staging data rules**:
  - name test records with the prefix `ZZ TEST`;
  - FWBooth1 is read-only;
  - never touch payment run 0d008153 or the package "Native payment adult
    ticket 0d008153";
  - never write the OTO App's `otoapp.*_checkins` tables;
  - never photograph identity documents;
  - never print, log or commit a secret.
- One-off database reads on staging: `node scripts/agent/render.mjs job
  "cd apps/api && node -e \"...one line...\""` (no `$`, no newlines, schema
  `core` for branches).

## 7. Open points waiting on the owner

- The consolidated ruling list: docs/progress/OPEN_ITEMS.md section 3
  (ticket rulings 481/482/485/428/434, SCRUM-497, the 277 remainder) and
  every plan's question list (lift Q1-Q54; benefits; events; analytics -
  Q3 blocks SCRUM-508's fix).
- Waiting on outside parties: Xero connection, 2C2P sandbox credentials.
- SCRUM-510 (flake cause-naming) is queued for the first hygiene lane of
  the fix block, not on the owner.

## 8. The hosted environment

- Setup: `bash scripts/agent/cloud-setup.sh` (also the environment's setup
  script). It installs dependencies, starts Postgres on localhost:5433
  (`oto`/`oto`), clones the design reference into `imports/oto-pos` when
  `PROTOTYPE_REPO` and `GH_TOKEN` are set, installs Chromium, and writes a
  repo-root `.env` for the helpers from the session's environment.
- Settings the session needs (names only; values live in the environment):
  `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `RENDER_API_KEY`,
  `GH_TOKEN`, `PROTOTYPE_REPO`, `STAGING_ADMIN_PHONE`,
  `STAGING_ADMIN_PASSWORD`, `STAGING_RECEPTION_PHONE`,
  `STAGING_RECEPTION_PASSWORD`, `STAGING_MANAGER_PHONE`,
  `STAGING_MANAGER_PASSWORD`.
- Network: npm, GitHub, Docker Hub, the Playwright CDN, `*.atlassian.net`,
  `api.render.com`, `*.onrender.com`.

## 9. Known pitfalls

- Workflow scripts must have LF line endings.
- Builders sharing a checkout must never run git checkout/reset/stash or
  restore a file from a git ref; they edit forward and report a complete
  file list.
- When a gate hands something over, act on it at once: put it in the next
  round's brief, or file a ticket.
- `gh run list` truncates titles, so always match CI by commit SHA.

## 10. Work in flight at the hand-over

### The one open thread: round 6's final gate

The second fix round + final recheck workflow was running when this
hand-over was written (lane lane/s217b-r6, worktree C:/w/k1). What it is
closing: the id-less /api/employees* doors (the list, the Excel import
preview/apply, reorder), the storage.getEmployee call-site family (time
override, timekeeping read, role-holder writes), and the create body -
each either fenced to the caller's park group or dispositioned to its
named round in the census (server/lib/employeeParkGroups.ts). The final
recheck recounts both censuses itself and drives every door as another
park group before it may say MERGE.

**If this session is resumed locally:** read the workflow result, then
follow section 2's land-or-wip instruction. **If the cloud session takes
over:** git fetch; if lane/s217b-r6 exists on origin as wip, read
STATUS's newest block for where the gate stopped; the lane's review file
(apps/api/test/s217b-r6-review.test.ts) states every finding as a test.

### Standing debts that ride along (no action until their moment)

- Round 5+6 walkthrough pages (capture-agent passes at the next staging
  window; the SPRINT_2_ACCEPTANCE rows).
- The staging offboarding census before 0008 deploys (section 2's order).
- The 03:00 departed-login door and pre-existing cross-park login links
  (recorded in PLAN section 10; check staging for such links before
  round 7 closes).
- SCRUM-509's phone-bar design rule; SCRUM-503's scroll-hint choices.
