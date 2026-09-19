# Owner direction — decisions given in conversation

A running record of what the owner (Waqar) decided outside the written briefs.
Newest entries win over `CLAUDE.md`, `PROJECT_CONTEXT.md` and any design review.

## 2026-09-19

**What this programme is**
- The POS is the only *new* product. The client's other apps are real, live
  systems: the client edits them in Replit, an agency imports the code and
  deploys it on AWS from the agency's GitHub, with a production Postgres.
- Not every project in the client's Replit account is real — some are mockups.
  Only the real apps that share the production database get imported.
- We have no access to the agency's repos. We work from Replit exports and set
  up our own deployments (GitHub + Render).
- End state: one central database, one launcher page showing all OTO apps,
  apps sharing data, one admin dashboard with analytics of everything. UI
  designs come from the Replit prototypes.

**Cutover**
- The agency's AWS deployment stays production until the new system is ready;
  then the new system becomes live. One switch, no long parallel sync.
- We start from the existing Postgres schema + data dump (our modifications
  allowed where needed). At cutover the latest live production data is
  imported into the same tables. => Keep legacy tables import-compatible:
  changes are additive, and "load dump → re-runnable post-import script" is
  rehearsed before the real day.

**Boxes and hardware**
- Physical theft or tampering of the Raspberry Pi boxes is NOT a threat model
  (secure malls). The brief's decisions stand as written: shared HMAC band key
  on every box, Caddy DNS-01 on the box, full members + children cache on
  boxes.
- Hardware is at the park and needs travel. All software is completed first
  against simulators; device-specific issues are fixed on site afterwards.

**How we build**
- One continuous run, built heavily with AI agents. No gated module-by-module
  sprints.
- One GitHub repository with shared modules and a separate UI per app.
- Hard requirement: the whole system must never go down at once, and deploying
  one app must not affect the others. (See
  `docs/architecture/DEPLOYMENT_TOPOLOGY.md`.)

## Open with the owner

- GitHub organisation and Render account (owner's or client's); paid plan OK?
- A staging domain/subdomain with DNS access (needed for single sign-on
  across separately deployed apps).
- Which exact apps are real and in scope (decided when the exports are dropped).
- Whether booth game, messaging inbox, kiosk and gate are all in this run.
- Vendor protocol documents for the devices (`imports/_vendor-docs/`).
- A Raspberry Pi 5 / iPad on hand before travelling?
- Target date for the client to start using staging.
