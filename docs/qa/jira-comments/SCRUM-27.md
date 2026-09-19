SCRUM-27 — Operators, branches, administrators
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration: platform admin creates a second operator, assigns an administrator (invited operator_admin with SMS code), archives the operator → hidden from pickers; branch created WITH timezone and archived out of the picker.
Live browser: Admin → Access → Operators panel with archive-confirmation dialog; Branches panel persists via the write-through bridge.
