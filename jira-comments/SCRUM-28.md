SCRUM-28 — Manage login users
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration: deactivated account cannot sign in (clear ACCOUNT_INACTIVE message) and its live sessions die; temporary password returned once to the admin, signs in, guarded endpoints blocked with MUST_CHANGE_PASSWORD until changed, then unblocked.
Live browser: search, invite, activate/deactivate and temp-password actions in the Login Users panel — both destructive actions now behind confirmation dialogs.
