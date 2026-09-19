<!-- Read-only analysis of the imported Replit export, 2026-09-19. File references are relative to the export under imports/ (local only, not in git). No secret values are recorded here - variable names and locations only. -->

> **OTO App — backend and infrastructure** - intake analysis, 2026-09-19. Markers: [V] verified by reading code, [I] inferred, [U] unknown.

# OTO App backend and infrastructure analysis for re-platforming

Everything below comes from reading the code and the structure-only schema dump. Nothing was run or modified, the 33 MB data dump was not opened, and no secret values or personal data are reproduced.

- `APP` = `imports/oto-app`
- `DUMP` = `imports/_db/data-structure-only-for-oto-app.sql`
- **[V]** verified in code or dump. **[I]** inferred. **[U]** unknown.

## 0. Headline findings

1. **The repo does not describe a Kubernetes deployment.** [V]
   - `APP/infra/README.md:3` says "Pulumi (Python) + AWS App Runner … no Kubernetes".
   - `APP/k8s/*.yaml` is a Tilt local-dev rig only.
   - Only `app-dev` (otoplay.dev) and `app-staging` (otoplay.org) stacks exist.
   - The schema dump header says `Source Catalog: oto_staging`.
   - A Replit deployment also exists: Xero's callback is hard-coded to a `*.replit.app` host at `APP/server/xero-routes.ts:9`.
   - **Which environment holds production data is unknown [U].**
2. **Zero schema drift between the staging dump and the code.** [V]
   - 184 tables, 2,319 columns, 65 enums and 370 indexes all match by name and type.
   - The only code-only tables are `conversations` and `messages`, which are dead Replit chat boilerplate.
   - The schema is managed with `drizzle-kit push --force`, not migrations.
3. **The app is a monolith.** [V]
   - Express 4, Passport-local, Drizzle on `pg`.
   - `routes.ts` is 25,504 lines with 517 routes inside one closure.
   - `storage.ts` is 12,253 lines with 452 methods.
   - There are 796 live routes in total.
   - No unit tests; 45 Playwright e2e specs.
4. **Recommendation: lift as-is as its own Docker service on Render.** Give it its own schema and DB role, put an SSO adapter in front of Passport, and run a single instance. Do not fold it into the Fastify monolith in step 1 (reasons in §10).
5. **Serious exposure exists today.**
   - Real credentials are committed to git.
   - A public endpoint returns children's PII by phone number.
   - One route serves signed contract PDFs with no auth.
   - The kiosk clock endpoints are unauthenticated.
   - The credential "Vault" stores passwords in plaintext.
   - Full JSON response bodies are logged in the AWS environments.

## 1. Stack and runtime

| Item | Finding | Ref |
|---|---|---|
| Node | 20 on Replit and dev (`APP/.replit:1`, `APP/Dockerfile.dev:1`); **22** in the prod image (`APP/Dockerfile:1`). There is no `engines` field. | [V] |
| Server | Express 4.21. TypeScript ESM source is bundled to one CJS file by esbuild with all dependencies external. | `APP/script/build.ts:47-59` |
| Client | React 18 + Vite 7, built to `dist/public` and served by the same process with an SPA fallback. | `APP/server/static.ts:5-18` |
| ORM / DB | drizzle-orm 0.39 over a `pg` Pool with default size 10 and no SSL options (relies on the URL). | `APP/server/db.ts:13-14` |
| Sessions | express-session + connect-pg-simple on the same pool. Table `session`, `createTableIfMissing`. 24 h cookie. | `APP/server/storage.ts:1895-1898`, `APP/server/auth.ts:38-48` |
| Start | `npm start` runs `reconcile:calendar-colors` then `node dist/index.cjs`. Docker's `CMD` skips npm, and `.dockerignore` excludes `migrations/`, so the reconcile step never runs in the image. | `APP/package.json:10`, `APP/Dockerfile:78` |
| Port / health | `PORT` (default 5000, 8080 in the image), bound to `0.0.0.0`. Health is `GET /api/status`, which makes no DB check. | `APP/server/index.ts:101`, `APP/server/routes.ts:749` |
| Boot-time hard requirements | `DATABASE_URL`, `APP_ENV`, `STORAGE_ENV_PREFIX` and `OBJECT_STORAGE` throw if missing. | `APP/server/config/env.ts:1-24` |
| Body limit | 50 MB JSON, used for base64 face frames and signatures. | `APP/server/index.ts:22-31` |
| Security middleware | No helmet, CORS, CSRF or global rate limiter. There is no limiter on `/api/login`. | [V] grep |

### `APP/k8s/` (local Tilt only) [V]

| Kind | Name | Notes |
|---|---|---|
| Deployment + Service | `oto-app` | Image `oto-app-image`, port 5000, TCP readiness probe, 20 env vars as inline plain `value:` entries |
| PVC + Deployment + Service | `postgres-data`, `postgres` | 1 Gi RWO volume `pgdata`; `postgres:16-alpine` |

There is no Ingress, Secret, ConfigMap, Job, CronJob, HPA or namespace.

### `APP/infra/` (Pulumi Python, not Terraform) [V]

| Stack | AWS resources |
|---|---|
| `master`, `identity` | Organisation OU; IAM Identity Center permission set and admin group |
| `shared` (`stacks/service.py`) | A dedicated AWS account. ECR repo `oto-app`. S3 bucket `oto-uploads-<accountId>` (versioned, SSE, public access blocked, no CORS config). **RDS Postgres 16.13, db.t3.micro, 20 GB, `publicly_accessible=True`, security group 5432 open to `0.0.0.0/0`** (`:199`, `:230`). IAM task role with S3, Rekognition (`collection/faces-*`) and SES policies. ECR access role. |
| `app-dev`, `app-staging` (`stacks/app.py`) | App Runner service `oto-<env>`: port 8080, health check `/api/status`, 0.25 vCPU / 1 GB, auto-deploy off. Route53 zone plus custom domain. One database per environment (`oto_dev`, `oto_staging`) on the shared RDS. S3 key prefix per environment. |
| `local` | S3 bucket plus IAM **user** `oto-local` with long-lived keys for Tilt |

Schema rollout is a manual `drizzle-kit push` from a laptop against the public RDS (`APP/infra/scripts/migrate.sh:48-52`).

## 2. Module map

796 live routes [V]. 517 are in `server/routes.ts`; the rest are in the files named below.

| Module | Routes | Server files | Prefix(es) |
|---|---|---|---|
| Auth / session / account | 17 | `auth.ts`, `auth-otp-routes.ts`, `twilio-service.ts` | `/api/login`, `/logout`, `/user`, `/change-password`, `/api/auth/*`, `/api/my-account/*` |
| Users / permissions / overrides | 20 | `routes.ts`, `shared/permissions.ts` | `/api/users`, `/api/permissions/*`, `/api/module-overrides/*` |
| Org structure | 44 | `routes.ts` | `/api/branches`, `/api/operators`, `/api/admin/operators`, `/api/departments`, `/api/roles`, `/api/locations` |
| People / advisors / access policies | 8 | `routes.ts` | `/api/people` |
| HR employees core | 31 | `routes.ts`, `storage.ts`, `utils/username-generator.ts` | `/api/employees*` |
| Contracts, e-sign, PDF | 20 | `routes.ts`, `pdf.ts`, `pdf-storage.ts` | `/api/contracts`, `/api/signing/:token` |
| Contract templates / assignments | 14 | `routes.ts` | `/api/templates`, `/api/template-assignments` |
| Policy documents | 7 | `routes.ts` | `/api/policies` |
| Letters / warnings and e-sign | 8 | `routes.ts` | `/api/letters`, `/api/letter-sign/:token` |
| Employee documents | 4 | `routes.ts` (local disk) | `/api/employees/:id/documents` |
| Assets | 7 | `routes.ts` | `/api/assets/*` |
| Offboarding | 8 | `routes.ts` | `/api/offboarding/*` |
| Kiosk devices / activation / reception | 12 | `routes.ts`, `kiosk-auth.ts` | `/api/kiosk-devices`, `/api/kiosk/exchange`, `/refresh-session`, `/api/kiosk-reception/*` |
| Kiosk clock: face / PIN / phone | 18 | `routes.ts`, `face-recognition.ts`, `pin-utils.ts`, `phone-utils.ts`, `advisor-attendance.ts` | `/api/kiosk/*` |
| Timekeeping review / corrections | 12 | `routes.ts`, `timekeeping-deriver.ts` | `/api/timekeeping/*`, `/api/time-events*` |
| Scheduling | 62 | `routes.ts`, `break-generator.ts`, `shared/scheduling-validation.ts` | `/api/schedule/*`, `/api/rota`, `/api/shifts`, `/api/duty-*`, `/api/branch-events` |
| Leave / time-off / holidays | 23 | `routes.ts` | `/api/time-off`, `/api/leave-*`, `/api/sick-leave-*`, `/api/public-holidays` |
| Tasks / ops board / templates | 54 | `core/tasksRoutes.ts`, `core/compat/*.ts`, `core/taskGeneration.ts`, `routes.ts` | `/api/core/tasks`, `/api/tasks`, `/api/admin/tasks`, `/api/studio/task-*` |
| Checklists, runs, media | 29 | `routes.ts`, `core/checklistMediaRoutes.ts` | `/api/checklists`, `/api/checklist-runs`, `/api/checklist-media` |
| Announcements / notifications | 5 / 4 | `core/announcementsRoutes.ts`, `notification-service.ts` (in-app only) | `/api/announcements`, `/api/notifications` |
| SOP / KB / knowledge files / training | 27 | `routes.ts`, `translation-service.ts` | `/api/sops`, `/api/knowledge-base`, `/api/knowledge-files`, `/api/training` |
| Ask OTO and AI helpers | 8 | `routes.ts:21479+`, `ai-routes.ts` | `/api/ask-oto*`, `/api/ai/*` |
| Fix reports and supplier portal | 22 | `routes.ts`, `fix-media-thumbnails.ts` | `/api/fix-reports`, `/api/supplier-portal/*` |
| Events core | 33 | `routes.ts` | `/api/events`, `/api/admin/events`, `/api/bookings` |
| BEO / packages / line items / menus | 93 | `beo-routes.ts`, `birthday-package-routes.ts`, `pdf.ts` | `/api/beo/*`, `/api/events/:id/beo*` |
| Parent portal / invitations / RSVP | 19 | `parent-experience-routes.ts` | `/api/public/parent-portal/:token`, `/api/public/guest-invite/:token` |
| Camps and children | 23 | `routes.ts:15820-17583` | `/api/public/camp-*`, `/api/admin/children*`, `/api/core/camp-checkins/*` |
| Drop-off / nanny / public check-in | 22 | `checkin-routes.ts` | `/api/public/checkins`, `/api/core/checkins`, `/api/core/nanny-*` |
| Drop-off form builder | 7 | `dropoff-form-routes.ts` | `/api/dropoff-form`, `/api/public/dropoff-form/:branchId` |
| Staff vouchers | 11 | `voucher-routes.ts` | `/api/studio/voucher-templates`, `/api/hr/*vouchers`, `/api/core/vouchers/*` |
| Casual workers | 7 | `casual-worker-routes.ts` | `/api/casual-workers` |
| Payroll | 45 | `routes.ts`, `payroll-*.ts` (5 files) | `/api/payroll/*` |
| Org chart / Structure Lab | 8 | `orgChartRoutes.ts` | `/api/org-chart` |
| Attention engine / activity log | 9 / 3 | `attention-engine.ts` (about 22 rules) | `/api/attention-*`, `/api/activity-logs` |
| Xero OAuth / finance sync | 10 / 7 | `xero-routes.ts`, `finance-sync*.ts` | `/api/auth/xero`, `/api/finance` |
| Vault (shared credentials) | 6 | `routes.ts:24665+` | `/api/access` |
| Directory API (service-to-service) | 6 | `routes.ts:12973-13098`, `auth-middleware.ts:231-259` | `/api/directory/*` |
| Data admin (generic CRUD, about 90 models) | 7 | `data-admin/*` | `/api/data-admin` |
| Files / settings / dev tooling | 16 | `file-storage.ts`, `storage/*`, `prod-sync.ts` | `/api/files/*`, `/uploads`, `/objects/*`, `/api/settings`, `/api/seed`, `/app-map` |

- **Signatory** is not a module. It is three `settings` rows (`md_signatory_name`, `md_signatory_title`, `md_signature_image`). The stored image is applied automatically as the employer counter-signature on every signed contract (`APP/server/routes.ts:6236-6247`).
- **AI settings** are also `settings` rows (`ai_*_advice`, `ai_*_output_format`, `ai_event_extraction_model`).
- **Dead code:** `server/replit_integrations/{chat,audio,image}` is never registered. The tables `directory_cache`, `troubleshooting_*` and `hiring_media_assets` have no server references.

## 3. Auth and access

**Login [V]**
- Passport-local with the field `identifier`. A `+E.164` phone number or an email, plus a password (`APP/server/auth.ts:56-75`).
- `users.username` exists but is not used for login.
- Registration is disabled. `mustChangePassword` is not enforced on the server.

**Password hashing [V]**
- scrypt with Node defaults (N=16384, r=8, p=1), keylen 64.
- Stored as `hex(hash).saltHex`. The salt is used as the hex **string**, not decoded bytes (`APP/server/auth.ts:19-23`, `:193-198`).
- These hashes can be imported by a platform IdP and re-hashed on first login.

**Per-request cost [V]**
- `deserializeUser` calls `getUserWithBranchAccess`, which makes 4–8 queries (`APP/server/storage.ts:1980-2207`).
- `loadUserWithAccess` repeats that call (`APP/server/routes.ts:772`).
- `requireAuth` adds one more query.
- That is roughly 9–17 queries before any handler runs, so keep the app and the DB in the same region.

**RBAC [V]**
- `users.role` is one of `global_admin | operator_admin | admin | manager | staff | advisor`.
- An `advisor` is resolved at runtime to admin, manager or staff from `access_policies.access_level`.
- The raw role is not visible on `req.user`, so a special middleware re-reads it to block advisors from contracts, schedule, rota and payroll (`APP/server/routes.ts:784-799`).
- Branch scoping comes from `user_branch_access` (`all_branches` or `selected_branches`), from the operator's branches for `operator_admin`, or from `access_policies.branch_scope` and `branch_ids` for advisors.
- `shared/permissions.ts` defines 11 module keys, 7 admin-only actions and per-user overrides (`HOME_ONLY | ALL | CUSTOM`).
- **On the server, `requireModule()` is used on exactly one route** (`APP/server/routes.ts:5910`). Module permissions are effectively UI gating.
- Real enforcement is `requireAuth` plus `requireManager` or `requireAdmin`, plus inline branch filters.

**Tenancy [V]**
- `tenants` is one `default` slug. `tenant_id` appears on 114 of 184 tables.
- `users` has no `tenant_id`. It is derived from the user's first branch-access row.
- Code calls `getDefaultTenantId()` 171 times, so the app is soft single-tenant.
- An **operator** is a legal entity inside the tenant. It owns branches and scopes payroll. It has no tax-id or address fields.
- Latent bug: `tenantId || "default"` passes a slug where a UUID is expected (`APP/server/auth-middleware.ts:277`).

**Kiosk [V]**
- There are two mechanisms.
- Reception kiosk: a manager issues a one-time code (10 min, SHA-256 with `KIOSK_CODE_PEPPER`). `/api/kiosk/exchange` creates a device and returns a 30-day bearer token hashed with `SESSION_PEPPER` (`APP/server/kiosk-auth.ts:133-257`).
- Timeclock kiosk: a `deviceSecret` SHA-256 stored in `kiosk_devices.device_secret_hash`. **It is optional on every clock route.**

**Public links [V]**

| Link | Mechanism | Survives new secrets? |
|---|---|---|
| Contract signing `/sign/:token` | 32 random bytes, plaintext in the DB, 7 days (`routes.ts:6064`) | Yes |
| Letter signing; parent portal; guest invite; set-menu | Random tokens, plaintext in the DB, revocable | Yes |
| Supplier portal | 32 random bytes, stored as SHA-256 (`routes.ts:22950`) | Yes |
| Face enrolment QR | Random, SHA-256, 24 h, single use | Yes |
| **Branch check-in QR (printed)** | `HMAC(SESSION_SECRET,"checkin:"+branchId)[:16]` (`checkin-routes.ts:66-72`) | **No – reprint needed** |
| Signed-PDF download | HMAC with `SESSION_SECRET`; expiry never checked (`routes.ts:6358-6385`) | No |
| Kiosk sessions; advisor PIN fingerprints (`people.timeclock_pin_fingerprint`) | `SESSION_PEPPER`; `PIN_FINGERPRINT_SECRET` falling back to `SESSION_SECRET` | **No – re-activate kiosks and reset advisor PINs** |
| Employee PINs | Unsalted SHA-256 of a 4–8 digit PIN (`routes.ts:11008`) | Yes, but weak |

- All issued links embed the old host. The domains are in the agency's Route53 (staging) and at Gandi (dev). **Domain ownership is an [U] risk.**
- There are about 68 session-less routes in total.

## 4. Integrations and environment

| Service | Purpose | Notes |
|---|---|---|
| AWS S3 | All uploads in `s3` mode | **Two buckets:** the main `S3_BUCKET`, and a second `AWS_S3_BUCKET` / `AWS_S3_REGION` (default ap-southeast-7) for checklist media. The second *requires* explicit keys (`core/checklistMediaRoutes.ts:38-54`, `:83`), so it fails under an IAM role. |
| AWS Rekognition | Face enrolment and matching | §9 |
| GCS / Replit object storage | `replit` mode | Sidecar at `127.0.0.1:1106` or a service-account JSON |
| Twilio **Verify** | SMS OTP for password reset and phone verification | No plain SMS is sent |
| SMTP (nodemailer) | Used in one place: emailing a contract | If unset, the mail is "simulated" and logged. No SMTP keys exist in the Pulumi configs [V]. |
| OpenAI | Ask OTO (`gpt-4o-mini`), SOP from PDF (`gpt-4o`), event and BEO extraction (model from settings), translation (`gpt-5-mini`) | No embeddings and no pgvector. Ask OTO is keyword scoring in memory. |
| Xero | OAuth plus P&L and cash sync | Redirect URI hard-coded to the Replit host. Tokens are plaintext in `xero_tokens`. |
| Sentry | Server and client | `debug: true` |
| LINE, WhatsApp API, Google Drive, web push | **Absent in the server** | Only vestigial columns; `wa.me`-style links are client-side |
| Puppeteer / Chromium | Contract, letter, BEO and payslip PDFs, plus the invitation JPEG | Launches a fresh browser per document |

### Environment variables (names only) [V]

| Name | Read at | Purpose | Required | Replit-specific |
|---|---|---|---|---|
| `DATABASE_URL` | `server/db.ts:7`, `drizzle.config.ts:3` | Postgres | Yes | – |
| `APP_ENV`, `STORAGE_ENV_PREFIX`, `OBJECT_STORAGE` | `server/config/env.ts:1-3` | Environment gate, key prefix, `local|s3|replit` | Yes (throws) | Value `replit` only |
| `PORT`, `NODE_ENV` | `index.ts:101`, `:90` | – | Optional | – |
| `SESSION_SECRET` | `auth.ts:39` (hard-coded fallback) plus HMACs in `checkin-routes.ts:67`, `routes.ts:6340/6377`, `twilio-service.ts:11`, `pin-utils.ts:7`, `advisor-attendance.ts:47` | Session plus five token schemes | Yes in practice | – |
| `SESSION_PEPPER`, `KIOSK_CODE_PEPPER` | `kiosk-auth.ts:7-8` (hard-coded fallbacks) | Kiosk hashing | Yes in practice | – |
| `PIN_FINGERPRINT_SECRET`, `KIOSK_IDENTIFICATION_TOKEN_SECRET` | `pin-utils.ts:7`, `advisor-attendance.ts:47` | Advisor PIN / proof. The second falls back to a per-process random value, which breaks with more than one instance. | Optional | – |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | `index.ts:114-115`, `routes.ts:5932-5933` | First-boot admin | Optional | – |
| `LOG_RESPONSE_BODY` | `index.ts:59` | Logs every JSON body unless set to `"false"` | **Set to `false`** | – |
| `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `storage/s3Storage.ts:26-41`, `pdf-storage.ts:34-63`, `storage/presignedUpload.ts:24-36` | Main bucket. `AWS_REGION` is shared with Rekognition. | Yes on Render | – |
| `AWS_S3_BUCKET`, `AWS_S3_REGION` | `core/checklistMediaRoutes.ts:39`, `:83` | Second bucket | If the feature is kept | – |
| `PUPPETEER_EXECUTABLE_PATH` | `pdf.ts:227`, `payroll-payslip.ts:174`, `parent-experience-routes.ts:919` | The fallback is a Nix store path | Yes outside Replit | – |
| `USE_AWS_REKOGNITION`, `AWS_REKOGNITION_COLLECTION_ID` | `face-recognition.ts:314-315` | Face | To be removed | – |
| `AI_INTEGRATIONS_OPENAI_API_KEY` / `_BASE_URL` | `ai-routes.ts:12-13`, `routes.ts:21486`, `translation-service.ts:10` | OpenAI | Optional | Naming only; leave `BASE_URL` unset |
| `TWILIO_ACCOUNT_SID`, `_AUTH_TOKEN`, `_VERIFY_SERVICE_SID` | `twilio-service.ts:7-9` | OTP | Optional | – |
| `SMTP_HOST`, `_PORT`, `_USER`, `_PASS`, `EMAIL_FROM` | `email.ts:20-24` | Mail | Optional | – |
| `XERO_CLIENT_ID`, `_SECRET` | `xero-routes.ts:24-25` | Xero | Optional | – |
| `HR_DIRECTORY_API_KEY`, `DIRECTORY_API_RATE_LIMIT_*` | `auth-middleware.ts:209-241` | Directory API | If used | – |
| `SENTRY_DSN`, `APP_VERSION`, `APP_CHANGE_ID`; build-time `VITE_SENTRY_DSN`, `VITE_APP_*`, `VITE_HR_APP_URL` | `sentry.ts`, `Dockerfile:47-50` | Telemetry | Optional | – |
| `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR`, `GCS_*` (3), `REPL_ID`, `REPLIT_DEV_DOMAIN`, `REPLIT_DEPLOYMENT` | `pdf-storage.ts:68`, `replit_integrations/object_storage/objectStorage.ts:15-87`, `auth.ts:36`, `server/vite.ts:12` | Replit storage and cookie mode | No | **Yes** |
| `DEV_IMPORT_KEY`, `PRODUCTION_DATABASE_URL`, `DEFAULT_TENANT_ID` | `routes.ts:24463`, `prod-sync.ts:585`, `dropoff-form-routes.ts:278` | Dev tooling | No | – |
| `OTO_CORE_API_KEY` / `_URL` | Only in `infra/pulumi/stacks/app.py:129-134` | **Dead** | – | – |

## 5. Background work

Everything runs in-process on timers, with no queue and no locks [V].

| Job | Schedule | Ref | Idempotent? |
|---|---|---|---|
| Seed admin if there are zero users | Boot + 2 s | `server/index.ts:112-136` | Yes |
| Attention engine, full reconciliation | Boot + 5 s, then every 6 h | `index.ts:139-159` | Upsert |
| Auto-checkout of guests, **auto clock-out** (inserts `OUT` events marked `authMethod:"FACE"`), recurring-task generation | 00:01 Bangkok | `server/scheduled-jobs.ts:431-435` | **No** – clock-out is a plain insert; task generation is check-then-insert |
| Presence reconciliation, LEAVING→LEFT, deactivate departed users' logins, availability cleanup | 03:00, plus every 6 h | `:438-445` | Stuck-clock alerts are plain inserts |
| No-show alerts | Every 10 min, 07:00–22:00 | `:448` | Upsert |
| Reset-token cleanup | Every 60 s | `server/twilio-service.ts:26` | Yes |
| Directory API rate-limit store GC | Every 5 min (process-local) | `server/auth-middleware.ts:229` | In-memory |

- The app must run as a **single instance** on an always-on host. There is no catch-up if it is down at 00:01.
- The App Runner config has no autoscaling setting. App Runner idle-CPU throttling (platform behaviour, not checked in this repo) probably makes these timers unreliable there [I].
- The process must run with **`TZ=UTC`**. 369 columns are `timestamp` without time zone, and the code hand-rolls a +7 h offset (`scheduled-jobs.ts:8`).
- On a shared Postgres, also set `ALTER ROLE … SET timezone='UTC'` for this app's role.

## 6. Files and media

| Location | Contents | Ref |
|---|---|---|
| Main bucket `<prefix>/<folder>/<file>` | Folders: `branch-logos`, `profile-photos`, `pin-photos`, `fix-media`, `fix-media-thumbs`, `checker-photos`, `camp-photos`, `task-photos`, `task-attachments`, `checkin-photos`, `dropoff-photos`, `dropoff-signatures`, `invitations`, `knowledge-files`. The DB stores `/api/files/<folder>/<file>`. | `server/file-storage.ts`, `server/storage/s3Storage.ts:43-45` |
| Main bucket `<prefix>/contracts/…`, `<prefix>/letters/…` | Signed PDFs. **The DB stores `/<bucketName>/<key>`**, so paths must be rewritten when buckets change. | `server/pdf-storage.ts:49-57`, `:115` |
| Main bucket `<prefix>/tenants/<tenantId>/core/tasks/evidence/…` | Presigned browser PUTs. The bucket needs CORS, and the Pulumi bucket defines none. | `server/core/filesRoutes.ts:44` |
| Second bucket `checklists/<templateId>/…` | Checklist header and item media | `server/core/checklistMediaRoutes.ts:171-183` |
| **Local disk only** | **Employee documents** in `uploads/employee-documents/<id>/` with a local path in the DB. Unsigned contract PDFs in `pdfs/`. Payslips in `pdfs/payslips/`. Payroll exports in `exports/*`. | `routes.ts:366-375` and `:4955-5036`; `pdf.ts:6-9`; `payroll-payslip.ts:166`; `payroll-exports.ts:99`, `:337`, `:465`, `:543` |
| Base64 in the DB | Signature images in contracts, camp registrations, check-ins and settings | Schema |

- The local-disk files are lost on every redeploy of an ephemeral host, so on AWS they are probably already gone [I].
- **Public folders served without auth:** `branch-logos`, `dropoff-photos`, `dropoff-signatures`, `profile-photos`, `invitations` (`APP/server/routes.ts:22572`).
- **Images and thumbnails**
  - `sharp` is imported at `APP/server/fix-media-thumbnails.ts:17` but is **not in `package.json`**. It only resolves transitively through the vendored demo-recording tool `vendor/webreel-core`.
  - `ffmpeg` is spawned but is not installed in the Dockerfile, so video thumbnails silently fall back to the original file.
- **Chromium**
  - The production Dockerfile already installs Chromium and Thai fonts.
  - It needs Render's Docker runtime and realistically 2 GB RAM or more.

## 7. Database

### General shape [V]

- Postgres 16.13 in a Navicat structure dump. Everything sits in `public`.
- 184 tables, 65 enums, 370 indexes, 179 primary keys, 519 foreign keys and 27 unique constraints.
- No extensions, sequences, functions, triggers, views or check constraints.
- `gen_random_uuid()` is a core function, so no extension is needed.
- IDs are mixed: `varchar` holding a UUID in the HR schema, `uuid` in the Core schema.
- Nothing was created outside Drizzle, apart from connect-pg-simple's `createTableIfMissing`. `session` is also declared in Drizzle.
- The 2 of 3 partial unique indexes checked, `advisor_attendance_one_open_session` and `branches_tenant_calendar_color_unique`, exist in the DB (the third, `uq_checklist_runs_period`, was not inspected), and all 370 index names in the dump are declared in code.

### Drift [V]

- None in either direction, apart from the two dead chat tables, which are not listed in `APP/drizzle.config.ts:9`.
- `APP/migrations/` holds 25 hand-written SQL files with a partial journal. They are not what built the schema.
- Real defect:
  - The composite primary keys on `xero_tracking_categories`, `xero_tracking_options`, `cash_txns` and `cash_daily` use invalid Drizzle syntax (`APP/shared/schema.ts:4305`, `:4317`, `:4358`, `:4370`).
  - They were never created, so the dump shows **no primary key or unique constraint** on those tables.
  - `server/finance-sync.ts:138`, `:153`, `:424` and `:467` run `ON CONFLICT` against them.
  - The Finance Sync upserts will therefore fail at runtime. `pl_facts` also has no primary key.

### Tables by module (all 184 accounted for)

| Group | Count |
|---|---|
| Identity / org / access | 17 |
| Auth support | 3 |
| HR core / org chart | 12 |
| Contracts | 4 |
| Timekeeping / kiosk / face | 13 |
| Scheduling / leave | 24 |
| Payroll | 14 |
| Finance / Xero | 8 |
| Tasks | 12 |
| Checklists | 5 |
| Announcements / notifications | 2 |
| SOP / KB / AI / training / i18n | 15 |
| Fix | 3 |
| Events / BEO / packages | 30 |
| Parent portal | 5 |
| Camps | 2 |
| Guest services | 5 |
| Vouchers | 3 |
| Platform / misc (`settings`, `files`, `activity_log`, `attention_items`, `access_items`, `access_view_logs`, `directory_cache`) | 7 |

### Identity tables

- **`users`** (varchar id)
  - `username` (unique), `email` (unique, not null), `password`, `full_name`, `preferred_name`.
  - `role` (text, default `staff`), `operator_id`, `is_active`, `must_change_password`, `permission_review_required`.
  - `created_by`, `last_login_at`, `phone_number`, `phone_e164` (unique), `phone_verified`, `phone_verified_at`, `profile_photo_path`, timestamps.
  - No `tenant_id`. **127 foreign keys reference `users(id)`**, plus many `*_user_id` columns without a foreign key. Keep `users.id` stable.
- **`people`** (identity anchor)
  - `full_name`, `email` (unique), `person_type` (EMPLOYEE or ADVISOR), `is_active`, `is_protected`.
  - `timeclock_pin_hash` (scrypt), `timeclock_pin_fingerprint` (unique HMAC), phone fields, `department_id`, `face_*` (3 columns).
  - Linked to `users` only by email or by `access_policies.core_user_id`.
- **`employees`** (64 columns)
  - `tenant_id`, `person_id` (unique), `user_id`, `branch_id`, `primary_department_id`.
  - Names (including `thai_name` and `nickname`), `email` (**not unique**), phones, `address`.
  - `status`, `employment_state` (ACTIVE / LEAVING / LEFT), probation, offboarding, visa and work-permit fields.
  - `sso_number`, `tax_id_number`, pay basis and `daily_rate`, `default_merge_data` jsonb.
  - `face_*` (3 columns), `timeclock_pin_*` and usage counters, `profile_photo_*`, `weekly_off_days int4[]`, `version`.
- **`access_policies`** (unique on `person_id`)
  - `access_level` (STAFF / MANAGER / ADMIN), `modules` jsonb, `branch_scope` (ALL / SELECTED), `branch_ids` jsonb.
  - Vestigial "Core" provisioning columns.
- **Access and mapping tables**
  - `user_branch_access`: `tenant_id`, `user_id`, `branch_id`, `access_scope`.
  - `user_module_overrides`: `module_key`, `enabled`, `branch_scope_type`, `branch_ids`.
  - `employee_roles`, `role_department_map`, `role_branch_assignments`, `department_branch_assignments`.
- **Org tables**
  - `tenants`: `name`, `slug` (unique).
  - `operators`: `tenant_id`, `name`, `status`.
  - `branches`: `tenant_id`, `operator_id`, `name`, `address`, `logo_url`, `timezone` (default Asia/Bangkok), `calendar_color`, vestigial `google_drive_*` and `core_*`.
  - `departments`: tenant-wide.
  - `roles`: **`name` is globally unique**.
- **`session`**: `sid`, `sess` jsonb, `expire`.

## 8. POS and revenue touchpoints

There is **no customers, members or children table** [V]. A "child" is `(lower(child_full_name), emergency_contact_number)` deduplicated over `camp_registrations` (`APP/server/routes.ts:16605-16668`).

| Seam | Today | Ref |
|---|---|---|
| Birthday / private-event billing | `beo_event_billing`: `package_price`, deposit fields, `deposit_payment_method` enum, **`pos_order_ref`** (free text). The BEO PDF has a "POS" section that staff re-key by hand. | `APP/server/pdf.ts:604-640` |
| Event line items and templates | `event_line_items.unit_price_inc_vat`. VAT of 7 % inclusive is computed in `shared/vat-utils.ts`, which only the client uses. | `beo-routes.ts:1854-2330` |
| Studio / one-off bookings | `studio_event_bookings`: `amount_total`, `amount_paid`, `payment_status`, `payment_method` (includes `pos`), **`pos_reference`**, `source_channel` | `routes.ts:18536-18600` |
| Event prepayment | `core_events.total_value`, `prepayment_*`, `child_name`, `parent_name`, WhatsApp phone | Schema |
| Camps | `camp_registrations` holds the child and guardian PII. `camp_attendance.payment_method` is a per-day value. | `routes.ts:15820-17583` |
| Drop-off / nanny (paid, timed) | `service_checkins` (duration, extension, consent, photos), `dropoff_checkins` (children jsonb), `nanny_reservations`. There is no price field. | `APP/server/checkin-routes.ts` |
| Staff vouchers | `voucher_templates` → `user_vouchers.token` (QR) → `voucher_redemptions`. A manager redeems them. | `voucher-routes.ts:433-556` |
| Staff directory for POS sign-in | `/api/directory/*` with `X-HR-API-KEY` | `APP/docs/src/api/directory.md` |
| Finance | Xero P&L and cash tables, currently broken (§7) | – |

## 9. Biometrics

**How it works [V]**

1. A manager creates an enrolment QR. It is a 24 h single-use token stored as SHA-256 (`routes.ts:8099-8168`).
2. The kiosk posts a base64 face image. Rekognition `IndexFaces` is called with `ExternalImageId` set to the employee or person id.
3. The returned FaceId is stored in `employees.face_id` or `people.face_id`.
4. The enrolment photo is also saved as the profile photo in the **public** `profile-photos` folder (`routes.ts:8583-8720`).
5. For a match, `/api/kiosk/identify-face` runs a home-made "liveness" heuristic, then `SearchFacesByImage` at a threshold of 80 (`face-recognition.ts:508`).
6. The byte-difference heuristic is at `face-recognition.ts:180-305`.

**Where things live**
- Templates live only in the Rekognition collections.
  - `faces-dev` and `faces-staging` are in the agency's account.
  - `faces-local` is the Tilt collection.
  - The Replit environment uses its own collection name (in `.replit`).
- The DB keeps FaceIds, scores and `photo_evidence_url` on `time_events`, `kiosk_auth_attempts` and `advisor_attendance_sessions`.

**What must be removed or replaced**
- `server/face-recognition.ts` in full.
- `routes.ts:8099-8222` and `:8514-9007`, plus the FACE default at `:9008+`.
- Attention rules `FACE_ENROLLMENT_REQUIRED` and `FREQUENT_PIN_USAGE` (`attention-engine.ts:573-649`).
- The `authMethod:"FACE"` written by the midnight auto clock-out (`scheduled-jobs.ts:157`).
- Columns `face_*`, `confidence_score` and `liveness_score`, and the tables `enrollment_sessions` and `advisor_enrollment_sessions`.
- The env vars, the IAM policy and the `@aws-sdk/client-rekognition` dependency.
- A decision is needed on the clock-in evidence photos (`pin-photos`).
- Deleting the Rekognition collections requires the agency.

**Do not just unset `USE_AWS_REKOGNITION`.** The mock service returns the first enrolled employee for any face (`face-recognition.ts:132-145`). Remove the routes instead.

**The replacement needs a new trust model anyway**
- `/api/kiosk/clock` accepts a client-supplied `employeeId` with no auth (`routes.ts:9008-9040`).
- `/api/kiosk/clock-pin` and `/clock-phone` are open too (`routes.ts:9772`, `:9596`).

## 10. Re-hosting assessment

**Lift as-is first.**

Why:
- 796 Express handlers live in one closure.
- There are 1,400+ references to `requireAuth`, `req.user` and `req.userWithAccess`.
- There are roughly 10 multer configs and streaming responses.
- There are no unit tests.
- The client still commits to this code in Replit (2,920 commits in 8 months).
- A Fastify rewrite would fork from a moving upstream.
- Later extraction is cleanest for the modules that already have their own router files: vouchers, check-in, parent portal, BEO, tasks and announcements.

### Work list for Render

1. **Hosting.** Docker web service with the existing `Dockerfile`, 2 GB RAM or more, one instance, health check on `/api/status`, `TZ=UTC`, `LOG_RESPONSE_BODY=false`. Put it in the same region as Postgres.
2. **Own schema and own DB role.**
   - Drizzle emits unqualified table names, so `ALTER ROLE oto_app SET search_path=oto_app` works with no code change.
   - The session table and the raw SQL follow the search path too.
   - Generic table names would collide in a shared `public`: `users`, `session`, `roles`, `branches`, `tenants`, `settings`, `files`, `tasks`, `notifications`, `locations`.
   - **Never run these against the central DB:**
     - `drizzle-kit push --force`. It treats unknown tables as drops (`APP/scripts/post-merge.sh:22`, `APP/Dockerfile.dev:21`).
     - The reset scripts. They run `DROP SCHEMA public CASCADE` (`APP/infra/scripts/db-reset.sh:60`).
   - Move to generated SQL migrations. Longer term, run a `pgSchema("oto_app")` codemod over 186 tables and 65 enums.
   - To load the dump: restore it into a scratch database, run `ALTER SCHEMA public RENAME TO oto_app`, then `pg_dump` it across. The Navicat file hard-codes `"public".`.
   - `APP/server/prod-sync.ts:7+` contains a ready foreign-key-safe table load order.
3. **Object storage.**
   - Use S3 or R2.
   - There are 4 separate `S3Client` constructions with no `endpoint` option: `s3Storage.ts:31`, `pdf-storage.ts:34`, `presignedUpload.ts:26` and `checklistMediaRoutes.ts:38`.
   - Merge the second bucket into the first and add bucket CORS.
   - Rewrite `/<bucket>/…` in `contract_instances.signed_pdf_path` and in the `employee_letters` equivalent.
   - Move the four local-disk writers listed in §6 to object storage.
4. **Secrets.**
   - New values mean: reprint the branch check-in QR codes, re-activate every kiosk and reset advisor PINs.
   - Do this unless the agency hands over `SESSION_SECRET`, `SESSION_PEPPER`, `KIOSK_CODE_PEPPER` and `PIN_FINGERPRINT_SECRET`.
5. **Replit-specific pieces.**
   - Cookie `secure` is keyed on Replit env vars, so it would be `secure:false` on Render (`APP/server/auth.ts:36-47`).
   - The `replit_integrations` directory.
   - The `AI_INTEGRATIONS_*` naming.
   - The hard-coded Xero redirect URI.
   - The Nix Chromium fallback path.
   - Also declare `sharp` and add `ffmpeg` to the image.

### Swapping login for the platform session

Everything authenticated hangs on Passport's `req.user` and `req.isAuthenticated()`.

1. Add one middleware or custom strategy before `passport.session()`. It validates the platform cookie or JWT, maps it to a user through a new unique `users.platform_user_id`, and calls `req.login()`.
2. `getUserWithBranchAccess` then still resolves role, branch scope and tenant, so all 796 handlers stay untouched.
3. Keep the local `users` rows because of the 127 foreign keys. Keep OTO's branch and advisor scoping local in step 1.
4. Re-point about 15 credential-writing routes at the console:
   - `routes.ts:896`, `:952`, `:1017`, `:1302`, `:3134`, `:3435`, `:3598`, `:3690`, `:3761`, `:12627`, `:12867`, `:25023` and `:25178`.
   - `auth.ts:144`.
   - All of `auth-otp-routes.ts`.
5. Propagate the nightly `runDepartedAccountDeactivation` job to the platform (`scheduled-jobs.ts:91`).
6. Import the scrypt hashes in the format described in §3.
7. Logout needs a back-channel or a short local session.
8. Kiosk bearer tokens and public tokens stay outside SSO.

## 11. Fragile, surprising or undocumented

| # | Finding | Ref | |
|---|---|---|---|
| 1 | **Secrets tracked in git.** `temp-env` holds 26 variables, including a GCS service-account JSON, a Twilio token and an AWS secret. `k8s/app.yaml:30-33` and `:50-51` contain what look like a real AWS key pair and an OpenAI key. `.replit:75-77` has seed admin credentials. A Sentry DSN sits in `infra/scripts/build.sh:46`. `cookies.txt`, `core_export.json` (config data only) and `uploads/` (signed contracts, camp and check-in photos) are also committed. Rotate everything. | `APP/temp-env` | [V] |
| 2 | `GET /api/public/camp-registrations/lookup` is unauthenticated and has no rate limit. It returns children's names, dates of birth, photos, allergies and behavioural notes by phone number, with an `ILIKE %phone%` match on pickup persons. | `APP/server/routes.ts:15871-15915` | [V] |
| 3 | `GET /api/contracts/:id/signed-pdf` has no auth. Any authenticated user can also fetch `/api/files/contracts/…` with no object-level check. | `:6958`, `:22576` | [V] |
| 4 | `app.use("/uploads")` serves local files with no auth, including employee documents. It builds the path from raw `req.path`, so a traversal is likely possible unless the proxy normalises paths. | `:1497-1504` | [V] / [I] |
| 5 | The Vault stores passwords in plaintext, with the code comment "In production, encrypt this". Xero tokens and the MD's signature image are also plain in the DB. **Treat the data dump as highly sensitive.** | `:24847` | [V] |
| 6 | `LOG_RESPONSE_BODY` is set to `"true"` in AWS, so PII, reset tokens, kiosk codes and supplier tokens are written to the logs. | `infra/pulumi/stacks/app.py:81` | [V] |
| 7 | `script/set-passwords.ts` sets **all** passwords to one hard-coded value with no environment guard. | `APP/script/set-passwords.ts` | [V] |
| 8 | The branch logo is dropped from PDFs in cloud storage modes. `getLogoAsDataUrl` maps `/api/files/branch-logos/…` to a local path that does not exist. | `APP/server/pdf.ts:13-40` | [V] |
| 9 | Xero sync upserts cannot work (§7). The OAuth flow works only on the Replit host. Any logged-in user can read P&L, balance sheet and invoices. | `xero-routes.ts:9`, `:181+` | [V] |
| 10 | RDS is internet-facing with 5432 open to the world and `sslmode=no-verify`. | `infra/pulumi/stacks/service.py:199`, `:230`, `:240` | [V] |
| 11 | `/app-map` (an internal system map), `data-admin-schema.svg` and the production sourcemaps are served publicly. `GET /api/test-sentry` throws for anyone who calls it. | `server/index.ts:83`, `vite.config.ts:36` | [V] |
| 12 | `POST /api/seed` is public. It is inert once users exist, but it has hard-coded fallback credentials. | `routes.ts:5929-5951` | [V] |
| 13 | The Replit agent's own notes confirm several traps. Advisor role and linkage: `coreUserId` lookups silently fail, so use the email fallback. `users.name` crashes Drizzle at runtime. Fix-status UI values differ from the DB enum. **`drizzle push` was silently failing for a long period because of bad enum data.** | `APP/.agents/memory/*.md` | [V] |

## Unknowns to resolve

1. **Which environment and database is production** (App Runner "staging", Replit, or an agency stack not in this export)?
2. **Which database the data dump came from.** The data dump was not opened, so its source is unconfirmed.
3. **Who controls `otoplay.org`, `otoplay.dev` and the `.replit.app` deployment.** Every issued link and QR code embeds one of those hosts.
4. **Whether the agency will hand over:**
   - the four secrets listed in §10, item 4;
   - a proper `pg_dump -Fc`;
   - copies of both S3 buckets and the GCS bucket;
   - confirmation that the Rekognition collections have been deleted.
5. **How many DB file references actually resolve.** Run a prefix census on the restored data: `/api/files/`, `/objects/`, `/uploads/`, `uploads/employee-documents/`, and `/<bucket>/`.
6. **Row counts and the real tenant and operator setup.**
7. **Whether Xero, SMTP and the Directory API are in use at all.**
8. **The ongoing Replit development workflow.** The Replit workspace must never be able to point at the central DB.

Temporary analysis scripts are in the session scratchpad only. Nothing under `imports/` was created, modified or deleted.

## Key absolute paths

- `imports/oto-app/server/routes.ts`
- `imports/oto-app/server/storage.ts`
- `imports/oto-app/server/auth.ts`
- `imports/oto-app/server/auth-middleware.ts`
- `imports/oto-app/server/kiosk-auth.ts`
- `imports/oto-app/server/face-recognition.ts`
- `imports/oto-app/server/scheduled-jobs.ts`
- `imports/oto-app/server/file-storage.ts`
- `imports/oto-app/server/pdf-storage.ts`
- `imports/oto-app/server/checkin-routes.ts`
- `imports/oto-app/server/core/checklistMediaRoutes.ts`
- `imports/oto-app/server/xero-routes.ts`
- `imports/oto-app/server/prod-sync.ts`
- `imports/oto-app/shared/schema.ts`
- `imports/oto-app/shared/permissions.ts`
- `imports/oto-app/server/db/coreSchema.ts`
- `imports/oto-app/infra/pulumi/stacks/service.py`
- `imports/oto-app/infra/pulumi/stacks/app.py`
- `imports/oto-app/.agents/memory/`
- `imports/_db/data-structure-only-for-oto-app.sql`
