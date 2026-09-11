SCRUM-20 — Account setup
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration: invited account cannot sign in (403 SETUP_REQUIRED with clear message); setup code delivered via pluggable SMS adapter (console in dev, captured in tests); setup/complete verifies the 6-digit single-use code and sets the password; consumed code refused on reuse; expired code refused; after setup, sign-in works.
