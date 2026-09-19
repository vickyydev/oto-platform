SCRUM-9 — Monorepo, CI/CD, error tracking
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Test case: clean-machine bring-up = pnpm install && docker compose -f infra/docker-compose.yml up -d && pnpm db:migrate && pnpm db:seed && pnpm dev → API on :3001 (/health, /ready OK) and POS on :25741. Executed repeatedly, including from a freshly dropped database.
CI: .github/workflows/oto-platform-ci.yml runs typecheck → lint → migrations-twice-from-empty → seed → tests (PG16 service container) → build. Not yet proven on GitHub (nothing pushed — client's call).
Error hook: pino request-id logging verified in every API log line; Sentry hook no-op without DSN.
