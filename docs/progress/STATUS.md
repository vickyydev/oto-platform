# Current status — read this first when resuming

_Last updated: 2026-09-20 (Sprint 2 plan widened; revision paused mid-way)_

> **Resuming?** The precise checkpoint — what is done, what is pending in
> order, which research must be re-run, and what the owner still has to
> supply — is in `SPRINT_2_PROGRESS.md` (Status block first). The sprint
> scope changed on 2026-09-20: POS and booth first, then the OTO App on the
> central database (its schema and sign-on before CP1), Radar live with a
> per-branch source preference, and the Inbox pillars; QR payments through
> the 2C2P sandbox for real; adapters on the park's real devices
> (`../architecture/DEVICE_INVENTORY.md`). The plan is `SPRINT_2_PLAN.md`
> (19 tickets, CP1–CP7), still awaiting the owner's approval.

## Where we are

- **Sprint 1 is complete** and reviewed by the client (tag `sprint-1`):
  accounts, scoped permissions, audit, idempotency, file storage, members,
  children, tier verification, catalogue, pricing, tax, public booking.
  Report: `SPRINT_1_REPORT.md`. Client feedback is summarised in
  `../briefs/OWNER_DIRECTION.md`.
- **The repository is the suite monorepo**: platform at the root, docs split by
  purpose, `imports/` as the local-only drop zone. Remote:
  `github.com/vickyydev/oto-platform` (private), CI green.
- **The three real apps have been exported and reviewed** (OTO App, OTO Radar,
  Lucky Wheel), together with the OTO App production dump and the wheel
  specification. Findings: `../architecture/EXISTING_SYSTEMS.md`; per-app pages
  in `../features/`; review notes in `../architecture/intake-2026-09-19/`.
- **The programme plan is written:** `../architecture/PLATFORM_PLAN.md` —
  five apps, one database, sign-on, analytics continuity, two-device stations,
  booth, console, cutover.
- **The owner re-prioritised on 2026-09-19 (evening):** Sprint 2 = the suite
  launcher with centralised sign-in, the **POS complete against device
  simulators**, the **Lucky Wheel booth with its admin control panel**, and
  observability, deployed on Render temporary domains for the client to play
  with. OTO App and Radar lifts, messaging and migration move to Sprint 3.
- **The Sprint 2 plan is written and awaits approval:** `SPRINT_2_PLAN.md`
  (16 tickets, milestones, checkpoints, open decisions). Its rule references
  come from `../architecture/POS_RULES_RECONCILIATION.md`, which reconciles the
  previous developer's `../briefs/POS_BACKEND_LOGIC.md` with the brief.
- **Deployment shape is agreed:** one repo, many small deployables, a subdomain
  per app, one central database (`../architecture/DEPLOYMENT_TOPOLOGY.md`).
  On `*.onrender.com` the sign-on is a signed hand-off between apps (permanent
  mechanism); the parent-domain cookie is a later shortcut.

**Nothing in either plan has been built.**

## Waiting on the owner

1. **Approval of `SPRINT_2_PLAN.md`** and answers to its Open decisions that
   have no safe default (revenue definition, accountant session for inclusive
   tax and receipt numbering, wallet offline cap, alert channel).
2. Render account access (owner has one) — needed at S2-01c.
3. Later sprints: a real dump of Radar's published database and of the
   wheel's; Pisell and Papaya credentials from Replit Secrets (history must be
   exported before those subscriptions are cancelled); S3 contents; DNS
   control of the `otoplay` domains; staff clock-in decision.
4. Remaining vendor documents (gate, printers, scanner) and 2C2P sandbox
   credentials; a Raspberry Pi 5 on the desk would let the Pi image be built
   this sprint instead of on site.

## Next steps once approved, in order

1. Create the Sprint 2 Jira tickets from `SPRINT_2_PLAN.md` (one issue per
   ticket, lettered parts as sub-tasks).
2. Execute in the plan's order: S2-01 (hardening, transactions, schema move,
   first Render deploy) → S2-02/03 (launcher, sign-on, console, observability)
   → **CP1** → S2-04..07 (stations, box agent, simulators, booth) → **CP2** →
   S2-08..11 (display, checkout, tenders, printing, History) → **CP3, client
   play-test opens** → S2-12..15 → **CP4** → S2-16 → **CP5**.
3. Sprint 3: lift OTO App and Radar, Radar's per-branch source switch, messaging,
   migration rehearsals and cutover (`../architecture/PLATFORM_PLAN.md` §12).

## Known defects to fix first

- `apps/api/src/routes/accounts.ts`: anyone holding `admin:role:assign` can
  grant any role at any scope; temp-password and phone-change routes have
  the same missing dominance check.
- No database transactions anywhere in `apps/api`; audit rows are not atomic
  with the change they describe.
- The POS inactivity lock signs the session out server-side, which prevents
  the offline unlock the target design requires.

## Working rules that are easy to forget

- Nothing under `imports/` is committed except the three READMEs. The exports
  contain real credentials and the dumps contain real staff and children's
  data: structure and counts only, never values, never uploaded anywhere.
- Never run `drizzle-kit push` or an imported app's reset scripts against a
  shared database.
- Commits follow `/CONTRIBUTING.md`.
