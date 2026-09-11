// Generates jira-comments/SCRUM-<n>.md — the test-evidence comment for each
// Sprint 1 ticket. Run `node scripts/post-jira-comments.mjs` afterwards to
// post them (needs JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN in the env or
// /oto-platform/.env).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'jira-comments');
mkdirSync(OUT, { recursive: true });

const RUN = `Verified 2026-09-11 on commit tagged sprint-1+ (branch main), local stack: Fastify API :3001 + Postgres 16 (Docker) + MinIO + ported POS :25741. Full suites: 19 shared unit tests, 57 API integration tests (real Postgres per run), 2 Playwright smoke flows, plus scripted live-browser walkthroughs with screenshots (headless Edge).`;

const tickets = {
  7: `SCRUM-7 — Stack & reuse boundary
${RUN}

Delivered: ARCHITECTURE.md in /oto-platform restates the decided stack (Fastify 5 + zod, Drizzle/Postgres 16, pnpm+Turborepo, ported React POS), the monorepo layout, the reuse boundary (prototype UI + frontend logic carried over; stub api-server and /lib scaffolding NOT reused), the operator-naming glossary, and decisions log D1–D8.
Evidence: document in repo; prototype layout verified by running it and walking every screen (screenshots retained).`,
  8: `SCRUM-8 — System inventory
${RUN}

Delivered: SPRINT_1_PROGRESS.md holds the full screen inventory (every route marked wire-to-API / keep-on-mock / out-of-scope) and the logic inventory mapping each business rule to its prototype file:function and owning ticket (pricing, weekday/weekend, membership flow, children shape, inactivity lock, tax engine, phone rules).
Test case: inventories were used as the port source for every later ticket; deviations from the brief (per-tier adult rules, tax engine, 5 languages) raised as D1–D8/Q1–Q5 rather than silently coded.`,
  9: `SCRUM-9 — Monorepo, CI/CD, error tracking
${RUN}

Test case: clean-machine bring-up = pnpm install && docker compose -f infra/docker-compose.yml up -d && pnpm db:migrate && pnpm db:seed && pnpm dev → API on :3001 (/health, /ready OK) and POS on :25741. Executed repeatedly, including from a freshly dropped database.
CI: .github/workflows/oto-platform-ci.yml runs typecheck → lint → migrations-twice-from-empty → seed → tests (PG16 service container) → build. Not yet proven on GitHub (nothing pushed — client's call).
Error hook: pino request-id logging verified in every API log line; Sentry hook no-op without DSN.`,
  10: `SCRUM-10 — Data model & schema baseline
${RUN}

Test case: drizzle-kit migrate run twice from an empty database in a row — clean both times (also enforced in CI). Seed populates operator OTO, HKT Central (Asia/Bangkok), departments, 5 system roles from shared permission bundles, dev accounts, 6 members with children (peanut-allergy case included), the prototype's 4 ticket packages at exact prices (satang), holiday range, 7% inclusive VAT config.
Every FK indexed; ER diagram in ARCHITECTURE.md §8. Prototype-shaped pricing/tax stored as validated jsonb (zod schemas in @oto/shared) — decisions D1–D3, D6.`,
  13: `SCRUM-13 — Scoped permission engine
${RUN}

Unit tests (permissions.test.ts): operator scope covers its operator; platform-wide (null scope) covers every operator; branch/department/record scopes match only their ids; union across assignments.
Integration: 401 unauthenticated; branch-scoped reception grant ALLOWS member lookup on its branch; reception DENIED branch creation (403); GET /me/permissions returns effective permissions with scopes. Every Sprint 1 route sits behind requirePermission.`,
  14: `SCRUM-14 — Audit log
${RUN}

Integration tests assert audit rows with before/after for account.create, role_assignment.create, member.create, ticket_package.update; GET /audit filters by entity and is permission-guarded (reception 403, admin 200).
Live proof: after the browser walkthroughs, Postgres shows rows for auth.sign_in, member.create, visit.create, ticket_package.create/archive, booking.create — every mutating action audited.`,
  15: `SCRUM-15 — Idempotency & safeguards
${RUN}

Integration tests: same Idempotency-Key + same body twice → ONE member row, identical replayed response; same key + different body → 409 IDEMPOTENCY_MISMATCH. Business-key uniqueness under it: member/account phone unique per operator, branch code unique. Pattern documented in ARCHITECTURE.md §9; POS clients send a UUID key on every mutating call.`,
  16: `SCRUM-16 — Permission-bound file storage
${RUN}

Integration tests against real MinIO: register → presigned PUT upload → presigned GET download → byte-for-byte compare; /me surfaces the photo id. Access control: another account's file → 403 (reception lacks admin:account:read); unauthenticated → 401. Objects never public — only short-lived signed URLs after an owner-entity permission check.`,
  17: `SCRUM-17 — Locale, timezone, currency
${RUN}

Unit tests: Thai local 0818953926 → +66818953926; "+66 81 895 3926"; 00-prefix international (prototype edge case); invalid rejected; satang round-trips and ฿ formats; Asia/Bangkok round-trip (18:30Z → next calendar day); rate-mode boundary dates.
i18n: scaffold now carries ALL FIVE customer languages (en/zh/th/ru/fr) with real approved strings; POS consults it before the full prototype dictionary. Live proof: /book rendered fully in Thai, Chinese, Russian and French including database-driven package names (screenshots).`,
  19: `SCRUM-19 — Sign in by phone
${RUN}

Integration: active account signs in (session row present, Thai local format accepted); wrong password 401; SIXTH attempt after 5 failures → 429 with cooldown message; per-IP throttle at 4× so shared reception IPs are not locked by one phone (D7).
Live browser: lock screen keeps the prototype design with the added phone+password form; reception signs in and lands on the till with the operator badge showing the DB employee name. "Scan my face" remains a placeholder with a friendly hint.`,
  20: `SCRUM-20 — Account setup
${RUN}

Integration: invited account cannot sign in (403 SETUP_REQUIRED with clear message); setup code delivered via pluggable SMS adapter (console in dev, captured in tests); setup/complete verifies the 6-digit single-use code and sets the password; consumed code refused on reuse; expired code refused; after setup, sign-in works.`,
  21: `SCRUM-21 — Create staff account & assign access
${RUN}

Integration: admin creates an account with employeeName + reception role scoped to HKT Central; invitation code sent via the SMS adapter; the new account completes setup and signs in end-to-end.
Live browser: Admin → Access → Login Users → "Invite staff account" dialog (name, phone, role, branch scope) creates the invited row; audit recorded.`,
  22: `SCRUM-22 — Review & change effective permissions
${RUN}

Integration: GET /accounts/:id/permissions returns assignments + resolved effective permissions; adding/removing a role assignment is audited and immediately reflected.
Live browser: the Login Users panel's shield action opens the permissions dialog listing role assignments with scope labels and the full effective-permission chip set; Remove works in place.`,
  23: `SCRUM-23 — Password recovery
${RUN}

Integration: reset code to verified phone; complete sets the new password AND deletes every session (old cookie rejected on /me afterwards); the used code cannot be replayed; expired codes refused with a clear message.`,
  24: `SCRUM-24 — Sign out
${RUN}

Integration: POST /auth/sign-out deletes the session row; the old cookie is rejected. Playwright smoke: the operator-badge lock button returns the POS to the lock screen. Bonus hardening: any API 401 mid-session (expiry/deactivation elsewhere) locks the POS immediately via a global handler.`,
  25: `SCRUM-25 — Profile & photo
${RUN}

Integration: GET /me returns account+employee+branch+permissions+photoFileId; strict PATCH /me saves permitted fields and REJECTS unknown fields (schema strict); photo upload/download via SCRUM-16 flow proven end-to-end.
Deferred: a dedicated profile-photo UI control — the prototype has no profile screen; needs a placement decision.`,
  27: `SCRUM-27 — Operators, branches, administrators
${RUN}

Integration: platform admin creates a second operator, assigns an administrator (invited operator_admin with SMS code), archives the operator → hidden from pickers; branch created WITH timezone and archived out of the picker.
Live browser: Admin → Access → Operators panel with archive-confirmation dialog; Branches panel persists via the write-through bridge.`,
  28: `SCRUM-28 — Manage login users
${RUN}

Integration: deactivated account cannot sign in (clear ACCOUNT_INACTIVE message) and its live sessions die; temporary password returned once to the admin, signs in, guarded endpoints blocked with MUST_CHANGE_PASSWORD until changed, then unblocked.
Live browser: search, invite, activate/deactivate and temp-password actions in the Login Users panel — both destructive actions now behind confirmation dialogs.`,
  30: `SCRUM-30 — Find a returning member by phone
${RUN}

Integration: lookup with dashes/local format returns the E.164-stored member with children and active tier verification; unknown phone → null.
Live browser: customer types 0811111111 on the CUSTOMER DISPLAY keypad → staged as the session pending-lookup → till consumes it via the API (CLAUDE.md §7.4 — no shared browser state) → Mali appears with the Thai · verified chip and "Welcome back, Mali!" on the display. Screenshots retained.`,
  31: `SCRUM-31 — Create & enrich a member
${RUN}

Integration: create from phone+name only (tier defaults tourist); duplicate phone IN ANY FORMAT → 409 MEMBER_EXISTS with memberId detail; PATCH enrich saves email/notes; audit rows.
Live browser: unknown phone on the identify step opens the "New member?" dialog; creating "Fern" shows the toast and applies the member to the sale. Public /book equivalent: unknown phone continues as guest with standard rates.`,
  32: `SCRUM-32 — Select & reconfirm children for a visit
${RUN}

Integration: confirming children creates a DRAFT visit with visit_child rows and stamps child.last_confirmed_at; children of another member rejected; allergy PATCH audited with before/after; visit readable via API.
Live browser: after Mali's lookup the "Who's visiting today?" modal lists Nong Ploy (5, peanut allergy — editable in place) and Nong Tan (7); Confirm 2 children → toast + visit row in Postgres (2 visit_child rows, last_confirmed_at set). Playwright smoke covers the whole path.`,
  35: `SCRUM-35 — Configure a ticket package
${RUN}

Integration: the 4 seeded prototype packages come back with exact per-tier satang prices (expat −30%/−20% derivation, Thai Full-Day free_adults rule); create/edit/archive; negative price and zero hours rejected (400).
Live browser (the full user story): Admin → Tickets → "Add ticket type" → filled name "3 Hours Play", duration, hours=3, base ฿990/฿1,090 → saved → row appears in the table → Postgres row {"weekday":99000,"weekend":109000} → visible in the PUBLIC /book catalog immediately → archived via the trash + confirmation dialog → soft-deleted (active=f, archived_at set) and gone from lists. Also fixed the ported panel's "[object Object]" adult-price chip.`,
  36: `SCRUM-36 — Weekday/weekend/holiday pricing
${RUN}

Unit+integration (all five DoD cases): weekday; Saturday; Sunday; weekday inside a holiday range → weekend with the holiday named; range boundaries inclusive (13th and 15th in, 16th out).
Live browser: POS header chip reads "Weekday pricing" from GET /branches/:id/pricing-mode (Fri 2026-09-11, branch tz); public bookings on the seeded Loy Krathong holiday (Tue 2026-11-24) priced at WEEKEND rates server-side (integration-verified ฿1,190 for 1 kid + 1 adult tourist 1-Hour).`,
  37: `SCRUM-37 — Branch tax & service rules
${RUN}

Integration (DoD precedence chain): branch default from the per-category engine config (tickets → 7% inclusive VAT, 700bp, service 0); category override (500bp VAT + 1000bp service) beats branch; product override (0bp VAT) beats category while inheriting the category's service charge; PUT tax-config replaces the engine config (F&B service 10% verified via resolver) and is audited. Admin Tax panel persists through the write-through bridge.`,
};

for (const [num, body] of Object.entries(tickets)) {
  writeFileSync(join(OUT, `SCRUM-${num}.md`), body + '\n');
}
console.log(`Wrote ${Object.keys(tickets).length} comment files to jira-comments/`);
