SCRUM-24 — Sign out
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration: POST /auth/sign-out deletes the session row; the old cookie is rejected. Playwright smoke: the operator-badge lock button returns the POS to the lock screen. Bonus hardening: any API 401 mid-session (expiry/deactivation elsewhere) locks the POS immediately via a global handler.
