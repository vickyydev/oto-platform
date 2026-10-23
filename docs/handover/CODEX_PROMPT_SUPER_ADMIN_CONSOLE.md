# The first prompt for Codex — the Super Admin Console story (approved 2026-10-21)

Codex works in this same folder with the same environment and credentials as the planning agent, and is a development partner on the same team. Paste the block below as its first message for this story.

---

Hi Codex. New story for you: the **Super Admin Console** (the owner approved the plan on 2026-10-21). You develop it, test it, land it on main, deploy it through Render, and keep Jira and the docs current, exactly as we do for every story here. I (the planning agent) did the preparation and keep working beside you on other lanes, so we share the repo and must not step on each other's files.

**Start by reading, in this order**
1. `AGENTS.md` — our standing rules (you know them; re-read the absolute ones).
2. `docs/handover/CODEX_HANDOVER.md` — the newest note at the top is this story's hand-over.
3. `docs/progress/STATUS.md` — the newest block is the live state and always wins.
4. `docs/progress/plans/super-admin-console/PLAN.md` — the approved build plan. Everything below is a pointer into it: §1 decisions, **§2 who owns which files**, §3 navigation and permissions, §4 routes and schema, §5 conventions, §7–§10 and §14 the phases with acceptance, §13 how the earlier S2-23 design applies, §12 the Jira keys.
5. The `PROPOSAL.md` and the three `inventory-*.md` files in that folder — why the plan is what it is, and every screen, route, table and permission as it stands today. Read the inventory lines for an area before you touch it.
6. `docs/progress/SPRINT_2_PLAN.md` section "S2-23" — the console-own pages in detail; PLAN.md §13 says what of it applies.

**What is yours**
- Phases P1 to P5: stories SCRUM-608, 618, 628, 635, 642 and their subtasks (SCRUM-609–617, 619–627, 629–634, 636–640, 643–649). In order, one subtask at a time, each Deployed with proof before the next; a later phase never starts before the earlier one is Deployed. **Begin with SCRUM-609.**
- Files per PLAN.md §2: `apps/console/**`, the new `packages/admin-screens/**`, the console-facing api routes and services in §4.1, the OTO App read-only pages in P3, the migrations in §4.4; in `apps/pos/**` only what P1-9, P2-1 and P2-9 name.
- Not yours, ever, during this story: `apps/inbox/**`, `packages/assistant/**`, `apps/api/src/services/{inbox,assistant}/**`, `apps/booth/**`, `apps/radar/**`, `packages/box-agent/**`. P0 (SCRUM-603–607, 650, 651) is mine and is already live; build on it, do not redo it. If you need a change outside your files, put the question in STATUS and the ticket; I answer it — see PLAN.md §2 "Questions and standing authorizations" for what is pre-authorized and never needs a question at all.

**The ground rules that cause real damage when missed**
- Lift, do not redesign: the POS admin panels and the Console pages are approved screens; move them as components through `packages/admin-screens` and its `AdminApi` interface (PLAN.md §4.2); change navigation, wording and placement only.
- The console never writes another app's tables directly (PLAN.md §13): the OTO App is reached only through the identity seam and the provisioning service we already own, or through its own api as the acting user.
- Prototype and original-app rules stand; only data-source faults and real breakage are defects. A rule that looks wrong goes to STATUS as an owner question, unchanged in code.
- Every mutating route: zod in and out, a permission with the right `target` (the path or body branch; `operator: true` for operator-wide settings), an audit row, idempotency; `routes-guarded`, `route-write-conformance`, `id-conformance` and `route-scope-target` stay green and learn every new route.
- Migrations: expand-only, one per ticket, numbered on top of `main` at landing (`packages/db/migrations/meta/_journal.json`; the OTO App has its own set), `verify-schema` green.
- No attribution lines of any kind in commits, PRs or files; never commit `imports/` or `.env`; never print a secret; write about the system, never the commercial arrangement.

**The recipe per ticket (what "done" means here)**
Plan line → STATUS note that you started → worktree `C:/w/<lane>` on `lane/<topic>` from `origin/main` → schema, service, route, screen, tests (a test that fails without the change, for every fix) → gates **unpiped under `set -eo pipefail`** (each package's own `typecheck` script, its tests, `pnpm api-types:check` from the root when a route changed, `packages/shared` tests when shared changed, eslint on changed files, `verify-schema` on a migration; OTO App: `npm ci --ignore-scripts`, `npm run check:ratchet`, the relevant `tests/*.check.ts`) → commit per `CONTRIBUTING.md` with `Refs: SCRUM-nnn` → rebase on `origin/main`, gates again, push → **CI watched by the exact SHA** (`gh run list --branch main --commit <sha>`; a red run is fixed in the same session and said in the ticket) → Render deploys on green by itself (read `node scripts/agent/render.mjs deploys <service>` before any manual trigger; the OTO App deploys only on `apps/oto-app` changes; the Inbox and Radar sites are not in `deploy all`) → verify on staging and capture `<ticket>-NN-<what>.png` under `docs/qa/jira-comments/attachments/<ticket>/`, timestamped after the deploy → Jira the same turn: In Progress when picked, Testing, Deployed, with **one** plain-words comment per outcome a non-engineer can follow (what was wrong or missing, what is there now, how it was checked, the screenshot named and attached; the walker refuses Deployed without one; `node scripts/agent/jira.mjs status|comment|walk|attach`) → the STATUS block and the hand-over note updated, committed, pushed.

**Staging**
Everything you create is `ZZ TEST …`; never payment data, `otoapp.*_checkins`, the FWBooth1 box, the Inbox channel modes, or anything that sends an SMS (the adapter is real; creating a platform account sends one — use the demo people in the hand-over). A proof cites a record or screen timestamped after the deploy under test.

**Ask (in STATUS, one line in the ticket) when:** a change lies outside your files; the plan and the code disagree; a prototype rule would have to change; a migration would be destructive; a test can only pass by weakening a guard; staging would need a real SMS, a payment or a channel-mode change. Questions go to **the planner**, not the owner (owner directive 2026-10-23); only the SMS/payment/destructive-migration/rule-behavior/channel-mode cases are the owner's. Asking never stops the lane: keep working on everything that does not depend on the answer — the rest of the subtask, or the next independent subtask, or its read-only preparation. PLAN.md §2 "Questions and standing authorizations" lists four recurring patterns that are pre-authorized and need no question. Everything else you decide, note in STATUS, and keep going.

Start with **SCRUM-609**: "Admin" on the launcher, the ten-section navigation with its gates, the existing Console pages under Devices & places and Watch, old addresses still opening their pages. Write in STATUS that you have started, and take SCRUM-610 only once 609 is Deployed with its screenshot.
