# Deployment topology — recommendation

**Status:** agreed in principle by the owner 2026-09-19 (many small
deployables, not one server). Refined the same day after the imported apps were
reviewed — see "Refinements after the intake" below.

**Requirement (owner):** one repository; the whole system must never go down at
once; deploying one app must not affect the others.

## Recommendation in one line

**One repo, many small deployables, one parent domain with a subdomain per
app, one central database with a separate database login per service.** Not
one server under one domain.

## Why not one server under one domain

One process serving every app is the cheapest and gives the simplest single
sign-on, but it fails the requirement outright: every deploy restarts
everything (and disconnects every park box), one memory leak or crash loop in
any module takes all apps down, and any change anywhere redeploys everyone.

## The shape

```
                         otoplay-apps.example  (one parent domain)
   apps.…      pos.…       team.…      radar.…     <app>.…        api.…        edge.…
  launcher      POS       OTO App      analytics    (each real    platform     box sync,
  (static)    (static     (static)     (static)      app)         API          webhooks
               PWA)                                                (service)    (service)
      │           │           │            │            │             │            │
      └───────────┴───────────┴── one login cookie on the parent domain ──┴────────┘
                                         │
                       Central PostgreSQL (one schema per app/module,
                       one database login per service, per-login limits)
```

1. **Every frontend is its own Render Static Site.** Static sites are served
   from a CDN: they deploy atomically with instant rollback, cost little or
   nothing, and cannot be taken down by a backend crash. Each site has a Render
   *root directory* and *build filter* so a commit that only touches
   `apps/radar/` redeploys only Radar.
2. **Backends are split by what must not fail together, not one per screen.**
   - `edge` — what the park depends on: box sync ingest, box command channel,
     payment webhooks. Deployed rarely and on purpose.
   - `api` — platform core: sign-in, launcher, admin, POS cloud APIs.
   - one service per imported app that arrives with its own backend (lifted
     as-is first; merged into `api` later only where that pays off).
   - `worker` — background jobs (rollups, notifications, polling) so heavy
     work never stalls a request-serving process.
3. **Subdomains, not paths.** A subdomain per app needs no reverse proxy in
   front (a proxy would be the new single point of failure) and isolates each
   app's browser storage and service worker — important for the POS PWA.
4. **One sign-in across all of them.** The session cookie is set on the parent
   domain, so every subdomain sends it. Each backend validates it with the
   shared `packages/auth` library directly against the central database — no
   call to a separate auth service, so there is no auth server whose outage
   logs everybody out. Needs a real domain: `*.onrender.com` cannot share
   cookies.
5. **The database is the one shared dependency — so fence it.** One Postgres,
   one schema per app/module, and **one database login per service** with its
   own connection limit and statement timeout. A runaway query or connection
   leak in one app then cannot starve the others. Analytics reads rollup
   tables, not live sales tables. Point-in-time recovery on; a standby can be
   added later without redesign.
6. **Migrations never break a running neighbour.** Each schema has its own
   migration stream, run as a pre-deploy step, always additive first
   (add → deploy → remove later). This is also what keeps the legacy tables
   import-compatible for cutover.
7. **The park does not depend on any of it minute to minute.** Counters run on
   their boxes (local-first). A cloud outage or a bad deploy delays sync and
   reports; it does not stop selling, printing, card payments or child release.

## Refinements after the intake (2026-09-19)

Reviewing the real apps changed three details; the principle stands.

1. **A lifted app is one deployable, not two.** OTO App and Radar each serve
   their UI and API from the same process, and their clients make ~660
   same-origin relative `/api` calls (about 40 of them would lose the session
   if the API moved to another origin). Each therefore deploys as **one Docker
   web service on its own subdomain** — `team.…`, `radar.…` — rather than a
   static site plus a backend. Isolation is unchanged: each is still its own
   deployable with its own database login.
2. **Both lifted apps run exactly one always-on instance.** They keep
   in-process timers (OTO App: midnight auto clock-out, recurring tasks,
   no-show alerts; Radar: the five-minute POS sync) and per-process state.
   Autoscale is what causes Radar's sync gaps today. `TZ=UTC` on both.
3. **Radar's database login needs a direct connection**, not a
   transaction-mode pooler: its sync uses session-level advisory locks. It
   also creates tables at runtime, so its login owns its schema.

Sizing note: OTO App renders PDFs with headless Chromium — give it 2 GB RAM.
The sum of per-login connection limits must stay under the database plan's
limit (each lifted app defaults to a pool of 10).

The diagram above still holds with `team.…` and `radar.…` read as services
rather than static sites, and with two additions: `console.…` (super admin,
static) and the booth game, which is served locally by each booth box.

## What goes down with what

| Failure | Affected | Not affected |
|---|---|---|
| Bad deploy of one frontend | That app only (instant rollback) | Everything else |
| Crash or deploy of a lifted app (OTO App, Radar) | That app only, for the length of a restart | POS, launcher, console, the other lifted app, boxes |
| Crash/deploy of `api` | Sign-in, launcher tiles list, POS cloud screens for ~seconds | Park counters (on boxes), static shells, other app backends for already-signed-in users |
| Deploy of `edge` | Box sync pauses and resumes; boxes queue locally | All selling at the park, all apps |
| Database outage | All cloud apps (the one true shared dependency) | Park counters keep trading offline and sync afterwards |
| Shared package change (`packages/ui`, `packages/auth`) | Rebuilds each dependent app — each still deploys and rolls back independently | — |

## Cost outline (check current Render pricing before committing)

Static sites are free or near-free. Expect roughly one small paid web service
per backend (3–6 services) plus a managed Postgres at the tier in the brief.
Order of magnitude: tens of US dollars a month for staging, low hundreds for
production. Far cheaper than the isolation would cost on self-managed servers.

## Trade-offs accepted

- More moving parts than one server (mitigated by one `render.yaml` blueprint
  in the repo that declares every service).
- A parent-domain cookie means every app on that domain is equally trusted;
  the public website and booking site therefore live on a different domain or
  never receive that cookie.
- Imported apps keep separate backends at first, so some logic is duplicated
  until convergence. That is the price of lifting them quickly and safely.
