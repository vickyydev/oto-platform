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
| `oto-db-staging` | Postgres 16 | `basic_1gb`, 15 GB disk | Singapore |
| `oto-api-staging` | web service | `standard`, 1 instance | Singapore |
| `oto-pos-staging` | static site | — | CDN |

- POS: <https://oto-pos-staging.onrender.com> — **live**
- API: <https://oto-api-staging.onrender.com> — built and migrated, **not yet
  serving** (see "What is missing")

## What already works

- **The POS is live** and serves its client routes; `/api/*` rewrites to the
  api service, so the session cookie stays same-origin and the dev proxy and
  the deployment are one code path. `/api/health` currently answers 502
  because the api is not up — which is itself proof the rewrite reaches it.
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

## What is missing — three values

The api builds, migrates and seeds, then refuses to start:

```
Error: SMS_ADAPTER=twilio but TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
TWILIO_FROM are not set. Set them, or set SMS_ADAPTER=console on a local
machine; there is no fallback, because …
```

That is the guard working, not a defect. A deployment that quietly printed
verification codes into a hosted log stream would put a live credential where
anyone with log access can read it, and would leave every person who tried to
set up an account waiting for a text that was never sent.

Set the three on `oto-api-staging`, then turn its auto-deploy back on
(`checksPass`) and deploy. Its auto-deploy is **off** meanwhile, so it does
not retry and fail every time something merges.

## Decisions taken at the first deploy

- **`basic_1gb`, not `basic_4gb`.** The blueprint argued for 4 GB against the
  S2-22 restore and the analytics rollups. The dump is 33 MB, and the
  connection budget written into `render.yaml` (68 of 97) already fits the
  1 GB ceiling. Render changes the plan in place, so this is reversible in a
  click before the restore; over-provisioning a staging database is not.
- **The database is `basic_1gb` rather than the free type** because the free
  one expires after 30 days and carries no backups — a cliff in the middle of
  the sprint.
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
