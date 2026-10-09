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

Current checkpoint (9 October 2026, the hand-over to the cloud session): the
sprint's two big stories are Deployed with checked evidence (SCRUM-217
events/parties/camps/kiosk, SCRUM-218 staff benefits). The open story is
**S2-17b, the OTO App lifted whole (SCRUM-191, In Progress)**, run as lane
build-review rounds per docs/progress/plans/otoapp-lift/PLAN.md. Rounds 1-5
are LANDED, DEPLOYED and PROVEN on staging (sign-on fences; the employee
mirror with adoption proven on the demo cast; the night jobs under the
platform runner with the Q22 switch THROWN on staging; tenant ownership 4a+4b
with the contraction applied and Attention awake per park group; attendance
and operations with the sick-day approval restored and the face road standing
down). **Round 6 (the document modules) is mid-gate**: built with migration
0008 (expand; the offboarding census decides its unique index), one-transaction
offboarding proven by failure injection, and the signed-URL document gate -
its review found the HR employee doors crossing park groups (HIGH), the first
fix round closed the /:id census and was RIGHTLY rejected for missing the
id-less doors (the employee list leaking pay/tax/SSN; the Excel import able to
edit another park group's people), and the second fix round + final recheck
were running at the hand-over. **Land round 6 only on that recheck's MERGE.**

_The newest block of docs/progress/STATUS.md is always the exact state; it
supersedes this paragraph if they ever disagree._

| Item | State |
|---|---|
| Main | Green through round 6 (633cae41; run 37883987428). Platform migrations end at 0075 (next free 0076); the app's own at 0008 LANDED ON MAIN, applied nowhere yet (staging holds 0007) |
| Staging | All six services at a1b909e5. OTOAPP_JOBS=platform (the night work runs under the platform's watch). Known deliberate records: Som's evidence sick day 2026-10-14 (id c1e7e9ae-...); the four demo app employees; the jobs:run directory key (sha256 cd2ec7c8...) |
| Round 6 | LANDED AND GREEN: main 633cae41 (CI run 37883987428). Twenty-four commits through the full gate (review -> reject -> fix -> reject -> deeper fix -> final recheck MERGE). NOT yet deployed to staging - that is the NEXT SESSION'S FIRST ACTION, in the order below. Three standing pins ride in the review file (the approve race Q44; the kiosk-door and role-branch by-id gaps, queued in the fix block) |
| Round 6's staging deploy order | 1) run the offboarding census on staging (one-off job on the APP service: npm run offboarding:census; read-only; its result only decides the unique index - 0008 deploys either way); 2) deploy oto-app-staging at the green head (migrator applies 0008 with NOTICEs printed); 3) deploy all five platform services; 4) re-read the tenant read-back; 5) SCRUM-191 comment |
| After round 6 | Round 7 (park/knowledge/administration/finance: the finance keys migration, round 6's NOT NULL contraction, the people routes slice, voucher notices, the big walkthrough sweep), round 8 (restore rehearsal in CI, typecheck ratchet, acceptance index). THEN THE FIX BLOCK (docs/progress/OPEN_ITEMS.md) before ANY new story - the owner's standing ruling of 9 October |
| Owner queues | Lift plan Q1-Q54 (newest: Q38-Q46 attendance, Q47-Q54 documents/roles); benefits Q1-Q13; events Q1-Q14; analytics 1-17 (Q3 blocks SCRUM-508); SCRUM-497; the OPEN_ITEMS section-3 ruling list |
| Walkthrough debt (SCRUM-191) | Round 5's ten module pages; round 6's pages at its deploy; the SPRINT_2_ACCEPTANCE rows tick as modules prove |
| CI | Sharded 8 Oct (SCRUM-511 Deployed with the measured card): api 3 shards + pos on its own runner; ~13 min wall. The 0007-gate suites know the no-app-modules fallback path (cause chain surfaced) |

**Standing security/data rules** (unchanged): ZZ TEST prefixes for new test
records; FWBooth1 read-only; never touch payment run 0d008153; secrets never
printed (keys live only in Render env; known by sha256 in STATUS); no
attribution lines in commits; never commit imports/; benefit QR codes blurred.

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
