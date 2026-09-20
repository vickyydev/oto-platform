# Staging deployment — what exists on Render

_Last updated 2026-09-20, with the console (S2-03) and the OTO App (S2-17a)._

Everything below is live in the **Oto dev** Render workspace. Nothing here is
a plan: it is what is running, and what is not yet.

## The shape

Render **project `OTO Platform`**, with two environments so a production
environment sits beside staging later rather than colliding with it:

| Environment | Protected | Holds |
|---|---|---|
| `production` | yes | nothing yet |
| `staging` | no | the four resources below |

| Resource | Type | Plan | Region |
|---|---|---|---|
| `oto-db-staging` | Postgres 16 | `1c-2g` (1 CPU, 2 GB), 15 GB disk | Singapore |
| `oto-api-staging` | web service | `standard`, 1 instance | Singapore |
| `oto-pos-staging` | static site | — | CDN |
| `oto-launcher-staging` | static site | — | CDN |
| `oto-console-staging` | static site | — | CDN |
| `oto-app-staging` | Docker web service | `standard`, 1 instance | Singapore |

- Launcher: <https://oto-launcher-staging.onrender.com> — **live**
- POS: <https://oto-pos-staging.onrender.com> — **live**
- Console: <https://oto-console-staging.onrender.com> — **live**
- API: <https://oto-api-staging.onrender.com> — **live**
- OTO App: <https://oto-app-staging.onrender.com> — **declared, not yet created**

**The services were created one at a time from the API, not from a blueprint,
so `render.yaml` is a description rather than the thing Render reads.** Both
were drifting — the console had been live since S2-03 without appearing in the
file at all — and the file has been brought back level with what is running
(commit 3d9b6c1). Treat a change there as needing a matching change in the
dashboard until a blueprint is actually connected.

## What already works

- **All three services are live.** Each static site serves its client routes
  and rewrites `/api/*` to the api, so every session cookie stays same-origin
  on the origin that set it, and the dev proxy and the deployment are one code
  path.
- **One sign-in opens both apps.** The launcher signs a person in on its own
  origin and mints a short-lived signed token aimed at the POS; the POS
  exchanges it for its own cookie against the same session row. The api
  carries both origins in `ALLOWED_ORIGINS` — each app writes from its own —
  and only real hand-off *targets* in `HANDOFF_APP_ORIGINS`. The launcher is
  absent from that second list on purpose: it is the issuer, and naming it
  there stops the api booting.
- **Migrations and the seed ran against the real database.** The deploy log
  reads `migrations applied successfully`, then
  `Full seed (SEED_PROFILE=staging): platform rows plus the demo tenant`, then
  `Seed complete: operator OTO, branch HKT Central, roles, accounts, members,
  catalog.` The database is ready to sign in to.
- **Auto-deploy is gated on CI, with no credential on the GitHub side.** All
  three services use Render's `checksPass` trigger: Render watches the
  repository, waits for the `ci` workflow's commit status, and deploys only
  when it is green. The alternative — a deploy hook or an API key in
  repository secrets — would put a key to the whole workspace within reach of
  anyone who can push a workflow file, so the CI workflow deliberately has no
  deploy job.
- **The database is unreachable from the public internet** (`ipAllowList: []`).
  Only services in this workspace can connect. To run a one-off `psql` or the
  S2-22 restore from a laptop, add that address temporarily and remove it.

## Verified against the live deployment

- `/health` 200 and `/ready` reports the database reachable.
- Sign-in through the POS origin returns a session cookie marked
  `HttpOnly; Secure; SameSite=Lax` — the rewrite keeps it same-origin.
- The Sprint 1 membership check: `+66811111111` returns Mali with her tier
  verification and both children.
- A write carrying a foreign `Origin` is refused `ORIGIN_NOT_ALLOWED`.
- A member id belonging to no operator of the caller answers **404**.
- Both Playwright smoke flows pass against the two Render origins
  (`SMOKE_BASE_URL=https://oto-pos-staging.onrender.com pnpm --filter @oto/pos
  exec playwright test`): lock, sign in, membership lookup, child confirm,
  lock, unlock, sign out; and the create-member path.

SMS authenticates with a Twilio **Standard API key** rather than the account
auth token, so the credential this deployment uses is revoked and rotated on
its own. The account is a trial one for now: it can only text numbers added
to Verified Caller IDs in the Twilio console.

### The hand-off, across the two live origins (S2-02)

Run end to end against the deployed services, not in a test harness:

- Sign-in on the **launcher** origin: **200**, with its own session cookie.
- Minting a hand-off for the POS: **200**, `audience: pos`, and a `launchUrl`
  pointing at the POS host. The token is in the URL **fragment** and the query
  string is empty — a fragment is never sent to a server, so the credential
  reaches no access log, no proxy and no `Referer` on the next click.
- Exchanging it at the **POS** origin: **200**, and `/me` on the POS then
  answers **200** — one platform session, two app cookies, no second prompt.
- Replaying the same token: refused **`HANDOFF_REJECTED`**, reason
  `replayed`. The jti is claimed in a single statement, so a second tab racing
  the same fragment cannot win either.
- Reception asking for a **console** token: refused **`FORBIDDEN`** —
  `app:console:access` is not in that role. A tile a person cannot open is not
  a tile the api will mint for.

## Decisions taken at the first deploy

- **`1c-2g`, not `basic_4gb`.** Measured rather than guessed: the seeded
  database is 10 MB across 38 tables, and `max_connections` is **103** where
  the blueprint had budgeted 68 — so the connection argument for a larger
  plan did not survive contact with the real server. 2 GB caches the eventual
  33 MB restore many times over, and doubles the CPU from the 1 GB tier,
  which is what `pg_restore -j4` will actually want. Resizing is a plan
  change in place with a short restart, done here while nothing was live.
- **A paid database rather than the free type** because the free one expires
  after 30 days and carries no backups — a cliff in the middle of the sprint.
- **The api is `standard`, not `starter`:** argon2id on every sign-in makes
  the process CPU-bound, the free and starter types spin down when idle (a
  ~50 s cold start the first time someone opens the till), and Render's
  autoscaling only begins at `standard`.
- **Autoscaling is configured but commented out**, with the three things that
  must happen first written beside it. The api carries `PROCESS_ROLES=api,
  edge,jobs`: a second instance would give the virtual box a second brain and
  run every schedule twice. Raising the instance count before `jobs` splits
  out is a bug, not a scale-up.

## Where the credentials live

Nothing secret is in this repository. The Render API key, the object-storage
keys and the Jira token are in the gitignored `.env`; the service's own values
are set on the service in Render. `render.yaml` carries variable **names**
only, with `sync: false` where a person must supply the value.

The hand-off keyring (`HANDOFF_SIGNING_KEY`) is one of those values, and it is
a keyring rather than a key so that replacing it is expand and contract:
prepend a new `<kid>:<secret>` pair, deploy, and drop the old entry once every
token it signed has expired — 60 seconds at the TTL set here.

**The staging database password was printed into a session transcript on
2026-09-20 and should be rotated.** Render dashboard → `oto-db-staging` →
Info → *Reset database password*; services wired with `fromDatabase` pick the
new value up on their next deploy. The exposure is bounded — the string was
the internal hostname (`dpg-…-a`), which resolves only inside the Render
private network, and the database has `ipAllowList: []` so it is unreachable
from the internet either way — but a password in a log is a password to
replace, not to reason about.

### One database login, for now

The OTO App connects with the same `oto_platform` login the api uses, with
`search_path=otoapp` set as a connection startup parameter. The target
(DEPLOYMENT_TOPOLOGY.md item 5) is a login per service so a connection leak in
one app cannot starve the others, and `render.yaml` writes out the SQL for an
`oto_app` role with its own connection limit. It is deliberately not done yet:
creating it means connecting to the database with the superuser credential,
which is the thing being rotated above, and the split matters when the
production restore lands — S2-17b, where the connection budget is already on
the list.
