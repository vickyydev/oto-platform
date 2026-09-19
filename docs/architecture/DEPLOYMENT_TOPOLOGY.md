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

## What the first deploy actually does (S2-01c, 2026-09-20)

`render.yaml` at the repository root declares the staging environment: the api
web service, the POS static site and one managed Postgres in Singapore with
point-in-time recovery. It departs from the shape above — or settles something
the shape left open — in six places, each reversible by configuration rather
than by a rewrite, and each also recorded in `SPRINT_2_PROGRESS.md`.

1. **`edge` and `jobs` run inside the `api` service**, selected by
   `PROCESS_ROLES=api,edge,jobs`, instead of being their own deployables. One
   park with one virtual box does not yet justify three services. The blueprint
   carries a commented-out `worker` service as the split's target; enabling it
   means uncommenting it and removing `jobs` from the api's roles.
2. **One database login, not one per service.** There is one service to fence
   off from today. The per-service logins with their own connection limits
   arrive with the lifted apps, which is when a runaway query in one of them
   could actually starve another.
3. **Paths within a site, not only subdomains.** Each frontend is still its own
   static site on its own host, but each carries a rewrite `/api/*` to the api
   rather than calling an `api.` host directly. There is no shared reverse
   proxy in front of everything — the thing item 3 warns against — because the
   rewrite belongs to the site and fails with it. The reasoning is in
   `ARCHITECTURE.md` §16.
4. **No parent-domain cookie, and none planned as the mechanism.** Item 4
   assumed one. `*.onrender.com` cannot carry one and the booking site will sit
   on another domain in any case, so the launcher's signed per-origin hand-off
   token (S2-02) is the permanent answer; a parent-domain cookie becomes an
   optional shortcut behind the same adapter once a real domain exists.
5. **The api is sized to autoscale and pinned to one instance.** The instance
   type is Standard (1 CPU, 2 GB), chosen for argon2id — every sign-in and
   unlock costs 19 MiB and two passes on a thread-pool thread, and reception
   signing on at opening is when that lands hardest — and because autoscaling
   on Render starts at Standard, so the switch is later a line rather than a
   plan migration. The switch is not thrown yet: the api carries `edge` and
   `jobs` in-process (item 1), and both assume a single process. A second
   instance would give the virtual box a second brain and run every schedule
   once per container. The blueprint therefore holds `numInstances: 1` and
   carries the `scaling` block beside it, commented, with the order that
   unlocks it — split `jobs` into the worker service, split `edge` out or
   move the box's state into a row, then swap the two settings.
   `maxInstances` is capped at 3 by arithmetic, not by preference: the pool is
   10 connections per instance, so three instances take 30 of a budget that
   also has to cover the pre-deploy migration, the future jobs worker and the
   lifted apps' own pools against the database's connection ceiling. The
   database is `basic_4gb` for the same reason plus two others — the S2-22
   restore runs a scratch copy and a `pg_restore -j4` on this server, and
   Radar's rollups want the sales tables in cache. Going past three instances
   needs a smaller per-instance pool or a pooler, and a transaction-mode
   pooler is exactly what item 3 of the refinements above rules out for the
   logins that take advisory locks.
6. **Staging sends real SMS.** Setup and reset codes go to a phone here as
   they will in production, not to the log. A code in a hosted log stream is a
   live credential sitting where anyone with log access can read it, and a
   delivery path exercised only in production is one nobody has tested. The
   api refuses to start on a deployment that has no way to send a message, so
   the Twilio credentials are a precondition of the first deploy rather than a
   later improvement. The cost is a few satang a code; the alternative was an
   account takeover path that only existed on the environment people are
   invited to play with.

Deploys are gated on CI rather than on the push: every service sets
`autoDeploy: false` and the `deploy` job in `.github/workflows/ci.yml` calls
Render's deploy hooks only after the build is green on `main`.
