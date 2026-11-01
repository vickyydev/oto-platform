# The prompt for Codex — the till's browser checks in CI, then the parties count on Today (2 November 2026)

Codex works in this same folder with the same environment and credentials as the planning agent. Paste the block below as its first message. Two small, independent units; the first protects every later change to the till, the second is a reporting defect reception sees daily.

---

Hi Codex. Two units for you, in this order: **SCRUM-369** (the till's own browser checks never run in CI) and then **SCRUM-508** (Today › Performance counts no parties while the party tab trades). You develop, test, land on main, let Render deploy, and keep Jira and the docs current, as we do for every unit here. I (the planning agent) keep working beside you on three other lanes, so we share the repo and must not step on each other's files.

**Start by reading, in this order**
1. `AGENTS.md` — the standing rules; re-read the absolute ones.
2. `docs/progress/STATUS.md` — the newest block is the live state and always wins.
3. `CONTRIBUTING.md` — commit shape; no attribution lines of any kind.
4. For SCRUM-369: `.github/workflows/ci.yml` (how the Console's browser job runs on the Linux runners — Chromium there, Edge locally — and the `paths` filters), `apps/console/package.json` and its e2e scripts (the shape to copy), `apps/pos/package.json`, the till's existing Playwright smoke under `apps/pos` (lock → sign in → membership lookup → child confirm), `apps/api/test/*support*.ts` for how a throwaway database is made (embedded Postgres when `TEST_DATABASE_URL` is unset; Docker is not needed and not started).
5. For SCRUM-508: the ticket text, `apps/pos/src/pages/Today*.tsx` and the Performance tile, `apps/api/src/services/analytics*.ts` and the events seam the party tab writes through (`apps/api/src/services/event-writes.ts`, `party-tab.ts`), and `docs/progress/plans/analytics/*` question 3 (party money timing).

**What is yours**
- SCRUM-369: `apps/pos/package.json` scripts, `apps/pos/e2e/**` (or wherever the till's smoke lives — keep it where it is), `apps/pos/playwright.config.*`, one CI step in `.github/workflows/ci.yml` after Build, a `paths` entry so it runs when `apps/pos/**`, `packages/shared/**` or `apps/api/**` change. The run script makes its own throwaway database and seeds it the way the Console job does; the e2e script is NOT named `test` (the workspace `test` step must not pick it up). Browser choice stays the same as the Console job. **Done when a push that breaks the till's sign-in turns CI red** — prove it once on your branch by breaking sign-in deliberately in a throwaway commit, watching the run go red, and reverting.
- SCRUM-508: the Performance tile's data source on the api side and whatever the tile reads; count parties and their takings from the same place the party tab writes, never from the old bookings source. A test that fails without the fix: a party with a charge and a payment through the party tab makes "Parties today" 1 and its takings appear.
- Not yours, ever, during these units: `packages/payments-2c2p/**`, `apps/api/src/services/payments/**`, `scripts/pi/**`, `scripts/agent/push-release.sh`, `docs/ops/BOX_QUICKSTART.md`, `apps/api/src/services/checkin.ts`, anything named `nanny*`, `apps/console/src/components/dropoff/**`, `packages/db/migrations/**` (neither unit needs a migration), `apps/inbox/**`, `packages/assistant/**`, `packages/box-agent/**`, `apps/booth/**`. If you believe you need a change there, write the question in STATUS and the ticket and keep going on what does not depend on it.

**The ground rules that cause real damage when missed**
- Prototype rules stand: only data-source faults and real breakage are defects. SCRUM-508 is a data-source fault (the wrong source), not a rule change.
- Never weaken or skip a test or a guard to go green; fix the cause.
- Gates **unpiped under `set -eo pipefail`**: each package's own `typecheck`, its tests scoped to what you touched (apps/api: `pnpm --filter @oto/api exec vitest run --pool=forks test/<file>`; never `test -- run`), eslint on changed files; `pnpm api-types:check` only if a route changed (it should not).
- Commits per `CONTRIBUTING.md` with `Refs: SCRUM-nnn`; no attribution, co-author or generator lines; never commit `imports/` or `.env`; never print a secret; write about the system, never the commercial arrangement.
- Worktree `C:/oto-lanes/codex-<topic>-20261102` on branch `lane/codex-<topic>-20261102` from `origin/main`; `pnpm install --frozen-lockfile --prefer-offline` there first. Main is moving today (three other lanes land during the day): rebase on `origin/main` and rerun your gates before every push.

**Landing and proof**
Rebase → gates → `git push origin HEAD:main` → CI watched by the exact SHA (`sh scripts/agent/watch-ci.sh <full-sha> 45`; a red run is fixed in the same session and said in the ticket) → Render deploys on green by itself (`node scripts/agent/render.mjs status`; the POS and api services) → for SCRUM-508 a staging screenshot of Today › Performance with a `ZZ TEST` party counted, timestamped after the deploy, saved under `docs/qa/proof-2026-11-02/` and attached; for SCRUM-369 the CI run link with the till job green plus the deliberate red run that proved it bites → Jira the same turn with `node scripts/agent/jira.mjs status|comment|walk|attach`: In Progress when picked, Testing after the push, Deployed only with the proof attached (the walker refuses otherwise); **one** plain-words comment per outcome a non-engineer can follow → a STATUS block, committed and pushed.

**Staging**
Everything you create is `ZZ TEST …`; station "Till 2 (test)" only, never "Till 1 (Pi)" (a real device); never payment data on a real terminal, never the FWBooth1 box, never the Inbox channel modes, never anything that sends an SMS. Void or discard what you ring up.

Start with **SCRUM-369**. Write in STATUS that you have started, and take SCRUM-508 only once 369 is Deployed with its proof.
