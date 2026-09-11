SCRUM-32 — Select & reconfirm children for a visit
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Integration: confirming children creates a DRAFT visit with visit_child rows and stamps child.last_confirmed_at; children of another member rejected; allergy PATCH audited with before/after; visit readable via API.
Live browser: after Mali's lookup the "Who's visiting today?" modal lists Nong Ploy (5, peanut allergy — editable in place) and Nong Tan (7); Confirm 2 children → toast + visit row in Postgres (2 visit_child rows, last_confirmed_at set). Playwright smoke covers the whole path.
