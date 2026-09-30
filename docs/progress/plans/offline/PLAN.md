# Offline selling — the build plan for SCRUM-269, 270, 271 and 295

_Written 2026-09-30 from a read-only study of the requirement (register R1-R3 and Check 7 in
`docs/progress/ARCHITECTURE_CONFORMANCE_REGISTER.md`; the sprint plan's offline rule and the offline
lines of S2-05/06/09a/10a/11; `docs/briefs/PROJECT_CONTEXT.md` §5, §6, §8) and of the working tree.
Nothing here is built. S2-11 (SCRUM-208) is still moving, so every `file:line` is as of this date and
is re-read before a round. The cluster follows S2-11 (`AGENTS.md`) and lets SCRUM-206/205 close._

## 1. Offline selling, in the park's terms

The mall's internet drops on a Saturday afternoon, and the only change at the counter is a small
"offline" banner. Reception still finds a family by phone or signs up a new one, confirms the
children and their allergy notes, and rings up tickets, food and shop items at the same prices.
Cash opens the drawer; the card terminal works on its own 4G. Receipt and bands print from the
counter's own printer, numbered in that counter's series, and the bands open the gate. What cannot
be made safe without the internet says so politely: gift vouchers, a 2C2P QR, refunds and voids,
and wallet and online-booking spend until their own tickets add them. When the internet returns,
every sale reaches the platform exactly once, on the right trading day, and shows in History, the
reports and Radar as normal. Anything a person must look at (a price changed during the outage,
one family signed up at both counters) is filed, never lost, and flagged on Health.

## 2. The architecture

### 2.1 Two lanes, one set of ids

- **Online, the till keeps selling through the platform** as S2-10a and S2-11 built and verified
  it (`apps/pos/src/lib/saleWriter.ts` → `/sales`); vouchers, 2C2P QR, refunds, reprints and
  History are unchanged.
- **The box decides the lane.** Through the station bridge (2.2) the till asks whether its box's
  link is up (`linkUp`, `packages/box-agent/src/agent.ts:349-364`). The sale moves to the box lane
  when the link is cut, when the platform answers `503 STATION_FORCED_OFFLINE`, or when a money
  call fails at the network.
- **Both lanes carry the same till-minted ids** (sale, every line, one action id per press), so a
  sale begun on one lane and finished on the other meets itself on replay: `commitSale` replays by
  sale id, `payment_attempt_action_unique` by press (`apps/api/src/services/payments/offline.ts`,
  rule 2).
- **One thing holds the switch:** an electronic attempt with no final answer (a terminal
  mid-payment, a pending 2C2P QR) blocks the change until inquiry or staff confirmation resolves
  it; no replacement charge follows an unknown outcome (`ARCHITECTURE.md` §17). This departs from
  the letter of `docs/architecture/DEVELOPMENT_PLAN.md:328-332`; see OD-1.

### 2.2 The station bridge: how a till reaches its box

One contract, `/box/v1/station/:stationId/*`, written once in a new
`packages/box-agent/src/station-bridge.ts` over the existing `StationSessionManager`
(`station-session.ts`: lease as fencing token, compare-and-set, snapshots, `register()`), mounted
twice:

- **Virtual box (staging, CI):** mounted by the api process on the POS's origin (the existing
  `/api` rewrite), authenticated by the platform session plus the saved station
  (`apps/api/src/routes/stations.ts:209-226`), and deliberately **outside** the `stationTrading`
  guard: it is the box surface, so it keeps working with the toggle on, exactly as a Pi would.
- **Pi:** the agent listens on loopback and Caddy publishes it on the LAN with the box's own
  certificate (DNS-01, kept by `docs/briefs/OWNER_DIRECTION.md:30-33`); the kiosk server's
  loopback-only hardening (`runner/kiosk-server.ts:438-457`) is untouched. The bridge checks
  `Origin` against the POS origins and answers CORS and the Private Network Access preflight. Auth
  is a **box session**: at every unlock the till presents its staff token and the password; the box
  verifies the token against its cached deny-list (`staff-token.ts:254`) and the password against
  its cached hash (`OfflineAuth`, `:525`), then issues an opaque session bound to the jti and the
  station, ending at lock or token expiry. The token alone still opens nothing (`:23-29`).
- **Surface:** `GET status` (link, cache ages, outbox depth, receipt mark); `GET session` and an SSE
  channel on the pattern of `routes/stations.ts:654-700`; `POST lease | renew | release | unlock`;
  `GET members/lookup`; `POST intents` (the thirteen built-ins plus `cart.*`, `sale.*`,
  `payment.*`, `member.*`, `child.*`, `visit.*`, `receipt.observed`). The customer display reads
  the same channel with its own credential through `redactForCustomer` (`station-session.ts:852`).
  The cloud `POST /auth/unlock-offline` (`services/staff-token.ts:420-426`) retires once the POS
  uses the bridge.
- **On-site and credential steps (never deferred development):** the zone records, Caddy's DNS
  token, the router's local DNS, and the iPad's one-time local-network permission
  (`PROJECT_CONTEXT.md` §5-6).

### 2.3 What the box holds, and what it gains

**Exists:** nine cache scopes (`apps/api/src/services/sync.ts:3257-3273`), applied whole or not at
all with the deny-list first (`cache-apply.ts:45-69`), refreshed every 60 s, with the receipt mark
pulled on every tick (`agent.ts:2415-2439`). Nothing on the box reads `members`, `catalogue`,
`bands` or `station_config` yet. **It gains:**

- **`catalogue`** gains what a local quote lacks today (`ARCHITECTURE.md` §17): modifier groups and
  options, configured payment methods, promotion definitions, the branch's receipt header (name, tax
  id, address), and a version hash of its own that the fact carries (OD-8).
- **`staff`** gains each account's effective permissions at this branch (today: id, hash, status;
  the token carries no permissions).
- **`station_config`** gains the paired display credentials as hashes; the config bundle gains
  `bandKey` for counter and gate boxes (declared at `protocol.ts:476-493`, never set by
  `services/box.ts:1040-1110`, so a Pi answers every band scan `BAND_KEY_MISSING` today).
- **A local overlay** holds members, children and visits created offline; lookup reads it with the
  bundle until a pull includes them. These are the producers the appliers at `sync.ts:869-1300`
  have been waiting for. Reads follow the booth's cache-first pattern (`booth.ts:846-948`).

### 2.4 A sale on the box lane

1. **Price:** the bridge's `cart.*` intents price every line with the one satang engine (2.7) from
   the cached catalogue; the station document carries the totals the till and display show. On
   this lane the box's figure authorises taking money (`ARCHITECTURE.md:341`).
2. **Tender:** cash; a card through the box's own terminal adapter (`terminal/ghl.ts`, `digio.ts`,
   refs from `terminal/counter.ts`); a PAX QR flagged `awaiting_settlement`. The rest refuse (2.8).
3. **Finalise** in one store transaction (`store.ts:457-470` `atomically`, the booth's pattern):
   the sale snapshot, a receipt number from the station's series (`mintReceipt`,
   `agent.ts:2715-2745`), band ids and codes minted on the box (`packages/shared/src/band-code.ts`),
   the print jobs, and the `sale.finalised` + `payment.recorded` facts through `queueAll`
   (`outbox.ts:73-83`). This is `SaleQueue.record` (`agent.ts:2781-2847`) getting its first caller.
4. **Drawer, then printer:** cash opens the drawer only once the write is on disk
   (`agent.ts:2793-2805`); receipt and bands print from the snapshot (2.5). The till shows the
   prototype's confirmation step unchanged (`CLAUDE.md` §7).

### 2.5 Printing without the platform

`buildPrintDocument` (`services/sale-printing.ts:960-1006`) composes receipts, bands and prep
tickets from ledger rows, which an offline sale does not have yet. The composition moves into one
pure function in a shared package (sale snapshot → document): the platform feeds it rows, the box
its snapshot, same bytes both ways from one fixture set. The box keeps a print log by sale id, so a
late platform print of a sale it already printed is refused.

### 2.6 Replay: the existing path, with five changes

The replay of `sale.finalised` and `payment.recorded` (`payments/offline.ts`, `sync.ts`
`HANDLERS`) stays the path, with five changes:

- **Receipt:** adopt the box's printed number when it is free in the station's series and move
  `next_seq` past it; today it always allocates its own (rule 3). On a collision, allocate and
  record both, as today (OD-4).
- **Bands:** record the box's band ids and codes; mint nothing.
- **Price:** a sale priced from an older catalogue version is filed at the box's price with an
  alert (the SCRUM-401 pattern); the same version at a different total stays quarantined (OD-8).
- **฿0 comp:** a sale with no tender replays; today it is refused `SALE_NOTHING_TO_PAY`
  (`offline.ts:448-454`), against the S2-09a criterion (`SPRINT_2_PLAN.md:1622-1627`).
- **Members:** a merge keeps the discarded id as an alias of the survivor, so later child, visit
  and sale facts naming it land on the survivor. Today only the change feed carries
  `mergedFromMemberId` (`sync.ts:857-939`) and `child.created` would refuse `SYNC_MEMBER_ABSENT`.
  One migration.

### 2.7 Ids and money (SCRUM-270, SCRUM-271)

- **Ids.** The till mints what OD-12 lists. `commitSale` stops minting line ids (`sale.ts:2678`)
  and takes them from the cart. The offline cart already carries them (`offline.ts:124,171`), but
  the ledger discards them today. Children and visits accept a body id, as members and sales
  already do. The other ~13 create routes accept an optional one, which is R2's "now" fix. One
  conformance test binds the two UUIDv7 generators (`packages/shared/src/ids.ts`,
  `packages/box-agent/src/signing.ts:121-128`, advancing SCRUM-279).
- **Money.** F&B and shop pricing today lives only in the platform's `resolveItemLines`
  (`sale.ts:933`). It is extracted into `packages/shared` as a satang engine beside
  `computeTicketCartTotals`, so the platform, the till and the box price items with the same code.
  Every importer of `@/lib/tax`, `@/lib/sale`, `@/lib/fnb` and `@/lib/merch` for money (`roundTHB`,
  `computeTotals`, `computeFnbTotals`, `computeMerchTotals`; 30+ files, including
  `CustomerDisplay.tsx`, `Book.tsx`, F&B, Merch, Events, mobile, parties) moves through
  `cartWire`. `lib/reporting.ts` accumulates in satang and formats only at the CSV edge. A lint
  rule bans the old calculator; a schema check makes every money field `z.number().int()`.

### 2.8 The capability list (SCRUM-295)

This replaces the current-state table in `ARCHITECTURE.md` §17. Each row gets one test that runs
the operation with the offline toggle on and asserts the row (register Check 7).

| Operation | Offline | Why, and the bound |
|---|---|---|
| Unlock a locked till | Works | Token + password on the box; refused while no deny-list is held |
| Fresh sign-in | Works, bounded | Seen on this box in 30 days; deny-list ≤ 72 h old; banner (OD-6) |
| Find a member by phone | Works | Members cache + offline overlay; no age limit |
| Create a member; add or edit a child; confirm who is visiting | Works | Facts; same phone merges on sync (OD-7) |
| Ticket, F&B and shop pricing | Works, bounded | Cached catalogue; banner after 24 h; refused after 7 days (OD-5) |
| Promo code | Works | Till's copy; filed as applied, alert on difference (SCRUM-401) |
| Manual discount, ฿0 comp, tier change | Works | Same permission as online, from the cache (OD-11) |
| Cash | Works | Drawer opens after the sale is on disk |
| Card on the terminal | Works | Terminal's own 4G; no final answer → inquiry; GHL → OD-3 |
| PAX (Digio) QR | Works, flagged | `awaiting_settlement` until the settlement file matches |
| 2C2P QR | Refused | Minting is a server call (`PAYMENT_GATEWAY.md:51-54`) |
| Gift or prize voucher | Refused | Single use across counters is server-validated (`SPRINT_2_PLAN.md:1825`) |
| Wallet spend | Refused | Until the wallet ticket adds the capped row (OD-14) |
| Online booking redemption | Refused | S2-12 builds it on this bridge (`plans/arrival/PLAN.md` §2.3) |
| Refund, void | Refused; a "refund requested" note queues | Online only with `pos:refund:approve` (decision 8) |
| Receipt and bands for an offline sale | Works | From the box's snapshot and print queue |
| Reprint | Works for today's sales on this box | Anything older needs ledger rows |
| Customer display | Works | Follows the box (OD-10) |
| History, Today, reports | Refused politely | Platform reads; they fill in on reconnect |
| Child check-in and release | Rides this bridge in S2-13 | Not this cluster's row |

## 3. Recorded decisions

The build follows each answer unless the owner objects. **[owner]** marks the ones that are
genuinely the owner's call. Those still carry a default, so nothing waits.

**OD-1. Which way does the till sell while the internet is up?** Through the platform, as today;
it switches to the box lane when the box says the link is cut or a money call fails at the network,
and the shared ids make the switch safe. Everything that must work offline goes through the box,
which is what the plan's offline rule exists for. Routing every online sale through the box instead
would re-plumb vouchers, the 2C2P QR, refunds, reprints and History before the park's play-test.
Recorded in `ARCHITECTURE.md` as a deviation from `DEVELOPMENT_PLAN.md:328`. The cost: the box lane
is not exercised on every sale, so the per-row tests and the convergence harness carry that proof.

**OD-2. How does a till prove who it is to a box?** With a box session, issued when the box has
checked both the staff token and the password at unlock (2.2). The virtual box accepts the
platform session. **[owner]** Whether a short station PIN should replace the password (the design
review's suggestion, never adopted). Until then the build uses the password (`PROJECT_CONTEXT.md` §5).

**OD-3. Which tenders work offline?** The documents' answer: cash; a card on a terminal that
returns a final answer; and the PAX (Digio) QR, flagged `awaiting_settlement`
(`SPRINT_2_PLAN.md:1759-1760,1793-1794`; `DEVELOPMENT_PLAN.md:415-418`). Never offline: the 2C2P
QR and vouchers; wallet and booking claims wait for their own tickets (OD-14, S2-12); and a refused
fact is never turned into another tender.
**[owner]** A GHL card sale with no answer offline cannot be inquired. Recommended: staff confirm
it against the terminal's own screen and type the approval code, recorded on the box and flagged
for end-of-day reconciliation, because refusing it leaves money taken and unrecorded. Today that
confirmation is an audited online operation (`ARCHITECTURE.md:345`).

**OD-4. What happens to the receipt series on reconnect?** Each counter keeps one series, in the
plan's format (decision 16). Offline, the box continues from the higher of the mark it last pulled
and the last number the till reported through `receipt.observed` after an online sale; it persists
each number before printing, and its counter is keyed by the mark, so nothing is re-issued
(`agent.ts:2660-2675`). On replay the platform adopts the printed number when it is free and moves
on. On a collision (an abandoned sale that lost its answer; a replaced box whose predecessor's
unsent tail syncs later) the sale is filed under the next free number, both numbers on the audit
row, with a `sync_anomaly` alert. Voids keep their number; refunds have their own series, online
only. **[owner, with the accountant]** Whether a counter should instead print a second, box-owned
series while offline: it never collides, but gives each counter two series (`PROJECT_CONTEXT.md`
§8 already asks the accountant before go-live).

**OD-5. How stale may each cached scope grow?** Catalogue (prices, tax, holidays, payment
methods, promotions): sells normally for 24 h after the last good pull, then with a "prices last
updated" banner, and refuses new sales after 7 days, because a box holding a week-old catalogue is
more likely a cold spare than an outage. Members: no limit; a missed lookup creates, sync merges.
Staff: the token's own 16 h expiry, and a deny-list must be held. Receipt series and station
config: must be present, no age limit. **[owner]** The two catalogue numbers, both Console settings
("cache max age", `SPRINT_2_PLAN.md:3764`).

**OD-6. Is a fresh sign-in allowed with no internet?** Yes, per plan decision 11: staff seen on
this box in the last 30 days, with an offline banner. Added: the box must hold a deny-list pulled
within 72 h, so a dismissal still reaches the counter (the design review's freshness bound, never
adopted until now). Facts from such a session are marked `offline_fresh`. **[owner]** Confirm it;
`PROJECT_CONTEXT.md` §5 still marks it Open.

**OD-7. How does a member created offline merge?** As the code already does (`sync.ts:857-939`):
the same phone at two counters, the first to arrive survives and the second is recorded as a merge
naming both events. Added: the discarded id becomes an alias, so its children, visits and sales
land on the survivor. Children are never merged automatically; both are kept and the member is
flagged for staff to confirm at the next visit, so no allergy note disappears.

**OD-8. What if a price changed while the box was offline?** The fact carries the catalogue version
it was priced from. An older version is filed at the box's price with an alert: the money was taken
at a price the park displayed. The same version at a different total is quarantined, because that is
a defect. Quarantine also stays for integrity failures: a hash conflict, an epoch regression, an
unavailable payment method (`ARCHITECTURE.md:231`).

**OD-9. Who is the actor on a fact that syncs hours later?** The account that unlocked the box
session (the token's `sub`), with its `staffTokenJti` in the envelope; expiry since then does not
matter. If the jti was revoked **before** `occurredAt`, the fact is still applied and raises a
`revoked_actor` anomaly with an alert: a sale that happened is filed, not lost.

**OD-10. What does the customer display do offline?** It follows the box's station document through
the bridge with its paired credential and the redacted document: order, total and language toggle
keep working. A display that cannot reach its box shows its welcome screen, never a stale total.
Pairing a new display needs the platform. The till never waits on the display; the prototype's
skip / walk-in path stays.

**OD-11. Can discounts, comps and tier changes happen offline?** Yes, under the same permission as
online, read from the cached permissions; no second person approves, because the system has no
manager approval on discounts by design (`OPEN_QUESTIONS.md` 3c(b)). The ฿0 comp is required by
S2-09a. A tier upgrade with evidence becomes a `member.tier_changed` fact; a downgrade needs
`pos:member:tier_downgrade` on the unlocked account. Refunds and voids stay refused. **[owner]**
Whether anything should need a second person while offline (the design review's overlay, never
answered).

**OD-12. Where are ids minted?** The till: the sale, every line and item, the action id per press,
each member, child and visit. The box: receipt numbers, band ids and codes, print jobs, terminal
references, outbox events. The platform: derived rows nothing outside refers to (tax breakdowns,
discount allocations) and records created in the admin screens, whose routes accept an optional
body id. A replay whose line ids differ from the stored sale's is a conflict.

**OD-13. Bands on an offline sale.** They are minted on the box with the shared park key. The
owner's direction stands, and the design review's case for Ed25519 is noted but not adopted. The key
travels in the config bundle to counter and gate boxes only, never to booth boxes. Online sales keep
S2-11's platform minting, with the same key and format, so the gate cannot tell the two apart.

**OD-14. Wallet spend offline.** Refused in this cluster, because no local producer exists yet.
When the wallet ticket adds the capped row, the default is ฿300 per wallet per day, which has no
source (`SPRINT_2_PLAN.md:4621-4624`). **[owner]** The value.

## 4. Build rounds

Each round lands on `main` deployable, with staging evidence per the Jira rule (Deployed requires a
screenshot). Tests follow the repo's existing patterns and add no new framework: api integration
on the embedded Postgres harness (`apps/api/test/helpers.ts`), box-agent tests on SQLite, and
Playwright only with its own absolute output directory.

**Round 1: name it before saving it (closes SCRUM-270; starts SCRUM-295).**
- **Files:** `apps/pos/src/lib/cartWire.ts`, `apps/pos/src/api/sales.ts` (`buildCartPayload`),
  `apps/api/src/services/sale.ts` (`commitSale`), `routes/sales.ts`, the child and visit create
  routes; the ~13 admin create routes (`routes/accounts.ts`, `branches.ts`, `catalog.ts`,
  `files.ts`, `operators.ts`, `services/fleet.ts`); the id conformance test; `ARCHITECTURE.md` §17
  rewritten as 2.8 with a status per row; a new `apps/api/test/offline-capability.test.ts`, one
  case per row (refusals asserted now, "works" rows added as rounds 3-4 land).
- **Tests:** same sale and line ids replay with `x-oto-replay`; different line ids are a conflict;
  every create route with a body id replays. **Deployable:** nothing visible changes.

**Round 2: one calculator (closes SCRUM-271).**
- **Files:** the item engine extracted into `packages/shared` and the platform switched to it first
  (the existing sale tests prove nothing moved); every importer named in 2.7 ported, including
  `lib/reporting.ts` and its five CSV panels; the lint ban and the zod `.int()` check. The two
  disagreements `cart-totals.ts` records get fixtures; one that differs from a prototype figure
  beyond rounding goes to `OPEN_QUESTIONS.md`, not into the code.
- **Tests:** prototype-figure parity per surface; `driveCarts.ts` and `checkCartPricing.ts`
  rewired. **Deployable:** F&B, shop, events and the display show the same figures, in satang.

**Round 3: the bridge and the box's own reads (advances SCRUM-269).**
- **Files:** `station-bridge.ts` with its api mount (virtual boxes) and Pi mount (Caddy config in
  the box image); the cache additions of 2.3 in `services/sync.ts` and `services/box.ts`; the
  overlay in `store-sqlite.ts` / `store-postgres.ts` (edge migration); member (with
  `member.tier_changed`), child and visit producers; the alias migration and applier change;
  bridge unlock, box session and the fresh-sign-in rule; a lane arbiter in `apps/pos`, and
  `displaySession.ts` pointed at the bridge.
- **Tests:** the convergence harness (`buildApp` and `buildAgent` joined by a link that can be
  cut): a member created at two counters, the alias, deny-list refusal. **Deployable:** with the
  toggle on, a staging till unlocks, finds and creates members, confirms children and builds a
  priced cart; paying still refuses politely.

**Round 4: selling offline (advances SCRUM-269; finishes SCRUM-206's offline half).**
- **Files:** the box lane in `saleWriter.ts`; the bridge's `sale.*` and `payment.*` intents calling
  `SaleQueue.record`, with the terminal path and the refusals' copy; band minting and `bandKey`
  delivery; the shared print composer from `sale-printing.ts`, the local print log and
  `receipt.observed`; the replay changes of 2.6.
- **Tests:** crash points on the finalise transaction; a replay twice gives one sale; two boxes on
  one number raise an anomaly; a lane switch mid-sale converges; a late platform print is refused;
  a ฿0 comp replays. **Deployable:** a forced-offline virtual station sells with cash and the
  simulated terminal and prints from the box queue; after reconnect each sale shows once in
  History under its printed number.

**Round 5: proof (closes SCRUM-295, 269 and 206, then SCRUM-205).**
- Every row of 2.8 green with the toggle on. Staging evidence for the offline lines of S2-10a
  (cash and terminal, exactly once), S2-09a (a ฿0 comp with `origin=box`, a receipt in the station
  series) and S2-11 (receipt and bands from the box queue), plus an api restart while the box is
  offline with three queued events (`SPRINT_2_PLAN.md:1170-1172`).
- **Bench step (on-site/credential, not development):** the same bridge on the bench Pi over the
  LAN once the zone records and Caddy's DNS token exist. SCRUM-205 closes when its remaining
  subtasks are Deployed; check the register at the time.

## 5. What must not be touched

- **Run `0d008153`'s eight retained inventory rows** (the simulated partial payment on virtual-1,
  ids in `docs/qa/payment-stage/README.md:110,188`; `OPEN_QUESTIONS.md:41-46`): never replay the
  SALE, fabricate a callback, confirm no money or archive them; every replay test, quarantine replay
  and staging sweep excludes them by id. The separately cleaned GHL simulation is a different record.
- **Applied migrations** (0000-0034 on disk on this date): never edited; new ones append, created
  only by the platform lane (`AGENTS.md`). The api never rolls back before `85d35e0` (migration 0033).
- **Preserved branch tips:** `fix/offline-proof` (`d38eb3e`), `release/payment-follow-ups`,
  `fix/payment-request-copy`, `wip/bench-round-1`: never pruned, rebased or force-pushed.
- **The booth, the kiosk server and SCRUM-285's guard.** The booth's released local workflow on
  the Pi keeps working offline; the kiosk server stays loopback-only; the bridge sits beside
  `apps/api/src/plugins/station-offline.ts`, which is never loosened, and its Pi exclusion stays.
- **The prototype's design** (`CLAUDE.md` §7): no restyling, relabelling or moving, and the
  two-step payment stays.
- **Other work in progress.** The working tree carries another lane's uncommitted changes, so pull
  `main` before each round. Nothing under `imports/` is committed.

## 6. Honest unknowns

- **The browser-to-LAN call:** whether an installed iPad PWA served from `*.onrender.com` reaches
  an HTTPS origin on a private address without friction (local-network prompts differ by browser
  and version) is measured on the bench before round 5 claims it; until then the virtual box is the
  only proof.
- **The print composer** may not extract cleanly while S2-11 is still changing
  `sale-printing.ts`. **Terminal write-ahead:** no persist-before-bytes was found in `terminal/`;
  if it is absent, round 4 adds it, since a power cut mid-payment is the case it covers.
- **Catalogue version:** the bundle's version is hashed over all administered scopes together;
  OD-8 needs a catalogue-only hash. **Engine disagreements:** the two recorded ones may become
  owner questions rather than code.
- **Long outages:** past 16 h, fresh offline sign-ins each morning (OD-6); past the catalogue
  limit, selling stops (OD-5).
