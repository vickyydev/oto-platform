SCRUM-8 — System inventory
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Delivered: SPRINT_1_PROGRESS.md holds the full screen inventory (every route marked wire-to-API / keep-on-mock / out-of-scope) and the logic inventory mapping each business rule to its prototype file:function and owning ticket (pricing, weekday/weekend, membership flow, children shape, inactivity lock, tax engine, phone rules).
Test case: inventories were used as the port source for every later ticket; deviations from the brief (per-tier adult rules, tax engine, 5 languages) raised as D1–D8/Q1–Q5 rather than silently coded.
