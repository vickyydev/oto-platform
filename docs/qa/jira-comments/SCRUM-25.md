SCRUM-25 — Profile & photo
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration: GET /me returns account+employee+branch+permissions+photoFileId; strict PATCH /me saves permitted fields and REJECTS unknown fields (schema strict); photo upload/download via SCRUM-16 flow proven end-to-end.
Deferred: a dedicated profile-photo UI control — the prototype has no profile screen; needs a placement decision.
