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

_Updated: 2 October 2026, night (Bangkok)._

| Item | State |
|---|---|
| S2-14 wallets and stock (SCRUM-211) | Deployed |
| S2-15a End of Day (SCRUM-215) | Round 1 on main (320c396d, test fix e239454d). Rounds 2-4 to do. Plan: `docs/progress/plans/cash/PLAN.md` |
| SCRUM-493 till consistency | In Progress. Register: `docs/progress/plans/consistency/REGISTER.md` |
| SCRUM-494 (register entries 1-9) | Entries 5, 6, 7 on main (b165a118). Entries 8-9 (food counters) and then 4 (gate access) and 1-3 (tier, restock) were being built in the local session |
| SCRUM-495, SCRUM-496 | To do, in that order, after End of Day rounds 2-4 |
| SCRUM-497 | Owner confirmations; each item keeps the design's behaviour until answered |
| Staging | Live at 6b5f08f8 (End of Day round 1 and SCRUM-494 entries 5-7 included; migration 0052 applied). Round 1 evidence on SCRUM-215 (one ZZ TEST paid-out of B60 recorded on 2 Oct). Deploy again after each landing before its walkthrough |

**Check for unlanded work first.** If the local session stopped mid-build,
its edits were pushed to a branch named `wip/<topic>` (`git branch -r | grep
wip/`). Compare such a branch with main and the register entry before
deciding whether to finish it or rebuild from the entry.

## 3. Order of work (owner priority, 2 October)

1. Finish SCRUM-494: entries 8 and 9 (band safety data and prepaid meals at
   F&B and Shop), then entry 4 (Gate access on adult bands) and entries 1-3
   (tier expiry, tier pick, full-scope restock). Then deploy staging and take
   the staging evidence for all nine entries, then SCRUM-494 to Deployed.
2. S2-15a End of Day rounds 2, 3, 4 (plan section 7): provisional close and
   stranded occupancy and the End of Day receipt; settlement; demo-day and
   the staging walkthrough. SCRUM-215 then SCRUM-214 to Deployed.
3. SCRUM-495, then SCRUM-496 (register entries in their sections), applying
   SCRUM-497 answers as each runs.
4. Only then S2-15b and the rest of `docs/progress/SPRINT_2_PLAN.md`'s
   execution order.

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
- **Migrations**: the next free number after main's highest (0052 is the
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
