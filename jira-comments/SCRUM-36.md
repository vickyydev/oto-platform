SCRUM-36 — Weekday/weekend/holiday pricing
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Unit+integration (all five DoD cases): weekday; Saturday; Sunday; weekday inside a holiday range → weekend with the holiday named; range boundaries inclusive (13th and 15th in, 16th out).
Live browser: POS header chip reads "Weekday pricing" from GET /branches/:id/pricing-mode (Fri 2026-09-11, branch tz); public bookings on the seeded Loy Krathong holiday (Tue 2026-11-24) priced at WEEKEND rates server-side (integration-verified ฿1,190 for 1 kid + 1 adult tourist 1-Hour).
