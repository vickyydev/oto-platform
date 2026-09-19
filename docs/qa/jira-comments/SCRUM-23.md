SCRUM-23 — Password recovery
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration: reset code to verified phone; complete sets the new password AND deletes every session (old cookie rejected on /me afterwards); the used code cannot be replayed; expired codes refused with a clear message.
