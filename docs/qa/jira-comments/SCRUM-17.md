SCRUM-17 — Locale, timezone, currency
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Unit tests: Thai local 0818953926 → +66818953926; "+66 81 895 3926"; 00-prefix international (prototype edge case); invalid rejected; satang round-trips and ฿ formats; Asia/Bangkok round-trip (18:30Z → next calendar day); rate-mode boundary dates.
i18n: scaffold now carries ALL FIVE customer languages (en/zh/th/ru/fr) with real approved strings; POS consults it before the full prototype dictionary. Live proof: /book rendered fully in Thai, Chinese, Russian and French including database-driven package names (screenshots).
