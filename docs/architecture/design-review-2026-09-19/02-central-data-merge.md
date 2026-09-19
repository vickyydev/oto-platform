## 1. Establish what actually exists before designing mappings

**Evidence in the repository**
- `oto-platform/CLAUDE.md` line 19 says the existing system runs "on AWS (Kubernetes, PostgreSQL on RDS)".
- Brief section 12 says "Production RDS access is available". The addendum says "production Postgres dump".
- The only MongoDB string in the whole tree is `mongodb-client-encryption` in the esbuild externals list of the unused Replit stub (`artifacts/api-server/build.mjs:51`). That is template noise, not evidence.
- The balance of evidence is therefore Postgres. The "Node + MongoDB on EC2" note most likely describes an older generation of the system or a different app.

**The more probable surprise is several datastores, not the wrong engine**
- The Replit template in this repo (`lib/db`, `drizzle-kit push`, the `serial` id example) shows the shape each imported app will arrive in: its own Drizzle schema, pushed without migrations, to its own Replit-managed Postgres.
- "The production dump" probably covers the OTO App on RDS only.
- Satang, Wheel, Inbox (Asset Manager), Radar and Omni Analytics may each have their own database, or only mock data.

**How to confirm, using metadata only (no personal data moves)**
- In AWS: run `aws rds describe-db-instances`, `aws docdb describe-db-clusters` and `aws ec2 describe-instances`. Run `kubectl get deploy,sts,svc -A`. List the names of the environment variables and secrets on the workloads, looking for `DATABASE_URL` versus `MONGO_URI`.
- On the dump file: a `PGDMP` header plus `pg_restore -l` lists every table without restoring anything. A mongodump is `.bson` or `.archive`.
- In each imported repo: search `package.json` for `pg`, `drizzle-orm` or `prisma` versus `mongoose` or `mongodb`. Read `lib/db/src/schema/*`. Because `drizzle-kit push` lets the repo schema drift from production, the dump is the truth and the repo is not.
- Record the result as a data-source inventory table with one row per app: runtime host, datastore, whether the data is real, daily users, which module it maps to.

**Designing for either engine**
- Only stage 1 (landing) differs.
- A Postgres source is restored into a `legacy_<app>` schema.
- A MongoDB source is dumped to JSONL and loaded as `legacy_<app>.<collection>(_id text primary key, doc jsonb)`. SQL views then flatten the documents into typed staging tables.
- Everything from staging onward is identical. `core.legacy_map.source_pk` is `text`, so integers, UUIDs, ObjectIds and composite keys all fit.
- MongoDB adds effort in profiling (missing fields, mixed types per field). It does not change the architecture.

## 2. Database organisation

**One database, one cluster, one pool (brief section 9), with a Postgres schema per bounded context**

| Schema | Contents |
|---|---|
| `core` | operator, legal_entity (if the owner confirms separate companies), branch, department, location, employee (identity kernel only), account, account_identifier, credential, role, role_permission, role_assignment, module registry and entitlements, session, verification_code, audit_log, access_log, file_object, idempotency_key, signing keys, **legacy_map**, **erasure_log**, dsr_request, retention_policy |
| `crm` | tier, member, member_alias, child, pickup_person, member_tier_verification, **consent**. This is the second tier of the shared kernel, because POS, booking, events and camps, messaging, booth and analytics all reference customers. |
| `edge` | box, station, device, sync feed. Used by POS, booth, kiosk and the timekeeping kiosk. |
| `pos` | catalog, sale ledger, payment, cash, wallet, band, booking, redemption, visit |
| `inv`, `hr`, `sched`, `ops`, `events`, `msg`, `booth`, `fin`, `ai` | `hr`: contracts, documents, reviews, movements, sensitive fields. `sched`: availability, leave, rota, attendance. `ops`: tasks, checklists, announcements, SOP, Fix reports, staff vouchers. `fin`: Satang. |
| `analytics` | dimensions, daily and hourly facts, the dirty-date queue. No personal data. |

**Rules**
- Foreign keys may point from a module into `core`, `crm` and `edge` only, never between modules. Cross-module references are plain IDs plus application logic.
- A CI check queries `information_schema` for forbidden cross-schema foreign keys.
- An ESLint `no-restricted-imports` rule stops module A importing module B's Drizzle tables.
- Use Drizzle `pgSchema('core')` and similar, with `schemaFilter` added to `packages/db/drizzle.config.ts`. Keep **one linear migration stream**, because cross-schema foreign keys need one ordering and the API deploys as one unit. Triggers, partitions and roles go in hand-written SQL migrations.
- Rename the generic placeholders while they are empty: `transaction` becomes `pos.sale`, `item` becomes `inv.stock_item`.
- Replace growing pgEnums (`station_kind`, `contact_channel`) with text plus a CHECK constraint. `contact_channel` already needed migration 0002 to add one value.
- Every tenant-owned table carries `operator_id`, and `branch_id` where relevant. Tenancy stays row-scoped and is enforced in an operator-scoped repository layer. Do not enable row-level security now. The uniform columns make it possible later for `hr` and `crm.child` as defence in depth.
- Database roles:
  - `oto_app`: data manipulation only, no schema changes.
  - `oto_migrator`: schema changes.
  - `oto_etl`: used only during migration windows.
  - `oto_analytics_ro`: SELECT on `analytics` only.
- Skip per-module database roles. With one pool they add cost and no protection.
- Create the database as UTF8 with ICU. Use a `th-x-icu` collation for name sorting, `pg_trgm` for name search (Thai has no word boundaries) and lower-cased email indexes.

## 3. Shared kernel and identity unification

**No universal party table.** There are two identity aggregates:

1. **Staff identity: `core.employee` plus `core.account`.**
   - `employee` gains `employee_no`, `worker_type` (employee, casual, advisor; SCRUM-160), status, employment dates, `manager_employee_id`, the home branch and department, and `mastered_by`.
   - Deep HR data stays in `hr.*` keyed by `employee_id`: contracts, pay, national ID, bank details. These fields are encrypted at application level and sit behind their own permission.
   - Accounts without an employee remain allowed, for platform admins and an external accountant.
2. **Customer identity: `crm.member` plus `crm.child`.**

**An employee who is also a customer**
- This is an explicit, audited, nullable link: `crm.member.linked_employee_id`, with a partial unique index.
- The ETL sets it on an exact E.164 phone match plus human confirmation. HR can also set it.
- It powers staff benefits at checkout (SCRUM-100 and SCRUM-101).
- It keeps the two purposes, legal bases, retention clocks and erasure semantics separate. Reception never sees HR data. HR never sees a staff member's children.

**Staff accounts across apps**
- Users in the OTO App, Satang, Inbox, Radar and Wheel arrive keyed by email, username or phone.
- Add `core.account_identifier(account_id, kind phone|email|legacy_username, value_normalised, verified_at, is_login)`, unique on `(operator_id, kind, value)`. Several legacy users then resolve to one account.
- `account.phone NOT NULL` (`packages/db/src/schema/tenancy.ts`) has to relax accordingly.
- Add `core.credential(type password|pin|badge, algo, hash)`.
- Default cutover for staff: load every account as `invited` and use the existing SMS setup flow.
  - The flow is already built. It proves phone ownership, which phone sign-in depends on.
  - It works whatever the legacy auth was. Replit apps often use Replit Auth or Google, in which case there are no password hashes to carry.
  - A bcrypt-verify-then-rehash path is the fallback, only if the client objects.

**Customers duplicated across apps and phone formats**
- The deterministic key is E.164, produced by the same `normalizePhone` in `packages/shared/src/phone.ts`. Extend it with a legacy pre-normaliser for:
  - `66XXXXXXXXX` with no plus sign;
  - Thai digits ๐ to ๙;
  - zero-width spaces pasted from LINE;
  - multiple numbers in one field.
- Add `classifyPhone()` with these classes: valid TH mobile, valid TH landline, valid foreign, ambiguous, invalid, placeholder. `normalizePhone` currently uses the lenient `isPossible()`. The ETL records both `isPossible` and `isValid`.
- Match tiers:
  - An exact E.164 match merges automatically.
  - The same email with a similar name goes to a review queue.
  - A name-only match never merges.
- A phone shared by more than N members or N distinct names is quarantined, not merged. Typical causes are the reception phone and placeholder numbers.
- Children are de-duplicated only inside a merged member, by normalised name plus date of birth.
  - Survivorship for allergy and medical text is a **union that never drops content**.
  - The merge clears `last_confirmed_at` so the till forces the guardian to reconfirm at the next visit.
- Messaging contacts (LINE userId, WhatsApp id, Instagram handle) go to `msg.contact_identity` with a nullable member link. They are not forced into members.
- The merge mechanics are `crm.member.merged_into_id` plus `crm.member_alias(alias_id, member_id)`. They are shared with the offline rule in brief section 8 that the same phone created at two counters merges. One mechanism serves both the ETL and sync ingest.
- Change the `child` to `member` foreign key from `ON DELETE CASCADE` to `RESTRICT`.

## 4. ID strategy

- Every target primary key is a UUIDv7. Legacy IDs never become primary keys or columns.
- Human-facing business numbers are carried as business-key columns. Examples are the employee number, booking reference, original receipt or invoice number (in a distinct `origin='legacy'` series) and voucher codes.
- `core.legacy_map(source_system, source_table, source_pk text, target_schema, target_table, target_id uuid, run_id, match_rule, loaded_hash)`:
  - The primary key is `(source_system, source_table, source_pk)`.
  - There is an index on `(target_table, target_id)`.
  - Many-to-one rows record merges.
- Migrated IDs are **deterministic and UUIDv7-shaped**.
  - The 48-bit timestamp comes from the immutable legacy `created_at`. If that is unreliable, use a fixed per-source epoch.
  - The remaining bits come from SHA-256 of `source_system|table|pk`.
  - Build them with `UUID.fromFieldsV7` from the `uuidv7` package already in use.
- Migrated rows then sort chronologically beside native rows. Re-runs from an empty target produce identical IDs. The survivor of a merge is chosen by a stable rule (oldest `created_at`, then lowest key), so merged IDs are stable too.
- An existing `legacy_map` entry always wins over re-derivation.

## 5. The ETL pipeline

**Shape**
- A workspace package `oto-platform/tools/migrate`, excluded from the API bundle.
- A thin TypeScript runner over plain SQL files. Volumes are small and the team writes TypeScript.
- It runs in a **workbench Postgres** that contains the platform schema (applied by the normal migrations) plus `legacy_*`, `stg_*` and `etl.*` schemas.
- It runs on a controlled host, never against production RDS.
- Only finished target rows and `core.legacy_map` ever reach the production cluster.

**Stages**
0. **Acquire.**
   - Take `pg_dump -Fc --no-owner --no-acl` from a restored snapshot or a replica.
   - Take an inventory of the S3 bucket.
   - Transfer both encrypted.
   - Record the checksum and the snapshot timestamp.
1. **Land.**
   - Restore into an empty database, then `ALTER SCHEMA public RENAME TO legacy_<app>`.
   - Verify the source encoding in the dump header.
2. **Profile.** This is automated. The committed report contains no personal data and its JSON is diffable between runs. It covers:
   - row counts;
   - live versus dead tables, judged by the latest timestamps;
   - null rates;
   - orphaned foreign keys;
   - duplicate clusters;
   - phone classes;
   - an inventory of free-text status values;
   - money column types, with monthly sums;
   - file references checked against the bucket inventory;
   - Thai-text checks:
     - mojibake patterns such as `à¸`, produced when UTF-8 is read as Latin-1, or TIS-620 stored in a SQL_ASCII database;
     - U+FFFD and runs of `?`;
     - NFC normalisation;
     - **Buddhist-era years** (a date of birth in 2560 means 2017);
     - whether each `timestamp without time zone` column holds Bangkok local time or UTC, inferred from when clock-in events cluster.
   - Every table receives a verdict of migrate, archive-only or drop, signed off by the client.
3. **Stage.** Tables are typed and cleaned.
   - Phone normalisation runs as a TypeScript batch that writes `stg.phone_norm`, so SQL transforms join to exactly the runtime's normaliser.
   - Baht converts to satang, and any fractional result is flagged.
   - Timestamps become `timestamptz`.
4. **Resolve identities.**
   - Build the clusters.
   - Apply the persistent `etl.manual_decision` rows. They are keyed by legacy keys, so they survive re-runs.
5. **Transform** into the real target tables inside the workbench. Every constraint fires here, not in production.
6. **Load** into staging or production by upsert on `id`.
   - A previously loaded row is updated only if its current hash equals `legacy_map.loaded_hash`. A mismatch means the row was edited natively, so it goes to a conflict report.
   - A legacy member whose phone matches an existing native member maps onto the native ID. Children merge with the reconfirm flag. A native tier verification is never overwritten.
   - Audit gets one row per run per table with `origin='migration'`. `legacy_map` is the row-level provenance.
   - The loader consults `core.erasure_log` as a suppression list, so a re-run never resurrects an erased person.
   - `migrate unload --run <id>` removes a run's unmodified rows.
7. **Reconcile.**
   - Every source row has an outcome in `etl.row_outcome`: migrated, merged, rejected or excluded.
   - Totals are checked per month, per branch and per method, to the satang. They cover wallet or voucher liability, attendance hours, leave balances, and the count and value of open bookings.
   - A **hard assertion** requires every legacy child with allergy text to have allergy text in the target.
   - Run-to-run determinism is checked by table-content hashes. It needs the deterministic IDs and `migrated_at` set to the snapshot time, not `now()`.
8. **CI.**
   - CI runs the whole pipeline on a synthetic legacy fixture containing Thai text, Buddhist-era dates, duplicate phones and float money.
   - It reuses `createTestDatabase()` from `packages/db/src/testing.ts`.
   - Real dumps never reach CI or git.

**Files**
- Copy S3 objects to a staging bucket. Create `core.file_object` rows with deterministic IDs and verified checksums.
- Signed contract PDFs stay byte-identical, together with their signature evidence (SCRUM-166).
- **Excluded by rule:**
  - face images and templates (SCRUM-118 conflicts with brief section 13);
  - identity-document photos (brief section 10);
  - child photos.

## 6. Absorbing the other apps without a big bang

**Freeze-and-migrate, one module at a time**
- Every module has exactly one system of record at any moment. The module registry tracks it as status `legacy_link`, `pilot`, `live` or `retired`.
- The launcher shows every app from day one. Tiles with status `legacy_link` open the legacy app's URL. A tile flips to the internal route when its module is cut over. The client sees the professional suite immediately, with no data coupling.
- There is no dual-write and no request-time read-through to legacy.
- Where the new platform needs data still mastered in legacy, a **one-way scheduled snapshot import** of those kernel tables runs over a read-only RDS user. The imported rows are read-only in the new UI and marked `mastered_by='legacy_otoapp'`. The master flips when the owning module cuts over. The typical case is the employee list for staff benefits.

**Order**
1. The kernel: organisation structure, employee identity, accounts and roles. SCRUM-158 says to confirm this model before the schema is fixed.
2. Customers and children, with consent gating.
3. Wheel and Satang as low-risk rehearsals.
4. Ops: tasks, checklists, announcements, SOP, Fix.
5. Timekeeping, scheduling and leave, at a pay-period boundary.
6. HR documents and e-signature.
7. Events and camps, carrying open bookings and deposits.
8. Inbox. Each webhook can only point at one endpoint, so this is a natural hard switch.
9. Analytics and Radar last. They keep reading legacy until the rollups exist.

**Each module cutover**
- Two rehearsals.
- Freeze the legacy module, by a permission change or by revoking write grants on its tables so writes fail loudly.
- A final delta run.
- Reconcile gates.
- Flip the tile.
- Legacy stays read-only for 30 to 90 days. Then an encrypted archive is taken and AWS is torn down.

**Closed history goes to `analytics` facts and an encrypted archive.** Only open obligations and legally required records enter the new transactional tables:
- future bookings;
- stored value and live vouchers;
- leave balances;
- open tasks;
- employment records, contracts and attendance.

## 7. Analytics (Omni Analytics, Oto Radar)

- The `analytics` schema holds `dim_date` (Thai holidays taken from `branch_holiday`), `dim_branch`, `dim_product` and these facts:
  - `fact_sales_daily`
  - `fact_admissions_hourly`
  - `fact_occupancy_15min`
  - `fact_wallet_liability_daily`
  - `fact_attendance_daily`
  - `fact_labour_hours_daily`
  - `fact_tasks_daily`
  - `fact_booth_daily`
  - `fact_messages_daily`
- Every ledger row stores `business_date` at write time (branch timezone plus a day cut-off), so rollups never redo timezone logic.
- Rollup jobs:
  - They run in-process on the shared pool at about 03:00 Bangkok.
  - They are idempotent per (branch, business_date).
  - They recompute a sliding window plus every date in `analytics.dirty_date`. Sync ingest marks a date dirty when a box delivers late offline events.
- Live tiles (today's revenue, current occupancy, who is at work) are not served from rollups. They come from a few registered, bounded, indexed "today" queries or small read models such as `pos.branch_day_summary`.
- Dashboard endpoints use `SET LOCAL statement_timeout` and a small concurrency semaphore, so they cannot starve the pool on one CPU.
- The schema holds no names, phones or child-level rows. Member erasure therefore never touches rollups, and aggregates can be kept indefinitely.
- The two apps become front-ends over `/v1/analytics/*`. Code uses a distinct `analyticsDb` handle on the same pool, so moving to a read replica later is a configuration change.
- Legacy history is backfilled straight into the facts with `origin='legacy'`.

## 8. PDPA, retention and deletion

All legal specifics below need confirmation by Thai counsel.

**Children and sensitive data**
- Children's data arrives through the guardian. Allergy and medical notes are sensitive data under section 26 and need explicit consent.
- `child.consent_recorded_at` (`packages/db/src/schema/members.ts`) is not a consent record. Add `crm.consent(subject, given_by_member_id, purpose, notice_version, locale, channel, given_at, withdrawn_at, station_id, account_id)`.
- Purposes: `child_profile_storage`, `child_health_data`, one marketing purpose per channel, `pickup_photo`.
- Legacy children load with `consent_status='legacy_unverified'`. The till asks for consent at the next visit. Children with no visit inside the agreed window are not migrated.

**Erasure conflicts with the current foundations**
- CLAUDE.md says there are no hard deletes. `apps/pos/BACKEND_REQUIREMENTS.md` lines 98 to 125 require a hard delete for child profiles.
- Design:
  - hard-delete rows that nothing references;
  - anonymise in place where retained records reference the row;
  - keep the sale ledger free of customer personal data. Buyer details for a full tax invoice sit in a separate table with a five-year life.
- The audit `before/after` payload currently copies whole rows. Change it to an allowlisted, field-level diff with sensitive fields redacted at write time. The audit then stays immutable and is still safe under erasure.
- `core.erasure_log` holds the hashed phone and the legacy keys. It is:
  - re-applied after any backup restore;
  - consulted by ETL re-runs;
  - turned into tombstones that propagate to box caches through the sync feed.

**Other measures**
- `core.access_log` records reads of child health data and sensitive HR fields. It is partitioned monthly.
- `core.dsr_request` holds data-subject requests. Each module manifest registers `exportSubject` and `eraseSubject` handlers.
- `core.retention_policy` plus a nightly job applies retention. Proposed defaults for the client and counsel to confirm:

| Record | Proposed retention |
|---|---|
| Inactive member | Anonymise after 24 months |
| Child profile | 12 to 24 months after the last visit, or when the child ages out |
| Conversations | 12 months |
| Employee register and wage records | 2 years after termination |
| Payroll, tax and accounting documents | 5 to 7 years |
| Audit | Per action class. Child release and HR legal events are kept longer than the blanket twelve months in the brief. |
| Raw EDC byte logs | 90 days |
| Legacy dump and workbench | Destroyed with a written record 90 days after the final cutover |

**Processor duties for the dump**
- The working directory is inside OneDrive (`C:/Users/waqar/OneDrive/Desktop/Projects/oto-pos`). A dump placed there would sync to a third-party cloud.
- Keep dumps on an encrypted volume outside OneDrive. Add `*.dump`, `*.sql.gz` and `*.bson` to `.gitignore`. Never paste rows into Jira or an AI tool.
- Prefer a **pseudonymised dump** for development. HMAC-based, format-preserving scrambling keeps the duplicate structure intact. The real dump is used only on a controlled host for final profiling, rehearsals and cutover.
- Hosting in Singapore is a cross-border transfer. The privacy notice must disclose it.

## 9. Cutover and rollback shape

**Per module**
- Profile and agree the mapping spec.
- Rehearsal 1 on staging. The client receives the reconciliation report.
- Rehearsal 2. It must reproduce rehearsal 1 exactly.
- Schema freeze for that module.
- At T0, with the park closed:
  - freeze legacy;
  - take the final snapshot;
  - run the timed pipeline, keeping a twofold margin inside the window;
  - apply the automated hard gates: counts, money to the satang, liabilities, the child-allergy assertion and open bookings;
  - a named go/no-go decision (SCRUM-113);
  - flip the module status and the launcher tile;
  - run smoke tests;
  - bump `cache_epoch` so every box does a full resync.

**Rollback**
- Before go: run `migrate unload --run`, or restore the pre-load backup. A Render point-in-time restore creates a new instance, so the runbook must include repointing `DATABASE_URL`.
- After go, inside a short window (72 hours for ops modules, one pay period for timekeeping): unfreeze legacy and re-key the new records from an exported report.
  - Reverse sync into a legacy system nobody maintains is not worth building.
  - Windows stay short. Cutovers happen at quiet times, one module at a time, to keep the blast radius small.
- After the window: forward-fix only.
- Parallel run (SCRUM-111) is limited to one week, on one branch or counter, using daily reconciliation queries defined in advance.