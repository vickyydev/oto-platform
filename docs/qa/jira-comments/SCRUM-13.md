SCRUM-13 — Scoped permission engine
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Unit tests (permissions.test.ts): operator scope covers its operator; platform-wide (null scope) covers every operator; branch/department/record scopes match only their ids; union across assignments.
Integration: 401 unauthenticated; branch-scoped reception grant ALLOWS member lookup on its branch; reception DENIED branch creation (403); GET /me/permissions returns effective permissions with scopes. Every Sprint 1 route sits behind requirePermission.
