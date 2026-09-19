SCRUM-21 — Create staff account & assign access
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration: admin creates an account with employeeName + reception role scoped to HKT Central; invitation code sent via the SMS adapter; the new account completes setup and signs in end-to-end.
Live browser: Admin → Access → Login Users → "Invite staff account" dialog (name, phone, role, branch scope) creates the invited row; audit recorded.
