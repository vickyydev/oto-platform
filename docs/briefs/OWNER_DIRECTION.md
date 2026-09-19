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

## 2026-09-19 (later) — after the apps were exported

**The suite**
- Deployment shape agreed: many small deployables, a subdomain per app — not one
  server under one domain.
- The real apps are three: **OTO App**, **OTO Radar**, **Lucky Wheel**. Exports
  are in `imports/`; database files in `imports/_db/`.
- The suite opens on a launcher listing the apps; staff pick the app they use
  and sign in. Four app frontends — POS, OTO App, lucky wheel, Radar — plus a
  **fifth, built by us: a super admin** that oversees and controls everything:
  all apps' analytics report to it; activity logs (which staff did what); user
  control and permissions; POS station setup. Exact contents to be decided
  later; it must be in the plan from the start.
- One central database. Login tokens may be shared or separate per app — the
  database is what must be central.
- Analytics must come from our own database too, **and** Radar's history must
  be imported so cumulative totals include the past, not only sales made after
  the new system starts.
- The POS staff screen and customer screen will be **separate devices**; how
  their session is linked must be planned.
- The wheel game is a web page with a button and hard-coded prizes; it must
  become controlled from the admin side.
- Assume the previous developer (the agency) will not provide their servers or
  deployment. We set everything up ourselves.
- Do not worry about secret values: find the environment variable *names* in
  the code so we know what to provision.
- The hard part is the backend: robust and fast, no delays, with Raspberry Pi
  boxes operating the park devices.

**Corrected by the review** (details in
`docs/architecture/EXISTING_SYSTEMS.md`)
- The parks use **two** third-party POS systems — Pisell (Floresta) and Papaya
  (Chalong) — not Papaya alone. OTO POS replaces both.
- Radar has no sales-booth or voucher-booth feed; "Sales Booth" is a marketing
  channel derived from Pisell voucher data. The only pushed booth data is the
  wheel.
- Radar and the wheel run on Replit with their own databases; only OTO App is
  on AWS (App Runner, not Kubernetes). The database called `oto_staging` holds
  the live data.
- The Radar database file is a structure listing without data; a real dump is
  needed.

## 2026-09-20 — scope of Sprint 2 widened; decisions changed

Stated after reading the first Sprint 2 proposal. These win over
`PROJECT_CONTEXT.md` §7.2 (2C2P) and over the earlier "OTO App in Sprint 3".

**Order of work inside the sprint** (priority, not separate sprints):
1. **POS first**, complete: everything the prototype has — the till, the
   customer display, the POS's own admin panels, the booking-site screen, the
   inventory/stock controls — plus the **Lucky Wheel voucher game** with its
   admin control panel. Every function is committed as it lands and recorded in
   the progress log so any new agent resumes exactly where the last one
   stopped.
2. **OTO App**: its tables go into the central database **now** (its own
   schema), so the demo can prove one sign-on across apps and one database: an
   admin creates a user, the user opens the OTO App through the launcher. Then
   the whole live app is lifted onto the platform, improved where it can be,
   and the features still owed under the contract — taken from the agency's
   proposal site (`docs/briefs/AGENCY_PROPOSAL.md`) — are built. The POS keeps
   its own admin; the OTO App keeps its own admin controls. Both in this sprint.
3. **Radar active at the same time**: legacy Pisell/Papaya figures as seeded
   mock data, and **live analytics from our POS** — a demo sale made on staging
   must appear in Radar when the branch's source preference is "OTO POS".
4. **Unified Inbox** (the client's work in progress, imported as
   `imports/oto-asset-manager/`; milestone 4): its data pillars are laid in the
   central database now and a mockup shell sits on the launcher, styled per the
   client's design.

**Launcher**: the first screen is a styled, OTO-Park-themed landing page
listing the apps (POS, OTO App, Radar, Lucky Wheel, Console, Inbox) with
"coming soon" placeholders where an app is not ready; it is also where the
central login is tested.

**Payments**: QR payments are integrated for real through the park's payment
gateway sandbox, not simulated. The owner first called it "the SCB payment
gateway" and then pointed at `developer.2c2p.com`: the gateway is **2C2P**
(SCB is the acquiring bank behind the park's merchant account), so
PROJECT_CONTEXT §7.2 stands — 2C2P Payment Token / Do Payment for the QR on
the customer display, the Redirect API for the booking site, sandbox first
with real QR codes, production by configuration. The owner supplies the
merchant credentials; the plan lists exactly what is needed
(`docs/architecture/PAYMENT_GATEWAY.md`). If the park also holds an SCB
Developer Portal application (direct PromptPay API), it is added as a second
`QrPayment` provider, not a replacement. Card payments stay on the EDC
terminals through their ECR specifications.

**Devices**: the park's hardware reference and the gate documents (GE-X2
protocol, HX-X1 manual, supplier answers, reader HTTP spec) are on file; the
adapters and simulators use the real models, protocols and values
(`docs/architecture/DEVICE_INVENTORY.md`).

**Revenue, prices, receipts**: use the Replit code as the definition — Radar's
formula for revenue, the prototype's price list and tiers, the prototype's
receipt layout and the voucher sample for print templates. No accountant
session now; corrections are entered later as data.

**Process**: besides the ticket plan, a development and technical plan must
exist for AI agents with all context, research and conclusions, so an agent
can always resume with enough context.

## 2026-09-20 (later) — one sprint for all the software; no Sprint 3

Given after reading plan v2. These decisions replace every "Sprint 3" in the
earlier documents.

- **There is no Sprint 3.** Sprint 2 finishes **all** the software. What
  follows it is not another development sprint but **on-site testing with the
  real devices at the park**: connect the hardware, fix what the real world
  breaks, and let the client play with the whole suite against the real
  backend. Anything the plan previously pushed to "Sprint 3" is either built
  now or is an on-site/credential step — and must be labelled as such, never
  as deferred development.
- **Staging is production-grade.** The Render environment is called staging
  and keeps the staging safeties, but the code in it is the production code.
  It stays staging only because the agency's system is still live; when the
  suite proves itself on site, that same build becomes production.
- **Start from the real production data.** The OTO App dump already in
  `imports/_db/db-structure-with-data-dump-for-oto-app.sql` (33 MB, live rows)
  is the starting point for the OTO App on the central database. Radar is fed
  real figures so it has something to show, and changes made on the POS show
  up as effects.
- **Data-source switch is an admin control.** An administrator — from the OTO
  App's admin and from the Console — chooses per branch whether the analytics
  shown are the current POS (Pisell/Papaya) or the new OTO POS.
- **Face clock-in:** keep the module but **off behind a flag** on staging;
  the flag is flipped later if the owner wants it (Open decision 29 closed).
- **Payment gateway:** the bank confirmed that the URL the owner sent
  (`developer.2c2p.com`) carries the sandbox API documentation. Build against
  the real documented API now; the credentials arrive later and go into
  `.env` as `PGW_*`. No mock QR where the real API can be used.
- **Super admin (Console) is the owner's own control surface.** The POS keeps
  its admin for POS operations and the OTO App keeps its admin for internal
  operations; the Console is deliberately an addition *for the owner*, so that
  future control is easy. We design it ourselves: think through every control
  worth having across all apps, plan it properly, describe it fully in the
  Jira ticket, and build it in this sprint.
- Simulations must be built on the **real documents and data** already
  captured, never on guesses: the gate protocol, the terminal dialects, the
  printer command sets and the payment API are all on file
  (`docs/architecture/DEVICE_INVENTORY.md`, `PAYMENT_GATEWAY.md`).

## Open with the owner

Consolidated in `docs/architecture/PLATFORM_PLAN.md` §14 and
`docs/progress/SPRINT_2_PLAN.md` "Open decisions". In short:

- Real dumps of Radar's and the wheel's databases; a `pg_dump -Fc` of OTO App.
- Pisell / Papaya / spin / marketing / OpenAI values from Replit Secrets — and
  no cancellation of Pisell or Papaya until the history export is done.
- S3 bucket contents; who controls DNS for the `otoplay` domains; whether the
  agency hands over OTO App's session and kiosk secrets.
- Staff clock-in: keep face recognition (re-enrol in our own AWS) or switch to
  PIN / phone + photo — the brief bans biometrics, the live app uses them daily.
- Revenue definition for OTO POS; who owns supervised care; cutover shape;
  Replit change freeze; spin eligibility; seeding members from check-in history.
- Render account and paid plan, a staging domain with DNS access, vendor device
  documents, a Raspberry Pi 5 / iPad on hand before travelling, target date.
