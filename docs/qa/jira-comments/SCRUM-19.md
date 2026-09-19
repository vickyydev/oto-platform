SCRUM-19 — Sign in by phone
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration: active account signs in (session row present, Thai local format accepted); wrong password 401; SIXTH attempt after 5 failures → 429 with cooldown message; per-IP throttle at 4× so shared reception IPs are not locked by one phone (D7).
Live browser: lock screen keeps the prototype design with the added phone+password form; reception signs in and lands on the till with the operator badge showing the DB employee name. "Scan my face" remains a placeholder with a friendly hint.
