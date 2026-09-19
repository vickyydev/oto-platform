# OTO Platform — Project Context (companion to CLAUDE.md)

This document consolidates everything decided about the OTO platform beyond Sprint 1. `CLAUDE.md` governs how you work and what Sprint 1 built. This file is what you design *for*: the full product, the devices, the network, the payment flows, the offline model, and the booth game. Read both before starting Sprint 2. Where this file and `CLAUDE.md` disagree, this file is newer and wins; note the conflict in `SPRINT_2_PROGRESS.md`.

Everything marked **Decided** is settled; build on it. Everything marked **Open** needs the client's answer; build the safe default and flag it.

---

## 1. The product in one paragraph

OTO Park is an indoor children's play park in Phuket, Thailand, inside a shopping mall, with two branches. The platform replaces a Replit-built prototype and covers: admission sales with printed wristbands, a customer-facing display, member records with children and allergy notes, tiered pricing (tourist / expat / Thai), prepaid child wallets spent at the restaurant, F&B ordering to a kitchen printer, supervised child care with authorised pickup and release, online booking with QR redemption, a self-service kiosk, an entrance gate with live occupancy, events and camps, stock, staff timekeeping and scheduling, customer messaging (LINE, WhatsApp, Instagram), reporting, and a standalone lucky-wheel voucher game run from mall booths. Staff use iPads. Every counter has a small Linux box that owns its hardware.

## 2. Delivery plan

**Decided.** Sprint 1 built the foundation (accounts, permissions, audit, idempotency, members, catalog). Sprint 2 is one continuous run that finishes **all remaining software** on staging, with every device and third party behind a simulator or sandbox. The stabilisation period that follows is hardware bring-up, integrations against real accounts, parallel run and cutover. No further module-by-module sprints.

Consequence for you: nothing in Sprint 2 may block on hardware or a third-party account. Every external dependency gets an adapter interface, a simulator implementation, and a real implementation that can be dropped in later without touching callers.

Checkpoints and progress tracking work exactly as in `CLAUDE.md`, with `SPRINT_2_PROGRESS.md` as the record.

## 3. System topology

```
                 ┌──────────────────────── Cloud (Render, Singapore) ────────────────────────┐
                 │  API (Fastify)  ·  PostgreSQL  ·  Object storage  ·  Admin console  ·  Booking site │
                 └───────────────▲───────────────────────────▲───────────────────────────────┘
                                 │ outbound WebSocket only    │ outbound only
     ┌───────────────────────────┴─────── Park LAN ──────────┴──────────────────────────┐
     │  Router (park-owned, dual-SIM 4G failover)  ·  Switch  ·  Private Wi-Fi          │
     │                                                                                   │
     │  iPads (POS in Safari, PWA) ──Wi-Fi/HTTPS──▶ Station boxes (Raspberry Pi 5)       │
     │                                               ├── USB: EDC, scanner              │
     │                                               ├── LAN: printers (port 9100)      │
     │                                               └── local DNS for *.central.otoplay.co │
     │  Gate box (Pi 5) ── relay ──▶ gate controller; ── serial ──▶ passage events       │
     │  Booth box (Pi 5, elsewhere in the mall) ── HDMI TV, USB button, LAN printer      │
     └───────────────────────────────────────────────────────────────────────────────────┘
```

**Decided principles**
- The cloud is the **system of record**. A box is the **system of action**. Nothing at a counter waits on the internet to sell, print, take a card payment or release a child.
- Boxes initiate every connection. Nothing inbound reaches the park network.
- Boxes do not talk to each other. Coordination goes through the cloud; offline safety comes from self-verifying tokens (Section 8), not peer lookups.
- The iPad is a screen. Nothing is ever plugged into it.

## 4. Station boxes

**Decided.** Raspberry Pi 5, 4 GB, NVMe boot, active cooler, official PSU, read-only root filesystem with a writable data partition, hardware watchdog, systemd-managed Node agent. One identical image for every box; role and config come from the cloud after the box registers with its device key. A pre-imaged spare per park.

Per park today: counter 1, counter 2, gate, plus a spare. Kiosk gets its own box if built. The booth game uses the same image with a different role (Section 11).

**What the agent on a box does**
- Registers with the cloud, sends a heartbeat every 60 s (online, printer reachable, paper status, USB devices present, last sync).
- Holds a SQLite cache: catalog, prices, members and children, staff accounts and roles, today's bookings, valid bands, station config.
- Holds an outbound queue: transactions, payments, bands issued, passage events, child check-ins and releases, vouchers. Retried until acknowledged. Every item idempotent by ID.
- Serves HTTPS on the LAN with a real certificate (Section 6).
- Drives devices through adapters (Section 7).
- Verifies staff session tokens offline with a public key. Enforces one active till per station; allows one customer display; allows read-only observers.
- Serves the station's current sale to both the till iPad and the customer display so the prototype's split screen becomes two devices.

**Station model.** A station (FD1, Counter 2, Gate 1, Kiosk 1, Booth 3) belongs to exactly one box. A box can host more than one station. Device assignments (receipt printer, kids bracelet printer, adult bracelet printer, scanner, card terminal) live on the station in the cloud and are pushed to the box. Devices offered in the station setup wizard are the ones that box has reported. The wizard gains one step after "what does this station do": **choose the box**. Test print runs iPad → box → printer, or admin console → cloud → box → printer when done remotely.

## 5. iPad POS

**Decided**
- Browser POS, React + Vite from the prototype, served from the cloud over HTTPS, installed as a **PWA with a service worker** so the app shell loads with no internet.
- Staff sign in, then pick a station from a list. The choice is stored on the iPad. "Set up station" in the header changes it. Only admins see the setup wizard; staff only pick.
- iOS asks once for local-network permission; document it in the setup checklist.
- The till talks to its box over the LAN. When the iPad is outside the park (admin at home), the same screens go via the cloud instead. The app must not care which.
- Lock after inactivity; unlock with password. Offline unlock verifies the existing token.
- **Open:** whether a fresh sign-in is allowed with no internet. Default: allow for staff seen on that box in the last 30 days, with an "offline" banner.

## 6. Network

**Decided**
- Park-owned router and private Wi-Fi (confirmed). Internet is dual-SIM cellular with automatic failover. No power backup yet; a small UPS for router, switch and boxes is on the client's list. The gate opens on power loss by design and needs none.
- Boxes and printers get fixed addresses via DHCP reservation on the router. iPads do not.
- Public DNS zone `central.otoplay.co` (and one per branch) with A records pointing at private LAN addresses. Boxes obtain Let's Encrypt certificates via DNS-01 with Caddy and the DNS provider module; renewal is automatic. Certificates are valid 90 days, so an internet outage never invalidates them.
- **Local DNS**: dnsmasq on two boxes (counter 1 and gate) answering for the park's names, forwarding everything else upstream. The router hands out both as DNS servers. This is what lets an iPad find a box with no internet.
- **Open:** router make and model, admin access, and whether the SIM plans are capped.

## 7. Devices and adapters

Every device type is behind an interface in the box agent with a simulator implementation and a real one. Callers never know which is active.

### 7.1 Payment terminals (EDC)
**Decided.** Four terminals, two per branch, SCB acquirer:

| Unit | Model | Integration | Serial | Provisioned for |
|---|---|---|---|---|
| EDC #1, #2 | NEXGO N5 | GHL "LinkPOS", XML over USB serial, 9600 (parity: doc implies none, sample code odd — test) | TID 65703235, 65703236 | Cards |
| EDC #3, #4 | PAX A920Pro | Digio "Direct Terminal", BER-TLV over USB serial, 9600 8N1, XOR checksum | SN 1854355548, 1854355549 | QR / wallets |

- The terminal is a USB serial device on the box. The box sends a sale (amount, reference, payment type), the terminal handles the customer and authorises with SCB over its **own 4G**, and returns approval code, transaction ID, masked card, TID, MID. No internet on the park side is involved.
- `PaymentTerminal` interface: `sale`, `void`, `inquire`, `settle`. Adapters: `GhlLinkPos`, `DigioDirect`, `Simulator`.
- Station config maps payment method → device: card → NEXGO, QR/wallet → PAX. Route by method so a later provisioning change is config, not code.
- Digio reference is 6 digits: per-terminal rolling counter, mapped to the transaction ID, uniqueness scope to confirm. GHL `pos_ref_no` is 20 chars in Sale, 12 in Query; use 12.
- Digio supports inquiry for all types, void, refund, settlement from POS, and returning the QR payload (`A18`). GHL cannot inquire card sales and cannot void Thai QR; void windows: card before settlement, wallets before 23:00.
- **Any sale with no final response triggers an inquiry before the till may continue.** On GHL card sales, where inquiry is unavailable, prompt staff to confirm against the terminal's own screen and record the outcome, audited.
- Log every raw byte in both directions before parsing.
- Amounts: GHL decimal string "100.25"; Digio integer satang "10025". Internal money is integer satang.
- **Open:** LinkPOS enablement on the production TIDs (bank provisions it), whether PAX can be enabled for cards, whether GHL supports LAN/TCP transport on the N5, sandbox unit availability. Validation plan: borrow the branch PAX for an afternoon and run ฿1 transactions with voids.
- The terminal being tethered by USB means it no longer roams. One card station and one QR station per branch unless more terminals are bought. Any untethered terminal keeps working standalone; staff record those payments manually.

### 7.2 QR and e-wallets on the customer display
**Decided.** In-person Thai QR is generated through **2C2P Direct API** (2C2P is the PSP; SCB is the acquirer behind it), not through a bank API. Flow: Payment Token (channel `THQR`) → Do Payment → response `type: "URL"` with a QR image URL and `respCode 1005` pending → render on the customer display → backend notification to our webhook **and** Transaction Status polling as the safety net → mark paid. Payment Inquiry for anything unresolved. Refund/void via Payment Maintenance (JWE/JWS, separate key setup).
- Requests are JWT-signed with HMAC SHA-256 using the merchant Secret Key. Sandbox: demo Merchant ID + Secret Key, base `https://sandbox-pgw.2c2p.com`. Production: credentials from 2C2P, `https://pgw.2c2p.com`, THQR enabled on the merchant, backend return URL registered in the portal.
- The QR is an image URL hosted by 2C2P, so it needs internet. **Fallback when offline: the PAX terminal's own QR** (`A3`), which runs on 4G. The till must switch automatically.
- Online booking uses 2C2P's **Redirect API** (hosted page). Cards in person go through the EDC, never through the customer display.
- **Open:** 2C2P fee schedule for THQR, how a paid QR is simulated in sandbox, whether the park already has a 2C2P merchant account from the booking site.

### 7.3 Printers
**Decided.** ESC/POS receipt printers (Xprinter, Welltech G4) and TSPL wristband printers (4B-2082A). Prefer the Ethernet variants: fixed IP, port 9100, driven by any box. USB variants attach to a box. The kitchen printer is Ethernet. Cash drawer hangs off the receipt printer's RJ11 and is fired by the printer. Box pings every assigned printer on a schedule and reports reachability and paper status in its heartbeat; the station screen shows a red indicator before staff notice a missing receipt.

### 7.4 Scanners
**Decided.** Fixed-mount 2D scanners (Zebra DS22 series) on USB to the box, set to serial mode so the agent controls them, one per height where guests are scanned. Bluetooth HID scanners paired to the iPad remain supported (they type into the browser), as does the iPad camera. The station wizard's scanner step offers three options: this device's camera, a scanner paired to this iPad, a scanner attached to the box.

### 7.5 Gate
**Decided.** Chinese swing/flap gate, controller **HX-X1** (manual, firmware V1.55+); protocol document supplied as **GE-X2** (2021). Supplier says commands match; verify on the bench.
- The box makes the access decision. The gate is an actuator: it receives a **dry contact pulse** (~1 s) on `L-OP` / `R-OP` / `COM` from a relay HAT on the gate box, and reports **passage events** back over serial (`61` left passed, `62` right passed, timeouts, wrong-direction `83`/`84`, tailgating `93`/`94`). `L-34` upload mode default 1 pushes events unprompted. Machine ID `L-30`, baud `L-31`.
- Fail-safe: opens on power loss. Fire alarm input `XF` holds open. Infrared anti-pinch `L-10` on; physical anti-pinch `D-17`/`D-18`. Tailgating detection `L-21` is **off by default: turn it on**. Remote control `L-27` is **on by default: turn it off** and pair nothing.
- Both directions host-controlled (`L-2` mode 0); no free exit at a children's park.
- A keyed switch across `L-OP`/`COM` is the manual override when the box is down.
- Occupancy is counted from passage events, not from open commands. Anti-passback lives in the box: one band, one entry until an exit.
- **Open:** whether the host port is RS232 or RS485 (buy the matching USB adapter), whether a TTL-to-Ethernet module is factory-fitted and which; the physical datasheet is the client's concern, not ours.

### 7.6 Kiosk
Self-service admission: scan a booking QR, receive bands and wallet credit, hand off to staff when supervision is required. Needs its own box, screen, scanner and wristband printer. Same redemption service as the staff flow; one implementation, two surfaces. Kiosk mode and device sessions are shared with the booth (Section 11).

## 8. Offline model

**Decided**
- **Sales, printing, card payments, member lookup, member creation, child check-in and release** all work with no internet. They run on the box's cache and queue.
- **Band codes are minted on the box**: a station-prefixed ULID plus an HMAC signature under a key every box holds. The gate verifies the signature locally. No lookup needed for a band sold at another counter while offline.
- **Booking QRs are signed** the same way, so a booking made online minutes before an outage can still be admitted; the box checks the signature and its local redemption log.
- **Receipt and tax-invoice numbers carry a per-station prefix** so two offline tills never collide. The prefix scheme is to be confirmed with the park's accountant against Thai abbreviated tax invoice rules before go-live.
- **Staff sessions are signed tokens** with a shift-length expiry, verified by the box with a public key. Cloud-issued when online.
- **Not made safe offline, by design:** wallet spend and single-use redemption across two stations that cannot see each other. Wallet spend offline is capped at a configurable small amount; the rest is online-only with a clear message.
- **Child release offline** is mandatory: authorised pickup list cached on the box, release recorded locally with staff, time, collector and evidence, synced later. A child is never refused release because the internet is down.
- Sync is idempotent and conflict-tolerant: same phone created at two counters merges; duplicate events are dropped by ID.

## 9. Hosting

**Decided.** Render, Singapore region, API and web services beside a managed PostgreSQL at the 1 CPU / 2 GB tier to start, moving to 1 CPU / 4 GB when analytics dashboards are in daily use. Point-in-time recovery on. No high availability for now. One connection pool in the API with a modest maximum; workers and analytics do not open their own. Audit log partitioned by month or archived after twelve months. Nightly rollups for reporting before any read replica.

## 10. Business rules gathered since the plan

- **Pricing tier is a property of the member**, set once at the door with evidence, applied automatically everywhere (till, kiosk, booking site). Checkout has no tier selector. Upgrade and downgrade are a single "change member tier" action: new tier, evidence type from a client-defined list, optional evidence expiry, note, verified-by/when/where captured automatically, audited. Downgrade may require a manager role. On evidence expiry, flag for re-verification rather than silently downgrading. **Do not store photos of identity documents.** **Open:** accepted evidence per tier; whether the tier extends to the member's party.
- **Cash management** exists: cash drawer, opening float, count at close with variance against the closing staff member, paid-outs, safe drops, change fund top-ups. Not in the original plan; add it.
- **Payment settlement export** per terminal and per day, reconciled against SCB's settlement report and 2C2P's, keyed by TID and by 2C2P invoice number.
- **One spin per band or per member** governs the booth game (Section 11). No facial recognition anywhere in the product: biometric data is sensitive under Thai PDPA and unnecessary.
- **LINE** is in scope for messaging alongside WhatsApp and Instagram.

## 11. Lucky-wheel voucher booth

A promotional spin-the-wheel game at mall booths, originally a closed vendor web page on an Android TV stick. **Decided:** rebuilt as an OTO app on the same platform.

**Hardware per booth:** Raspberry Pi 5 4 GB (same image as station boxes, booth role), HDMI to a TV, USB red dome button (HID keyboard: one keypress = spin), Ethernet or Wi-Fi, ESC/POS 80 mm receipt printer on the LAN (port 9100) for vouchers. Chromium in kiosk mode boots straight into the booth app.

**Software**
- Booth is a station type managed from the POS admin like any other: create the booth, pick a game layout from a set of ready designs, configure prizes and probabilities, optionally choose an idle screensaver video, assign staff, activate.
- At the booth the box loads the booth's config bundle from the cloud and caches it. Staff sign in by QR badge or PIN. The game runs; every spin and every voucher carries the booth ID and the staff ID.
- Vouchers are printed with a signed code and queued locally when offline, synced later. Redemption at a counter scans the code, verifies the signature, checks single use.
- One spin per wristband or per member phone number, checked against the box's local log and the cloud when online. Which unit of limitation applies is per-booth config.
- Heartbeat every 60 s: online, printer reachable, paper, last spin, staff signed in. Alerts on offline, printer fault, paper out, and "vouchers printing with nobody signed in", delivered to a channel the client chooses (LINE OA, Telegram or email are cheap; WhatsApp needs the Business API).
- Per-booth reporting: spins, prize distribution, vouchers issued and redeemed, uptime.
- **Open:** whether the idle video is wanted; alert channel; prize list and probabilities for launch.

## 12. Data migration

**Decided.** Production RDS access is available. Sprint 2 profiles the live data (row counts, live vs dead tables, duplicate customers, Thai text encoding) and builds a repeatable migration into the Sprint 1 schema, run from a local restore, never against production. Reconciled by counts and totals until two runs match. The old system stays live on the client's AWS until cutover.

## 13. Explicitly not built

Face authentication or any biometric feature. Cloud-in-the-loop for any device action. Peer-to-peer box communication. Direct bank QR APIs (2C2P covers it). Anything that ties a device to a specific iPad.

## 14. Sprint 2 execution shape

Order the work so that every screen in the prototype becomes real against simulators, in this dependency order, continuously, with checkpoints as in `CLAUDE.md`:

1. **Box agent core**: registration, heartbeat, cache, queue, sync, offline token verification, station model, device interface with simulators. Pi image with Caddy, dnsmasq, watchdog.
2. **Money path**: scanning service, pricing and checkout, payments (terminal adapters + 2C2P + offline queue + cash), printing (receipts, wristbands, kitchen), sales records. Simulators for every device.
3. **Arrival**: signed band codes, gate logic and occupancy, booking and redemption, child supervision and release with offline path, kiosk surface.
4. **In-park revenue**: wallets with offline cap, F&B, staff benefits, reporting and settlement export, tier verification screen.
5. **Booth game**: booth station type, game app, admin for layouts and prizes, voucher issue and redemption.
6. **Messaging**: inbox, routing, record linking, LINE/WhatsApp/Instagram adapters behind one interface with a simulator.
7. **Migration** tooling and trial runs.
8. **Cutover prep**: floor runbook, parallel-run reconciliation queries, rollback notes.

Hardware and third-party bring-up is the stabilisation phase, not Sprint 2. Every item above must be demonstrable on staging with the simulators before that phase starts.
