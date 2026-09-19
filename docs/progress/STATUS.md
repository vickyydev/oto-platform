# Current status — read this first when resuming

_Last updated: 2026-09-19_

## Where we are

- **Sprint 1 is complete** and reviewed by the client (tag `sprint-1`):
  accounts, scoped permissions, audit, idempotency, file storage, members,
  children, tier verification, catalogue, pricing, tax, public booking.
  Report: `SPRINT_1_REPORT.md`. Client feedback is summarised in
  `../briefs/OWNER_DIRECTION.md`.
- **The repository was restructured** into the suite monorepo: platform at
  the root, docs split by purpose, `imports/` as the local-only drop zone.
- **Pre-Sprint-2 design review is done**
  (`../architecture/design-review-2026-09-19/`), and the owner has since
  settled several points — see the README in that folder before relying on
  any recommendation in it.
- **Deployment shape is agreed:** one repo, many small deployables, a
  subdomain per app, one central database
  (`../architecture/DEPLOYMENT_TOPOLOGY.md`).

## Waiting on the owner

1. Replit exports of the **real** apps, dropped into `imports/<app-name>/`.
2. The production Postgres **schema + data dump**, dropped into `imports/_db/`.
3. Vendor device documents in `imports/_vendor-docs/` (card terminals, gate,
   printers, 2C2P).
4. Render account, a staging domain with DNS access, and a target date.

## Next steps, in order

1. **Intake** each dropped app: stack, tables, login method, Replit-specific
   dependencies; compare its schema files against the real production schema;
   write `../features/<app>.md` from the template.
2. **Profile the dump** in the local Docker Postgres: tables per app, row
   counts, shared entities (branches, staff, customers), data quality.
3. **Decide the master table per shared entity** and the post-import script
   that links legacy rows to the platform's core tables. Legacy tables stay
   import-compatible so the cutover is "load fresh dump, run the script".
4. **Write `SPRINT_2_PLAN.md`**: foundation rework first (transactions and a
   service layer, client-supplied ids, box-verifiable staff token, the
   role-assignment permission defect, schema per app), then the execution
   order in `../briefs/PROJECT_CONTEXT.md` section 14, then the app merges.
5. Build — one continuous run, against device simulators, deployed to Render
   as each piece becomes demonstrable.

## Known defects to fix first

- `apps/api/src/routes/accounts.ts`: anyone holding `admin:role:assign` can
  grant any role at any scope; temp-password and phone-change routes have
  the same missing dominance check.
- No database transactions anywhere in `apps/api`; audit rows are not atomic
  with the change they describe.
- The POS inactivity lock signs the session out server-side, which prevents
  the offline unlock the target design requires.
