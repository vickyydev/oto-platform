SCRUM-7 — Stack & reuse boundary
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Delivered: ARCHITECTURE.md in /oto-platform restates the decided stack (Fastify 5 + zod, Drizzle/Postgres 16, pnpm+Turborepo, ported React POS), the monorepo layout, the reuse boundary (prototype UI + frontend logic carried over; stub api-server and /lib scaffolding NOT reused), the operator-naming glossary, and decisions log D1–D8.
Evidence: document in repo; prototype layout verified by running it and walking every screen (screenshots retained).
