# OTO Radar

The park's revenue dashboard, lifted onto this platform (S2-18, SCRUM-219).

A **working copy**, not a reference copy: the read-only export stays at
`imports/oto-radar/` and is never built or deployed. Like `apps/oto-app` it
keeps npm and its own `package-lock.json`, is excluded from the pnpm
workspace, serves client and server from one Express process, and is built
from its `Dockerfile`. Commands in this directory use `npm`.

## What was left behind

Dumps, archives, cookies, env files, fixtures with passwords, the inherited
HR Playwright tests, Replit integrations and plugins, the shared-password
staff login, and the export's migration chain (HR tables plus a seed of staff
names and birth dates). The Pisell and Papaya sync pipelines and the five
push/import/wipe routes were deleted: Radar's figures come from the OTO POS
rollup (`GET /analytics/summary`), not from those systems.

## Schema

Tables live in schema `radar` of the platform database. The SQL is
unqualified; `script/migrate.mjs` applies it with `search_path=radar`, and the
server's pool sets the same search path on every connection. The ledger is
`radar.__drizzle_migrations`.

- `npm run db:migrate` is the only way the schema changes. The server never
  migrates at boot and exits if the ledger is missing.
- After `npm run db:generate`, strip every `"public".` from the new SQL; the
  migrator refuses a file that still has one.

## Run locally

```sh
npm ci
DATABASE_URL=postgres://... npm run db:migrate
DATABASE_URL=postgres://... npm run dev          # or: npm run build && npm start
```

| Variable | Needed for |
|---|---|
| `DATABASE_URL` | Always. A direct (non-transaction-pooled) Postgres URL. |
| `PORT` | Listen port (default 5000; 8080 in the image). |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | The trends assistant; unset answers 503. |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | Optional; unset uses the provider default. |
| `SPIN_WIN_REDEEM_KEY` | The Spin & Win ingest/issue routes; unset answers 503. |
| `OTO_RADAR_MARKETING_API_KEY` | The external marketing summary; unset answers 503. |
| `LOG_RESPONSE_BODY` | `false` keeps response bodies out of logs (the image sets it). |
| `APP_VERSION`, `APP_CHANGE_ID` | Reported by `/healthz`. |

`npm run check:ratchet` holds the inherited TypeScript diagnostics at the
ceiling in `script/typecheck-baseline.json`.
