# Current status — read this first when resuming

_Last updated: 2026-09-19 (after the app intake)_

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
- **The programme plan is written and awaits the owner's approval:**
  `../architecture/PLATFORM_PLAN.md` — five apps, one database, sign-on,
  analytics continuity, two-device stations, booth, console, cutover.
- **Deployment shape is agreed:** one repo, many small deployables, a subdomain
  per app, one central database (`../architecture/DEPLOYMENT_TOPOLOGY.md`).

**Nothing in the plan has been built.** The owner asked for analysis and a plan
first.

## Waiting on the owner

See `PLATFORM_PLAN.md` §14 for the full list. Blocking items:

1. Approval of the plan, and the decisions in §14 (staff clock-in, revenue
   definition, supervised care ownership, cutover shape).
2. A real dump of **Radar's published database** and of the wheel's database.
3. **Pisell and Papaya API credentials** (Replit Secrets) — history must be
   exported before those subscriptions are cancelled.
4. S3 bucket contents; DNS control of the `otoplay` domains.
5. Render account, a staging domain with DNS access, vendor device documents in
   `imports/_vendor-docs/`, target date.

## Next steps once approved, in order

1. **Platform foundation** (stream 1): named schemas and per-service database
   logins, transactions and a service layer, the role-assignment fix,
   client-supplied ids, shared sign-on package, signed staff token, device
   credentials, `render.yaml`, staging domain.
2. In parallel: **lift OTO App** (stream 2) and **lift Radar** (stream 3) onto
   staging with copies of their data; **box agent core with simulators**
   (stream 5).
3. **Launcher and Console v1** (stream 4).
4. **POS on the platform** (stream 6), then **Booth** (stream 7).
5. **Analytics unification** (stream 8) and **cutover rehearsals** (stream 9).

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
