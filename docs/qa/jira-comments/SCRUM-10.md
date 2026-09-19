SCRUM-10 — Data model & schema baseline
Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).

Test case: drizzle-kit migrate run twice from an empty database in a row — clean both times (also enforced in CI). Seed populates operator OTO, HKT Central (Asia/Bangkok), departments, 5 system roles from shared permission bundles, dev accounts, 6 members with children (peanut-allergy case included), the prototype's 4 ticket packages at exact prices (satang), holiday range, 7% inclusive VAT config.
Every FK indexed; ER diagram in ARCHITECTURE.md §8. Prototype-shaped pricing/tax stored as validated jsonb (zod schemas in @oto/shared) — decisions D1–D3, D6.
