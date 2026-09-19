# OTO App ("OTO Suite")

## What it is for
The park's day-to-day management system, used by all staff every day since about
May 2026: HR records, contracts and letters with e-signature, timekeeping kiosks,
scheduling and leave, payroll, tasks / checklists / ops board, announcements,
SOPs and the "Ask OTO" assistant, fault reports with a supplier portal, events
and birthdays (event orders, packages, parent portal, RSVP), camps, drop-off and
nanny check-in, staff vouchers. 72 login users, 69 employees, 3 branches.

## Intake
- **Source:** `imports/oto-app/` — Replit export of 2026-09-19 (last commit
  2026-09-15; 2,920 commits, 37 in the last 30 days — still actively edited).
  Detailed notes: [`01-oto-app-backend.md`](../architecture/intake-2026-09-19/01-oto-app-backend.md),
  [`02-oto-app-frontend.md`](../architecture/intake-2026-09-19/02-oto-app-frontend.md).
- **Real or mockup:** **live, with production data.** Two earlier Replit apps
  ("OTO HR", "OTO Core") merged, plus "Studio" pages. Deployed by the agency on
  AWS App Runner via Pulumi; the environment named `staging` is production.
- **Stack:** React 18 + Vite 7 + Tailwind 3 + shadcn (122 routes, ~129k lines);
  Express 4 monolith (796 routes; `routes.ts` 25.5k lines, `storage.ts` 12.2k);
  Drizzle on `pg`; Passport-local with scrypt hashes; sessions in Postgres;
  uploads on S3 (two buckets) with some writers still on local disk; Puppeteer
  for PDFs; Twilio Verify; OpenAI; AWS Rekognition for face clock-in; Sentry.
  No unit tests; 48 Playwright specs.
- **Its tables:** all 184 in the dump (`imports/_db/`), 65 enums, 519 foreign
  keys. 93 tables hold data (~46.8k rows). Busiest: `time_events` 8,116,
  `kiosk_auth_attempts` 7,814, `checklist_run_items` 4,049,
  `schedule_assignments` 3,354, `service_checkins` 2,038, `dropoff_checkins`
  1,332. Empty today: payroll, SOP / KB, Ask OTO, vouchers, assets, Xero.
- **Export vs production:** zero drift — all 184 tables, 2,319 columns and 370
  indexes match the code. Schema is managed with `drizzle-kit push --force`, not
  migrations. Known defect: four finance tables lack the primary keys their
  upserts rely on, so the Xero sync cannot work.
- **Shared entities it touches:** tenants, operators, branches; users, people,
  employees, roles, branch access, per-user module switches. **No customer,
  member or child table** — parents and children are free text across seven
  tables.
- **Replit-specific dependencies to replace:** cookie `secure` flag keyed on
  Replit env vars; `replit_integrations/` storage module; `AI_INTEGRATIONS_*`
  naming; Xero redirect hard-coded to the Replit host; Nix Chromium path; three
  Replit Vite plugins.
- **Secrets found in the export:** yes — `temp-env` (26 variables), `k8s/app.yaml`,
  `.replit` (seed admin), a Sentry DSN, `cookies.txt`, plus uploaded personal
  files. All excluded from git here (`imports/` is ignored); all to be rotated.

## Integration plan
- **Deployable:** one Docker service serving UI and API together (its client
  makes ~660 same-origin `/api` calls). Existing `Dockerfile`; ≥2 GB RAM for
  Chromium; exactly one always-on instance (in-process timers: 00:01 auto
  clock-out and recurring tasks, 03:00 reconciliation, 10-minute no-show alerts);
  `TZ=UTC`; health check `/api/status`; same region as the database.
- **Login:** an adapter before `passport.session()` validates the platform
  cookie, maps it to the local `users` row via a new `platform_user_id`, and
  calls `req.login()`. All handlers stay unchanged. scrypt hashes are imported
  and re-hashed on first sign-in. User, permission and password screens
  (~15 credential-writing routes) are re-pointed to the Console. Kiosk bearer
  tokens and public token links stay outside the sign-on.
- **Data:** schema `oto_app` via `ALTER ROLE … SET search_path` (Drizzle emits
  unqualified names, so no code change). Load path: restore the dump into a
  scratch database → `ALTER SCHEMA public RENAME TO oto_app` → dump across.
  Post-import script: add `platform_user_id`, mirror accounts / branches / staff
  into `core`, rewrite stored bucket paths, apply the clock-in decision. Never
  run `drizzle-kit push --force` or the reset scripts against the central
  database.
- **Files:** one bucket; merge the second (checklist media) into it; add bucket
  CORS for browser uploads; move the four local-disk writers (employee
  documents, unsigned contract PDFs, payslips, payroll exports) to object
  storage.
- **Seams to the rest of the suite:** `beo_event_billing.pos_order_ref` and
  `studio_event_bookings.pos_reference` become real links to POS orders;
  check-ins, camps and events gain a member id; staff vouchers become redeemable
  at the POS (the server endpoints exist, no client calls them); the Directory
  API (`/api/directory/*`) already serves staff identity to other systems.
- **Launcher tile:** "OTO App" (or "Team"), shown with `app:team:access`.

## Environment variables (names only)
| Purpose | Variables |
|---|---|
| Required to boot | `DATABASE_URL`, `APP_ENV`, `STORAGE_ENV_PREFIX`, `OBJECT_STORAGE` |
| Runtime | `PORT`, `NODE_ENV`, `TZ=UTC`, `LOG_RESPONSE_BODY=false` |
| Sessions and token schemes | `SESSION_SECRET`, `SESSION_PEPPER`, `KIOSK_CODE_PEPPER`, `PIN_FINGERPRINT_SECRET`, `KIOSK_IDENTIFICATION_TOKEN_SECRET` |
| Object storage | `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (`AWS_S3_BUCKET`, `AWS_S3_REGION` only until the buckets are merged) |
| PDFs | `PUPPETEER_EXECUTABLE_PATH` |
| SMS codes | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` |
| AI features | `AI_INTEGRATIONS_OPENAI_API_KEY` (leave `_BASE_URL` unset off Replit) |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` |
| Optional | `HR_DIRECTORY_API_KEY`, `SENTRY_DSN`, `VITE_SENTRY_DSN`, `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` |
| Removed with face clock-in | `USE_AWS_REKOGNITION`, `AWS_REKOGNITION_COLLECTION_ID` |

New values for the session and token secrets mean: reprint the branch check-in
QR posters, re-activate every kiosk tablet, reset advisor PINs. Everything else
(signing links, parent portals, supplier links) survives.

## Security fixes applied during the lift
Public children's-data lookup by phone; signed contract PDFs served without
login; kiosk clock endpoints that accept any employee id; `/uploads` served
without login; plaintext credential vault; response-body logging; public
source maps, schema diagram and system map; missing CSRF / origin checks once a
parent-domain cookie exists.

## Status
| Area | State | Notes |
|---|---|---|
| Code review of the export | done | 2026-09-19 |
| Data profile (counts, structure only) | done | from the Navicat dump |
| Agency proposal captured and assessed against the export | done | 2026-09-20, `docs/briefs/AGENCY_PROPOSAL.md` |
| `otoapp` schema on the central database, launcher sign-on, user provisioning | planned | Sprint 2 — S2-17a, before CP1 (proves one database, one login) |
| Full lift to Render (hosting, storage, jobs, security fixes) | planned | Sprint 2 — S2-17b, after the POS is complete |
| Contract features from the proposal (§6.2 gaps, benefit profiles if confirmed) | planned | Sprint 2 — S2-17c, list confirmed by the owner (Open decision 30) |
| POS / member / events seams | planned | Sprint 2 — S2-17b views; ownership of check-in is Open decision 25 |
| Face clock-in on staging | owner decision | Open decision 29 |

## Open questions
- Staff clock-in: the live system uses face recognition daily (60 of 69
  enrolled); the brief bans biometrics and the templates cannot be exported.
  PIN / phone + photo fallback exists. Owner decision.
- Will the agency hand over the five secrets, the S3 contents, and delete the
  Rekognition collections?
- Who controls DNS for `otoplay.org` / `otoplay.dev`?
- Are Xero, SMTP and the Directory API actually used?
- Does staff need a Thai interface? (English only today.)
- Replit change freeze and re-import policy until cutover.
