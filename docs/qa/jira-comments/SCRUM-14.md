SCRUM-14 — Audit log
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration tests assert audit rows with before/after for account.create, role_assignment.create, member.create, ticket_package.update; GET /audit filters by entity and is permission-guarded (reception 403, admin 200).
Live proof: after the browser walkthroughs, Postgres shows rows for auth.sign_in, member.create, visit.create, ticket_package.create/archive, booking.create — every mutating action audited.
