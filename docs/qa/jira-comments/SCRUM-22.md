SCRUM-22 — Review & change effective permissions
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration: GET /accounts/:id/permissions returns assignments + resolved effective permissions; adding/removing a role assignment is audited and immediately reflected.
Live browser: the Login Users panel's shield action opens the permissions dialog listing role assignments with scope labels and the full effective-permission chip set; Remove works in place.
