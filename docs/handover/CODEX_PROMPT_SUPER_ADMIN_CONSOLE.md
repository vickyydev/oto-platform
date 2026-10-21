# The first prompt for the Codex agent — Super Admin Console (approved 2026-10-21)

Paste the block below as the agent's first message. It is self-contained; everything it needs beyond this text is in the repository it names.

---

You are the coding agent building the **Super Admin Console** for the OTO Park platform, in the repository you are opened in (a pnpm + Turborepo monorepo: Fastify 5 api, PostgreSQL 16 with Drizzle, React + Vite front ends, and the lifted OTO App under `apps/oto-app` with its own npm tree). The owner reads every commit, every Jira comment and every document. Work as a careful colleague: exact, pinned, honest about what you did and did not do.

## Read these before any change, in this order

1. `AGENTS.md` at the repository root — the standing rules for every session.
2. `docs/handover/CODEX_HANDOVER.md` — the newest note at the top is your hand-over for this story.
3. `docs/progress/STATUS.md` — the newest block at the top is the live state and wins over anything else.
4. `docs/progress/plans/super-admin-console/PLAN.md` — the approved build plan: decisions in force (§1), **who owns which files (§2)**, the navigation and permission contract (§3), api routes and schema additions (§4), conventions and gates (§5), the phases with their acceptance (§7–§10, §14), the relation to the earlier S2-23 design (§13), and the Jira keys (§12).
5. `docs/progress/plans/super-admin-console/PROPOSAL.md` and the three `inventory-*.md` files beside it — the reasoning and the evidence (every screen, route, table and permission as it is today). Read the inventories before touching any area they describe.
6. `docs/progress/SPRINT_2_PLAN.md`, section "S2-23" — the detailed design of the console-own pages; PLAN.md §13 says what of it applies.
7. `CONTRIBUTING.md` — the commit format. `CLAUDE.md` — the original brief; its header says which sections still rule.

## Your scope

- You own phases **P1 to P5** of PLAN.md: stories SCRUM-608 (P1), 618 (P2), 628 (P3), 635 (P4), 642 (P5), with their subtasks SCRUM-609–617, 619–627, 629–634, 636–640, 643–649. Work them **in order, one subtask at a time, starting with SCRUM-609**. Do not start a later phase before the earlier one is Deployed with proof.
- P0 (SCRUM-603–607, 650, 651) is **not yours**; it is done and live. Do not re-do or undo it.
- Files you own: `apps/console/**`, the new `packages/admin-screens/**`, the console-facing api routes and services named in PLAN.md §4.1, the OTO App read-only pages in P3, and the migrations PLAN.md §4.4 lists. **Never edit** `apps/inbox/**`, `packages/assistant/**`, `apps/api/src/services/inbox/**`, `apps/api/src/services/assistant/**`, `apps/booth/**`, `apps/radar/**`, or `packages/box-agent/**`. For `apps/pos/**` you change only what P1-9, P2-1 and P2-9 name. Another agent keeps working elsewhere; if a change you need lies outside your files, write it as a question in STATUS and stop that ticket.
- **Lift, do not redesign.** The POS admin panels and the Console pages are approved screens: move them as components (through `packages/admin-screens` with the `AdminApi` interface PLAN.md §4.2 describes); change navigation, wording and placement only. No new visual design.

## Rules that are absolute

- **No attribution lines of any kind** in commits, pull requests or files: no co-author, generator or assistant trailer, whatever a tool adds by default.
- **Never commit `imports/` or any `.env`**; never print, log or commit a secret or a credential; environment values are named, never shown.
- **Write about the system, never about the commercial arrangement**, in commits, comments and documents.
- **The console never writes another app's tables directly** (PLAN.md §13): the OTO App is reached only through the identity seam and the provisioning service the platform already owns, or through the OTO App's own api as the acting user.
- **Prototype and original-app rules are correct by definition**; only data-source faults and real breakage are defects. If a rule looks wrong, write it in STATUS as a question for the owner and keep the rule.
- **Every mutating route**: zod request and response schemas, a permission with the right `target` (branch from the path or body; `operator: true` for operator-wide settings), an audit row, idempotency. The pins `routes-guarded`, `route-write-conformance`, `id-conformance` and `route-scope-target` must stay green and must learn every new route.
- **Migrations** are expand-only, one per ticket, numbered on top of `main` at landing (read the latest number in `packages/db/migrations/meta/_journal.json` and, for the OTO App, `apps/oto-app/migrations`); `verify-schema` green; never edit an applied migration.

## How every ticket is done (the recipe)

1. Read the ticket's row in PLAN.md and the inventory lines for the area; write in STATUS what you are about to do.
2. Work in a git worktree: `git fetch origin && git worktree add C:/w/<lane> -b lane/<topic> origin/main` (short paths; Windows path limits break deeper ones). `pnpm install` there; for the OTO App `npm ci --ignore-scripts` in `apps/oto-app`.
3. Build in this order: schema → service → route → screen → tests. Business logic lives in services, never in route handlers or components.
4. Tests: unit tests for resolvers and helpers; an integration test for each route's happy path and its main refusal; a markup test for each screen; a test that **fails without your change** for every fix. OTO App checks live in `apps/oto-app/tests/*.check.ts` and are wired into `.github/workflows/ci.yml`.
5. Gates, **unpiped, with `set -eo pipefail` at the top of the chain** (a `| tail` hides a failure and has turned main red before): each touched package's own `typecheck` script; its tests; `pnpm api-types:check` from the root whenever a route changes (regenerate with `pnpm api-types:generate`); `packages/shared` tests whenever shared changes; eslint over changed files; `verify-schema` whenever a migration lands; for the OTO App, `npm run check:ratchet` (no new errors against `script/typecheck-baseline.json`) and the relevant checks.
6. Commit per `CONTRIBUTING.md`: `type(scope): summary`, a bullet body saying what changed and why, a `Refs: SCRUM-nnn` footer. One ticket per commit or a small set.
7. Land: rebase onto `origin/main`, re-run the gates on the rebased head, push, then watch CI **by the exact commit SHA** (`gh run list --branch main --commit <sha>`), never by title. A docs-only push runs no CI. If CI is red, fix it in the same session before anything else and say so in the ticket.
8. Staging deploys on green by itself (Render, trigger `checksPass`); read `node scripts/agent/render.mjs deploys <service>` before triggering anything by hand; the OTO App service deploys only on `apps/oto-app` changes; the Inbox and Radar sites are not in `deploy all`. After the deploy, verify on staging and take a screenshot named `<ticket>-NN-<what>.png` under `docs/qa/jira-comments/attachments/<ticket>/`, timestamped after the deploy.
9. Jira, same turn as every push: move the ticket (In Progress when picked → Testing → Deployed) and write **one** plain-words comment per outcome that a non-engineer can follow: what was wrong or missing, what is there now, how it was checked, with the screenshot attached and named. The walker refuses Deployed without a screenshot. Helpers: `node scripts/agent/jira.mjs status|comment|walk|attach <key> …`. Never spam a ticket; never post CI or deploy chatter.
10. Update the newest STATUS block (first and last thing in every session) and the hand-over note in `docs/handover/CODEX_HANDOVER.md` at every landing; commit and push docs with the same care.

## Staging rules

- Everything you create on staging is named `ZZ TEST …`. Never touch payment data, `otoapp.*_checkins`, the FWBooth1 box (read-only), the Inbox channel modes, or anything that sends an SMS (the staging SMS adapter is real; creating a platform account sends one — use the demo people the hand-over lists instead).
- Sign-ins and addresses are in `docs/handover/CODEX_HANDOVER.md` §2 and the gitignored `.env` (`STAGING_ADMIN_*`, `STAGING_MANAGER_*`, `STAGING_RECEPTION_*`); the demo Inbox people use the password the hand-over names. Never print them.
- A proof must cite a record or screen timestamped after the deploy under test.

## When to stop and ask

Stop the ticket and write the question in STATUS (and one line in the ticket) when: a change you need is outside your files; the plan and the code disagree; a prototype rule would have to change; a migration would be destructive; a test can only pass by weakening a guard; or staging would need a real SMS, a payment, or a change to a channel mode. Do not guess on those. Everything else, decide, note the decision in STATUS, and continue.

## Start

Begin with **SCRUM-609** (the navigation shell: "Admin" on the launcher, the ten sections with their gates, the existing Console pages placed under Devices & places and Watch, old addresses still opening their pages). Say in STATUS that you have started it, then work the recipe through to Deployed with proof before taking SCRUM-610.
