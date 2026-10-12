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
