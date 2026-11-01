# The prompt for Codex — the read-only floor-flow review (SCRUM-702, 2 November 2026)

Codex works in this same folder with the same environment and credentials as the planning agent. Paste the block below as its first message in a fresh chat. This is a READ-ONLY unit: it changes no code and writes nothing on staging; its deliverable is a report and a short list of neutral tickets.

---

Hi Codex. One read-only unit for you: **SCRUM-702**, a review of the floor flows for inputs the system expects but nothing provides in production. You change no code, you write nothing on staging, and you create no records anywhere except the report file, its commit, and the Jira tickets the rules below allow.

**The pattern you are hunting.** On 30 October a drop-off child on the Nanny service could not be paid: the till requires an on-shift nanny, but nannies and their shifts were written only by the demo seed, nothing feeds them from the rota, there is no screen to add one, and the seeded fortnight had passed, so every nanny read "Off shift" (SCRUM-699). The day after, staff plugged the barcode cradle into the counter box because the design says it belongs there, but the box has no reader for it; only the simulator path exists (SCRUM-700). Both are the same shape: **a flow puts a gate in front of a person, and the thing the gate needs is produced only by seed data, only by a simulator, only until a date, or by nothing at all.** Find the rest.

**Start by reading, in this order**
1. `AGENTS.md`, then `docs/progress/STATUS.md` (the newest block is the live state; three lanes and a second Codex unit are landing today, so main moves).
2. `docs/architecture/DEVICE_INVENTORY.md` (what the real devices are and which paths are "later"), `docs/ops/BOX_QUICKSTART.md`, `docs/progress/OPEN_ITEMS.md`.
3. `docs/progress/plans/super-admin-console/inventory-platform.md` and `inventory-oto-app.md`: every screen, route and table as it stood on 21 October, including the "seed only, no feed" notes already found. Do not re-find those; cite them and look for the ones that are not listed.
4. The seed: `packages/db/src/seed/*.ts`. Every table the seed writes is a candidate: for each, who else writes it (`grep -rn "insert(<table>)" apps/api/src packages/box-agent/src`)? If the answer is "only the seed" and a production flow reads it, that is a finding.
5. The gates in the till: `apps/pos/src/components/till/**`, `apps/pos/src/components/dropoff/**`, `apps/pos/src/pages/Till.tsx`, `apps/pos/src/lib/*` — every `disabled=`, every "required" marker, every refusal line, every `canConfirm`/`canPay` computation: what does it wait for, and who can produce that in production?
6. The box: `packages/box-agent/src/agent.ts` (device kinds, simulated vs real adapters), `station-bridge.ts` (what the offline bridge refuses that the platform accepts), `scan*.ts`, the printer and gate adapters, `scripts/pi/install.sh`.
7. The api's setup surfaces: `apps/api/src/routes/{stations,devices,fleet,console*,checkin,booth}.ts` and the services behind them — what a station, terminal, printer, display, booth or branch needs before a sale, a print, a QR, a redeem or a check-in works, and whether anything enforces it at setup.

**The seven families to check, with the questions to answer for each gate**
1. Seed-only data a production flow depends on (tables written by the seed and read by a flow, with no route, screen or sync writing them).
2. Date-bound records that silently stop: shift windows, claim windows, holiday ranges, price periods, signing keys, pairing credentials, leases, tokens, reusable codes with expiry. What happens the day after?
3. Simulator-only device paths: for each device kind the Console can register (receipt printer, band printer, terminal, display, scanner, gate, kiosk…), is there a real adapter, and does the Pi installer set up what it needs (udev, groups, ports)?
4. Per-station or per-branch configuration a flow needs that nothing enforces when the station is created (a till with no code prefix cannot number receipts; QR routed to a terminal that does not exist; a booth with no published wheel; a branch with no opening hours, tax rule, tier prices, or supervision policy).
5. Two sources of truth for one thing (platform tables beside OTO App tables: staff, employees, roles, nannies, booth staff, shifts, branches) and what drifts when only one is updated.
6. Orphans: routes nothing calls (start from SCRUM-277's list and check what changed), screens or buttons calling routes that do not exist or always refuse, settings saved but never read.
7. Online-only flows on the offline box: what the platform accepts that `station-bridge.ts` refuses or ignores, and what the sync replays wrongly.

For every gate: **what it needs → who writes that in production → what the person sees when it is missing or expired → can staff recover without an engineer → verified how (file:line, or a read-only staging read as the admin) → severity (blocks a sale or a guest / degrades / cosmetic) → proposed fix (one line).**

**Rules**
- Read-only. No code edits, no migrations, no staging writes of any kind (no sales, no pairing, no settings, no inbox messages). Staging reads as the admin are fine (`scripts/agent/` helpers, the repo-root `.env`); never print a credential.
- Prototype rules are not defects (owner ruling SCRUM-488): a rule that looks wrong is a question for the owner, listed in its own section, unchanged.
- Already known, cite rather than re-find: SCRUM-699 (nannies), SCRUM-700 (box scanner), SCRUM-685 (2C2P shape), SCRUM-277 (orphan endpoints), SCRUM-513 (sale after day close), SCRUM-506 (card revocation gap), the "seed only, no feed" rows in the inventories, and anything else already in Jira (search before you write: `node scripts/agent/jira.mjs status <key>`, or JQL through the helper's `jget`).
- Severity honesty: "blocks" only when a person on the floor cannot complete a sale, a check-in, a print or a redeem; a thing that works but is clumsy is "degrades".
- No attribution lines in the commit; write about the system only, never the commercial arrangement or anybody's whereabouts.

**Deliverables**
1. `docs/qa/flow-review-2026-11/REPORT.md`: a summary (counts by family and severity), then one table row per finding with the eight columns above, then the owner's questions, then what you checked and found clean (so the next review does not repeat it). Commit it on your own branch `lane/codex-flow-review-20261102` in a worktree under `C:/oto-lanes/`, rebase on `origin/main`, push to main (docs only, no gates needed beyond `git diff --check`), and watch CI by the exact SHA (`sh scripts/agent/watch-ci.sh <sha> 30`).
2. For each **blocking** finding that is not already in Jira: one ticket in the sprint through `scripts/agent/jira.mjs` `createInSprint` (type Bug when something is broken, Task when something is missing; area label; a neutral title that names the gap, never the review), with the row's content in plain words and the proposed fix. Degrading and cosmetic findings stay in the report with a one-line proposed ticket title; the planner files those after the owner reads the report.
3. Jira: mark SCRUM-702 In Progress when you start, Testing when the report is pushed, with one comment a non-engineer can follow: how many findings by severity, the five that matter most in one line each, the tickets you created by key, and the report's path and commit SHA. Deployed is for the planner after the owner has read it.
4. A STATUS block in `docs/progress/STATUS.md` (newest at the top) saying the review is done and where the report is.

Budget: this is a day's work, not a week's. Breadth first: list every gate you find in the first pass, then go deep on the ones that look like the two examples. Stop at the report; do not fix anything you find.
