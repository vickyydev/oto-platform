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

Current checkpoint: the sprint's two big stories are CLOSED and Deployed with checked staging evidence (SCRUM-217 events/parties/camps/kiosk, SCRUM-218 staff benefits, plus 443/484/504 and the earlier small fixes). The sprint's remaining story is **S2-17b, the OTO App lifted whole onto the platform (SCRUM-191, In Progress)**, run as nine lane build-review rounds per docs/progress/plans/otoapp-lift/PLAN.md. Round 1 (sign-on, identity, the route fences) is live on staging with its 403 probes. Round 2 (the employee mirror: otoapp_v.employees, job:otoapp.employee_sync, adoption, card revocation on leaving, the benefits swap) landed on main as 43b214ee with the review's two prescribed fixes applied at the gate; CI was being watched at this refresh.

_Updated: 8 October 2026. Live STATUS (docs/progress/STATUS.md) carries exact deployments and the newest block always wins._

| Item | State |
|---|---|
| Main | 43b214ee (round 2 of the lift). Platform migrations through 0075; next free 0076. The OTO App's own migrations through 0005 (otoapp_v.employees), applied by the app's migrator |
| Staging | All six services at a726f18b (round 1). Round 2 deploys IN ORDER: oto-app first (runs 0005), then GRANT USAGE on otoapp_v + SELECT on otoapp_v.employees to the api role and run packages/db/scripts/otoapp-employee-seam-readback.ts (exit 0), then the api/rest - else booth sync answers 503 EMPLOYEES_SEAM_NOT_GRANTED |
| SCRUM-191 (the lift) | In Progress. Rounds 3-8 remain: night jobs on the runner, tenant ownership + Attention (4a/4b), attendance/operations, documents, finance + walkthroughs, rehearsal |
| Owner queues | SCRUM-497 and SCRUM-488 answers; benefits plan Q1-Q13; events plan Q1-Q14; lift plan Q1-Q20 (Q16-Q20 added at round 2: ties, standing-case repeats, delete doors, the never-copied leaver, the ADOPTION_CONFLICT settle tool) |
| Open small tickets | SCRUM-502/503 ledgers, 505-508; SCRUM-480 waits on the USER (R2 CORS). Held-with-reasons list in STATUS |

**Unlanded work** is saved, unreviewed, under `wip/saved-20261006/*`. Treat those branches as reference only until a lane picks one up.

**Rules**

- No feature pushes and no staging deploys while main is red.
- The active lane is `lane/s217b-r2` (worktree C:/w/g17), about to be superseded by round 3's lane. Rebase on `origin/main` before every push; platform migration numbers are assigned at landing (next free 0076).

## 3. Order of work (owner priority, 2 October)

1. SCRUM-494 staging evidence for all nine items (section 10), then
   SCRUM-494 to Deployed. If anything turns out BROKEN on staging, fix it
   first. Then SCRUM-493's first part is done.
2. S2-15a End of Day:
   - round 2: finish from `wip/eod-round-2-inflight` against
     `ROUND_2_BRIEF.md`, review, land, then deploy and screenshot;
   - round 3: settlement, as in plan section 4;
   - round 4: demo-day scenarios and the closing walkthrough.

   Then SCRUM-215 goes to Deployed after its proof. SCRUM-214 remains open: its analytics child SCRUM-216 is still To Do, confirmed from Jira on 6 October.
3. SCRUM-495, then SCRUM-496 (the register entries in their sections),
   then SCRUM-498, applying SCRUM-497 answers as each runs.
4. Only then S2-15b (SCRUM-216) and the rest of
   `docs/progress/SPRINT_2_PLAN.md`'s execution order.

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

- SCRUM-497: details to confirm (each keeps the design's behaviour).
- SCRUM-488: four End of Day points from round 1 (named approver/witness
  without PIN; staff may close; nothing added to a closed day; a card refund
  handed back in cash comes off the cash line).
- SCRUM-480, SCRUM-481, SCRUM-482, SCRUM-485: earlier rulings.
- Waiting on outside parties: Xero connection, 2C2P sandbox credentials.

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

### S2-17b round 2 staging acceptance (next action once CI is green on 43b214ee)

1. Deploy **oto-app-staging** at the green head (its migrator applies app migration 0005, publishing `otoapp_v.employees`; the migration grants nothing).
2. Run the GRANT as a one-off job on the api image: USAGE on schema `otoapp_v` and SELECT on `otoapp_v.employees` to the api's database role, then `packages/db/scripts/otoapp-employee-seam-readback.ts` must exit 0 with counts.
3. Deploy the five platform services ("deploy all") at the same head.
4. Acceptance, IN THIS ORDER: provision the four demo people's OTO App users to their platform accounts BEFORE creating them as employees in the app (or within one 15-minute copy window) - otherwise their platform rows are never adopted and Nok's benefit override is left behind (plan Q20). Then: the four core.employee rows adopted, Nok's override intact on a fresh card, a second run changing nothing, job:otoapp.employee_sync on Health, the HR employees walkthrough page, and the SCRUM-218 comment updating check 1 (the mirror now feeds benefits).
5. Then launch round 3 (the night jobs on the platform runner) per PLAN.md section 8.

### Standing small work

SCRUM-502/503 hold the open small-ticket ledgers; 505-508 are filed defects not yet picked up; SCRUM-480 waits on the user for the Cloudflare R2 CORS rule. The tender-machine tickets 415/416 are unblocked (E4 landed) but queued behind the lift.
