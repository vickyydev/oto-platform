SCRUM-30 — Find a returning member by phone
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration: lookup with dashes/local format returns the E.164-stored member with children and active tier verification; unknown phone → null.
Live browser: customer types 0811111111 on the CUSTOMER DISPLAY keypad → staged as the session pending-lookup → till consumes it via the API (CLAUDE.md §7.4 — no shared browser state) → Mali appears with the Thai · verified chip and "Welcome back, Mali!" on the display. Screenshots retained.
