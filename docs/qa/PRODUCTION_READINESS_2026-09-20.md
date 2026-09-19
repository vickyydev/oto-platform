# Production readiness audit — 2026-09-20

_Audit of `apps/api`, `apps/pos` and `packages/*` against the first
deployment: a staging environment running the **production build** against
throwaway data, on Render, behind a proxy, with the POS served as a static
site that rewrites `/api/*` to the api service, opened by the park's team on
real devices over a mall connection._

**This document produces findings, not fixes.** No source file was changed.
Nothing here was executed against Render, R2 or Twilio; every finding is read
out of the code in the working tree.

## Reading this list

Findings are grouped by when they have to be dealt with, and ranked inside
each group. Each one carries the file and line as they stood while this was
written, what breaks, the sequence that breaks it, how far it reaches, and a
fix in a sentence or two.

- **Blocks the first deploy** — the park's team will hit it on the walkthrough,
  or it puts a member's data where it should not be.
- **Fix during the sprint** — real, but staging survives a day without it.
- **Note for later** — worth recording, not worth a ticket yet.
- **Verify on the first deploy** — not defects: unknowns that one observation
  settles, and that are expensive to discover later.
- **Deliberate, not findings** — things that look wrong and are not, recorded
  so nobody "fixes" them.

### Moving ground

`apps/api/src/env.ts`, `apps/api/src/services/sms.ts` and `render.yaml` were
being edited **while this audit ran**. Two problems found early were already
closed in the working tree by the time the document was written, and are
recorded under "closed while this ran" rather than as open findings. Line
numbers for those three files are from the current working-tree version;
`render.yaml` was still moving at the end, so its line numbers may have
shifted again.

---

## Blocks the first deploy

### B1 — Every profile-photo upload asks object storage to create the bucket

`apps/api/src/routes/files.ts:62` → `apps/api/src/services/files.ts:30-34`

`POST /files` calls `ensureBucket()` on every single upload, and
`ensureBucket` is `bucketExists()` followed by `makeBucket()` when the head
comes back empty. Under minio-js 8.0.7 that is up to three round trips before
a byte moves: `GET /bucket?location=` (the region probe, because no `region`
is set on the client), `HEAD /bucket`, and then `PUT /bucket` if the head says
the bucket is not there.

**Scenario.** The bucket is Cloudflare R2 with an API token scoped to
`oto-files-staging` and **Object Read & Write** — the token the owner was told
to create. That token has no bucket-creation right. Someone opens their
profile and uploads a photo; `bucketExists` throws on a 403 rather than
returning `false` (minio-js only maps `NoSuchBucket`/`NotFound` to `false`,
`dist/main/internal/client.js:740-758`), the error reaches the error handler
as an unknown throw, and reception sees **500 Internal server error** on a
path that is on the Sprint 1 acceptance list.

**Blast radius.** Profile photos — the only thing using storage today. It
becomes wider the moment anything else stores a file.

**Fix.** Call `ensureBucket()` once at boot (or not at all — the bucket is
created by the owner, not by the api), and treat a failure as "storage
unavailable" rather than letting it fall through to a 500. Set `region` on the
minio client explicitly so the region probe never happens.

### B2 — The boot guard does not check that object storage is actually reachable configuration

`apps/api/src/env.ts:76-84` (defaults) and `:121-165` (`assertProductionSafe`)

`MINIO_ENDPOINT` defaults to `localhost`, `MINIO_PORT` to `9000`,
`MINIO_USE_SSL` to `false`. `assertProductionSafe` refuses the development
**access key and secret** on a deployment, and says nothing about the endpoint,
the port or SSL.

**Scenario.** The deploy sets the three `sync: false` values it was asked for
— endpoint host, access key, secret — and the port or the SSL flag is missed,
or the endpoint is left unset. The api boots clean and healthy. The first
upload then talks plain HTTP to port 9000 of a host that only answers TLS on
443: on Render that is a connection that hangs until the OS gives up, holding
a request and a pool connection, with no timeout anywhere in
`services/files.ts`. Nothing in `/ready` notices, because `/ready` only checks
the database (`routes/health.ts:7-14`).

**Blast radius.** Every file operation; one hung upload per stuck request,
each holding a connection out of a pool of ten.

**Fix.** Extend `assertProductionSafe`: on a deployment, refuse
`MINIO_ENDPOINT` of `localhost`/`127.0.0.1`, and refuse `MINIO_USE_SSL=false`.
Give the minio client a request timeout. Consider adding a storage probe to a
separate readiness surface — not to `/ready`, which must not take the service
out of rotation because a bucket is down.

### B3 — The verification SMS is sent inside an open database transaction

`apps/api/src/routes/accounts.ts:133` and `apps/api/src/routes/operators.ts:135`,
against `apps/api/src/services/tx.ts:56-82` and the pool settings in
`packages/db/src/index.ts:34-46`

`issueCode(tx, app.sms, …)` runs inside `withTx`. With the console adapter
that was a log line. With Twilio it is an outbound HTTPS call with a 10 s
deadline and up to three attempts plus back-off — a worst case of about 31 s
(`services/sms.ts:58-69`) — during which the Postgres connection sits **inside
a transaction, idle**, and `idle_in_transaction_session_timeout` is 30 s
(`packages/db/src/index.ts:44`).

**Scenario.** An administrator creates a staff account while Twilio is slow or
a retry is in flight. Postgres terminates the connection at 30 s; the
transaction is lost; the insert of employee, account, role assignments and the
verification-code row is rolled back — **after** the SMS has gone out. The new
staff member holds a valid-looking code for an account that does not exist,
and the administrator sees a 500. The shorter version of the same problem
happens on every slow send: one of ten pool connections is pinned in an open
transaction for as long as the provider takes.

**Blast radius.** Creating a staff account and assigning an operator
administrator — both on the staging walkthrough. Under load, pool starvation
that shows up as unrelated timeouts at the till.

**Fix.** Commit first, send second: write the code row inside the transaction
and send the SMS after it commits, with the send's failure reported to the
caller (the account exists; the code can be reissued) rather than rolling the
account back. Never hold a transaction open across a network call to a third
party.

### B4 — `GET /members/:id` is not scoped to the caller's operator

`apps/api/src/routes/members.ts:197-212`, via `memberWithChildren` at `:60-97`

Every other member route filters on `member.operatorId`. This one does not:
`memberWithChildren(app, req.params.id)` selects the member by id alone, then
returns their phone, name, email, notes, tier verification **and every child
with allergies and medical notes**.

**Scenario.** The walkthrough creates a second operator ("Admin: create
operator, branch, administrator" is on the acceptance list). Any account in
either operator that holds `pos:member:read` — reception included — can read
any member of the other operator by id. Ids are UUIDv7, so this is not
enumerable by guessing; it is reachable by anyone who has ever seen an id (a
copied URL, a support request, an audit row, a previous role at the other
operator).

**Blast radius.** Children's medical data across a tenancy boundary. The one
class of data in this system that should never cross one.

**Fix.** One line: pass the caller's `operatorId` into the lookup and answer
404 when it does not match — the same shape `DELETE /members/:id` already
uses at `:174-179`.

---

## Fix during the sprint

### S1 — Cross-tenant writes: the route guard cannot enforce tenancy, and four handlers assume it does

`apps/api/src/services/permissions.ts:46-57` (`grantCovers`), with
`apps/api/src/plugins/session.ts:143-156`

An `operator`-scoped grant covers a target whenever `grant.scopeId ===
target.operatorId`, and `requirePermission` fills `target.operatorId` from the
**caller's own** session. No route supplies an operator target. So for a
caller holding an operator-scoped permission, `config.target.branchId` is
never actually checked against anything: the guard passes for **any**
`branchId` in the URL, including another operator's. Every handler therefore
has to re-check ownership itself. Four do not:

| Route | File | What it lets through |
|---|---|---|
| `PATCH /branches/:branchId/ticket-packages/:id` | `routes/catalog.ts:123-161` | edit another operator's prices |
| `DELETE /branches/:branchId/ticket-packages/:id` | `routes/catalog.ts:163-198` | archive another operator's package |
| `DELETE /branches/:branchId/holidays/:id` | `routes/catalog.ts:253-279` | delete another operator's holiday range |
| `POST /visits` (`memberId`) | `routes/visits.ts:46-61` | put another operator's children on a visit and stamp their `last_confirmed_at` |

Each matches on id plus a caller-supplied `branchId`/`memberId` without ever
asking whether that branch or member belongs to the caller's operator. The
sibling `POST`/`GET` routes call `loadBranch(app, branchId, auth.operatorId)`
correctly, which is why this reads as an omission rather than a decision.

**Blast radius.** Prices the tills charge, and a child record written by
another tenant. Requires knowing the ids, as B4 does.

**Fix.** Call `loadBranch(...)` in the three catalogue handlers, and check the
member's operator in `POST /visits`, exactly as `POST /members/:id/children`
does at `routes/members.ts:496-497`. Separately, consider making the guard
itself resolve a `branchId` target to its operator so a missing handler check
fails closed.

### S2 — The POS mints a fresh Idempotency-Key on every call, so the safeguard never fires

`apps/pos/src/api/client.ts:62` (`idemKey = () => crypto.randomUUID()`), used at
13 call sites in `apps/pos/src/api/platform.ts`

The key is generated **inside the call**, so a second attempt carries a
different key and is a different request as far as the api is concerned. The
whole idempotency plugin is, from the POS's side, decoration.

**Scenario.** Reception taps "Save" on a new ticket package on a mall
connection that is thinking about it, and taps again. Two packages. The same
for a holiday range, an operator, a role grant, a branch, an account
invitation and a booking. Only `POST /members` and `POST /visits` are safe,
and only because they carry a client-minted entity id
(`platform.ts:112`, `:130`) — which is the pattern that actually works here.

**Blast radius.** Duplicate catalogue rows and duplicate invitations on
staging; duplicate sales once S2-08 lands on the same client.

**Fix.** Mint the key once per user intent, in the component that owns the
button, and reuse it for every retry of that intent. Extend the client-minted
id pattern to the remaining creates.

### S3 — The booking site's Idempotency-Key is ignored entirely

`apps/api/src/plugins/idempotency.ts:53` (`if (!req.auth) return;`)

Idempotency is keyed on an account. `/public/bookings` has no account, so the
header the booking site does send (`platform.ts:244`) is dropped on the floor.

**Scenario.** A visitor on hotel wifi submits a booking, sees nothing happen,
submits again. Two bookings, two references, two held slots, one family.

**Blast radius.** The public booking flow, which is the one surface a member of
the public touches.

**Fix.** Let an unauthenticated principal own a key (branch code plus the key,
or the request hash alone), or give the booking a client-minted id the way the
till has.

### S4 — Sign-in is an unmetered account-existence oracle

`apps/api/src/routes/auth.ts:27-52` (no `ipLimited`, unlike every other public
auth route) and `apps/api/src/services/auth.ts:207-215`

Status is checked **before** the password, and the two status refusals throw
without calling `throttleFail`. So `403 SETUP_REQUIRED` and `403
ACCOUNT_INACTIVE` cost an attacker nothing and count towards nothing — and
`/auth/sign-in` is the one public auth route with no per-IP bucket attached.

**Scenario.** A script posts a phone number and a junk password, over and
over. A 401 means no account; a 403 names which state the account is in. The
park's staff roster, by phone number, at whatever rate the network allows.

**Blast radius.** Disclosure, not takeover: the password check is still
throttled per phone and per IP. It gets worse once staff phone numbers are
also member phone numbers.

**Fix.** Add `...ipLimited` to the route, and count the status refusals in the
per-IP bucket. The clear message SCRUM-19 asks for can stay — it is the
absence of a cost that makes it an oracle.

### S5 — The members list is an N+1 that can exhaust the pool inside one request

`apps/api/src/routes/members.ts:160`

`Promise.all(rows.map((m) => memberWithChildren(app, m.id)))` over up to 50
members, each doing three queries plus a `staffName` lookup when a tier
verification exists — roughly 150-200 queries fired concurrently against a
pool of 10 (`packages/db/src/index.ts:37`) with a 10 s acquire timeout
(`:40`).

**Scenario.** Two managers open the Members panel at once while the till is
selling. Acquisitions queue past 10 s and throw `timeout exceeded when trying
to connect`, which surfaces as a 500 — possibly to the till rather than to the
panel that caused it.

**Blast radius.** Whoever is unlucky enough to need a connection during those
seconds.

**Fix.** Three queries for the whole page (members, their children, their
latest verification) joined in memory, rather than three per member.

### S6 — One audit row is written outside its own transaction

`apps/api/src/routes/members.ts:514` — `audit.record(app.db, …)` inside a
`withTx` block that has `tx` in scope

Every other call site inside `withTx` passes `tx`. This one passes the pool.

**Scenario.** The child insert fails after the audit row is written (a
constraint, a statement timeout). The transaction rolls back; the
`child.create` audit row commits anyway and describes a child that does not
exist. The exact failure S2-01b's transaction work exists to remove, and
`transactions.test.ts` would not catch it because it forces its failure on the
audit insert itself.

**Blast radius.** The audit trail's credibility, which is the point of having
one.

**Fix.** `audit.record(tx, …)`.

### S7 — Password reset and account setup are not transactional

`apps/api/src/routes/auth.ts:140-159` (setup) and `:183-208` (reset)

Both run four or five statements with no `withTx`, unlike every other mutating
route.

**Scenario, reset.** `consumeCode` succeeds, `setPassword` succeeds,
`invalidateAllSessions` fails (a blip, a statement timeout). The password has
changed and **every old session is still live** — the one behaviour SCRUM-23
names in its acceptance criteria, quietly not true.

**Scenario, setup.** `consumeCode` marks the code used and `setPassword`
fails. The code is spent, the account is still `invited`, and the staff member
has to ask for another one.

**Blast radius.** Rare, and security-relevant when it happens.

**Fix.** Wrap both in `withTx`, as the ticket's siblings already are.

### S8 — A temporary password is stored in clear text when a key is sent

`apps/api/src/routes/accounts.ts:351` returns `{ temporaryPassword }`, and
`apps/api/src/plugins/idempotency.ts:152-155` writes the response body into
`idempotency_key.response_body`

The POS does not currently send a key on that call
(`platform.ts:266`), so this is latent — but any client that does, or any
future retry wrapper, persists a working credential in a jsonb column for
`IDEMPOTENCY_TTL_HOURS` (24) and replays it to anyone holding the key.

**Fix.** Mark the route as never-replayable, or redact known credential fields
before storing. The simplest honest option: do not store a response body for
routes that mint a secret.

### S9 — The idempotency claim outlives a crash, and caches refusals

`apps/api/src/plugins/idempotency.ts:66-121` and `:126-157`

Two related problems in one mechanism:

1. **Stuck in flight.** The claim row is written before the handler runs and
   is only resolved by a response. A deploy, an OOM or a `SIGKILL` between the
   two leaves `status_code` null for ever; every retry of that key gets `409
   IDEMPOTENCY_IN_FLIGHT` until the key expires 24 hours later. Render
   restarts the service on every deploy, so mid-operation restarts are routine
   rather than exotic. Nothing sweeps in-flight claims —
   `purgeExpiredIdempotencyKeys` (`:38-44`) only removes **expired** rows and
   is not scheduled yet (a recorded S2-03 follow-up).
2. **Refusals are cached.** The plugin's `preHandler` is registered at
   application level and the permission guard is a route-level `preHandler`
   (`plugins/permission.ts:92-96`), so the claim is taken **before** the guard
   refuses. `onSend` then stores any status below 500 — a 403, a 400
   validation error — and replays it for 24 hours to that key.

**Fix.** Record `started_at` on the claim and treat one older than a short
timeout as abandoned (take it over atomically, as the expiry path already
does). Store only successful responses, or at least skip 4xx.

### S10 — The active branch at sign-in is whatever Postgres returns first

`apps/api/src/services/auth.ts:221-226` — `.limit(1)` with no `orderBy`

**Scenario.** The operator has two branches (the walkthrough creates one).
Reception signs in and lands on an arbitrary one, which can differ between
sign-ins and after a plan change. Branch drives pricing mode, catalogue and
every branch-scoped permission check.

**Fix.** Order by `created_at`, or refuse to guess and make the station's
branch the source.

### S11 — A visitor's phone number is parked on the session row indefinitely

`apps/api/src/routes/me.ts:127-158`

The customer display writes the typed phone to `session.pending_lookup_phone`;
the till clears it on consume. The 30-second freshness is applied **on read
only** (`:155`). A lookup that is never consumed — the customer walks away,
the till moves on, the shift ends — leaves the number in `core.session` until
the row is deleted, which nothing currently does.

Also: the value is stored exactly as typed, with no normalisation or length
limit, so it is an arbitrary caller-controlled string in a core table.

**Fix.** Clear it on read regardless of freshness, normalise and bound it on
write, and include stale sessions in the S2-03 housekeeping sweep.

### S12 — Commercial wording in files that a reader outside the team can see

The standing rule is to name the system, never the arrangement. These are in
code and configuration, not documents:

- `render.yaml` — several comments about what "the client" plays with and "the
  client's staging URL" (the file was being rewritten as this was audited, so
  check the current text rather than the line numbers)
- `.github/workflows/ci.yml:55` — "never reaches the client's staging URL"
- `apps/api/src/env.ts:64` — "gives the client something to play with"
- `apps/api/src/services/demo-reset.ts:24` — "The client is meant to play with
  the staging deployment"
- `apps/api/src/routes/ops.ts:65` — "neither the client nor the seed can
  describe"

**Fix.** "The park's team", "staging", "reception", "the till". Note that the
POS's own on-screen wording — "client activity", the History tab's client view
— is the prototype's approved term for a **visitor** and must not be renamed
(CLAUDE.md §7.1).

---

## Note for later

- **N1 — the upload route trusts its body.** `routes/files.ts:41-85` accepts
  any `contentType`, does not check that `ownerEntityId` exists or belongs to
  the caller's operator, and issues a presigned PUT with no size or type
  constraint. Anyone with `pos:member:update` can put an arbitrary object of
  arbitrary size in the bucket.
- **N2 — the audit row for a file is written outside a transaction** too
  (`routes/files.ts:64-82`), same class as S6, lower stakes.
- **N3 — `ageFromDob` uses the device's timezone.**
  `apps/pos/src/api/mappers.ts:36-44` parses `YYYY-MM-DD` as local midnight, so
  a child's displayed age can be a day out around a birthday on a tablet set
  to the wrong zone.
- **N4 — `crypto.randomUUID()` needs a secure context.**
  `apps/pos/src/api/client.ts:62` and `newId()` are fine over HTTPS on Render,
  and will throw the day a till opens the POS over plain HTTP from a Pi on the
  mall LAN.
- **N5 — the booking reference format is irregular.**
  `routes/public.ts:239` pads a value up to 1,679,615 to four digits, so
  references range from `OTO-0042-4821` to `OTO-1679615-4821`. It is printed on
  a voucher.
- **N6 — the seed prints raw errors.** `packages/db/src/seed/index.ts:534`
  logs the whole error object; a pg `detail` quotes the offending value, which
  for the member seed is a phone number. Only reachable on a manual `db:seed`.
- **N7 — a misconfiguration answers 400.** `routes/files.ts:58` and `:101`
  return `badRequest('File storage is not configured')`. That is the server's
  fault, not the caller's: 503.
- **N8 — nothing sweeps the growing tables yet.** `idempotency_key`,
  `verification_code`, `auth_throttle` and revoked/expired `session` rows all
  accumulate. Known, owned by S2-03's job runner.
- **N9 — pino has no `redact` list.** `apps/api/src/lib/logger.ts` relies
  entirely on call-site discipline, which S2-01a established carefully. A
  redaction list would make a future careless log line harmless rather than a
  leak.

---

## Verify on the first deploy

These are not defects. They are things the code cannot tell me and one look at
the running deployment can.

1. **The proxy hop count.** `TRUST_PROXY=1` assumes exactly one proxy in front
   of the api. Browser traffic reaches it through the **static site's**
   `/api/*` rewrite, which may add a hop of its own. If it does, `req.ip` is a
   Render address rather than the visitor's, and the entire mall shares one
   120-per-minute bucket. Symptom: `TOO_MANY_REQUESTS` for everyone at once,
   or every `access.denied` audit row showing the same address. Check
   `req.ip` in a request log line against a known public address on the first
   day.
2. **The `Origin` header survives the rewrite.** The whole write surface
   depends on it (`app.ts:149-157`). If Render's rewrite rewrites or strips
   `Origin`, either every write is refused (`ORIGIN_NOT_ALLOWED`) or the check
   silently passes for everything. One POST from the deployed POS settles it.
3. **`Set-Cookie` survives the rewrite** and the session cookie lands on the
   POS origin with `Secure` and `SameSite=Lax` intact.
4. **R2 and the region probe.** With no `region` on the minio client, every
   presign first issues `GET /bucket?location=`. Confirm R2 answers it, and
   that the region it yields (or the `us-east-1` fallback at
   `minio/dist/main/internal/client.js:552`) is one R2 will accept a signature
   for. Setting `region: 'auto'` explicitly removes both the round trip and
   the question.
5. **`SIGTERM` reaches the process through the pnpm wrapper.** Already flagged
   in the blueprint; the evidence is a "shutting down" line in the logs on
   every deploy. Without it, deploys drop in-flight requests.

---

## Deliberate, not findings

Recorded so they are not re-reported:

- **The screens on mock data.** CLAUDE.md §6 keeps selling, F&B, shop, stock,
  check-in, events, messages, Today and History on the in-memory mock for now.
  `mockApi.ts` being 5,836 lines of fake API is the plan, not a defect.
- **"Client" in the POS interface.** The prototype's word for a visitor. The
  UI rules forbid renaming visible labels.
- **The demo reset deletes across every operator.** It is a platform-wide
  control behind `OPS_TEST_CONTROLS` and a platform-wide assignment
  (`routes/ops.ts:19-27`), on a deployment that declares itself a playground.
- **Bookings are created with `status: 'paid'` without a payment.**
  `routes/public.ts:250` — ported prototype behaviour; payments are M2.
- **The console SMS adapter still exists.** It is now refused on any
  deployment; it remains how a developer receives a code locally.
- **`tsx` at runtime and `--prod=false` on the install.** Deliberate, and
  explained in `render.yaml`.

### Closed while this ran

Both were open when the audit started and are fixed in the working tree
(uncommitted) as it ends:

- **The SMS adapter fell back to the console when Twilio credentials were
  missing**, writing verification codes into a hosted log stream and
  delivering none. `buildSmsSender` now throws at boot
  (`services/sms.ts:185-211`), and `assertProductionSafe` refuses
  `SMS_ADAPTER=console` on any non-local deployment (`env.ts:153-158`).
- **The Twilio call had no timeout.** It now has a 10-second deadline, three
  attempts with back-off, a deliberate no-retry on its own timeout, and a
  typed 502 rather than a bare 500 (`services/sms.ts:57-183`).

---

## Coverage — what this audit did not examine

Nobody should read the list above as exhaustive.

**Read closely:** every file in `apps/api/src` (routes, services, plugins,
lib, `app.ts`, `index.ts`, `env.ts`); `packages/db/src/index.ts`, the seed and
`drizzle.config.ts`; `packages/shared/src/{ids,money,dates}.ts`;
`apps/pos/src/api/*` and `apps/pos/src/auth/OperatorContext.tsx`;
`render.yaml`, `.github/workflows/ci.yml`, `apps/pos/vite.config.ts`,
`.env.example`; and the relevant part of minio-js 8.0.7 where behaviour
mattered.

**Not examined:**

- **`.env`** — never opened, by instruction. Every statement about
  configuration comes from `.env.example`, `env.ts` and `render.yaml`. If the
  real values disagree with those defaults, findings B2 in particular may read
  differently.
- **The database schema and the migration SQL.** `packages/db/src/schema/*.ts`
  and `packages/db/migrations/*` were not read: indexes, foreign-key actions,
  check constraints and the `0005` schema move are unverified here.
  `pnpm --filter @oto/db verify-schema` is the instrument for that and was not
  run.
- **The test suite.** The 14 files under `apps/api/test/` were listed, not
  read, and nothing was run — this audit changed no source file, so there was
  nothing of mine to verify, and the instruction was to leave the full suite to
  the lead. So "is this behaviour covered by a test?" is unanswered for every
  finding above.
- **The POS beyond its API seam.** Roughly 250 components,
  `mockApi.ts` (5,836 lines) and `catalogStore.ts` (1,837 lines) were not
  read. The mock screens are deliberately mock, but a mock screen can still
  crash the bundle, and that was not checked.
- **`Book.tsx` and the public booking journey**, the i18n dictionary, the
  Playwright smoke spec, and `packages/shared`'s pricing and tax resolvers
  (`pricing.ts`, `pricing-mode.ts`, `catalog-shapes.ts`, `phone.ts`,
  `permissions.ts`) — the money-and-rules core, which deserves an audit of its
  own.
- **Anything live.** No Render service, no R2 bucket, no Twilio account, no
  browser. Every "verify on the first deploy" item is there because reading
  code cannot answer it.
- **`render.yaml`'s final revision.** It was being rewritten while this was
  written; the version audited raised the database to `basic_4gb`, the api to
  `standard`, and made Twilio a required input. Its scaling block and the
  arithmetic behind the connection budget were not reviewed.
