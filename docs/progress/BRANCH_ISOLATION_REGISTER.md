# Branch isolation register

**What this is.** The park trades at two places — Oto Play Park, Central Floresta
and Oto Play Park, Robinson Chalong — and each has a manager. This register says,
for every route and screen that touches data owned by a branch, what a manager of
Floresta sees and can do, what a manager of Chalong sees and can do, and what the
operator administrator sees and can do. Every cell carries the request and the
response that proved it.

Each cell is marked one of:

- **SCOPED** — the answer stops at the branch the caller holds.
- **LEAKS** — the caller sees or does something at the branch they do not hold.
- **BY DESIGN operator-wide** — deliberately not per-branch, with the reason.

**Ground truth is the running system.** Nothing here was taken from a document.
A database was migrated from empty, seeded, and the api driven against it as four
real signed-in accounts. 219 requests were recorded.

**Re-tested 2026-09-22**, after SCRUM-263 to SCRUM-268 were written, on a second
database built the same way from empty. Every cell below that said LEAKS was
asked again, with the same people and the same requests. Four of the five are
closed; the fifth is closed except for one route, and one new door was found.
The original finding is left in place under each — it is the record of why the
code is the shape it is.

---

## How it was produced

| | |
|---|---|
| Database | `oto_proof`, created empty, `drizzle-kit migrate` from zero, then the new seed |
| Api | `apps/api` on `:3177`, `DEPLOY_ENV=local`, against that database |
| Branches | `hkt-central` → *Oto Play Park, Central Floresta*; `robinson-chalong` → *Oto Play Park, Robinson Chalong* |
| Second operator | *Rival Park, Patong* — inserted as a fixture, to test the cross-operator axis |
| Probes | 240 requests: 111 × 200, 78 × 403, 19 × 404, 11 × 400 in the six main passes, plus two follow-ups |

### The four people driving it

| Actor | Account | Holds |
|---|---|---|
| **Floresta manager** | Khun Lek | `branch_manager`, branch scope, Central Floresta — 83 grants, every one branch-scoped |
| **Chalong manager** | Khun Dao | `branch_manager`, branch scope, Robinson Chalong |
| **Reception** | Som | `reception`, branch scope, Central Floresta |
| **Operator admin** | Khun Anan | `platform_admin` platform-wide + `operator_admin` operator-wide |

A fifth was created during the run, to answer the member question from both
sides: reception at Robinson Chalong, made the ordinary way through the admin
API and signed in on a password they set themselves.

That pairing is the whole point. With one branch open, a branch-scoped grant and
an operator-wide one behave identically, so nothing was holding the scope
resolver honest. Two branches hold it honest.

### Gates, on the whole monorepo

```
pnpm test        5 tasks successful, 5 total
                 @oto/api        41 files   699 tests   passed
                 @oto/print       8 files   209 tests   passed
                 @oto/shared      4 files   197 tests   passed
                 @oto/telemetry   4 files    36 tests   passed
                 @oto/box-agent            167 tests   passed
                 ---------------------------------------------
                 57 files       1,308 tests   0 failed
pnpm typecheck   10 successful, 10 total
eslint apps packages   exit 0
migrate from empty     [✓] migrations applied successfully
```

Nothing is committed and nothing was staged.

### The re-test, 2026-09-22

| | |
|---|---|
| Database | `oto_verify`, created empty, `drizzle-kit migrate` from zero, then the same seed, then the app's own baseline into `otoapp` |
| Api | `apps/api` on `:3188`, `DEPLOY_ENV=local`, **with a staff-token signing key set** |
| Why the key | the first run could not tell whether the till came away with an offline credential, because that deployment had no key: "no token minted" would have passed for the wrong reason. Here the refusal asserts no `core.staff_token` row **and** the legitimate pick asserts one is minted |
| Fixtures | the same rival-operator branch and booth; a paper alert at Floresta and a branchless deployment alert; a quarantine row, an anomaly and a failed run **at each park**, so an empty tab could not be mistaken for a scoped one |
| Probes | 210 recorded requests — 162 × 200, 39 × 403, 8 × 404, 1 × 401 — plus direct reads of `core.account`, `core.role_assignment`, `core.staff_token` and `otoapp.user_branch_access`, because on four of these five the finding was never the status code but what the refusal did or did not change |

Gates, on the whole monorepo, on the combined tree:

```
pnpm test        5 tasks successful, 5 total
                 @oto/api        44 files   742 tests   passed
                 @oto/print       8 files   209 tests   passed
                 @oto/shared      4 files   197 tests   passed
                 @oto/telemetry   4 files    36 tests   passed
                 @oto/box-agent            167 tests   passed   (0 fail)
                 ---------------------------------------------
                 60 files       1,351 tests   0 failed
pnpm typecheck   10 successful, 10 total
eslint apps packages   exit 0
migrate from empty, twice in a row   [✓] then [✓], then seed clean
```

43 tests and 3 files more than the first run — the three new files behind
SCRUM-263 to SCRUM-268. The one failure the booth slice reported mid-flight
(`fleet-api.test.ts`, the station pick) was a half-written tree, and does not
reproduce: that file passes here.

---

## Verdict

**DO NOT MERGE yet — one route and one door.** The change since the first run is
large and in the right direction: four of the five defects are closed on the
running system, and the two that gated opening the second park are among them.

**What is now closed, proven on the re-test:**

| | was | now |
|---|---|---|
| **L1** SCRUM-263 | Chalong's manager signed in at Floresta and every route refused her | seated at Robinson Chalong; all seven routes `200` |
| **L2** SCRUM-264 | reception at Floresta took Chalong's till and its lease | `403` at the session move, at the pick, at the lease and at the standing check; no `staff_token` row |
| **L4** SCRUM-266 | a manager at one park issued a working password for a hire at the other | `403 OUT_OF_BRANCH_SCOPE` on all seven; `password_hash` still null, `status` still `invited` |
| **L5** SCRUM-267 | one operator's administrator read another's booth list | `404 BRANCH_NOT_FOUND`, body carrying neither the booth's id nor its name |
| **L3** SCRUM-265 | the Health page showed every branch's fleet | Floresta's manager gets her two boxes, Chalong's gets box 3, the administrator gets all three — and `/ops/failures`, `/ops/anomalies` and `/ops/runs` scope too, now that there are rows at both parks to tell them apart |

**What blocks it, and both are small:**

1. **`GET /ops/quarantine` is the one route of L3 still unscoped.**
   `listQuarantine` (`apps/api/src/services/sync.ts:3595`) filters on
   `eq(box.operatorId, …)` and nothing else, and its route passes no reach. On
   the re-test the two managers got **byte-identical** answers carrying both
   parks' box names and both parks' refusal reasons. It takes the same `reach`
   parameter and the same clause on the box it already joins — the fix its four
   siblings in `services/ops.ts` already have.

2. **An operator-scoped grant makes somebody staff of every branch — and
   SCRUM-268's own route hands one out.** `grantAppAccess`
   (`apps/api/src/services/app-identity.ts:89`) writes `app_access_oto_app` at
   **operator** scope, which is right for app access: the OTO App is not a
   per-branch thing. But `atBranch` (`apps/api/src/lib/staff-scope.ts`) reads
   *any* operator-scoped assignment as "administers every branch" — a rule
   written for administrators — so everyone provisioned into the OTO App becomes
   staff of both parks. Floresta's manager then sees a Robinson Chalong
   colleague's **phone number** in `GET /accounts`, sees them on
   `GET /branches/<Floresta>/staff`, and **can grant them a role at her own
   branch** (`200`), which is the last line of L4's reproduction reached by a
   different door. Takeover proper is still refused — but by
   `assertDominatesAccount`, not by the branch gate, so what is holding six of
   those seven requests is not the fix that was written for them.

**Why these two block, when the work is this good.** It is the same test the
first run applied to itself, and it has to be applied evenly. This tree ships the
two-branch seed. Both of the above are unreachable under one branch and live
under two — a branch manager reading the other park's box names and sync refusal
reasons, and a branch manager reading a colleague's phone number at the other
park and granting them a login at their own. Merging the seed with them open is
the same trade the first run refused, at a smaller size.

Both fixes are small and their shape is already settled. `listQuarantine` takes
the `reach` parameter its four siblings in `services/ops.ts` already take, and
the clause goes on the `box` it already joins. `atBranch`'s third half needs to
ask for an **administrator** role held operator-wide rather than for any role
held operator-wide, which is what it was written to mean.

**What is no longer the blocker.** The seed itself. The three defects that were
latent under one branch and live under two — the till, the health page and the
account takeover — are closed, so opening Robinson Chalong no longer turns those
on. What is left is two narrower doors of the same kind, and the argument for
closing them before the second park opens is the argument this register has made
throughout.

---

## The register

### 1. Branches

| Route / screen | Floresta manager | Chalong manager | Operator admin | Verdict |
|---|---|---|---|---|
| `GET /branches` — POS **Branch switcher**, Console **Devices**, **Booths**, **Activity** pickers | `200` → `hkt-central` only | `200` → `robinson-chalong` only | `200` → both | **SCOPED** |
| `PATCH /branches/:id` own branch | `403 FORBIDDEN` | — | `200` | **SCOPED** — a branch manager holds no `admin:branch:update`; renaming a park is the operator's act |
| `PATCH /branches/:id` other branch | `403 FORBIDDEN` | `403 FORBIDDEN` | `200` | **SCOPED** |

The switcher only offers branches the caller holds, because it is drawn from
`GET /branches`, which is filtered by grants. The route underneath it is not so
careful — see **L2**.

### 2. The station picker after sign-in

| Route / screen | Floresta manager | Chalong manager | Operator admin | Verdict |
|---|---|---|---|---|
| `GET /me/stations` — POS **station picker** | `200` → Counter 2, Reception Till 1 (both Floresta) | `200` → Reception Till 1 (Chalong), **at the seat sign-in gave them** | `200` → Booth 1, Counter 2, Reception Till 1 | **SCOPED** — SCRUM-263 / SCRUM-264 |
| `PUT /me/session/branch` to the other branch | `403 OUT_OF_BRANCH_SCOPE` | `403 OUT_OF_BRANCH_SCOPE` | `200` — an administrator moves freely, and still does | **SCOPED** — SCRUM-264 |
| `PUT /me/session/station` at the other branch | `403 STATION_OTHER_BRANCH` | — | `200` (after switching), `codePrefix=T3` | **SCOPED** — SCRUM-264 |
| `GET /me/stations` on a session seated by the OLD sign-in (branch written straight into the row) | `200 {"stations":[]}` | — | — | **SCOPED** — the route re-reads the grant rather than trusting the row |

Re-tested 2026-09-22. The picker is no longer filtered by a value the caller
writes for themselves: `GET /me/stations` passes `branchId: null` unless the
caller holds a grant at the session's branch, so a session seated before this
rule existed gets an empty list rather than the other park's tills. A station
somebody may not use is **absent, never flagged** — the route says nothing was
withheld.

### 3. Ticket packages and prices

| Route | Floresta manager | Chalong manager | Operator admin | Verdict |
|---|---|---|---|---|
| `GET /branches/:b/ticket-packages` own | `200` → 4 packages | `200` → 4 packages | `200` | **SCOPED** |
| …other branch | `403 FORBIDDEN` | `403 FORBIDDEN` | `200` | **SCOPED** |
| `POST /branches/:b/ticket-packages` own | `200` `{"id":"01a0c956-5123-…"}` | — | `200` | **SCOPED** |
| …other branch (valid body) | `403 FORBIDDEN` | — | `200` | **SCOPED** |
| `PATCH …/ticket-packages/:id` own | `200 {"ok":true}` | — | `200` | **SCOPED** |
| …other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** — SCRUM-248's fix |
| `DELETE …/ticket-packages/:id` other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** — SCRUM-248's fix |

Prices are per-branch by design: both parks seed *1 Hour Play*, and they are two
different rows that may carry two different prices.

### 4. Holidays and the pricing mode

| Route | Floresta manager | Chalong manager | Operator admin | Verdict |
|---|---|---|---|---|
| `GET /branches/:b/holidays` own | `200` → Loy Krathong 2026-11-24…25 | `200` → its own Loy Krathong row | `200` | **SCOPED** |
| …other branch | `403 FORBIDDEN` | `403 FORBIDDEN` | `200` | **SCOPED** |
| `POST /branches/:b/holidays` other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |
| `DELETE …/holidays/:id` other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** — SCRUM-248's fix |
| `GET /branches/:b/pricing-mode` own | `200 {"date":"2026-09-22","mode":"weekday"}` | `200` | `200` | **SCOPED** |
| …other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |

Each park holds its own holiday rows. A public holiday that closes one mall does
not close the other, and the calendar is per-branch for that reason.

### 5. Tax

| Route | Floresta manager | Chalong manager | Operator admin | Verdict |
|---|---|---|---|---|
| `GET /branches/:b/tax-config` own | `200` → VAT 7% inclusive | `200` | `200` | **SCOPED** |
| …other branch | `403 FORBIDDEN` | `403 FORBIDDEN` | `200` | **SCOPED** |
| `PUT /branches/:b/tax-config` other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |
| `GET /branches/:b/tax-overrides`, `/tax-resolve` other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |

### 6. Stations, boxes and devices — the Console **Devices** page

| Route | Floresta manager | Chalong manager | Operator admin | Verdict |
|---|---|---|---|---|
| `GET /branches/:b/stations` own | `200` → Booth 1, Counter 2, Reception Till 1 | `200` → Reception Till 1 (T3) | `200` | **SCOPED** |
| …other branch | `403 FORBIDDEN` | `403 FORBIDDEN` | `200` | **SCOPED** |
| `GET /stations/:id` other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |
| `PATCH /stations/:id` other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |
| `POST /branches/:b/stations` other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |
| `GET /branches/:b/boxes` own | `200` → Virtual box 1, 2 | `200` → Virtual box 3 | `200` | **SCOPED** |
| …other branch | `403 FORBIDDEN` | `403 FORBIDDEN` | `200` | **SCOPED** |
| `POST /boxes/:id/claim-code` other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |
| `GET /boxes/:id/commands`, `/heartbeats`, `/devices` other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |
| `PATCH /devices/:id` own | `200` → device returned | — | `200` | **SCOPED** |
| …other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |
| `GET /branches/:b/credentials` other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |
| `GET /branches/:b/staff` own | `200` → Anan, Som, Lek | `200` → Anan, Dao | `200` | **SCOPED** |
| …other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |

The operator administrator appears on **both** parks' staff lists. That is the
2026-09-20 ruling encoded in `atBranch` (`apps/api/src/lib/staff-scope.ts`):
somebody who administers the whole operator administers every branch in it, and
without that they would belong to no branch and vanish from their own station
picker.

### 7. The Console **Health** page and the rest of ops

| Route | Floresta manager | Chalong manager | Operator admin | Verdict |
|---|---|---|---|---|
| `GET /ops/health` | `200` → Virtual box 1, 2 (Floresta) | `200` → Virtual box 3 (Chalong) | `200` → all 3 | **SCOPED** — SCRUM-265 |
| `GET /ops/health` → `alerts` | `200` → `paper.low:floresta` | `200` → none | `200` → `paper.low:floresta` **and** the branchless `ops.missing` | **SCOPED** — a branchless alert is the deployment's own, not "a row for their branch" |
| `GET /ops/failures` | `200` → the Floresta run only | `200` → the Chalong run only | `200` → both | **SCOPED** — SCRUM-265 |
| `GET /ops/runs?fingerprint=fp-floresta` | `200` → the run | `200` → nothing | `200` → the run | **SCOPED** — a fingerprint is no longer a query-string guess away from a hidden group |
| `GET /ops/anomalies` | `200` → Virtual box 1's only | `200` → Virtual box 3's only | `200` → both | **SCOPED** — SCRUM-265 |
| `GET /ops/quarantine` | `200` → **both parks' rows** | `200` → **both parks' rows** | `200` → both | **LEAKS** — still open, see **L3** below |
| `GET /ops/integrations` | `200` → sms, storage, jobs, alerts, sentry | identical | identical | **BY DESIGN operator-wide** — these are the deployment's own providers, not a branch's |

Re-tested 2026-09-22 with a quarantine row, an anomaly and a failed run seeded at
**each** park, so that an empty tab could not be mistaken for a scoped one — the
caveat the first run had to make about `/failures`, `/quarantine` and
`/anomalies` no longer applies to any of them.

Health, failures, runs and anomalies now stop at the caller's branches.
`/ops/quarantine` does not: the two managers' answers were byte-identical and
both carried `Virtual box 1` and `Virtual box 3` with each park's refusal
reason.

### 8. Sales

| Route | Floresta manager | Chalong manager | Operator admin | Verdict |
|---|---|---|---|---|
| `GET /sales` (no filter) | `200` → Floresta's only | `200` → Chalong's only | `200` → both | **SCOPED** |
| `GET /sales?branchId=<other>` | `403 FORBIDDEN` | `403 FORBIDDEN` | `200` | **SCOPED** — an explicit branch you do not hold is refused, not silently emptied |

### 9. Visits

| Route | Floresta manager | Chalong manager | Operator admin | Verdict |
|---|---|---|---|---|
| `POST /visits` `{branchId: own}` | `200` `{"id":"01a0c955-2867-…","status":"draft"}` | `200` `{"id":"01a0c955-2873-…"}` | `200` | **SCOPED** |
| `POST /visits` `{branchId: other}` | `403 FORBIDDEN` | — | `200` | **SCOPED** — SCRUM-250's fix |
| `GET /visits/:id` own branch's visit | `200` | `200` | `200` | **SCOPED** |
| `GET /visits/:id` other branch's visit | `403 FORBIDDEN` | `403 FORBIDDEN` | `200` | **SCOPED** — SCRUM-250's fix |

### 10. The audit log — Console **Activity**

| Route | Floresta manager | Chalong manager | Operator admin | Verdict |
|---|---|---|---|---|
| `GET /audit` (no filter) | `200` → 50 rows, **every one** `branchId=hkt-central` | `200` → 1 row, `branchId=robinson-chalong` | `200` → both, plus branchless rows | **SCOPED** |
| `GET /audit?branchId=<other>` | `403 FORBIDDEN` | — | `200` | **SCOPED** |
| Rows with a null branch | absent | absent | present | **SCOPED** — operator-level events (an account created, a sign-in refused before a session existed) are not "rows for their branch" |

### 11. Accounts and sessions — POS **Login Users** panel

| Route | Floresta manager | Chalong manager | Operator admin | Verdict |
|---|---|---|---|---|
| `GET /accounts` | `200` → Anan, Som, Lek, + her own new hire | `200` → Anan, Dao, + his own new hire | `200` → all | **SCOPED** |
| `GET /accounts/:id/sessions` other branch's manager | `403 OUT_OF_BRANCH_SCOPE` | — | `200` | **SCOPED** |
| `GET /accounts/:id/permissions` other branch's **manager** | `403 OUT_OF_BRANCH_SCOPE` | — | `200` | **SCOPED** — the code shifted from `ROLE_NOT_DOMINATED`; scope is now asked first |
| `PATCH /accounts/:id` other branch's **manager** | `403 OUT_OF_BRANCH_SCOPE` | — | `200` | **SCOPED** — same shift |
| `POST /accounts/:id/temp-password` other branch's **manager** | `403 OUT_OF_BRANCH_SCOPE` | `403 OUT_OF_BRANCH_SCOPE` | `200` | **SCOPED** — same shift |
| all seven, against a **roleless** account at the other branch | `403 OUT_OF_BRANCH_SCOPE` on every one | — | `200` | **SCOPED** — SCRUM-266 |
| the same, against an account tied to **no branch at all** | `403 OUT_OF_BRANCH_SCOPE` | — | `200` | **SCOPED** — a manager administers nobody who belongs nowhere |
| the same, against somebody holding an **operator-scoped** grant (any role, not only an administrator's) | **`200` on `POST /:id/role-assignments`**; their phone is in `GET /accounts` | — | `200` | **LEAKS** — the new door, below |

Re-tested 2026-09-22. All seven of L4's requests refuse, and the database
confirms the refusals changed nothing: after the whole sequence the hire's
`password_hash` was still null, `status` still `invited`, phone unchanged and
`role_assignment` empty.

**The refusal code moved on some cells, and that is the right change.** Scope is
checked before dominance, because scope is what holds when the target has no
roles and dominance is what holds when it has too many. The rows above record
the codes this run returned; the first run's `ROLE_NOT_DOMINATED` is kept in the
sentence beside each so the change is visible rather than quietly overwritten.

**The door that is still open.** `atBranch` (`apps/api/src/lib/staff-scope.ts`)
counts anyone with an **operator-scoped** assignment as staff of every branch —
a rule written so an operator administrator does not vanish from their own
station picker. `grantAppAccess` writes `app_access_oto_app` at operator scope
for everybody provisioned into the OTO App, so they satisfy it too:

```
GET  /accounts                                   (as Floresta's manager)  → 200
     { "phone": "+669000000…", "employee": { "name": "…" } }
       ← somebody whose employee record is at Robinson Chalong
GET  /branches/<Floresta>/staff                                           → 200
     …the same person, on Central Floresta's staff list
POST /accounts/<them>/role-assignments
       {"roleName":"reception","scopeType":"branch","scopeId":<Floresta>} → 200
```

The other six requests against that person still refuse — with
`403 ROLE_NOT_DOMINATED`, i.e. by the dominance check and not by the branch
gate, which passed. Chalong's own manager, who holds only a branch-scoped grant,
is correctly absent from Floresta's list throughout.

### 12. Role grants — can Floresta's manager grant anything at Chalong?

| Request by the Floresta manager | Response | Verdict |
|---|---|---|
| `POST /accounts/:id/role-assignments` `{roleName:"reception", scopeType:"branch", scopeId:<Chalong>}` | `403 ROLE_NOT_DOMINATED` | **SCOPED** |
| …`{roleName:"staff", scopeType:"branch", scopeId:<Floresta>}` | `200 {"id":"01a0c956-514a-…"}` | **SCOPED** |
| …`{roleName:"operator_admin", scopeType:"operator", scopeId:<operator>}` | `403 ROLE_NOT_DOMINATED` | **SCOPED** |
| …`{roleName:"platform_admin", scopeType:"operator", scopeId:null}` | `403 SCOPE_NOT_OWNED` | **SCOPED** |
| …`{roleName:"branch_manager", scopeType:"branch", scopeId:<Chalong>}` **to themselves** | `403 ROLE_NOT_DOMINATED` | **SCOPED** |

**No.** A branch manager cannot grant past their own branch, cannot grant
operator-wide, cannot grant platform-wide, and cannot promote themselves into
the other park. That is the dominance rule in `access-control.ts` working
exactly as written — with the single exception of **L4**, where the target holds
no role and there is nothing to dominate.

### 13. Print templates and print jobs

| Route | Floresta manager | Chalong manager | Operator admin | Verdict |
|---|---|---|---|---|
| `GET /branches/:b/print-templates` own | `200` → 6 templates | `200` → its own 6 | `200` | **SCOPED** |
| …other branch | `403 FORBIDDEN` | `403 FORBIDDEN` | `200` | **SCOPED** |
| `PATCH /print-templates/:id` other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |
| `GET /branches/:b/print-jobs` own | `200 {"jobs":[]}` | — | `200` | **SCOPED** |
| …other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |
| `GET /boxes/:id/print-jobs` other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |
| `GET /stations/:id/printers`, `POST /stations/:id/test-print` other branch | `403 FORBIDDEN` | — | `200` | **SCOPED** |

Each park seeds its own six templates. A receipt footer is per-branch because
the address printed on it is.

### 14. The booth admin panel

| Route | Floresta manager | Chalong manager | Operator admin | Verdict |
|---|---|---|---|---|
| `GET /branches/:b/booths` own | `200` → Booth 1 | `200 {"booths":[]}` — Chalong has none | `200` | **SCOPED** within the operator |
| `GET /branches/:b/booths` the **other park** inside the operator | — | `403 FORBIDDEN` | `200` | **SCOPED** |
| `GET /branches/:b/booths` **another operator's branch id** | `403` | — | `404 BRANCH_NOT_FOUND` | **SCOPED** — SCRUM-267 |
| `GET /booths/:id/draft` at Floresta | `200` | `403 FORBIDDEN` | `200` | **SCOPED** |
| `GET /booths/:id/status`, `/staff`, `/versions` at Floresta | `200` | `403 FORBIDDEN` | `200` | **SCOPED** |
| `POST /booths/:id/publish` at Floresta | — | `403 FORBIDDEN` | `200` | **SCOPED** |
| `GET /booth-layouts` | `200` → Classic wheel | identical | identical | **BY DESIGN operator-wide** — a layout is a design the operator owns and both parks draw from |
| `GET /voucher-definitions` | `200` → six prize definitions | identical | identical | **BY DESIGN operator-wide** — the prize *definition* is the operator's; which booth offers it is per-branch |

### 15. Member lookup — operator-wide by design

| Route | Reception, **Floresta** | Reception, **Chalong** | Both managers | Verdict |
|---|---|---|---|---|
| `GET /members/lookup?phone=+66811111111` | `200` → Mali, id `01a0c952-1467-…`, tier `thai` | `200` → **the same row, same id** | `200` → the same row | **BY DESIGN operator-wide** |
| `GET /members/:id` | `200` | `200` | `200` | **BY DESIGN operator-wide** |
| `GET /members` (the whole register) | `403 FORBIDDEN` | `403 FORBIDDEN` | `200` | **SCOPED by role** — SCRUM-246's fix; reception looks a member up, it does not download the register |

**Confirmed both ways.** A reception account was created at Robinson Chalong the
ordinary way — the operator administrator creating it with `reception` scoped to
that branch, the invitee setting their own password — and it finds the identical
member row that Central Floresta's reception finds.

This is right. A family that buys a wristband at Central Floresta on Saturday
and at Robinson Chalong on Sunday is one member with one set of children, one
tier and one allergy note — not two records that disagree about whether a child
is allergic to peanuts. A member belongs to the park, not to a building.

The same account is correctly refused the other park's business:

```
GET /sales?branchId=<Central Floresta>                  → 403 FORBIDDEN
GET /branches/<Central Floresta>/ticket-packages        → 403 FORBIDDEN
GET /sales?branchId=<Robinson Chalong>                  → 200
GET /branches/<Robinson Chalong>/ticket-packages        → 200
```

Worth noting in passing: a temporary password issued to that account correctly
forced a change before it could reach anything — every route answered
`403 MUST_CHANGE_PASSWORD` until the password was set.

What stays per-branch is the *visit*: the same member visiting Chalong creates a
Chalong visit, and Floresta's manager cannot read it (§9).

---

## The five defects

### L1 — Signing in puts every account on the operator's first branch

`apps/api/src/services/auth.ts:431-444` sets the new session's branch to

```
select … from branch where operatorId = … limit 1
```

— no `orderBy`, and no regard for where the account actually works.

**Reproduction.** Khun Dao is the manager of Robinson Chalong and holds grants
there and nowhere else.

```
POST /auth/sign-in  {"phone":"+66900000005","password":"…"}   → 200
GET  /me                                                      → 200
     "branch": { "code": "hkt-central",
                 "name": "Oto Play Park, Central Floresta" }
```

They land at the other park. Every route that takes no explicit branch then
falls back to that session branch, where they hold nothing:

```
GET /branches      → 403    GET /sales         → 403
GET /accounts      → 403    GET /audit         → 403
GET /members?…     → 403    GET /ops/health    → 403
GET /members/lookup → 403
```

Robinson Chalong's manager cannot use the system at all until they switch
branch. Every one of those returns `200` the moment they do.

This is a lockout rather than a disclosure — but it is also the half of **L2**
that makes the session branch a value nobody can trust.

**Closed — SCRUM-263, re-tested 2026-09-22.** `seatBranch()` in
`apps/api/src/services/auth.ts` computes the seat from grants: operator-wide
reach seats at the operator's first live branch **ordered** by `createdAt, id`,
so "first" is the same branch on every sign-in; anyone else is seated at their
employee record's branch when they hold something there, else at the first live
branch their grants do cover.

```
POST /auth/sign-in  {"phone":"+66900000005", …}              → 200
GET  /me                                                     → 200
     "branch": { "code": "robinson-chalong",
                 "name": "Oto Play Park, Robinson Chalong" }
```

All four seeded accounts sign in and land where they work: Anan, Som and Lek at
Central Floresta, Dao at Robinson Chalong. Every one of the seven routes that
refused her now answers:

```
GET /branches → 200    GET /sales          → 200
GET /accounts → 200    GET /audit          → 200
GET /members  → 200    GET /ops/health     → 200
GET /members/lookup?phone=+66811111111     → 200
```

**One behaviour change beyond the leak, and it wants saying before staging.** An
account whose grants reach no live branch is now refused sign-in outright:

```
POST /auth/sign-in  (a roleless account holding a temporary password)
  → 403 NO_BRANCH_ACCESS
    "This account has no access at any branch yet — a manager needs to give it
     a role at the branch you work at."
```

Audited as `auth.sign_in_failed` with reason `no_branch_access`, and no session
row is written. That includes somebody holding a temporary password, who can no
longer reach the password-change screen. They could act nowhere anyway, but the
refusal is now at the door rather than at every route behind it.

### L2 — Reception at one park can take the other park's till

The chain, each step proven:

1. `PUT /me/session/branch` (`apps/api/src/routes/me.ts:105-123`) is
   `auth: 'session'` and nothing else. It checks the branch is in your operator.
   It does **not** check you hold anything there.
2. `GET /me/stations` filters on `auth.branchId` — the value you just set.
3. `PUT /me/session/station` → `pickStation`
   (`apps/api/src/services/fleet.ts:501-548`) checks the station is in your
   **operator**, that its branch equals `auth.branchId`, and that the station's
   access list admits you. A station whose `access_scope` is `all_staff` admits
   anyone. **No permission is checked against your grants at that branch.**
4. `standing()` (`apps/api/src/routes/stations.ts:165`) —
   `if (auth.stationId === stationId) return { row, role: 'holder' }` — returns
   *holder* with no permission check at all, so every station route that follows
   asks nothing.

**Reproduction.** Som is reception at Central Floresta. Her only grant is
`reception` scoped to Central Floresta.

```
PUT  /me/session/branch   {"branchId":"01a0c952-13fa-…"}      → 200 {"ok":true}
GET  /me/stations                                             → 200
     stations: [{ "name":"Reception Till 1", "id":"01a0c952-14be-…" }]
                 ← Robinson Chalong's till
PUT  /me/session/station  {"stationId":"01a0c952-14be-…"}     → 200
     station: { "branchId":"01a0c952-13fa-…", "codePrefix":"T3" }
POST /stations/01a0c952-14be-…/lease  {"holder":"…","takeover":false}
                                                              → 200
     lease: { "leaseId":"01a0c957-617a-…", "holderKind":"till",
              "accountId":"01a0c952-143c-…" }   ← Som
GET  /stations/01a0c952-14be-…/session                        → 200
     document: { "stationId":"01a0c952-14be-…", "view":"staff" }
```

She is standing at Robinson Chalong's till with the lease in her hand. The
Floresta manager does the same (`200` on the pick and on the lease).

Two things this register did **not** prove, and should not be read as proving:
a sale was not rung through (the quote body was rejected on its own schema
before the branch was reached), and no shift token was minted here because this
deployment has no signing key set. On staging, which has one, step 3 mints a
token the other park's box verifies offline. That is worth checking before the
next branch opens.

The reason the screens are not the way in is that `GET /branches` — which draws
the switcher — *is* scoped, so the dropdown offers only your own park. The
defect is reachable by anything that can make an HTTP request, including a till
that remembered a station id.

There is also a comment at `GET /me/stations`
(`apps/api/src/routes/fleet.ts:310-312`) that says the branch is "the session's
branch, never a parameter: a caller must not be able to ask what stands at a
branch they are not signed in to." Given `PUT /me/session/branch`, that
guarantee is not one the code gives.

**Closed — SCRUM-264, re-tested 2026-09-22, every link of the chain.** Som is
reception at Central Floresta and holds `reception` there and nowhere else.
Driven against the real routes, aimed at Robinson Chalong:

```
PUT  /me/session/branch   {"branchId":"<Robinson Chalong>"}
                                          → 403 OUT_OF_BRANCH_SCOPE
                                            "You hold no access at that branch"
GET  /me/stations                         → 200
     stations: [ "Counter 2", "Reception Till 1" ]   ← both Central Floresta
PUT  /me/session/station  {"stationId":"<Chalong's till>"}
                                          → 403 STATION_OTHER_BRANCH
POST /stations/<Chalong's till>/lease     → 403 FORBIDDEN
GET  /stations/<Chalong's till>/session   → 403 FORBIDDEN

core.staff_token rows for Som after the whole chain:  0
```

Zero, on a deployment that **can** mint them — the key was set for this run
precisely so that number would mean something.

Four more cases, each one a way the old chain could have survived:

```
# a session seated by the OLD sign-in, its branch written straight into the row
GET  /me                    → 200   session branch is robinson-chalong
GET  /me/stations           → 200   {"stations":[]}
PUT  /me/session/station    → 403   STATION_OTHER_BRANCH

# the shift outliving the grant: her role assignment removed mid-shift, while
# she is standing at her own till
GET  /stations/<her till>/session  → 403 STATION_OTHER_BRANCH
#   …and 200 again the moment the grant is restored

# the manager of Central Floresta, aimed at Robinson Chalong
PUT  /me/session/branch     → 403 OUT_OF_BRANCH_SCOPE
PUT  /me/session/station    → 403 STATION_OTHER_BRANCH
```

**And the positive path, at her own park, unchanged:**

```
PUT  /me/session/branch   {"branchId":"<Central Floresta>"}      → 200
GET  /me/stations                → 200  Counter 2, Reception Till 1
PUT  /me/session/station         → 200  staffToken minted
POST /stations/<her till>/lease  → 200  lease held
GET  /stations/<her till>/session→ 200  view "staff", stage "identify"

core.staff_token rows for Som at her own till:  1
```

The operator administrator still moves freely — to Robinson Chalong, picks its
till (`codePrefix T3`), and back — which is what an administrator is for.

### L3 — The Console's Health page shows every branch's equipment

`GET /ops/health` (`apps/api/src/routes/ops.ts:96`) is guarded by
`admin:health:read` with **no target**, and `fleetHealth`
(`apps/api/src/services/ops.ts:1881-1892`) scopes by `operatorId` alone.

**Reproduction.** Khun Dao, manager of Robinson Chalong only, on their own
correct session branch:

```
GET /ops/health   → 200
  boxes: [
    { "name":"Virtual box 1", "branchName":"Oto Play Park, Central Floresta",
      "devices":[ "Band Printer (adults)", "Band Printer (kids)", "EDC 1",
                  "EDC 3", "Kitchen Printer", "Receipt Printer 1",
                  "Receipt Printer 2", "Scanner 1" ] },
    { "name":"Virtual box 2", "branchName":"Oto Play Park, Central Floresta",
      "devices":[ "Receipt Printer 3" ] },
    { "name":"Virtual box 3", "branchName":"Oto Play Park, Robinson Chalong",
      "devices":[ "Receipt Printer 1" ] }
  ]
```

Three boxes across both parks, byte-identical to what Floresta's manager gets
and to what the operator administrator gets. `/ops/failures`, `/ops/quarantine`
and `/ops/anomalies` are built the same way; they were empty in this fixture, so
they are marked from their construction rather than from a populated answer.

**Closed except one route — SCRUM-265, re-tested 2026-09-22.** `services/ops.ts`
gained a `HealthReach` and a `reachClause` — `null` for operator-wide,
`inArray(column, ids)` for a branch list, and `sql\`false\`` for an empty reach,
because an empty reach is a real answer and not an absent filter — and
`routes/ops.ts` computes it with `branchReach(effective, 'admin:health:read', …)`
rather than from `auth.branchId`.

The re-test put a quarantine row, an anomaly and a failed run at **each** park,
so the first run's "empty, so marked by construction" caveat is gone:

```
GET /ops/health      as Floresta's manager  → 200  Virtual box 1, Virtual box 2
                     as Chalong's manager   → 200  Virtual box 3
                     as the administrator   → 200  all three
   Chalong's manager's body carries no "Virtual box 1", no "Virtual box 2",
   no "Kitchen Printer" and no "Central Floresta".

GET /ops/health → alerts
   Floresta's manager  → paper.low:floresta
   Chalong's manager   → none
   the administrator   → paper.low:floresta AND the branchless ops.missing

GET /ops/failures    → each manager sees only their own park's failed run
GET /ops/anomalies   → each manager sees only their own park's box
GET /ops/runs?fingerprint=fp-floresta
                     → Chalong's manager sees nothing
```

**`GET /ops/quarantine` is still open.** `listQuarantine`
(`apps/api/src/services/sync.ts:3595`) scopes on `eq(box.operatorId, …)` alone
and its route passes no reach:

```
GET /ops/quarantine  as Floresta's manager  → 200
                     as Chalong's manager   → 200   ← byte-identical
   both bodies carry "Virtual box 1", "Virtual box 3", and each park's
   refusal reason
```

It takes the same `reach` parameter and the same clause on the box it already
joins.

### L4 — A branch manager can take over a roleless account at the other park

Four routes are fenced only by `assertDominatesAccount`, which walks the
target's roles and so passes **vacuously when the target holds none**. A new
hire who has been given an account but not yet a role is exactly that.

**Reproduction.** A roleless account whose employee record sits at Robinson
Chalong. Khun Lek — manager of Central Floresta — on their own correct session
branch:

```
GET   /accounts                       → 200  the hire is correctly ABSENT
GET   /accounts/<hire>/permissions    → 200  {"assignments":[],"effective":[]}
GET   /accounts/<hire>/sessions       → 403  OUT_OF_BRANCH_SCOPE   ← the one that holds
POST  /accounts/<hire>/temp-password  → 200  a working password was returned
PATCH /accounts/<hire>  {"phone":"+669000000…"}   → 200 {"ok":true}
PATCH /accounts/<hire>  {"status":"inactive"}     → 200 {"ok":true}
POST  /accounts/<hire>/sessions/revoke            → 200
POST  /accounts/<hire>/role-assignments
        {"roleName":"reception","scopeType":"branch","scopeId":<Floresta>}
                                                  → 200
```

A manager at one park issued a working password for a colleague at the other
park, changed their phone number, deactivated them, and then granted them a role
at their own branch. The temporary password's value is deliberately not recorded
here; that a live one was returned is the finding.

The mirror confirms the shape is exactly "roleless target": the same request
against an account that *does* hold a role is refused —

```
POST /accounts/<Floresta reception>/temp-password   (as Chalong's manager)
                                                    → 403 ROLE_NOT_DOMINATED
```

`assertAccountInScope` already exists in `routes/accounts.ts` and would close
this; it was not widened onto the write surface because doing so changes admin
behaviour the console may depend on.

**Closed — SCRUM-266, re-tested 2026-09-22.** `assertAccountInScope` was widened
onto the whole by-id surface and taught to take the `Permission` the route
actually guards on, rather than assuming `admin:account:read` — reading a
colleague and taking their account over are different grants, so they get
different reaches. Scope is asked **before** dominance, because scope is what
holds when the target has no roles.

The same reproduction, request for request, as Khun Lek:

```
GET   /accounts                       → 200  the hire is correctly ABSENT
GET   /accounts/<hire>/permissions    → 403  OUT_OF_BRANCH_SCOPE
GET   /accounts/<hire>/sessions       → 403  OUT_OF_BRANCH_SCOPE
POST  /accounts/<hire>/temp-password  → 403  OUT_OF_BRANCH_SCOPE
PATCH /accounts/<hire>  {"phone":…}   → 403  OUT_OF_BRANCH_SCOPE
PATCH /accounts/<hire>  {"status":"inactive"}   → 403  OUT_OF_BRANCH_SCOPE
POST  /accounts/<hire>/sessions/revoke          → 403  OUT_OF_BRANCH_SCOPE
POST  /accounts/<hire>/role-assignments         → 403  OUT_OF_BRANCH_SCOPE

the hire afterwards, read from the database:
  password_hash = null   status = invited   phone unchanged   role_assignments = 0
```

The refusals changed nothing — which is the half of this worth checking, because
the finding was never the status code, it was that a live password came back.

**And the people who should be able to do it still can:**

```
Khun Lek → her OWN new hire at Central Floresta
  permissions 200 · sessions 200 · temp-password 200 · phone 200 · role grant 200
  afterwards: password_hash SET, status active, role_assignments 1

Khun Dao → the Robinson Chalong hire, which is his
  temp-password 200 · role grant 200

the operator administrator → all three, including the one tied to no branch
  permissions 200 · temp-password 200
```

An account tied to **no** branch is now operator-administrator-only. That does
not break the console, which always sends a role assignment at creation; it bites
an account created by a direct API call with `roles: []`.

### L5 — One operator's booth list is readable by another operator

`GET /branches/:branchId/booths` (`apps/api/src/routes/booth.ts:364-374`) calls
`listBooths(app.db, req.params.branchId)`, and `listBooths`
(`apps/api/src/services/booth-admin.ts:592`) takes no operator id. The guard
does not establish it either: an operator-scoped grant matches on the operator
and ignores the branch id in the target.

**Reproduction.** *Rival Park, Patong* belongs to a different operator. OTO's
own operator administrator:

```
GET /branches/<rival branch>/booths        → 200
    booths: [{ "id":"01a0c900-…-004", "name":"Rival Booth",
               "branchId":"01a0c900-…-002" }]
```

Every one of its twelve siblings refuses the same id correctly:

```
GET /branches/<rival branch>/ticket-packages  → 404 NOT_FOUND
GET /branches/<rival branch>/stations         → 404 BRANCH_NOT_FOUND
GET /branches/<rival branch>/boxes            → 404 BRANCH_NOT_FOUND
GET /branches/<rival branch>/print-templates  → 404 BRANCH_NOT_FOUND
GET /branches/<rival branch>/staff            → 404 BRANCH_NOT_FOUND
GET /branches/<rival branch>/holidays         → 404 NOT_FOUND
GET /branches/<rival branch>/tax-config       → 404 NOT_FOUND
…and five more
```

This is SCRUM-248's defect exactly — a `/branches/:branchId/…` route that never
loads the branch scoped to the caller's operator — in a file SCRUM-248 did not
cover. Within one operator it is correctly scoped: Chalong's manager is refused
Floresta's booths.

**Closed — SCRUM-267, re-tested 2026-09-22.** The route now calls
`loadBranchForOperator` before listing, the call its twelve siblings make, and
`listBooths` takes the operator as well as the branch and joins `branch` on it —
a second fence, so a future caller that forgets gets an empty list rather than
somebody else's booths.

```
GET /branches/<rival branch>/booths   (as OTO's own administrator)
  → 404 BRANCH_NOT_FOUND
    the body carries neither the rival booth's id nor its name
```

It now answers exactly as its siblings do, all of which were re-asked the same
id and all of which refused. The positive path is unchanged: Central Floresta's
booth list returns Booth 1 to the administrator and to Floresta's own manager,
Robinson Chalong's returns an empty list because it has no booth, and Chalong's
manager is refused Floresta's with `403 FORBIDDEN`.

---

## The seam: the OTO App's own branches

The OTO App carries its own `branches` table with the same three real names. The
question was whether anything maps one to the other, and where a person
provisioned from the platform lands.

**What is true today.**

1. **The mapping column exists. Nothing fills it.** `otoapp.branches` carries
   `core_branch_id`, `core_sync_status`, `core_synced_at` and `core_sync_error`
   (`apps/oto-app/shared/schema.ts:439-442`, DDL at
   `apps/oto-app/migrations/0000_otoapp_baseline.sql:279-282`). A search of the
   whole repository for those four names returns **only** the DDL, the Drizzle
   column definitions, and two optional fields in the `updateBranch` signature
   inside the app's own storage layer (`apps/oto-app/server/storage.ts:445-448`,
   `2647-2650`). **No platform code, no route, no job and no seed ever writes or
   reads one.** The column is an intention that was never wired up.

2. **A person provisioned from the platform lands in no OTO App branch at all.**
   `createOtoAppUser` (`apps/api/src/services/oto-app-users.ts:155-203`) writes
   `otoapp.users` with `operatorId` and `platformUserId` — and no branch. Its own
   header says so: *"What the app owns and this does not touch: branch access
   (`otoapp.user_branch_access`), access policies, and the employee record a user
   is matched to. Those are set inside the OTO App."* The app's
   `users.accessScope` defaults to `selected_branches`, and `user_branch_access`
   gets no rows — so the answer to "which branch do they land in" is **none, at
   either park**. Somebody has to open the OTO App and set their branch access
   by hand.

3. So the two systems' branch lists are **two independent lists that happen to
   carry the same names**. Nothing keeps them in step. Renaming Central Floresta
   on the platform does not rename it in the OTO App, and nothing would notice.

**What a mapping would need** (not built, as instructed):

- A decision on direction: whether `core.branch` is the record and the app's
  rows follow it, or the two are peers reconciled by a key.
- A stable join key. `core_branch_id` is `text` against a platform `uuid`, which
  works but should be stated. Matching on *name* would be wrong — the export's
  Central Floresta name carries a trailing space, and names are edited.
- A decision about Head Office, which is a row in the app's list and deliberately
  not a platform `branch` (it trades nothing). A mapping has to say what happens
  to it rather than fail on it.
- The provisioning step to place a new user into the mapped branch, which means
  writing `otoapp.user_branch_access` — a table the platform has so far
  deliberately not touched, so that boundary is a decision to take, not an
  oversight to fix.
- A reconciliation for the rows that exist today on both sides already unmapped.

Raised as **SCRUM-268**, a subtask of SCRUM-191.

### The seam, re-tested 2026-09-22 — the minimum is built

`seatInAppBranch` in `apps/api/src/services/oto-app-users.ts` resolves the
person's platform branch **from their employee record** — `account → employee.branchId
→ branch`, never `auth.branchId` — then an app branch by `core_branch_id`, else
by exact name, and writes one `otoapp.user_branch_access` row. Provisioning still
succeeds when nothing resolves, and the response and the `app_identity.link`
audit row carry `appBranch` so the launcher tile can say the person landed
nowhere rather than opening onto an app that answers every screen with nothing.

Driven with the administrator's session **parked at Robinson Chalong** the whole
time, so the seat cannot have come from it. The two app branches were set up with
their names deliberately drifted apart from the platform's:

```
POST /admin/apps/oto_app/users   (a person whose employee record is at Central Floresta)
  → 200  appBranch: "Floresta (app spelling)"  matchedBy=core_branch_id
         otoapp.user_branch_access → Floresta (app spelling)

POST /admin/apps/oto_app/users   (…at Robinson Chalong; that app row has no core_branch_id)
  → 200  appBranch: "Oto Play Park, Robinson Chalong"  matchedBy=name
         otoapp.user_branch_access → Oto Play Park, Robinson Chalong

POST /admin/apps/oto_app/users   (…whose employee record has no branch)
  → 200  appBranch: null  unplacedReason=no_platform_branch
         otoapp.user_branch_access → (none)
```

The id match wins over the drifted name, the name fallback works when there is no
mapping, and an unplaceable person is provisioned anyway with the reason stated.

**The cost, and it is the new door in §11.** `grantAppAccess` writes the access
role at **operator** scope, which is right — the OTO App is not per-branch. But
`atBranch` reads any operator-scoped assignment as "administers every branch", so
everybody provisioned this way becomes staff of both parks. That is what puts a
Robinson Chalong colleague's phone number on Central Floresta's manager's screen
and lets her grant them a role at her own branch. The seam did not create the
rule; it is the first thing to hand that rule out at scale.

---

## Jira

| Defect | Key | Priority | After the 2026-09-22 re-test |
|---|---|---|---|
| L1 — sign-in lands on the operator's first branch | **SCRUM-263** | High | **Holds** — Testing |
| L2 — session branch is unchecked; one park's staff take the other's till | **SCRUM-264** | Highest | **Holds**, whole chain — Testing |
| L3 — the Health page shows every branch's equipment | **SCRUM-265** | High | **Holds except `/ops/quarantine`** — stays In Progress |
| L4 — a roleless account at the other branch can be taken over | **SCRUM-266** | High | **Holds** — Testing |
| L5 — booth list has no operator check | **SCRUM-267** | Medium | **Holds** — Testing |
| OTO App branch mapping | **SCRUM-268** (subtask of SCRUM-191) | Medium | **Holds** — Testing |

Comments were added to SCRUM-248, SCRUM-249 and SCRUM-250 recording what the
first run proved about each, against two live branches, and to SCRUM-263 to
SCRUM-268 recording what the re-test proved.

**Two follow-ups this re-test raises, neither yet ticketed:**

1. Scope `listQuarantine` by the caller's reach, the way its four siblings in
   `services/ops.ts` now are.
2. Decide what `atBranch`'s operator-scoped half should mean. It was written so
   an operator administrator does not vanish from their own station picker;
   reading it as "anybody holding anything operator-wide" now admits every
   person provisioned into the OTO App onto every branch's staff list. Almost
   certainly it should ask for an administrator role, not for any role.

---

## What the uncommitted work got right

Worth saying plainly, because most of this register is green and that is not an
accident:

- All thirteen `/branches/:branchId/…` routes in `catalog.ts` now load the
  branch scoped to the caller's operator. Every cross-branch and cross-operator
  probe against them refused.
- The four list routes — branches, accounts, account sessions, audit — answer
  from the caller's **grants** rather than from their session branch, which is
  the only thing that could have worked, because the session branch is a value
  the caller writes for themselves (**L2** is the proof of that).
- Visits are checked at the branch in the body, re-checked after the branch is
  settled, and re-checked again on read.
- A branch manager cannot grant past their own branch in any of the five ways
  tried.

The three defects outside that slice — **L1**, **L2**, **L3** — are the ones
that decide whether the second park can actually open.

---

## What the re-test settled, and what it did not

Written after driving the same people at the same routes on a second database
built from empty, 2026-09-22.

**Settled.** The second park can open. L1 and L2 were the two gates on that, and
both hold under every shape the chain could have taken — the direct move, the
picker, the pick, the lease, the standing check, a session seated by the old
sign-in, and a grant withdrawn mid-shift. The one number that was missing from
the first run is now there: **zero `staff_token` rows** after the refused chain,
on a deployment that mints them, and **one** after the legitimate pick.

**The principle held up where it was applied.** Every fix reads grants, never
`auth.branchId`, and the three places that needed a branch question with no
permission attached — the seat, the move, the station's holder — ask the union
over every permission the account holds rather than hiding sign-in behind one
string in a role bundle. That is the right call: a permission tidied out of
`staff` one afternoon would otherwise have seated nobody anywhere.

**Not settled.** Two things, and both are the same shape — a rule that was right
for the caller it was written for, reused for a caller it was not:

- `listQuarantine` was never moved onto a reach, so one route of the Health page
  still answers both parks to either manager.
- `atBranch` was written so an operator administrator belongs to every branch.
  Read as "anybody with an operator-scoped grant", it now puts every person
  provisioned into the OTO App on every branch's staff list — and through the
  branch gate that SCRUM-266 added.

Both are small, both have a settled shape, and both are live the moment Robinson
Chalong opens — which is why they hold the merge rather than trail it.
