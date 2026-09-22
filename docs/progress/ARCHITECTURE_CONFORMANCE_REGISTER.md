# Architecture conformance register

_Produced 2026-09-22, against `main` at `91f5d8b` — the last code commit, deployed
to staging. (`fbd127b`, which landed on top while this was being written, is
documentation only.)_

**What this is.** The park owner asked a plain question after the two-branch
round: *is the platform actually following the architecture that was decided,
and where is it not, before those places cost a refactor?* This register is the
answer. It takes each decision that was written down — in `CLAUDE.md` §3 and §8,
`docs/architecture/ARCHITECTURE.md` and `docs/architecture/DEVELOPMENT_PLAN.md`
— and says what the code **does**, with the file, the line, and the request or
query that showed it.

Every decision gets one of three answers, never a fourth:

- **CONFORMS** — the code does it everywhere it applies, and there is something
  that makes it so.
- **DRIFTED** — somewhere the code does not. Named, with the proof.
- **NOT ENFORCED** — the code happens to do it today, but nothing would fail if
  it stopped. A decision that holds only because the fixture has one branch, one
  operator or one station is **NOT ENFORCED**, not CONFORMS.

**Ground truth is the code and the running system, never a document.** A
document that says "we always X" was treated as a claim to test. Where a claim
could only be settled live it was driven live: a second operator built by hand
against a real Postgres for the tenancy sweep, the deployed staging OpenAPI
(`/docs/json`, 181 operations / 152 paths — staging runs this code) for the
money-shape and seam questions, and the local database read directly for audit
content.

**Nothing was modified.** No source change, nothing staged, no commit. Probe
scripts ran from the scratchpad and were deleted.

---

## 1. The headline

| | Count |
|---|---|
| **CONFORMS** | 16 |
| **DRIFTED** | 20 |
| **NOT ENFORCED** | 7 (grouped into the seven checks in §3) |

Every DRIFTED item and every check below is on the board under epic **SCRUM-181**,
labelled `architecture`: **SCRUM-269 … SCRUM-288** are the twenty drifts, in the
order of §2; **SCRUM-289 … SCRUM-295** are the seven checks, in the order of §3.

**How far the code is from the design, honestly.** The floor is firmer than the
count suggests. The decisions that were made *and then given something to hold
them* have held completely: row-scoped tenancy across all 84 tables, the
fail-closed permission guard, reach computed from grants rather than the
session, integer satang with three database CHECK constraints under the sale
ledger, `timestamptz` on all 155 platform timestamp columns, the business date
that refuses a caller-supplied date because it has no parameter for one, and
`routes-guarded.test.ts` — which is why no unguarded route exists anywhere.
That is not luck; each of those has a constraint, a test, or a single chokepoint
behind it.

The drift is in three places, and each has a shape worth naming. **First, the
oldest code:** Sprint 1's auth, `me` and `files` routes were written before
`withTx` existed and were never migrated, so ten write paths still write a
change and its audit row separately. **Second, the newest money path:** the sale
ledger landed this week entirely on cloud routes, against a written rule that
says the till talks only to the box — the box surface the rule names,
`/box/v1/station/*`, **does not exist**, and the sync appliers for members,
children and visits have no producer. **Third, and this is the one that
generalises:** where a decision was never given a check, it drifted quietly. The
fixture seeds one operator, so four cross-operator holes reached staging. No
test asks whether a route declares a scope target, so 55 of 81 guarded routes
declare none and nothing distinguishes the safe 51 from the four that leak. No
test asks whether a mutating route is transactional, so 109 of 112 have never
been asked.

The pattern the owner should take from this: **every decision that has a check
conforms, and every decision that has no check has drifted somewhere.** That is
why §3 is ranked before §2 in the plan at the end.

---

## 2. DRIFTED — ranked by what it costs to fix later

Ranked by the *shape* of the later fix, as asked: a rewrite first, then a
migration, then a column, then a line. Security and unrecoverable-history items
sit low in this ordering because they are cheap to fix — they are pulled to the
front in §5 for a different reason, and marked here.

| # | Jira | What | Size of the fix **now** | Shape of the fix **later** |
|---|---|---|---|---|
| R1 | SCRUM-269 | The till sells through the cloud; the box has no money path | register two intents, model the sale as a fact | rewrite of `sale.ts` + a receipt-block protocol + migration |
| R2 | SCRUM-270 | Ids are minted by the server, against the written rule | accept a body id on ~13 more create routes | retrofit route + service + idempotency + sync ledger, after boxes exist |
| R3 | SCRUM-271 | The POS carries a second, baht-float money stack; reporting is floats end to end | port four surfaces through `cartWire` | reconcile two engines that already disagree, against written rows |
| R4 | SCRUM-272 | Four front ends hand-roll ~120 response types; the OpenAPI is consumed by nothing | a build step generating a client | the same build step against 3× the hand-rolled surface |
| M5 | SCRUM-273 | Archived members, children and branches still trade; unique indexes block reuse for ever | filter + partial-unique migration ×6 | the same migration against rows already collided into workarounds |
| M6 | SCRUM-274 | The OTO App's timestamps are naive and the platform writes into them | `ALTER … USING` per column, while someone remembers what the rows meant | the same migration with the `USING` clause as a guess |
| M7 | SCRUM-275 | The box has nowhere to keep a cache; the receipt high-water mark ships as `0` | one table, one timer, one field | reconciling live receipt numbering |
| M8 | SCRUM-276 | The OTO App holds pay in three incompatible representations | one representation, one migration | the same, over accumulated payroll history |
| C9 | SCRUM-277 | 27 routes have no caller — media, station lease, tax overrides, booth PINs, shift revocation | write the callers, or delete | route **and** consumer rewritten when the shape turns out wrong |
| C10 | SCRUM-278 | `apps/booth` has no deployment; `HttpBooth` has never made a call | a Render static site + a `/booth/*` rewrite | first run of that code path is in the park |
| C11 | SCRUM-279 | Two UUIDv7 generators | one shared conformance test | a silent index regression, found months later |
| L12 | SCRUM-280 | **Security.** Shift tokens listed and ended across branches and operators | a predicate and a dominance check | a live incident on the till |
| L13 | SCRUM-281 | **Security.** Alerts acknowledged, and runs read, across operators | a predicate and a load | a corrupt ops record |
| L14 | SCRUM-282 | **Unrecoverable.** Ending a shift and switching branch write no audit row | one `audit.record` each | history that cannot be backfilled |
| L15 | SCRUM-283 | An audit row is written on the pool from inside its own transaction | one character | phantom audit rows, indistinguishable for ever |
| L16 | SCRUM-284 | Auth, profile, file and shift writes are not transactional | a `withTx` wrapper each | a person locked out at a counter |
| L17 | SCRUM-285 | The offline toggle proves the opposite of what it was built to prove | 503 on the station credential + the matrix | "works offline" asserted, never tested |
| L18 | SCRUM-286 | `apps/pos` is outside eslint, so the never-log-a-phone rule misses the app that holds them | delete one ignore line, fix what it finds | a PII leak in the app with the medical notes |
| L19 | SCRUM-287 | An unnormalised visitor phone is stored on the session, unaudited | `normalizePhone` + an audit row | a stored phone nobody can match |
| L20 | SCRUM-288 | Deactivating an account does not reach the OTO App | set `is_active`, unlink | a dismissed person with a working password |

### R1 · SCRUM-269 — The till sells through the cloud; the box has no money path

**The decision.** `docs/architecture/DEVELOPMENT_PLAN.md:328`: *"Offline rule.
The till talks only to the box surface (`/ws/station`, `/box/v1/station/*`) for
identify, cart, tender, print and redeem; cloud routes are admin or read-only
for the till."*

**What the code does.** `/box/v1/station/*` does not exist — not in
`apps/api/src/routes/box.ts`, not on staging. The `/box/v1` surface is exactly
ten paths (`box.ts:114–303`): `register`, `heartbeat`, `config`, `cache`,
`commands/poll`, `commands/:id/result`, `print-jobs/:id/result`, `sync/push`,
`sync/pull`, `sync/key`. Every one is box→cloud housekeeping. Nothing a till can
call.

The whole selling path is cloud: take the station (`routes/fleet.ts:346`), hold
the lease, find the member (`GET /members/lookup`), attach the display, price
the cart (`routes/sales.ts:256`), record the sale (`:273`), take the money
(`:324`), and number the receipt — `services/sale.ts:1022–1091` reads and
updates `pos.receipt_series` **inside the cloud transaction**.

The mechanism to do it the decided way exists and is unused.
`packages/box-agent/src/station-session.ts:186` is `register(type, spec)`, with
the comment *"The money path owns `cart.*` and `payment.*`"*. **Nothing outside
tests calls it.** `BUILT_IN_INTENTS` (`:903`) holds eight intents, none of them
cart or payment. And five sync appliers — `member.created`, `member.updated`,
`child.created`, `child.updated`, `visit.created` (`services/sync.ts:763`) —
**have no producer**: every one of those writes goes through a cloud route
instead. `services/sale.ts` never raises a print job; grep for `print` across
its 1,787 lines returns two comments.

**The counter-example, in the same repository.** The booth mints its own code,
prints on the box's own printer, queues three facts through the outbox, reads
its own cached bundle and verifies staff PINs against the cached staff list. It
is the one module built the way the plan says, which is the proof the pattern is
buildable — the money path had the same option and did not take it.

**Cost.** The receipt counter is the expensive half: moving it to the box means
a per-box allocation block, a hand-out protocol, a migration and a
reconciliation for blocks a dead box never spends. `finaliseSale` writes the
tender, the number and the finalisation in one transaction it will not have
offline. Doing it now is registering intents against a station session that
already works. Doing it after Sprint 2 ships is the rewrite the owner is asking
about, and `sale.ts` grows every week.

### R2 · SCRUM-270 — Ids are minted by the server, against the written rule

**The decision.** `docs/architecture/ARCHITECTURE.md:202`, stated flatly: *"Ids
are minted by the client, not by the database … a till knows the id of the thing
it is about to create before it has a connection."* §55 gives the reason: it
keeps ids client-generatable for the offline queue.

**What the code does.** `newId()` is called **server-side** in
`routes/accounts.ts:202,221,313`, `routes/branches.ts:75`,
`routes/catalog.ts:122,323,465,664`, `routes/files.ts:128`, `routes/operators.ts`
and `services/fleet.ts`. Exactly two routes accept an id from the caller, and
both make it optional: `POST /members` (`routes/members.ts:299`) and `POST
/sales` (`routes/sales.ts:167`).

Half-measures compound it: `POST /sales` takes the sale head's id, but every
line id is server-minted (`services/sale.ts:1335,1376,1412,1588`), so a box can
name the sale it rang up and cannot name its lines — its local copy and the
platform's disagree line-for-line after sync.

**Cost.** This is the premise the entire offline queue rests on. Every create an
offline box needs becomes a retrofit of the route, the service, the idempotency
path and the sync ledger — after the boxes exist and there is traffic to
migrate. The cost grows with every route added.

### R3 · SCRUM-271 — The POS carries a second money stack; reporting is floats end to end

**The decision.** `CLAUDE.md` §3: money is integers in satang, never floats.

**What the code does.** `apps/pos/src/lib/tax.ts:258` is
`roundTHB = (n) => Math.round(n * 100) / 100`, and `lib/sale.ts`, `lib/fnb.ts`,
`lib/merch.ts` are the same era. **34 files import it; 7 use the satang engine.**
`apps/pos/src/lib/cartWire.ts` is an honest, well-built translation layer — and
it covers the *ticket* path only. Still on baht floats:
`components/till/CustomerDisplay.tsx`, `pages/Book.tsx`, all of F&B, all of
Merch, Events.

Separately, `apps/pos/src/lib/reporting.ts` accumulates `grossRevenue`,
`taxCollected` and `serviceCharge` as floats, and five panels emit `.toFixed(2)`
into CSV (`SalesReportPanel`, `TaxVatReportPanel`, `ProfitabilityReportPanel`,
`DiscountCompReportPanel`, `WalletPromoReportPanel`). It reads `@/mockApi`
today, so no real money is wrong yet — but the VAT report is an external-facing
document, and float accumulation over a month of rows is exactly where a receipt
stops reconciling.

**Cost.** Four more surfaces to port, each the port S2-09a already did once for
tickets, plus a reconciliation of two engines that `cart-totals.ts` already
records as giving *different answers* in two measured cases. Wiring reporting is
not a data-source swap: every accumulator changes unit.

### R4 · SCRUM-272 — Four front ends hand-roll their response types; the OpenAPI is consumed by nothing

**What the code does.** The API generates an OpenAPI document — served at
`/docs/json`, 168 KB on staging, 181 operations — and **nothing reads it**.
`apps/pos/src/api/platform.ts` declares 18 local interfaces and imports nothing
from the API. `apps/console/src/components/booth/boothApi.ts:9–11` says outright
that the types "are restated rather than" imported. Across the four front ends
there are roughly 120 hand-rolled response interfaces.

A response-shape change therefore typechecks green on **both** sides of every
seam and fails only at runtime, in front of a person at the till. All five seam
failures of this sprint were this shape.

**Cost.** Low now — the repo already contains the walker pattern to copy
(`packages/print/test/single-renderer.test.ts` walks every `.ts`/`.tsx` under
`apps/` and `packages/`, with explicit `turbo.json` inputs so the cache cannot
stale it), and `app.routeRegistry` is already enumerable. Generating a typed
client is a build step while there are 120 interfaces. At three times that it is
a migration.

### M5 · SCRUM-273 — Archived records still trade, and unique indexes block reuse for ever

**The decision.** `CLAUDE.md` §3: soft deletion, `archived_at`, no hard deletes
of business records — and the corollary the code states itself at
`routes/members.ts:228–265`: *"an archived member must not still be findable at
a counter that is offline."* `DELETE /members/:id` duly sets `archivedAt` and
pushes an `op: 'delete'` change so boxes drop it.

**What the code does.** The central API then does not honour its own rule. Only
`GET /members/lookup` filters (`routes/members.ts:170`). Still returning or
accepting an archived member:

| Where | File:line | What still works |
|---|---|---|
| Member detail + children | `routes/members.ts:105` | full record, phone, children's allergies and medical notes |
| Create a visit | `routes/visits.ts:77` | archived member checked in |
| Attach to a sale | `services/sale.ts:324` | archived member billed |
| Add a child | `routes/members.ts:595` | new child on an archived guardian |
| Edit a child | `routes/members.ts:660` | — |

An archived **child** is not filtered at check-in either: `routes/visits.ts:88`
validates only that the child belongs to the member. Ten branch resolutions test
operator ownership but not `archivedAt`, including `services/sale.ts:269` — **a
sale can be rung up at an archived branch** — and `routes/catalog.ts:48`, whose
catalogue can still be configured. (The branch half of this is already
**SCRUM-253**; the member, child and index halves are not.)

**The index half is the expensive one.** The newer tables got partial uniques:
`station_name_unique … where archived_at is null` (`schema/fleet.ts:404`),
`station_code_prefix_unique` (`:407`), `booth_layout_name_unique`
(`schema/booth.ts:115`). The Sprint 1 tables did not:

- **`member_phone_unique` on `(operator_id, phone)` — `schema/members.ts:80`,
  unconditional.** Archive a member and **that phone number can never be
  registered again in that operator.** Reception archives a mistyped duplicate
  and the real person can no longer be created. This sits on the park's primary
  customer key.
- `tier_code_unique` (`members.ts:41`), `ticket_package_name_unique`
  (`catalog.ts:63`), `booking_reference_unique` (`future.ts:50`),
  `voucher_definition_code_unique` (`promo.ts:149`), `voucher_code_unique`
  (`promo.ts:263`) — the same shape.

**Cost.** A migration per index — mechanically cheap, but each must run against
rows that may already have collided into a workaround (a member created as
`+66…x`, a package named "Day Pass (2)"), and those workarounds are unpickable
later.

### M6 · SCRUM-274 — The OTO App's timestamps are naive, and the platform writes into them

**The decision.** `CLAUDE.md` §3: all timestamps `timestamptz`, stored UTC.

**What the code does.** The platform's own 155 timestamp columns are all
`withTimezone: true` — see CONFORMS. The OTO App, **in the same database**, has
210 timestamp columns of which only 44 carry a timezone, and it is *mixed, not
uniformly wrong*: tables from roughly line 3500 on (payroll, newer features)
got `timestamptz`; everything before did not. Mixed is worse than uniform,
because a comparison between two of its tables now depends on which era each was
written in.

The platform writes into naive columns: `services/oto-app-users.ts:105` and
`:137` both `.set({ …, updatedAt: new Date() })` against `otoapp.users.updated_at`,
declared `timestamp('updated_at')` at `packages/db/src/schema/otoapp.ts:78`.
Even the seam columns the platform is supposed to own are naive —
`core_account_provisioned_at`, `provisioning_last_attempt_at` (`otoapp.ts:331,336`),
`core_synced_at` (`:441`).

**Cost.** A migration per column, `ALTER … TYPE timestamptz USING … AT TIME ZONE
'Asia/Bangkok'` — and the `USING` clause is **a guess about what the existing
rows meant**, only answerable while someone remembers. The guess gets harder
every month, and the mixed schema means it has to be made per table rather than
once.

### M7 · SCRUM-275 — The box has nowhere to keep a cache; the receipt high-water mark ships as `0`

The cache bundle itself is good: `services/sync.ts:3081` builds `catalogue` as
one atomic item — packages, categories, products, tiers, holidays, tax config,
overrides — which is genuinely enough to price a cart offline, against a pure
shared engine a box could run. Three defects sit around it:

1. **Six of nine scopes are never read.** In non-test code `store.readBundle` is
   called three times: `services/staff-token.ts:417,419` (`staff`, `deny_list`),
   `packages/box-agent/src/booth.ts:484` (`booth`), `agent.ts:675` (`staff`).
   `catalogue`, `members`, `bookings`, `bands`, `station_config` and
   `receipt_series` are pulled, written to the box store, and read by nothing.
2. **`receipt_series` is stubbed.** `sync.ts:3422` ships `highWaterMark: 0` for
   every station, with the comment *"S2-11 fills this from the sale ledger."*
   The ledger landed this week; this was not filled. Two boxes restored from
   backup both start at 0 and mint the same receipt numbers;
   `sale_receipt_unique` catches it at the cloud and **refuses the sale**
   (`sale.ts:1321`) — which, offline, means the money was taken and the fact is
   quarantined.
3. **The cache does not survive a restart, and nothing refreshes it.**
   `packages/box-agent/src/store-sql.ts:238–247` says it plainly: *"The `edge`
   schema has no table for a box's cached bundles … the virtual box holds them
   here and loses them when the api restarts."* `box_cache` appears nowhere in
   `packages/db`, so **every Render deploy wipes the staff list and the
   deny-list.** And `syncCache()` has exactly one caller — `agent.ts:1470`, at
   boot. No timer, no config-change trigger; `BOX_COMMAND_KINDS`
   (`protocol.ts:399`) offers `clear_cache` but no *refresh*. **A revocation
   never reaches a running box**, contradicting both the plan and
   `staff-token.ts`'s own comment.

**Cost.** `edge.box_cache` is one table and one migration, cheap now; the
refresh timer is a few lines. The high-water mark is what compounds: once real
receipts exist under cloud-allocated numbers, back-filling a per-box block
scheme means reconciling live numbering.

### M8 · SCRUM-276 — The OTO App holds pay in three incompatible representations

`integer` whole baht (`daily_rate`, `old_salary`, `new_salary` —
`apps/oto-app/shared/schema.ts:695,862,933`), `numeric(12,2)` (payroll:
`gross_pay`, `net_pay`, `amount` — `:3825–3828`), and JS floats in between:
`payroll-calculation.ts:267–280` does `parseFloat(advance.remainingBalance)`,
`parseFloat(advance.principalAmount) / months`, then `.toFixed(2)` back. A
salary advance divided by months in floats with a running balance carried
forward is the textbook accumulating error — on wages.

### C9 · SCRUM-277 — 27 routes have no caller

Verified twice, comments stripped, all six callers searched. The expensive ones:

| Route(s) | File | Note |
|---|---|---|
| `POST /files`, `GET /files/:id/url` | `routes/files.ts:109,157` | **The whole SCRUM-16 media subsystem** — MinIO, `file_object`, presigned PUT/GET, permission-bound access. No front end calls either. `apps/pos/src/api/platform.ts:20` reads `photoFileId` and nothing resolves it to a URL. |
| `POST /stations/:id/lease`, `/lease/renew`, `/lease/release`, `GET /stations/:id/session`, `/channel`, `POST /intents`, `/button` | `routes/stations.ts:257–445`, `scanning.ts:309` | The two-device station session. Not duplicated — `services/station-session.ts:5` imports the one implementation from `@oto/box-agent`. The caller is S2-08, unbuilt. |
| `GET/POST /branches/:id/tax-overrides`, `GET /branches/:id/tax-resolve`, `GET /product-categories` | `routes/catalog.ts:633,644,690,717` | SCRUM-37's override tier. The POS reads `/tax-config` only. |
| `PUT /booths/:id/prize-order`, `GET/PUT/DELETE /booths/:id/staff[/:acct][/pin]`, `POST /booth-layouts`, `PATCH /booth-layouts/:id`, `POST/PATCH /voucher-definitions` | `routes/booth.ts:515–907` | **Booth staff PIN management has no screen at all.** |
| `GET /accounts/:id/staff-tokens`, `DELETE /staff-tokens/:jti`, `GET /staff-tokens/settings` | `routes/staff-token.ts:168,195,218` | Shift tokens can be **minted** and **used** from the UI but not listed or revoked. A token issued to a lost iPad cannot be ended from any screen. |
| `POST /box/v1/sync/key`, `GET /box/v1/sync/pull` | `routes/box.ts:236,276` | `services/sync.ts:1422` prints an error instructing a box to `POST /box/v1/sync/key` — an instruction to a caller that does not exist. |
| `POST /booth/reprint`, `POST /boxes/:id/simulate`, `POST /print-jobs/:id/reprint`, `GET /devices/:id/printouts/:seq/preview.png` | `routes/booth.ts:240`, `routes/print.ts:428,393,513` | |

**Cost.** The media subsystem and the tax-override tier are the expensive ones:
both were specified in Sprint 1, both have tables and migrations behind them, and
neither has ever been exercised by a browser. When a caller is finally written
the response shape will be wrong in ways no test can currently see — a rewrite
of the route *and* its consumer, not a column. The shift-token gap is a security
cost rather than a build cost.

### C10 · SCRUM-278 — `apps/booth` has no deployment, and `HttpBooth` has never made a call

`render.yaml` has no booth service (already tracked in `SPRINT_2_PROGRESS.md:13–14`).
The consequence is not in that ticket: `apps/booth/src/booth/client.ts:36`
defaults to `/booth` **same-origin**, and no static site rewrites `/booth/*` —
only `/api/*`. `chooseTransport()` picks `FakeBooth` in dev and `HttpBooth` in a
build, so **the first time that code path runs at all will be the first time it
runs in the park.**

### C11 · SCRUM-279 — Two UUIDv7 generators

`packages/shared/src/ids.ts newId()` (the `uuidv7` package) and a second,
hand-rolled implementation at `packages/box-agent/src/signing.ts:121`. The reason
is given — `box-agent` cannot import `@oto/shared` yet, per its `contract.ts` —
and the need for time-ordering is real, but it is a second implementation of a
format the ledger's index behaviour rests on, with no shared conformance test. A
bit-layout difference shows up as an index that stops being append-mostly,
months later, with no error.

### L12 · SCRUM-280 — Shift tokens can be listed and ended across branches and across operators

**Security.** Proven live against a real database with a hand-built second
operator.

- `DELETE /staff-tokens/:jti` → `services/staff-token.ts:261` builds the whole
  predicate as `eq(staffToken.jti, scope.jti)`. No operator, no branch. The route
  (`routes/staff-token.ts:194`) declares `admin:account:update` with **no
  target** and passes no operator. `core.staff_token` carries *both*
  `operator_id` and `branch_id`; neither is used.
  *Proof:* the Floresta manager revoked a live Chalong shift token — `200
  {"revoked":1}`, and the row came back revoked.
- `GET /accounts/:id/staff-tokens` (`routes/staff-token.ts:168`) filters by
  operator and account only — no branch reach, and no dominance check, though
  every *other* account route goes through `loadTargetAccount` and the dominance
  rule in `services/access-control.ts`.
  *Proof:* `200` with the Chalong token's `jti`, `accountId`, `stationId`, `boxId`.

**These two compose into the same shape as SCRUM-264, one level up.** Step one
hands over the jti; step two ends it. No id guessing, no unusual state:
`branch_manager` holds both `admin:account:read` and `admin:account:update`
(`packages/shared/src/permissions.ts:247`). A manager at one park can end a shift
credential on a till at the other park — the till's money surface. It would
surface as "the till logged itself out mid-shift", with no explanation.

### L13 · SCRUM-281 — Alerts are acknowledged, and runs read, across operators

**Security.**

- `POST /ops/alerts/:alertId/acknowledge` → `services/ops.ts:2789`
  `acknowledgeAlert` UPDATEs on `alert.id` alone. The route (`routes/ops.ts:130`)
  declares `admin:ops:manage`, no target, and loads nothing first.
  *Proof:* an administrator of operator A acknowledged operator B's alert —
  `200 {"ok":true}`, row acknowledged.
  The sharpest part: **the same file states the rule this route breaks.**
  `routes/ops.ts:366` — *"Both actions load the box FIRST and act on that row's
  branch, never on the caller's session branch — the rule S2-04 established for
  every by-id route."* The quarantine pair obeys it; the alert route, 230 lines
  above, does not.
- `POST /ops/runs/:runId/retry` → `services/ops.ts:2635` `findRun` selects by id
  with no operator predicate, though `core.ops_run` carries `operator_id` and
  `branch_id`. Lower blast radius — the row is not returned, and jobs are
  platform-wide sweeps — but the audit row is then filed under the *caller's*
  operator for another operator's run, which corrupts the one record meant to
  settle who did what.

### L14 · SCRUM-282 — Ending a shift and switching branch write no audit row

**Unrecoverable.** Audit history cannot be backfilled; every day these stay open
is a day of missing trail on the two actions the last security round was about.

- `routes/staff-token.ts:195` → `revokeStaffTokens` (`services/staff-token.ts:261`)
  updates `staff_token` and records nothing. Minting *is* audited
  (`staff_token.mint`); an administrator ending somebody's shift is not. The
  `revoked_by_account_id` column holds who, but there is no row in the trail the
  Console reads.
- `routes/me.ts:123`, the active-branch switch. SCRUM-264 made this a security
  boundary and the comment at `:109–122` says so at length — and moving a session
  between parks writes no audit row. The grant check is correct; the record that
  it was exercised does not exist.

### L15 · SCRUM-283 — An audit row is written on the pool from inside its own transaction

`routes/members.ts:621` calls `audit.record(app.db, …)` from **inside** the
`child.create` `withTx` callback. If the transaction rolls back the audit row
survives, describing a child that does not exist — and `withTx` will *also* write
`child.create.failed`. This is the exact Sprint-1 pattern the header comment at
`services/tx.ts:10–15` says was eliminated. The fix is one character:
`app.db` → `tx`. The cost of leaving it is that the audit log accumulates phantom
rows no later cleanup can distinguish from real ones.

### L16 · SCRUM-284 — Auth, profile, file and shift writes are not transactional

Ten write paths, all in the oldest code, run as unrelated statements:

| Path | File:line | The window |
|---|---|---|
| Password setup / reset / change | `routes/auth.ts:298,350,378` | a crash between `consumeCode` and `setPassword` burns a single-use code and leaves the old password — an invited staff member locked out with a spent code |
| Mint a shift credential | `routes/staff-token.ts:64` → `services/staff-token.ts:160–242` | publish key → **revoke the session's existing token** → insert → audit; a failure between revoke and insert leaves the till with no live shift token, which is exactly the credential that unlocks it with the mall link down. The same function called from `PUT /me/session/station` *is* inside a transaction (`services/fleet.ts` `pickStation`), so the invariant holds on one path and not the other |
| `PATCH /me` | `routes/me.ts:57–101` | employee row + audit on the pool |
| `POST /files` | `routes/files.ts:134–152` | `file_object` + audit on the pool |
| `POST /auth/handoff/exchange` | `routes/auth.ts:217–233` | spends the jti, sets the cookie, then audits on the pool |
| sign-in / sign-out / lock / unlock | `services/auth.ts:332,511,541,588,650` | session row and audit row written separately |
| `offlineUnlock` | `services/staff-token.ts:583–603` | clears `locked_at`, then audits |

### L17 · SCRUM-285 — The offline toggle proves the opposite of what it was built to prove

`DEVELOPMENT_PLAN.md:331` says the toggle *"returns 503 from cloud routes for
that station credential, so an 'offline' demo cannot be faked."* `setOffline`
cuts the **box's** outbound client only; grep for `offline` in
`apps/api/src/plugins/` returns one unrelated line. The till's cloud routes are
untouched, so with the box "offline" a sale still completes.

Two related absences. `DEVELOPMENT_PLAN.md:333` and `:638` require an **offline
capability matrix** in `ARCHITECTURE.md`, one row per operation — it does not
exist; "offline" appears three times in that file, all about UUIDv7. *This is why
the drift in R1 went unnoticed:* the artefact that would have listed "sale —
refused offline" was never written, so nothing failed when the sale was built
cloud-only. And **there is no Pi.** `createBoxAgent` has one non-test caller,
`services/box.ts:1465` — the virtual box inside the api process. No bin, no entry
script, no systemd unit, no Dockerfile, no `infra/` target. `@oto/box-agent/sqlite`
— the store a real Pi would use — is imported only by tests. Nothing has ever
opened it outside a test run.

What a Pi would actually do today, with the link down: **sale** — nothing;
**member lookup** — nothing, though the members sit unread in the box's cache;
**print** — nothing for the till; **unlock** — nothing, because
`POST /auth/unlock-offline` is a *cloud* route (`routes/staff-token.ts:122`) even
though the verifier is correctly on the box; **booth spin** — works, fully, the
one flow that does what the plan describes.

*(Adjacent, noted not ranked: `packages/box-agent/src/credentials.ts` still
stores the box secret and sync private key as plaintext JSON at mode `0600` —
mitigated by Ed25519 meaning a stolen disk can only *check* staff tokens, never
mint them, but it is the owner's named theft risk. And `badgeHash`/`staffCode`
are never written into the `staff` scope — `sync.ts:3258` emits `pinHash` only —
so booth badge sign-in yields nobody.)*

### L18 · SCRUM-286 — `apps/pos` is outside eslint

`eslint.config.mjs:13` ignores `apps/pos/**` entirely — *"The ported prototype UI
keeps its original style; linted separately later."* The effect is that
`oto/no-pii-in-logs` does not apply to **the one app that handles phone numbers,
children's names and allergy notes**, and it makes 24 `console.*` calls. The OTO
App's exclusion two lines below is reasoned and compensated (a vendored redactor
every log line goes through); this one is not compensated at all.

Alongside it, `apps/pos` has no unit runner, and because `tsconfig.json` sets
`include: ["src/**/*", "vite.config.ts"]` its Playwright specs (`e2e/smoke`,
`sale-ledger`, `pwa-offline`) are **neither run nor typechecked** — they can rot
silently.

### L19 · SCRUM-287 — An unnormalised visitor phone is stored on the session

`routes/me.ts:157` — `.set({ pendingLookupPhone: req.body.phone, pendingLookupAt: new Date() })`.
That is the customer-display → till channel, storing a raw phone in
`core.session.pending_lookup_phone`. It works only because the consumer
round-trips through `GET /members/lookup`, which normalises. The row holds a
visitor's phone number, which `ARCHITECTURE.md` §15 treats as a secret for log
redaction. There is no audit row, and the 30-second TTL is applied on *read*
(`:178`) — nothing expires it on write.

### L20 · SCRUM-288 — Deactivating an account does not reach the OTO App

`PATCH /accounts/:id` with `status: 'inactive'` revokes platform sessions
(`routes/accounts.ts:425`) but never touches `otoapp.users.is_active` and never
unlinks. This is safe today **only** because `OTOAPP_LEGACY_LOGIN` defaults false
(`apps/oto-app/server/middleware/platformSignOn.ts:106`) and the 10-second
liveness check against `/me` then fails. One environment variable on a Render
service and a deactivated person keeps a working OTO App password no platform
action can reach. Nothing in CI or in the boot guard asserts that flag stays off.

*(Related and already tracked: `otoapp.branches.core_branch_id` is **read** at
`services/oto-app-users.ts:251` and **written by nothing**, so every provisioning
falls through to the name match at `:258`. That is **SCRUM-268**, in Testing —
not re-raised here.)*

---

## 3. NOT ENFORCED — and the check that would hold each

Seven checks. Each is named the way `routes-guarded.test.ts` is named: something
a person has to deliberately edit to make a violation pass.

### Check 1 · SCRUM-289 — A two-operator, two-branch default fixture

**What is not enforced.** `apps/api/test/helpers.ts` → `packages/db/src/seed/index.ts:116`.
Measured, not assumed: `OPERATORS: 1 ['OTO'] · BRANCHES: 2 ['hkt-central','robinson-chalong']`.
Two branches was just fixed; **one operator is the identical trap one level up.**
Nine test files build a second operator by hand for one assertion each; the other
35 encode "nil reach, one operator" as the premise — which is exactly why L12 and
L13 reached staging.

Also held by this check: **`GET /sales` skips the branch check when the session
has no active branch.** `routes/sales.ts:362` —
`const branchId = req.query.branchId ?? auth.branchId ?? undefined; if (branchId) await req.requirePermission(...)`.
`auth.branchId` is `string | null` (`plugins/session.ts:33`). With both absent no
branch check runs and `listSales` filters by operator alone
(`services/sale.ts:1695`) — every branch's sales. It does not leak today only
because sign-in always seats a branch. That is a fixture, not a check. The code
fix is one `else` computing `branchReach('pos:sale:read')`.

**The check.** Seed a second operator by default — its own branch, station, box,
member, sale, alert, ops run, quarantine row — and a second branch manager, so
every route test runs with a foreign row present. Add an unseated-session case.
Existing assertions that rely on nil reach are re-stated explicitly, behind a
named flag if they must stay.

**Cost of not having it:** every sweep like this one has to be done by hand
instead of by CI. That cost is already being paid.

### Check 2 · SCRUM-290 — Every by-id route declares its scope target, or loads then checks

**What is not enforced.** `apps/api/test/routes-guarded.test.ts` enumerates every
route and fails if one is unguarded — which is why no unguarded route exists. It
never asks whether a route touching a branch-owned row declares `target:` or does
load-then-check. **55 of 81 guarded routes declare no target**, and nothing
distinguishes the 51 that are fine from L12 and L13.

**The check.** Extend the same registry walk: a `POST|PUT|PATCH|DELETE` or by-id
`GET` whose params name an entity must either declare `target:`, or appear in a
commented allowlist of routes that load the row first — the same "somebody has to
edit this deliberately" device the existing test uses for the open surface.

**This is the check that would have caught all four tenancy leaks.** One test.

### Check 3 · SCRUM-291 — A mutating-route conformance test

**What is not enforced.** `test/transactions.test.ts` hand-drives **three** routes
(accounts, visits, public bookings) out of **112 mutating route registrations**.
Every drift in L14–L16 sits in the 109 nobody wrote a test for. Three further
idempotency facts sit under the same gap:

- **The Idempotency-Key is minted per HTTP attempt, not per gesture.**
  `apps/console/src/api/client.ts:89` — `export const idemKey = () => crypto.randomUUID()`
  — is called *inside* each helper at request time (`api/fleet.ts:375,392,425,461,488,524,530`;
  `apps/pos/src/api/platform.ts:141,145,149,160,177`). A second press of Save mints
  a *different* key. The comment at `client.ts:82–88` claims "a double press, a
  flaky connection or a retry lands one station, one device, one command" — a
  claim the code does not support. The only thing preventing a duplicate is
  `setBusy(true)` in the drawer components
  (`components/devices/StationDrawer.tsx:126`) — a UI disable, not a server
  guarantee, and useless in the case idempotency exists for: the request times
  out and the person presses again. Sales are the exception that proves the rule
  (`apps/pos/src/api/sales.ts:321` derives the key from the sale id). The POS
  wrapper's `put`, `patch` and `delete` accept no key at all
  (`apps/pos/src/api/client.ts:156–158`).
- **The store keeps a 4xx as firmly as a 200.** `plugins/idempotency.ts:191–233`:
  `onSend` releases only on `>= 500`. A corrected request then hashes differently
  and gets 409 for `IDEMPOTENCY_TTL_HOURS` (default 24, `env.ts:53`). This already
  bit twice and was worked around in the till rather than fixed at the source —
  `apps/pos/src/api/sales.ts:336–343` documents it. **Fix the keys without fixing
  this and every console form inherits the sale ledger's bug on the same day.**
- **`POST /public/bookings` cannot be made idempotent at all.**
  `routes/public.ts:142`: the plugin returns early for a caller with no session
  (`plugins/idempotency.ts:118`), the id is server-minted (`:238`), the reference
  is random (`:239`), and there is no unique business key. The fix is to accept an
  optional body id and replay on it, exactly as `routes/visits.ts:48–61` already
  does.

**The check, in two parts, both using machinery that already exists.**

1. *Static.* Read `apps/api/src/routes/*.ts` and `services/*.ts` and assert that
   no `audit.record(` call lexically inside a `withTx(` callback receives `app.db`
   or `db` as its first argument. This catches L15 exactly, and the next one on
   the day it is written. **An afternoon, and the highest-cost class — land this
   first.**
2. *Registry-driven.* Walk `app.routeRegistry` for `POST|PUT|PATCH|DELETE`. Each
   route must either appear in an explicit, commented `WRITES_NOTHING` allowlist
   (quote, preview, button, the booth relays) or, driven with a seeded happy-path
   body, satisfy: exactly one committed `audit_log` row; under the existing
   `oto_test_fail` trigger, **zero** business rows and exactly one `<op>.failed`
   row (i.e. the write was inside the transaction); and, sent twice with the same
   `Idempotency-Key` and body, one row and `x-oto-replay: true` on the second —
   unless the route declares `secretResponse` or `credential`. The body fixture
   per route is the real work.

### Check 4 · SCRUM-292 — A schema-shape test

**What is not enforced.** Three decisions hold today by discipline alone:

- **Tenancy columns.** The whole `edge.*` box family carries no tenancy column at
  all — `box_command`, `box_heartbeat`, `box_print_job`, `box_counter`,
  `box_staff_session`, `box_throttle`, `box_runtime`, `sync_cursor`,
  `sync_quarantine`, `sync_anomaly`, `station_event`, `box_outbox`, `box_state` —
  plus `booth.booth_staff_assignment`, `core.station_staff`, `station_device`,
  `box_sync_key`, `crm.child`, `crm.visit_child`, `pos.attendee`, `wallet_entry`,
  `stock_level`, `payment_attempt`; and two carry `branch_id` with no
  `operator_id` (`crm.member_tier_verification`, `otoapp.user_branch_access`).
  They are safe *today* because every query joins a scoped parent — `crm.child` is
  the honest example, `routes/members.ts:637` loads the guardian inside the
  caller's operator first and says why — but nothing makes that join mandatory,
  and the next handler written against these tables inherits no protection.
  **This is the one that becomes a refactor:** adding `operator_id` to `edge.*`
  later is a column plus a backfill on the highest-volume tables in the system,
  and they are what the Pi boxes write to, so the backfill lands on rows arriving
  from the field. *(Correct exception, stated so it is not re-raised:
  `core.idempotency_key` needs no `operator_id` — its PK is `(account_id, key)`,
  `schema/platform.ts:80`, and an account belongs to one operator.)*
- **`timestamptz`.** `pnpm --filter @oto/db verify-schema` compares the live
  catalogue against a committed snapshot, so it catches drift *from the snapshot*
  — not a wrong-typed column that is wrong in both. No rule anywhere says "a
  timestamp column is `timestamptz`."
- **Archivability and lookup keys.** Nothing requires a unique index on an
  archivable table to be partial (M5), nothing requires a phone column to hold
  E.164, and nothing validates that an id is a v7.

**The check.** A test over the Drizzle schema objects (no database needed):

1. every table in a tenant schema declares `operator_id`, or appears in a
   commented `SCOPED_BY_PARENT` allowlist naming the parent and the column that
   joins to it;
2. every timestamp column is `withTimezone: true`, no exceptions;
3. every unique index on a table that has `archived_at` is partial on
   `archived_at is null`, or is allowlisted with a reason;
4. every phone column carries a CHECK (`^\+[1-9]\d{6,14}$`). **Phone
   normalisation currently lives only at the route boundary** — all 18
   `normalizePhone` call sites are in `routes/*` plus `services/auth.ts:284` and
   `services/sync.ts:782`; no service normalises on the way in, and
   `member_phone_unique` is unique on *whatever was stored*. A job, a box path or
   the next route written is one omission away from a member nobody can find.

### Check 5 · SCRUM-293 — A seam test: front-end calls diffed against the route registry

**What is not enforced.** No front end has a test runner: `apps/pos`,
`apps/console`, `apps/launcher`, `apps/booth` and `packages/db` have no `test`
script; CI runs `tsc --noEmit` and a build for each. The OTO App's ~40 Playwright
specs are outside CI by design. The one seam a test actually pins is
`apps/api/test/sales.test.ts:1200` — *"is called by apps/pos, and the route it
calls exists here"* — hand-written for one route pair, and its own comment says
why: *"`apps/pos` has no test runner of its own, so this is the only place in the
repository where the two halves are checked to still be pointing at each other."*
Meanwhile `apps/console/src/components/booth/odds.ts` — the arithmetic that tells
a manager what the park is giving away — has zero coverage, while the copy the
box obeys (`packages/box-agent/src/booth-draw.ts:117`) is tested.

The same gap lets second copies live: **`normalizePhone` exists twice with
different semantics** (`packages/shared/src/phone.ts:34` returns E.164 with `+`
or `null`; `apps/pos/src/lib/phoneUtils.ts:26` returns bare digits and never
null) and `PhoneInput.tsx` — which composes the value the till sends — imports
the local one; **pricing and tax exist twice** (~1,100 POS lines against the
satang engine's 1,694-line suite); **wheel odds exist twice**. Each is contained
today by a deliberate boundary (`cartWire`, `cartQuote`) and nothing enforces the
containment.

**The check.** Generalise the walker the repo already has
(`packages/print/test/single-renderer.test.ts`, with explicit `turbo.json`
inputs): extract every API path literal from all four front ends, resolve each
against `app.routeRegistry`, and fail on a call with no route **or** a route with
no caller that is not in a commented `NOT_YET_CALLED` allowlist (which makes C9
an explicit, dated list rather than an accident). Add an import guard: nothing
under `apps/pos/src/components` or `pages` may import `lib/phoneUtils`,
`lib/pricing` or `lib/tax` directly — only the named boundary modules may. Then
generate a typed client from `/docs/json` so R4 cannot regrow.

### Check 6 · SCRUM-294 — A money-type lint

**What is not enforced.** The API boundary accepts non-integer money. Parsing the
**deployed** OpenAPI, eleven money-named fields are `type: number` with no
`integer`. The ones that matter: `POST /sales` and `POST /sales/quote` →
`manualDiscounts[].value` and `promos[].value` are `z.number()`, and `type`
includes `"fixed"` — a fixed discount is **satang**
(`packages/shared/src/discount.ts:76`) — and
`packages/shared/src/discount.ts:139` returns it unrounded:
`if (discount.type === 'fixed') return Math.min(Math.max(0, discount.value), base);`
The percent path rounds (`cart-totals.ts:725`); the fixed path does not.

Calibrated honestly: the consequence is a **refused sale**, not corrupt money,
because the `bigint` column and the CHECK constraints catch it. But that means
the database is the only thing enforcing the decision, and the missing check is
one character: `.int()`.

**The check.** A lint rule plus a schema assertion: every zod field whose name
matches the money vocabulary (`*Price`, `*Amount`, `*Total`, `value` on a
discount, `*Satang`) must be `z.number().int()`; and, in `apps/pos`, ban
`roundTHB` and float money arithmetic outside the named fallback modules, so the
remaining surfaces can only be ported, never extended.

### Check 7 · SCRUM-295 — An offline capability matrix that is executable

**What is not enforced.** L17: the matrix required by
`DEVELOPMENT_PLAN.md:333,638` does not exist, and the offline toggle does not
refuse the till.

**The check.** Write the matrix into `ARCHITECTURE.md` — one row per operation:
allowed / capped / refused, maximum cache age, staff-token expiry, deny-list
propagation. Then make the toggle return 503 from cloud routes for that station
credential, and add one test per row that drives the operation with the toggle
on and asserts the row. A row that claims "works offline" then cannot be written
without the box path existing.

---

## 4. CONFORMS — what is load-bearing

Stated briefly so a future reader knows what to be careful with.

| Decision | What makes it so |
|---|---|
| **Row-scoped, single schema** | No schema-per-tenant construct anywhere in 84 tables; `operator_id` on every tenant-owned table outside the `edge.*` family in Check 4 |
| **Load-then-check on by-id routes** | `loadX(db, auth.operatorId, id)` then `requirePermission(…, { branchId: row.branchId })` at ~23 sites in `services/fleet.ts`, 11 in `print.ts`, 16 in `booth.ts`, 15 in `catalog.ts`, plus `stations.ts` and `scanning.ts` |
| **The guard is fail-closed** | `services/permissions.ts:55` — a branch-scoped grant **denies** when the target branch is absent, rather than falling through |
| **Reach computed from grants, never the session** | `services/access-control.ts:335`, applied on `/branches`, `/accounts`, `/audit`, `/ops/*`; verified live — the Floresta manager's `/branches` returns Floresta only. `services/permissions.ts:46` names the rule: *"passing the guard is not that check"* |
| **Every route is guarded** | `test/routes-guarded.test.ts` walks `app.routeRegistry` and fails on the day an unguarded route is written. The model to copy for Checks 2, 3 and 5 |
| **Money in the sale ledger** | Every column `bigint … satang` (`schema/sales.ts:345–376`) with three database CHECK constraints: `gross = net + service + tax_inclusive + tax_exclusive` (`:446`), `discount = manual + promo` (`:450`), non-negativity on all eleven figures (`:454`) |
| **One rounding point** | `packages/shared/src/rounding.ts` — half-up at the satang, `apportion()` by largest remainder so shares sum exactly, with a stated and tested safe-magnitude bound. The only float column in the platform schema is `edge.ts:208 tempC`, a thermometer |
| **The business date** | `packages/shared/src/business-date.ts` computes from `branch.business_day_start` in the branch timezone, DST-analysed including the fall-back case where the date runs backwards; stamped as a `date` column on `sale`, `sale_line`, `sale_discount`, `spin` and the edge counters, never derived on read, indexed. `services/sale.ts:250–272` refuses a caller-supplied date **by having no parameter for one** — *"A caller that could pass its own date could choose weekend pricing on a Tuesday."* |
| **`timestamptz` on the platform** | All 155 timestamp columns across 16 schema files; held by one shared `timestamps` / `archivedAt` spread in `packages/db/src/schema/helpers.ts` |
| **Phone normalisation itself** | `packages/shared/src/phone.ts:39` maps a leading `00` to `+`, with the comment stating this diverges from the prototype deliberately (which left `0066…` as a key matching nobody and silently created a duplicate member), and naming its own known edge (Thai IDD `001`/`007`) |
| **Permissions are one list** | Every literal in every front end is assigned to a `Permission`-typed field imported from `@oto/shared/permissions` — a typo fails typecheck |
| **The durable outbox** | `packages/box-agent/src/outbox.ts` — signed, `(box_id, journal_epoch, box_seq)`-keyed, bounded, backed-off, epoch-aware, quarantining rather than dropping. The pattern works; R1 is that the money path does not use it |
| **The OTO App boundary** | `packages/db/src/schema/otoapp.ts` is a narrow re-declaration of only the columns the platform touches, deliberately **not** exported from `./index` so a Drizzle diff can never meet it; `otoapp` is outside `schemaFilter`; `services/oto-app-users.ts` is the single file permitted to write there and says so. Where mastering is undecided it **refuses to guess** — *"a foreign-key violation dressed up as a tenant"* (`:292–297`) |
| **Audit content** | Better than the decision required: a child's allergies and medical notes are stored verbatim in `before`/`after` (`routes/members.ts:692–702`) but masked on read by key name for any caller without `admin:audit:read_sensitive`, judged against the branches being read rather than the session's branch, and an unmasked read writes its own `audit.read_sensitive` row inside the same transaction (`routes/audit.ts:45–60,174–245`) — confirmed live. No credential reaches the log: `mintStaffToken` records the claims not the token, `reissueClaimCode` the expiry and slot not the code, `handoff_rejected` puts the claimed account id in `after` rather than the FK column |
| **Idempotency needs no `operator_id`** | `core.idempotency_key`'s PK is `(account_id, key)` (`schema/platform.ts:80`) and an account belongs to one operator, so cross-operator replay is structurally impossible. A deliberate exception, correctly taken |
| **The demo reset** | `services/demo-reset.ts` hard-deletes facts but is gated four ways — `OPS_TEST_CONTROLS`, `platformWide: true`, a typed confirmation phrase, one transaction, an audit row (`routes/ops.ts:826–855`). Deliberate and documented. It does delete `audit_log` rows (`demo-reset.ts:148`), worth a second look, but it is demo-only |

**Worth a decision, not clearly drift:** hard deletes of access-grant rows —
`roleAssignment` (`routes/accounts.ts:372`), `appIdentity`
(`routes/app-identities.ts:417`), `boothStaffAssignment`
(`services/booth-admin.ts:1580`). Each writes an audit row first, so *who* had
access *when* is still answerable from the audit log rather than the table. Given
§13 chose `revoked_at` over deleting sessions for exactly this reason, the
asymmetry looks unintended. (`branchHoliday`'s delete at `routes/catalog.ts:530`
is already guarded — the route refuses once sales were priced by that range.)

---

## 5. The order to do it in

**Enforcement first, so the fixes cannot regress — and because every decision in
§2 that drifted is a decision nothing was holding.** Each check below is written
so that a violation requires somebody to deliberately edit an allowlist.

**Stage 0 — the two security items jump the queue.** L12 and L13 are a predicate
each, hours of work, and they are live on staging: a manager at one park can end
a shift credential on the other park's till. Do them first regardless of the
ranking, because the ranking is by fix cost and these are cheap and reachable
today.

**Stage 1 — enforcement (in this order, cheapest first).**

1. **Check 3, part 1** — the static "no `audit.record(app.db)` inside `withTx`"
   scan. An afternoon; catches the highest-cost class.
2. **Check 2** — the route scope-target assertion. One test; it is the check that
   would have caught all four tenancy leaks.
3. **Check 1** — the two-operator default fixture. A seed change; it turns this
   whole sweep into something CI does.
4. **Check 4** — the schema-shape test, before `edge.*` grows further.
5. **Check 6** — the money-type lint, and `.int()` with it.
6. **Check 5** — the seam walker, then the generated client.
7. **Check 7** — the offline matrix and a toggle that means it.

**Stage 2 — the unrecoverable and one-character fixes**, because audit history
cannot be backfilled: **L14** (shift revocation, branch switch), then **L15** (one
character), then **L16** (a wrapper each, starting with the password paths and the
shift mint, since both leave a person unable to work), then L19 and L20.

**Stage 3 — the drifts by cost, largest later-cost first:** **R1** (the box money
path — every week it waits, `sale.ts` grows), **R2** (ids minted at the till —
the offline premise), **M7** (`edge.box_cache`, the refresh timer and the receipt
high-water mark: one migration, and it should land *before* any box mints a
number), **M5** and **M6** (the two migrations whose cost is the rows they must
run against), **R3**, **R4**, then **C9–C11**, **L17**, **L18**, **M8**.

**Stage 4 — decide, don't build:** the media subsystem (C9) is either Sprint 3
work or delete-and-rebuild; leaving it as a subsystem nobody has ever run is the
one outcome that costs twice.

---

## 6. What could not be settled

- **The provisioning path was not driven.** The OTO App branch mapping
  (`core_branch_id` written by nothing) was verified at the schema level only;
  the live path belongs to **SCRUM-268**, already in Testing.
- **The archived-record findings are read from the code.** Each would need one
  authenticated request to demonstrate, and archiving a record on staging to
  prove a point is a change better scheduled than discovered — another workflow
  is driving that deployment.
- **No authenticated staging session was used** for the primitives sweep; the
  live checks there were `/health`, `/ready` and the public OpenAPI document,
  which is what settled the money-shape question.
