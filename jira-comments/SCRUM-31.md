SCRUM-31 — Create & enrich a member
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration: create from phone+name only (tier defaults tourist); duplicate phone IN ANY FORMAT → 409 MEMBER_EXISTS with memberId detail; PATCH enrich saves email/notes; audit rows.
Live browser: unknown phone on the identify step opens the "New member?" dialog; creating "Fern" shows the toast and applies the member to the sale. Public /book equivalent: unknown phone continues as guest with standard rates.
