# Staging deployment — what exists on Render

_Last updated 2026-09-20, at the first deploy._

Everything below is live in the **Oto dev** Render workspace. Nothing here is
a plan: it is what is running, and what is not yet.

## The shape

Render **project `OTO Platform`**, with two environments so a production
environment sits beside staging later rather than colliding with it:

| Environment | Protected | Holds |
|---|---|---|
| `production` | yes | nothing yet |
| `staging` | no | the three resources below |

| Resource | Type | Plan | Region |
|---|---|---|---|
| `oto-db-staging` | Postgres 16 | `1c-2g` (1 CPU, 2 GB), 15 GB disk | Singapore |
| `oto-api-staging` | web service | `standard`, 1 instance | Singapore |
| `oto-pos-staging` | static site | — | CDN |

- POS: <https://oto-pos-staging.onrender.com> — **live**
- API: <https://oto-api-staging.onrender.com> — **live**

## What already works

- **Both services are live.** The POS serves its client routes, and `/api/*`
  rewrites to the api, so the session cookie stays same-origin and the dev
  proxy and the deployment are one code path.
- **Migrations and the seed ran against the real database.** The deploy log
  reads `migrations applied successfully`, then
  `Full seed (SEED_PROFILE=staging): platform rows plus the demo tenant`, then
  `Seed complete: operator OTO, branch HKT Central, roles, accounts, members,
  catalog.` The database is ready to sign in to.
- **Auto-deploy is gated on CI, with no credential on the GitHub side.** Both
  services use Render's `checksPass` trigger: Render watches the repository,
  waits for the `ci` workflow's commit status, and deploys only when it is
  green. The alternative — a deploy hook or an API key in repository secrets —
  would put a key to the whole workspace within reach of anyone who can push a
  workflow file, so the CI workflow deliberately has no deploy job.
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
