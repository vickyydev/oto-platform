# OTO — operations platform for OTO Park

One repository for the whole OTO suite: the new POS, the platform API and
database, and (as they are imported) the client's existing apps — all on one
central database behind one sign-in.

## Map

```
apps/         deployable applications
  api/          Fastify API (platform core)
  pos/          POS: till, customer display, admin console, booking site
packages/     shared code used by every app
  db/           Drizzle schema, migrations, seed, test database helper
  shared/       money, phone, dates, ids, pricing, permissions, i18n
  config/       shared eslint / prettier / tsconfig
infra/        docker-compose for local Postgres + MinIO
scripts/      repo tooling (Jira evidence scripts)
docs/         briefs · architecture · features · progress · qa   → start at docs/README.md
imports/      raw Replit exports, production dump drop zone, vendor device docs
              (reference input only — never built, linted or deployed)
CLAUDE.md     working agreement + Sprint 1 brief (loaded by AI agents automatically)
```

## Run it locally

```
pnpm install
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate && pnpm db:seed
pnpm dev            # API on :3001, POS on :25741
```

Dev sign-ins: admin `0900000001` / `admin1234`, reception `0900000002` / `reception1234`.

`pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm build`
