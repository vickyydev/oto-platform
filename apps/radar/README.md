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

## Sign-on and the route census

Radar has no users of its own: the platform session is the identity. The
launcher opens `https://<radar>/#handoff=<token>`; the client posts the token
to `POST /api/auth/handoff`, which exchanges it with the platform
(`POST /auth/handoff/exchange`, sent from `RADAR_PUBLIC_ORIGIN`) and sets an
httpOnly `radar_session` cookie carrying the platform session's own token.
Every private request asks the platform who that is (`GET /me`,
`GET /me/permissions`, cached ten seconds) and needs `app:radar:access`.
`POST /api/auth/sign-out` clears Radar's cookie only.

`server/routeCensus.ts` lists every route as public, key-protected or
guarded; anything under `/api` that is not public or key-protected needs the
session, listed or not. `npm run test:census` walks the router and fails on
a route nobody classified.

## Figures

Every park's figures come from the platform's `GET /analytics/summary` (the
OTO POS rollup) through `server/sources/otoPos.ts`, read with the signed-in
person's own session — Radar holds no service credential, so the platform
decides what each person may see. The booth report reads
`GET /analytics/booths` the same way. Radar's park keys (`floresta`,
`chalong`) are matched to platform branches by name. The Pisell and Papaya
pipelines, their tables and every screen that read them are gone.

The external marketing summary keeps its key and rate limit but answers 503:
it has no person's session to read the platform with.

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
| `PLATFORM_API_URL` | Sign-on and every figure: the platform api's base URL. Unset, private routes answer 503. |
| `RADAR_PUBLIC_ORIGIN` | Sign-on: Radar's own origin, equal to the `radar=` entry of the api's `HANDOFF_APP_ORIGINS` (and listed in its `ALLOWED_ORIGINS`). |
| `LAUNCHER_URL` | Optional: the OTO launcher's address (absolute http/https). Set, signing out of Radar lands there, and every signed-out or refused screen carries an "Open the launcher" button. Unset, sign-out stays on Radar's own "open from the launcher" page with no link. |
| `PORT` | Listen port (default 5000; 8080 in the image). |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | The trends assistant; unset answers 503. |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | Optional; unset uses the provider default. |
| `SPIN_WIN_REDEEM_KEY` | The legacy wheel's ingest/issue routes, kept until its URL retires at cutover; unset answers 503. |
| `OTO_RADAR_MARKETING_API_KEY` | The external marketing summary (authenticates, then 503 — see Figures). |
| `LOG_RESPONSE_BODY` | `false` keeps response bodies out of logs (the image sets it). |
| `APP_VERSION`, `APP_CHANGE_ID` | Reported by `/healthz`. |

`npm run check:ratchet` holds the inherited TypeScript diagnostics at the
ceiling in `script/typecheck-baseline.json`.
