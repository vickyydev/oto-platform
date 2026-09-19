SCRUM-16 — Permission-bound file storage
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration tests against real MinIO: register → presigned PUT upload → presigned GET download → byte-for-byte compare; /me surfaces the photo id. Access control: another account's file → 403 (reception lacks admin:account:read); unauthenticated → 401. Objects never public — only short-lived signed URLs after an owner-entity permission check.
