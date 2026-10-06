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

Current checkpoint: main is green; End of Day closes at any counter again (lane D landed). SCRUM-494, SCRUM-215, SCRUM-499 and SCRUM-500 are Deployed. SCRUM-495 and SCRUM-496 are being finished in two parallel lanes. SCRUM-498 comes next after SCRUM-495, then S2-15b (SCRUM-216).

_Updated: 6 October 2026. Live STATUS and the newest SESSION_HANDOVER stop block carry exact deployments and checkpoints._

| Item | State |
|---|---|
| Main | Green (SCRUM-501 repair confirmed). Migrations through 0061 (End of Day receipt after close). Lanes renumber at landing: next free 0062. Migrations through 0060. 0061 is reserved for SCRUM-495 and 0062 for SCRUM-496 |
| SCRUM-494 (till consistency, band details and services) | Deployed. Register entries 1-9 are on main and live |
| SCRUM-215 (S2-15a End of Day) | Deployed. Follow-up work is on branch `lane/eod-followups` |
| SCRUM-499 (Lucky Wheel fixed-code vouchers) and SCRUM-500 | Deployed |
| SCRUM-495 (till behaviour consistency) | Being finished on branch `lane/s495-finish`. Register entries 10, 11, 12, 13, 15, 16, 18, 19, 20, 40, 42, 43 are on main and live on staging. Entries 14 (Add time), 17, 29, 30 and 41 are being finished. Then screenshot evidence, then Deployed |
| SCRUM-496 (stock, booking and check-in consistency) | Being finished on branch `lane/s496-consistency`. Register entries 21-28 and 31-39 |
| SCRUM-497 | Details for the owner to confirm (register entries 44-65). Each keeps the approved design's behaviour until answered |
| SCRUM-498 | Next after SCRUM-495: food-counter band details through the counter box when the internet is down. Closes SCRUM-493 |
| SCRUM-216 (S2-15b analytics) | Plan drafted: docs/progress/plans/analytics/PLAN.md (migration 0063 reserved). Build after SCRUM-495 and SCRUM-496 land (shared sale, refund and wallet files). Then SCRUM-214 to Deployed, then the rest of `docs/progress/SPRINT_2_PLAN.md`'s execution order |
| SCRUM-488 | Owner's End of Day ruling applied; four round-1 points to confirm |

**Unlanded work** is saved, unreviewed, under `wip/saved-20261006/*`. Treat those branches as reference only until a lane picks one up.

**Rules**

- No feature pushes and no staging deploys while main is red.
- Lanes `lane/s495-finish` and `lane/s496-consistency` own separate files. Rebase on `origin/main` before every push and take the migration number reserved above.

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

### SCRUM-494 staging evidence (status Testing)

Drive each item on staging, as a person would:
- sign in with `scripts/agent/evidence.mjs` (`posSignIn` as RECEPTION or
  MANAGER);
- at "Pick your station", choose **Reception Till 1** (never FWBooth1);
- prefix every record you create with "ZZ TEST" and pay with cash only.

Then group the screenshots into at most five evidence cards, built with
`card()`, in `docs/qa/jira-comments/attachments/SCRUM-494/`:
- tier (items 1-2);
- restock (item 3);
- gate (item 4);
- check-in (items 5-7);
- food (items 8-9).

Open every image before using it. Attach the cards, comment in plain
words, then `walkTo('SCRUM-494', 'Deployed')`. The walk refuses without
an image.

| # | What to show | State at hand-over |
|---|---|---|
| 1 | A tier verified with no document expiry; an expired document keeps the tier with "Document expired - re-verify" | No-expiry half captured (ZZ TEST Tier Thai, +66894940001, verified Thai by Som with no expiry). Expired half is blocked on staging: nothing can record a past expiry there, by design. Show it as a test-run card from `apps/api/test/s494-money*.test.ts` and `apps/pos/test/s494-money-gate.test.ts` |
| 2 | A verified member sold at Tourist when staff pick Tourist | WORKS: receipt T1-000055, ฿1,040 cash, the member keeps Thai |
| 3 | A refund covering the rest of a sale restocks once | Being captured at hand-over; redo it |
| 4 | Gate access off on a package: its adult bands carry `gate_access=false` | Staging has no gate screen. Show the package setting plus a read-back (`render.mjs job`) of the bands' flag |
| 5 | Phone till (390x844) redeems a ZZ TEST booking once, with real band codes | To do |
| 6 | Drop-Off switched to Nanny on the cart: the board shows Nanny | To do. A nanny must be on shift |
| 7 | Phone-size check-in and release show on the desktop board | To do |
| 8 | At F&B, a child's band shows the allergy banner; a no-food child shows "Parent did not authorize food orders for this child."; the kitchen ticket carries that child's allergy line | To do |
| 9 | A prepaid meal is served once, a second attempt is refused, and release refunds only unserved meals | To do |

ZZ TEST data created so far: member ZZ TEST Tier Thai; sale T1-000055
(bands T1-N69MZ5, T1-ZA4CGQ); one paid-out of ฿60 on 2 Oct (SCRUM-215
round 1 evidence).

### End of Day round 2 (SCRUM-215)

See `docs/progress/plans/cash/ROUND_2_BRIEF.md`, including its "State at
hand-over".

### Questions already raised (do not re-ask; wait for the answers)

- SCRUM-497:
  - the 22 register details, plus details added on 2 October: Leave as
    booked; Mark Arrived; the gate reader's wording; a no-gate adult
    counted under kids; refusal on exit; the re-verify wording; the
    prepaid hold wording; refunded prepaid meals; prepaid lines on the
    receipt.
- SCRUM-488: the four End of Day round-1 points.
- SCRUM-498: the counter-box items (1)-(5).
