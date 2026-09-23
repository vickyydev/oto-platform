# SCRUM-206 / S2-10a — the box and device plumbing a terminal adapter rides on

**Reading basis.** `git status --porcelain` at start listed none of
`packages/box-agent/**`, `apps/api/src/services/{box,ops,jobs,print,fleet,sale}.ts`,
`packages/db/src/schema/**`, `packages/shared/src/simulator.ts`,
`docs/architecture/DEVICE_INVENTORY.md` or `PAYMENT_GATEWAY.md` as modified — so
**the file as it is == HEAD (adff73c)** for every path cited below. The dirty
paths in this tree (`apps/api/src/routes/{files,fleet,members}.ts`,
`apps/pos/**`, `services/`, new tests) are not load-bearing for this map; where
one is touched below it is called out.

---

## 1. Verdict first

**A terminal adapter lives on the BOX**, inside `packages/box-agent`, as a
sibling of `src/printing/` — not in the api. Three reasons, each already decided
in the tree:

- The ECR link is a serial device node on the box.
  `docs/architecture/DEVICE_INVENTORY.md:79` (D3): "ECR semi-integration on the
  box: NEXGO via GHL LinkPOS XML, PAX via Digio Direct Terminal, both over USB
  serial to the box, both with a simulator that speaks the same messages."
  `DEVICE_INVENTORY.md:924-948` fixes the physical layer:
  `ecr_transport: usb-serial`, `linux_device: /dev/serial/by-id/…`,
  `open_by_id_not_ttyACMn: true`, `timeouts: { open_ms: 2000, idle_read_ms: 500,
  customer_interaction_ms: 120000 }`.
- `packages/box-agent` is deliberately dependency-free of the database and
  Fastify so the same file runs on the Pi and in the api process —
  `packages/box-agent/src/agent.ts:51-58`: "the same file has to run on a
  Raspberry Pi in Phuket and inside the api process on Render. The 'virtual
  box' is not a simulation of the agent — it IS the agent."
- The print pipeline is already the exact template for this and says so:
  `agent.ts:48-50` — "Everything the box does towards the DEVICES — printing,
  scanning, the gate — is S2-06 and slots in behind `executeCommand` and
  `reportDevices`."

The api side owns the ledger (`pos.payment_attempt`), the routing decision, the
command row, the ops_run and the gateway (QR, which is an HTTP integration and
therefore correctly cloud-side per `PAYMENT_GATEWAY.md:566-590`).

---

## 2. The print pipeline, as the shape to copy

Five files, and the separation is the thing S2-10a should mirror one-for-one.

| File | Role | Terminal analogue |
|---|---|---|
| `printing/channel.ts` | the wire: `PrinterChannel {write,query,close}`, `ChannelFactory`, `tcpChannel`, `CHANNEL_TIMEOUTS`, `PrinterError` | a **serial** channel — new, see §7 |
| `printing/adapter.ts` | the dialect: `escposAdapter`, `tsplAdapter`, both `{probe, print}` over a channel | `ghlLinkposAdapter`, `digioTlvAdapter` |
| `printing/queue.ts` | routing station+role→device, serialisation per device, durable queue, retry | terminal routing + the inquiry rule |
| `printing/simulator.ts` | a byte-stream device behind the **same** adapter | terminal simulators in the two dialects |
| `printing/index.ts` | picks simulator vs real **per device row** | same switch |

Load-bearing details:

- **`PrinterChannel`** — `printing/channel.ts:93-105`: `write(bytes)`,
  `query(bytes, expect, timeoutMs)` ("Resolves with however many bytes arrived
  before `timeoutMs`, which may be none"), `close()`. `ChannelFactory` is
  `(target: ChannelTarget) => Promise<PrinterChannel>` (`channel.ts:108`), and
  `ChannelTarget` is `{host, port}` (`channel.ts:19-23`) — **TCP-shaped, which is
  where a terminal does not fit** (§7).
- **The simulator sits behind the same adapter, chosen by the device row.**
  `printing/index.ts:119-130`: one `ChannelFactory` resolves the device by
  address and returns `sim.connect()` when `device.transport === 'simulated'`
  (`index.ts:85`), else falls through to `openReal`. The stated reason,
  `index.ts:112-118`: "The adapter above it cannot tell which it got … whatever
  the simulator proves about the adapter is a claim about the code that will
  drive the real printer, because it IS that code." `printing/simulator.ts:1-35`
  goes further — it parses with the renderer's own reader and can serve itself
  on a real TCP port (`simulator.ts:95`, `listen(port?)`).
- **Routing station+role→device on the box**: `printing/queue.ts:307-321`
  `routeTo(bundle, role, stationId)` — filters `bundle.stations` by id, then
  `station.devices.find(d => d.role === role)`. `ROLE_FOR_KIND`
  (`queue.ts:76-86`) maps a job kind to a `station_device` role.
- **One device is never talked to twice at once**: `queue.ts:524-536`
  `serialise(deviceId, fn)` chains promises per device id. Written for printers
  ("neither vendor document says whether a second TCP session is refused or
  stalled", `queue.ts:23-27`) and it is exactly the rule a tethered EDC needs.
- **Durable queue across restart**: `queue.ts:435-490` `recover()` — a job left
  `queued` goes back on the queue; a job left `sending` is reported `failed`
  with `PRINT_INTERRUPTED` and **never retried automatically** (`queue.ts:186-205`,
  D12). This is the precedent for what an interrupted card tender must do.
- **Health is measured, never defaulted cheerful**: `adapter.ts:39-74`
  `PrinterHealth` + `unknownHealth`; `agent.ts:838-847` — "before this, every
  printer on a box reported `reachable` / `ok` because nothing had asked it
  anything, which is the one answer a health indicator must never give by
  default."

---

## 3. How the till reaches a device through its station

It is a **queued command with its own result route**, not an RPC. Five hops,
using `test_print` as the worked example:

1. **Till → api, scoped by station.** `apps/api/src/routes/print.ts:240`
   `POST /stations/:id/test-print` (siblings: `routes/print.ts:300`
   `/stations/:id/printers`; `routes/scanning.ts:156` `/stations/:id/scan`,
   `:185` `/scan/simulate`, `:319` `/button`).
2. **api resolves station → box and station+role → device.**
   `services/print.ts:258-295` `resolveTestPrintTarget` ("a station belongs to
   exactly one box"); `services/print.ts:306-329` `routeOnBox` joins
   `core.station_device` on `role` + `device.box_id`, excluding archived rows.
   The cloud's answer is recorded up front but **the box re-resolves and its
   answer wins** (`print.ts:297-305`).
3. **api writes the durable row FIRST, then queues the command.**
   `services/print.ts:489-524` inserts `edge.print_job` in its own transaction
   with an audit row — "a command whose job row does not exist yet is a box
   reporting against nothing" (`print.ts:460-467`) — then
   `print.ts:526-545` calls `queueCommand` with `printJobId` in the payload and
   the `actionId`.
4. **The command row.** `services/fleet.ts:1646-1669` `queueCommand`: mints an
   id, `expiresAt = now + boxSettings().commandTtlS`, inserts `edge.box_command`
   with `payload` jsonb, `requestedByAccountId`, `actionId`, and writes an audit
   row `box.command.<kind>`. Guards above it: a named device must be on this box
   (`fleet.ts:1612-1626`), a `simulate` payload must parse `SimulatorActionSchema`
   (`fleet.ts:1586-1596`), and a secret-bearing action is **refused outright**
   (`fleet.ts:1605-1611`).
5. **Box collects, runs, acks.** `agent.ts:1354-1406` `runPendingCommands()`:
   `POST /box/v1/commands/poll` with `{max: 5}` → `executeCommand` → `POST
   /box/v1/commands/:id/result`, carrying `x-oto-action-id` back up
   (`agent.ts:1373-1381`) so one gesture is one log-line group. Cloud side:
   `services/box.ts:1049` `pollCommands`, `box.ts:1098` `completeCommand`.
6. **The device outcome goes up its OWN route, not the command result.**
   `agent.ts:474-484` states the rule: "a command result says 'I took this
   instruction' … a job outcome says 'paper came out', and for a job that waited
   half an hour on an empty roll it is sent long after the command was
   acknowledged." Implementation `agent.ts:485-526` → `POST
   /box/v1/print-jobs/:id/result` → `services/print.ts:616` `recordPrintJobResult`.
7. **Live state back to screens** is SSE on `GET /stations/:id/channel`
   (`apps/api/src/routes/stations.ts:446-475`), snapshot-then-deltas from
   `StationSessionManager` (`box-agent/src/station-session.ts`, wired at
   `agent.ts:623-632`), keepalive 25 s (`routes/stations.ts:~500`).

**Timing, which S2-10a has to design around.** Command poll interval defaults to
**5 s** (`agent.ts:328`), heartbeat to **60 s** (`agent.ts:327`); a heartbeat ack
with `commandsPending > 0` also triggers a poll (`agent.ts:1320-1322`). So the
worst-case latency from "staff press Card" to "the terminal beeps" is ~5 s on
today's transport, before the 120 s customer-interaction window
(`DEVICE_INVENTORY.md:948`). A print job can wait; a guest at a till cannot.

---

## 4. The command queue and its vocabulary

- **Kinds**: `packages/box-agent/src/protocol.ts:419-437` `BOX_COMMAND_KINDS` =
  `test_print, config_apply, clear_cache, collect_logs, restart, go_offline,
  go_online, reset_store, simulate`. The comment at `protocol.ts:407-418` is a
  standing instruction: this list is **a CHECK constraint in `edge.box_command`**
  and has four copies that must agree — here, `packages/db/src/schema/edge.ts`,
  `apps/api/src/routes/fleet.ts`, `apps/console/src/api/fleet.ts` — with
  `apps/api/test/contract-drift.test.ts` comparing two of them.
- **`simulate` is the extension point**, deliberately one kind with a zod union
  in the payload: `protocol.ts:428-435` — "One kind rather than one per action …
  every addition here is a migration." The union is
  `packages/shared/src/simulator.ts:45-91` `SimulatorActionSchema`:
  `printer.fault`, `printer.clear`, `scanner.scan`, `button.press`,
  `badge.present`, `pin.enter`.
- **Handout/ack shapes**: `protocol.ts:444-479` — `BoxCommandHandout
  {id, kind, payload, actionId, attempts, expiresAt, createdAt}`,
  `BoxCommandResultRequestSchema {state: succeeded|failed, result?, errorCode?,
  errorMessage?}`, and `BoxCommandResultResponse.replayed` so a box that retries
  a lost ack learns it did not act twice (`protocol.ts:469-479`).
- **Dispatch on the box**: `agent.ts:1408-1688` `executeCommand`, one `case` per
  kind, with `default` answering `UNKNOWN_COMMAND` by name (`agent.ts:1676-1686`).
- **Expiry**: `services/box.ts:1334` `expireStaleCommands`, swept by
  `job:housekeeping.retention` (`services/jobs.ts:422-430`).

---

## 5. ops_run — the ticket's "every adapter call an ops_run"

**No migration is needed.** `packages/db/src/schema/ops.ts:40-50` /
`ops.ts:151` already permit `'http','process','job','client','adapter','device',
'sync','webhook','integration','console'`. The column comment at
`ops.ts:97-102` even names the convention the ticket wants:
`adapter:2c2p.do_payment`.

- **Writer**: `apps/api/src/services/ops.ts:158-226` `recordRun(exec, input)`.
  `RecordRunInput` (`ops.ts:121-143`) already carries `actionId`, `requestId`,
  `operatorId`, `branchId`, `stationId` and an optional caller-supplied `id`
  (used by sync so a run id can be stamped inside the transaction —
  `ops.ts:122-128`, the same trick a payment attempt could use).
- **Existing `kind: 'device'` precedent**, worth copying verbatim:
  `services/print.ts:666-697` — one run per failure, `name:
  \`device:printer.${errorCode}\`` so the fingerprint groups "this printer keeps
  running out of paper" rather than one row per receipt, with the device id in
  `detail`. Also `services/box.ts:1192-1210` (`name: \`device:box.${kind}\``,
  ok **and** failed) and `box.ts:815` (heartbeat).
- **Scrubbing is automatic and already card-aware.** `ops.ts:172` passes every
  `detail` through `scrubDetail = redact` from `@oto/telemetry`
  (`ops.ts:64-76`). `packages/telemetry/src/redact.ts` denies keys `pan`, `cvv`,
  `track2`, `cardnumber`, `cardholder`, `approvalcode`, `approvalnumber`
  (`redact.ts:148-198`) and sweeps bare card-length digit runs by **Luhn**
  (`redact.ts:219-236`, `BARE_CARD_RE`, `passesLuhn`).
  **Consequence for S2-10a**: `approvalCode` in an `ops_run.detail` is redacted
  today, while the ticket wants the approval code *stored on the attempt*. Those
  are two different sinks and the split is already enforced — good news for the
  "PAN/PII redaction fixture" evidence, and a trap if anyone expects the code to
  show on the Failures page.
- **Failures page / Attempts correlation**: `ops.ts:2446-2546` `failureGroups`,
  `ops.ts:2660` `runsForFingerprint`, and `ops_run.action_id` is indexed
  (`schema/ops.ts:147`) — which is what makes the ticket's "the action id on an
  attempt matches the Box log line and the adapter ops_run" a single query.

---

## 6. Station / device rows — is there a `terminal` role?

**Yes, both of them, already seeded and already routed.**

- Device kind: `packages/db/src/schema/fleet.ts:480` and the CHECK at
  `fleet.ts:588-591` include `'terminal'`.
- Roles: `fleet.ts:610-622` `STATION_DEVICE_ROLES` = `receipt, kids_band,
  adult_band, kitchen, bar, scanner, **card_terminal**, **qr_terminal**, gate,
  cash_drawer`; CHECK at `fleet.ts:646-650`; one device per role per station
  (`uniqueIndex('station_device_role_unique')`, `fleet.ts:643`).
- Terminal identity columns exist on `core.device`: `terminalId` /
  `merchantId` — `fleet.ts:540-542` "Payment terminals only, from the acquirer:
  TID and MID" — plus `serialNumber`, `protocol` (`fleet.ts:531-538`, whose
  comment already names `ghl_linkpos`, `digio_tlv`) and `settings` jsonb
  (`fleet.ts:543-562`).
- **They reach the box.** `BoxConfigDevice` carries `terminalId`, `merchantId`,
  `serialNumber`, `protocol`, `transport`, `address`, `settings`
  (`box-agent/src/protocol.ts:270-294`), and `BoxConfigStation` carries
  `paymentRouting` (`protocol.ts:296-307`), populated at
  `services/box.ts:936`.
- **Tender routing is a station document**: `core.station.payment_routing` jsonb
  — `schema/fleet.ts:352-359`: "Which tender goes to which device: card to a
  terminal, QR to the gateway or to a terminal's own QR, cash to the drawer …
  the set of tenders is still growing (S2-10a)". The Console already edits it
  (`apps/console/src/components/devices/StationDrawer.tsx:348-392`,
  `apps/console/src/api/fleet.ts:188-191`: `card?: 'card_terminal' | 'manual'`,
  `qr?: 'gateway' | 'qr_terminal' | 'none'`).
- **The seed already provisions both terminals on the till.**
  `packages/db/src/seed/index.ts:887-901`: `EDC 1` = NEXGO N5, protocol
  `ghl_linkpos`, TID `65703235`, MID `4648434010`; `EDC 3` = PAX A920Pro,
  protocol `digio_tlv`, serial `1854355548`. Both on `transport: 'simulated'`
  (`seed/index.ts:802-842`, with the note "the adapters are written against the
  truth and only the physical link changes on site"). Assigned at
  `seed/index.ts:978-979`: `card_terminal → devCard`, `qr_terminal → devQr`.
- `DEVICE_INVENTORY.md §4 D3` (line 79) is the decision row; §5 (lines 86-102)
  carries the message-level facts (LinkPOS `SALE/QUERY/VOID`, 12-char
  `pos_ref_no`, ISO codes for card and 00/01 for wallets, decimal amounts, no
  QUERY for CARD, Thai QR cannot be voided; Digio `3E55` + BER length + BER-TLV
  + XOR checksum, tags 21/22/04/05/06, actions A1/A3/A18/A11…, satang amounts);
  §9.5 (lines 832-976) is the physical layer and the open questions.

---

## 7. The gaps — what S2-10a must add

Grouped by where the work lands. Everything here was verified absent, not assumed.

### Box side (`packages/box-agent/src/terminal/`, new)

1. **A serial channel.** `ChannelTarget` is `{host, port}`
   (`printing/channel.ts:19-23`) and `tcpChannel` is a `net.Socket`
   (`channel.ts:153`). A terminal needs a `/dev/serial/by-id/…` path, 9600 8N1
   (`DEVICE_INVENTORY.md:939,944`), re-resolved by-id on hot-plug
   (`DEVICE_INVENTORY.md:946`, and §9.5's simulator requirement at lines 949-957
   that the node disappear and come back with a different `ttyACM` number). The
   `write/query/close` interface itself carries over; the *timeouts* do not —
   `CHANNEL_TIMEOUTS` (`channel.ts:30-37`) has no 120 s customer-interaction
   budget.
2. **Two dialect adapters** encoding and parsing real vendor messages against
   fixtures from `imports/_vendor-docs/` (per the ticket): GHL LinkPOS XML,
   Digio 3E55/BER-TLV with the XOR checksum. Nothing of either exists —
   `grep` for `ghl_linkpos` / `digio_tlv` outside the schema comment
   (`fleet.ts:536`) and the seed (`seed/index.ts:891,899`) returns nothing.
3. **`terminal_counter` on the box** (device_id, next_ref): 6-digit rolling refs
   for QR/Digio, 12-char `pos_ref_no` for GHL. The box store
   (`box-agent/src/store.ts`, `store-sql.ts`) has no such table; the nearest
   precedent is the `receipt_series` cache scope
   (`agent.ts:259-265`, `agent.ts:1137-1197`) — a scope pulled unconditionally
   because it moves on every sale, which is the same problem shape.
4. **Two terminal simulators** behind the same adapters, mirroring
   `printing/simulator.ts`, with the §9.5 transport behaviours (not-ready,
   busy, a 30-90 s slow customer — `DEVICE_INVENTORY.md:955-957`, "the case that
   drives the inquiry-on-no-response rule in S2-10a") plus the ticket's
   message-level states (approved, declined, partial approval, no-final-response,
   inquiry unavailable, timeout, advance-clock for void windows).
5. **A `PaymentTerminal` capability on the agent**, exported beside
   `printing()` / `scanner()` / `booth()` (`agent.ts:1812-1843`), and new
   `executeCommand` cases. Note `DEVICE_INVENTORY.md:237-245` (§8) names
   `packages/contracts` as the home of `Printer`, `ScanInput`,
   `PaymentTerminal`, `QrPayment`, `Gate`, `CashDrawer` — **`packages/contracts`
   does not exist**; the workspace is `box-agent, config, db, print, shared,
   telemetry`. S2-10a either creates it or follows the precedent set by printing
   and puts the contract inside `box-agent`.
6. **Drawer kick.** `cash_drawer` is a role (`fleet.ts:620`) but the pulse is a
   property of the *sale*, already plumbed as `PrintRequest.finish`
   (`printing/queue.ts:100-115`: "whether a drawer opens is a property of the
   SALE — a card payment does not open it and a cash one does (S2-11 decides
   that)"). Cash tender therefore rides the existing print path, not a new one.

### Command / simulator vocabulary

7. **New `SimulatorActionSchema` members** for `terminal.*` and `gateway.*`
   (`packages/shared/src/simulator.ts:45-91`). No migration needed — that is the
   whole point of `simulate` being one kind (`protocol.ts:428-435`).
8. **A real command kind for a tender** is probably needed and *is* a migration
   across four copies (`protocol.ts:407-418`). `simulate` will not do: a card
   tender is production behaviour, not a pretence.
9. **`SIMULATOR_ACTIONS_WITH_SECRETS` must grow.** `simulator.ts:105-108` and
   the 409 at `services/fleet.ts:1605-1611` exist because
   `edge.box_command.payload` is stored jsonb rendered in the Console's command
   history. Any terminal action carrying a PAN, a track, or an approval code
   falls under exactly that rule and must go by the station channel instead.

### API side

10. **`pos.payment_attempt` is still the Sprint 1 placeholder** —
    `packages/db/src/schema/sales.ts:878-890`: `{id, saleId, method,
    amountSatang, status default 'recorded', payload jsonb}`, one index. The
    comment at `sales.ts:874-877` says so explicitly: "Still the Sprint 1
    placeholder shape. S2-10a owns its columns." Every column in the ticket
    (provider, terminal_ref, TID, MID, approval code, last4, invoice_no unique
    forever, tran_ref, payment_id, raw QR payload, expires_at,
    staff_confirmed_by, offline flag, paid_at, box_seq) is new, as is the whole
    status vocabulary — today `sale.ts:2300` writes a single `TENDER_APPROVED`.
11. **The existing finalise path is a stub to replace, not extend.**
    `services/sale.ts:2275-2331`: "CALLING THIS ROUTE IS THE CONFIRMATION THAT
    THE MONEY WAS TAKEN … a call that names no tender settles the balance in
    cash". It inserts one approved attempt inline. Split tenders and an
    "Attempts" list have no support there.
12. **No `packages/payments-2c2p`** (workspace listing above), **no `PGW_*` env
    vars** (grep over `*.ts|*.tsx|*.yaml|*.example` returns nothing), no
    webhook route. The design is fully written in
    `docs/architecture/PAYMENT_GATEWAY.md:566-590` (the `QrPayment` contract:
    `createQr`/`inquire`/`cancel`/`refund`, `TwoC2PQrPayment` vs
    `SimulatorQrPayment`) and `:592-614` (the attempt lifecycle). §2.9 (line 476)
    is the sandbox-behaviour section the ticket flags as UNCERTAIN.
13. **`job:payments.pending` does not exist.** Adding it is mechanical:
    `services/jobs.ts:344-407` `buildDefaultJobs` returns `JobDefinition[]`
    (`jobs.ts:95-106`: `{name, description, intervalSeconds, graceSeconds?,
    severity?, run(ctx)}`); registering one writes its `ops_expectation` row so
    the watchdog measures it (`jobs.ts:496-520`), it is claimed under a Postgres
    advisory lock so only one api instance runs a tick
    (`jobs.ts:78-80`, `jobs.ts:474-489`), it only runs where `PROCESS_ROLES`
    includes `jobs` (`jobs.ts:468-481`), and its outcome lands in `ops_run` /
    `ops_last` via `jobs.ts:576,591`. `PAYMENT_PENDING_MIN` (10) is a new env
    var.
14. **`payment_routing` has no zod schema.** `schema/fleet.ts:352-358` claims
    "Validated by a zod schema in @oto/shared at the API boundary" but
    `apps/api/src/routes/fleet.ts:113-114` is
    `const RoutingSchema = z.record(z.string(), z.unknown())` with the comment
    "A jsonb document whose shape is still moving (**S2-10a names the tenders**)".
    Naming them is this ticket's job, and `@oto/shared` has no `PaymentRouting`
    export today (grep over `packages/shared/src` returns nothing).
15. **A terminal-result route**, the analogue of `POST
    /box/v1/print-jobs/:id/result` (`agent.ts:506`, `services/print.ts:616`), so
    a tender outcome that arrives 90 s after the command ack lands on the
    attempt row rather than being squeezed into `BoxCommandResultRequest`. The
    reasoning at `agent.ts:474-484` transfers exactly.

### What is already there and should simply be used

- `ops_run` kinds `adapter` / `device` / `integration` / `webhook` (no migration).
- PAN/Luhn/track2/approval-code redaction (`packages/telemetry/src/redact.ts`).
- `x-oto-action-id` end-to-end: minted at the button, on the command
  (`fleet.ts:1655`), carried to the box (`protocol.ts:448`), returned on the
  result header (`agent.ts:1380`), indexed on `ops_run` (`schema/ops.ts:147`).
- Per-device serialisation (`queue.ts:524-536`), durable-queue recovery with the
  `sending` ⇒ never-auto-retry rule (`queue.ts:435-490`), and the
  offline/outbox machinery (`agent.ts:1703-1735`, `src/outbox.ts`) that the
  ticket's "with the box offline a cash sale and a terminal-approved sale
  finalise … exactly once" acceptance rides on.
- The S2-04 coarse fault injection, still honoured over measured health:
  `BoxAgentOptions.faults` (`agent.ts:80-86`) applied in `deviceReports`
  (`agent.ts:848-869`) — "a fault somebody deliberately asked for must not be
  overwritten by a probe that found the machine healthy" (`agent.ts:852-857`).
  It only covers `reachability` / `paperStatus` / `lastError`, so terminal
  faults belong in the S2-06-style `simulate` plane, not here.
