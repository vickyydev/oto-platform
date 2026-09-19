SCRUM-15 — Idempotency & safeguards
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration tests: same Idempotency-Key + same body twice → ONE member row, identical replayed response; same key + different body → 409 IDEMPOTENCY_MISMATCH. Business-key uniqueness under it: member/account phone unique per operator, branch code unique. Pattern documented in ARCHITECTURE.md §9; POS clients send a UUID key on every mutating call.
