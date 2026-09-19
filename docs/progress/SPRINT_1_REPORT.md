# Sprint 1 Report — Foundation, accounts, members, catalog (M1)

Delivered 2026-09-11. Tag: `sprint-1`. All 22 tickets complete; the sprint ran continuously per the working agreement, with checkpoint reviews waived by the client mid-run ("record and keep going") — the questions that would have gone to CP reviews are collected at the end.

## What was delivered

**Platform** (`/oto-platform` — new code only; the prototype repo is untouched reference):
- pnpm + Turborepo monorepo: `apps/api` (Fastify 5 + zod + OpenAPI at `/docs/json`), `apps/pos` (the ported prototype), `packages/db` (Drizzle + migrations + seed), `packages/shared` (phone/money/dates/pricing/permissions/i18n), `packages/config`, `infra/docker-compose.yml` (Postgres 16 + MinIO), CI workflow at repo-root `.github/workflows/oto-platform-ci.yml`.
- Full Section-4 schema plus the prototype's approved pricing/tax shapes (per-tier weekday/weekend satang prices, adult rules, per-category tax engine — decisions D1–D3/D6 in ARCHITECTURE.md), future-milestone tables present, every FK indexed, migrations apply cleanly twice from empty, seed ports the prototype catalog 1:1.
- Scoped permission engine (operator/branch/department/record, union-of-assignments, platform-wide grants), guard on every route, `GET /me/permissions`.
- Idempotency middleware on all mutating routes (replay / 409 mismatch / in-flight), audit log written by every mutating service with before/after, permission-guarded `GET /audit` with filters.
- MinIO-backed permission-bound files (presigned PUT/GET only after owner checks).
- Auth: argon2id phone+password sign-in with per-phone (5) and per-IP (20) cooldowns, invited-account setup and password recovery via single-use 10-minute SMS codes (console dev adapter), sign-out, forced change for temp passwords, sessions in httpOnly cookies (hashed at rest, sliding last-seen, branch on session).
- Admin APIs: accounts (invite/search/activate/deactivate/temp password), role assignments + effective permissions, operators + administrators (platform-wide gate), branches with timezone, ticket packages CRUD+archive with validation, holidays, tz-aware pricing-mode resolver, tax config + overrides + resolver (branch → category → product).
- Members: create from phone+name (operator-scoped duplicate rejection), enrich, lookup by any phone format with children + active tier verification, children CRUD with audited allergy edits, draft visits stamping `last_confirmed_at`.

**POS** (`apps/pos`): the prototype copied verbatim (316 files, design untouched) and wired — real sessions behind the unchanged lock screen (face scan stays a placeholder; sign-in/setup/reset forms added in its visual style), catalog hydration + write-through so the Tickets/Holidays/Tax/Branches/Members admin panels persist to the database, membership check through the session pending-lookup + `/members/lookup` with auto-tier, the new children-confirm modal creating draft visits, create-member dialog, API-driven pricing chip, Login Users + Operators admin panels, i18n scaffold wired ahead of the 5-language dictionary. Everything out of scope (§6) still renders on its mock data — verified screen by screen.

## Verification
- 66 automated tests green: 16 shared unit (phones incl. Thai local + 00-prefix, money, Bangkok tz round-trip, rate-mode boundary dates) + 50 API integration (every auth flow, scope combinations, idempotency replay/mismatch, audit coverage, file 403s, member/visit flows, all five pricing-resolver date cases, tax precedence chain).
- 2 Playwright smoke flows green against the running stack: lock → sign-in → lookup (keypad, through the API) → confirm 2 children → sign-out; unknown phone → create member.
- Acceptance checklist (§10) run against a freshly dropped/recreated database: migrations twice, seed, live walkthrough with screenshots; audit/visit/member rows spot-checked in Postgres afterwards.
- CI workflow complete but **not yet proven green on GitHub** — nothing has been pushed (that push is the client's call).

## Dev quick-start
```
cd oto-platform
pnpm install
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate && pnpm db:seed
pnpm dev          # API :3001 + POS :25741
```
Dev accounts: platform admin `+66 90 000 0001` / `admin1234` · reception `+66 90 000 0002` / `reception1234`. SMS codes appear in the API console log.

## UI additions (all in the prototype's design language)
Sign-in / setup / reset forms on the lock screen; create-member dialog; "Who's visiting today?" children modal; Admin → Access → Login Users and Operators panels; corrected the Tickets panel's stale "in-memory only" footnote and its `[object Object]` adult-price chip (pre-existing prototype bug).

## Deferred / known issues
- **Profile-photo upload UI**: endpoints + permission tests are done (SCRUM-16/25 backend complete); the prototype has no profile screen to hang the control on, so the UI was not invented — needs a client decision on placement (lock-screen badge menu vs. a new profile page).
- **Tier verification UI** stays on mock per §6 (schema + API-side reads exist).
- **Member tier admin edits** (verification writes from MembersPanel) are not persisted — display-only this sprint (§6).
- **Holiday edit** is delete+create under one id (no PATCH); invisible to the UI.
- Playwright's first run after a cold Vite start can time out while modules compile; the second run is stable (~9 s).
- In-memory sign-in throttle resets on API restart (documented D7 — only relaxes the limit).

## Suggested Sprint 2 preparation
1. Push to GitHub → confirm CI green on the runner (first checklist box that needs the remote).
2. Client answers to Q1–Q5 (below) before selling starts building on the pricing/tax shapes.
3. Decide the wristband/`transaction` payload details early — the empty tables exist, but M2 selling will freeze their columns.
4. Pick the SMS provider so the adapter gets a real implementation behind the console one.
5. Decide profile-photo UI placement.

## Questions for the client (carried from the waived checkpoint reviews)
- **Q1**: Confirm the per-tier price + adult-rule model (ported from the prototype) as the ticket_package shape, including `creditRule` instead of a flat `wallet_credit_amount`.
- **Q2**: Customer display ships 5 languages (en/zh/th/ru/fr) from the prototype; the brief's scaffold names en/th. Keep all five with en+th as the maintained scaffold files?
- **Q3**: Children are persisted with a `consent_recorded_at` stamp; BACKEND_REQUIREMENTS.md demands full consent records + retention + hard-delete before production. Sprint 2 ticket?
- **Q4**: Tier definitions are read from the API; tier CRUD (Markets & Tiers panel) stays mock. Wire it, or leave until the tier-evidence ticket?
- **Q5**: Tax follows the prototype's per-category engine with `tax_override` rows for category/product precedence — confirm as the SCRUM-37 interpretation.
