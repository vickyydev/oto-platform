# Device inventory and protocols — what the adapters and simulators must match

_Written 2026-09-20 from the park's hardware reference ("OTO Park — Hardware
Developer Reference v1.0", Floresta branch, 28 May 2026, kept locally as
`imports/_vendor-docs/OTO-Hardware-Developer-Reference-v1.0-2026-05-28.html`),
the four gate documents shared the same day, the two terminal specifications
already on file, and the web research recorded in section 9. Confidential:
contains the park's LAN layout and terminal identifiers._

The rule this document serves: every device adapter in `packages/contracts`
is written against the real protocol, and every simulator answers with the
real messages, so that on site only the physical link changes. Values that
still need a bench check are marked **confirm on site**.

## 1. Network

| Item | Value | Source |
|---|---|---|
| LAN | `192.168.88.0/24`, the mall's managed network today; printer addresses are DHCP reservations by MAC (stable across restarts) | hardware reference §01 |
| Park router | The brief expects a park-owned router with private Wi-Fi and dual-SIM failover (PROJECT_CONTEXT §5); the hardware reference says the mall network is the approved setup for now and a park router is the recommended long-term move | both |
| Counter box | The hardware reference plans an Intel mini PC as print server at a static `192.168.88.100`, port 3001; our design is a Raspberry Pi 5 per counter with the same role (PROJECT_CONTEXT §2). Both are Linux boxes; the box agent must run on either | both |
| Printer transport | Raw TCP port 9100 to every printer; never through the internet | hardware reference §07 |

## 2. Devices on the LAN

| # | Device | Model | Protocol | Link | Address / id | Role |
|---|---|---|---|---|---|---|
| 1 | Barcode scanner | Zebra DS22 series (cordless unit with a cradle — see §9.2) | Bluetooth to cradle; cradle to host as USB HID keyboard, string + Enter (`\r`) | USB | — | Wristband check at the gate, voucher QR at the till; later staff badges |
| 2 | Wristband printer #1 | 4B-2082A direct-thermal label printer | TCP 9100, label language per §9.1 | LAN + USB, 24 V 2.5 A | `192.168.88.204` | Kids' bands, reception |
| 3 | Wristband printer #2 | 4B-2082A | as above | LAN + USB | `192.168.88.210` | Adult bands / kiosk |
| 4 | Receipt printer #1 | Welltech G4, 80 mm, 260 mm/s, drawer port 24 V 1 A RJ11 | ESC/POS over TCP 9100 | LAN + USB + Wi-Fi | `192.168.88.202` | Main counter |
| 5 | Receipt printer #2 | Xprinter XP-80 series (exact model **confirm on site**, D6) | ESC/POS over TCP 9100 | LAN | `192.168.88.206` | F&B / kitchen |
| 6 | Receipt printer #3 | Xprinter XP-80 series | ESC/POS over TCP 9100 | LAN | `192.168.88.207` | Secondary counter |
| 7 | Receipt printer #4 | Xprinter XP-80 series | ESC/POS over TCP 9100 | LAN | `192.168.88.208` | Bar / F&B |
| 8 | EDC #1 | NEXGO N5, Android smart POS, SCB acquirer, app "SCB — OTO #1" | GHL LinkPOS XML over USB serial (spec on file) | 4G + Wi-Fi + BT; LAN via dock | TID `65703235`, MID `4648434010` | Cards (chip, tap, swipe, UnionPay), PromptPay via the SCB app |
| 9 | EDC #2 | NEXGO N5 | as above | as above | TID `65703236`, MID `4648434010` | as above |
| 10 | EDC #3 | PAX A920Pro, deployed by Digio (Thailand), app "OTO — Sale / Void / Settlement" | Digio Direct Terminal BER-TLV over serial (spec on file) | 4G + Wi-Fi + BT 5.0; LAN via back-plate port or dock | SN `1854355548` | Mobile payments: QR, wallets, cards |
| 11 | EDC #4 | PAX A920Pro | as above | as above | SN `1854355549` | as above |

Support lines named in the reference: Digio 02-026-3485, SCB merchant 02-777-7444.

Today the EDC terminals are **standalone**: staff take the card payment on the
terminal and then record it by hand in Pisell. The hardware reference lists
integrating them as its open decision D3 and recommends ECR semi-integration;
the two specifications on file (`imports/_vendor-docs/GHL-…pdf` for the NEXGO,
`Digio-TLV-LinkPOS-Spec.html` for the PAX) are exactly that integration.

## 3. Flows the reference describes (hardware touch points)

- **Walk-in:** guest → till creates the order → EDC if card → receipt on the
  Welltech → wristband(s) on a 4B-2082A → Zebra scan at the gate.
- **F&B:** order at the till → kitchen ticket on Xprinter `.206` → receipt on
  the counter printer.
- **Self-print kiosk (planned):** guest shows the booking QR → Zebra scans →
  the box looks the booking up → kids' bands on `.204`, adult bands on `.210`
  → receipt on the nearest Xprinter.

## 4. The reference's open decisions and how the platform resolves them

| # | Reference decision | Our resolution |
|---|---|---|
| D1 | 4B-2082A command language (ZPL, EPL2 or custom) | Research in §9.1: code the language the manufacturer documents as native first, keep the emulation as a switch; the printer simulator accepts both. **Confirm on site** with a test label. |
| D2 | iPad POS as PWA or Capacitor because the cradle is USB HID into the iPad | Avoided by architecture: **the scanner plugs into the box, not the iPad**. The box reads the HID (or USB-CDC serial) device and publishes scan events on the station channel; the till, display, gate and kiosk receive scans the same way, online or offline. HID-into-iPad stays as a fallback path only. |
| D3 | EDC integration level (standalone vs ECR) | ECR semi-integration on the box: NEXGO via GHL LinkPOS XML, PAX via Digio Direct Terminal, both over USB serial to the box, both with a simulator that speaks the same messages. Manual recording remains first-class for any terminal that is not tethered. |
| D4 | Wristband barcode format (Code 128 / Code 39 / QR) and payload | Band code = station-prefixed ULID + HMAC (PROJECT_CONTEXT §8). Printed as a **QR** (primary, fits the signed payload) plus a short human-readable code line; the Zebra reads both. The gate reader is a QR reader (the gate board itself cannot read codes — §6). |
| D5 | Offline sync engine (PowerSync vs ElectricSQL) | Neither. Box facts with per-box sequence numbers, a durable outbox, journal epochs and a station session document (SPRINT_2_PLAN "Design decisions"); no third-party sync engine. |
| D6 | Xprinter exact model | **Confirm on site** from the bottom label. ESC/POS behaviour is the same across the XP-80 family; the adapter is model-agnostic. |

## 5. Payment terminals — ECR facts already on file

- **NEXGO N5 / GHL LinkPOS** (`GHL-API-Integration-POS-to-SmartEDC-V1.4`):
  XML over USB serial, 9600 baud (sample code: 8 data bits, odd parity, 1 stop
  — **confirm on site**); messages `SALE`, `QUERY`, `VOID`; trade types CARD,
  ALIPAY, ALIPAY+, WECHATPAY, TRUEMONEY, DOLFIN, QRCS, THAIQRCODE;
  `service_type` SCAN or SHOWQR; `pos_ref_no` 12 characters; card responses use
  ISO codes, wallets 00/01; no QUERY for CARD; Thai QR cannot be voided; card
  void before settlement, wallet void before 23:00; amounts as decimals.
- **PAX A920Pro / Digio Direct Terminal** (spec v2.21): COM 9600 8N1; frame =
  `3E55` + BER length + BER-TLV + 1-byte XOR checksum; tags 21 action, 22
  response code, 04 reference, 05 version, 06 serial; action codes T0/T1
  terminal info, login/logout, sales A1 credit, A2 gift, A3 QR PromptPay, A4
  Alipay, A5 WeChat, A6 QR credit, A7 IPP, A8 ShopeePay, wallets A27/A35/A37,
  voids A11/A13…, A58 pre-auth cancel; supports inquiry, void, refund,
  settlement from the POS and returns the QR payload (A18); amounts in satang.

Routing is configuration on the station: card → NEXGO, QR/wallet → PAX, and
the SCB QR API (section 7 of the plan) when the box is online.

## 6. Entrance gate — GE-X2 gate with the HX-X1 control driver

Four documents were shared on 2026-09-20 (originals to be dropped into
`imports/_vendor-docs/`): the GE-X2 communication protocol (2021-12-01), the
HX-X1 control driver manual (BB-TC-01-V1.08, firmware V1.55+), the supplier's
answers to the client's questions, and a "Gate Interface Specification"
(闸机接口协议) for the network reader. Together they fix the architecture:

```
QR on wristband ──▶ network QR reader ──HTTP POST──▶ gate box (our endpoint)
                                                        │ decides open / deny
                    reader relay closes ◀── code "1" ───┘
                    dry contact ~1 s on HX-X1 L-OP / R-OP (COM)
                    HX-X1 ──RS485/RS232 19200 N81──▶ gate box: passage feedback
```

### 6.1 The reader's HTTP contract (we host it on the gate box)

The gate/reader pushes to **our** server; we host both endpoints. All values
are strings.

| Endpoint | Body | Reply |
|---|---|---|
| `POST /interaction/Api/checkCard` | `card` = base64 of the raw card id / QR text (e.g. `MDFBRDIxMzY=` → `01AD2136`), `type` `"0"` card / `"1"` QR, `serial` gate serial (e.g. `13165468`), `reader` `"0"` entry / `"1"` exit | `{"code":"1","message":"…"}` opens, `"0"` refuses; `message` is shown on the reader |
| `POST /interaction/Api/heartbeat` | `serial`, `reader` | `{"code":"1","message":"Operation successful"}` |

The heartbeat interval is fixed by the reader (**confirm on site**). The
`message` text is the only feedback the guest sees at the reader, so the box
answers with short bilingual strings ("Welcome" / "Band not valid" / "Adults
only at this gate" …).

### 6.2 HX-X1 controller — wiring and settings that matter to us

- Terminals on the main board (block 10): `BY` access-control open signal,
  `XF` fire alarm, `L-OP` open left, `COM` common, `R-OP` open right — dry
  contact, ~1 s pulse (supplier answer 1). The slave board has `L-OP`/`COM`/
  `R-OP` too.
- Serial: RS232/RS485, **19200 baud N81** (protocol header; HX-X1 `L-31`
  default 1 = 19200). Machine id `L-30` (1–255, default 1). Upload mode
  `L-34`: 0 = reply only when polled, **1 = push on state change (default)**,
  2–999 = push on change and repeat every n. `L-54` 0 = main and slave reply
  combined. Networking: a TTL-to-Ethernet module can be fitted (supplier
  answer 3; model not named — **confirm on site**, we assume a USB-RS485
  adapter on the box as the primary path).
- Behaviour we rely on: fire-alarm input opens and holds open without cutting
  power; power loss opens the gate (feature 12); anti-reversal, tailgating and
  loitering alarms; opening duration `L-1` (default 5–6 s); working mode `L-2`
  (0 = card both sides, 1 = IR left/card right, 2 = IR right/card left, 3 = IR
  both); close-on-reverse `L-17`; close-on-tailgating `L-22`; tailgating
  detection `L-21`.
- Fault codes on the display: E1/E2 Hall, E3/E4 overcurrent, E5/E6 timeout,
  E7 over-voltage, E8 under-voltage, E9 obstruction rebound, EA motor braking
  (IR blocked), EE encryption, E11–E16 infrared pair faults, E30 communication.
- Voice prompts 0–45 (e.g. 5 "Please pass", 7 "No entry", 28 "Please pass one
  at a time", 30 "Welcome, little friend", 38 "Welcome to the park", 40 "No
  tailgating", 41 "Do not linger", 42 "Do not go against the direction").

### 6.3 GE-X2 serial protocol (what the adapter speaks and the simulator emits)

Commands are `7E`-framed; the CRC in a **sent** command may be replaced by the
fixed bytes `95 FC`. Machine 1 examples:

| Purpose | Send | Reply |
|---|---|---|
| Broadcast read machine number | `7E 80 00 00 00 00 01 AA 00 01 A3 7A 7E` | `7E 80 00 01 00 00 01 00 00 01 00 01 00 38 7E` (byte 4 = machine no.) |
| Open left (single pass) | `7E 80 00 01 00 00 80 AA 00 01 01 00 DE 62 7E` | `7E 80 00 01 00 00 80 00 00 01 CA CA 7E` |
| Open left, stay open | `… 80 AA 00 01 01 01 CE 43 7E` | same ack |
| Close left | `7E 80 00 01 00 00 81 AA 00 01 01 8A AB 7E` | `7E 80 00 01 00 00 81 00 00 01 BC 7E 7E` |
| Open right / stay open / close right | `… 80 AA 00 01 02 00 8B 31 7E` / `… 02 01 9B 10 7E` / `… 81 AA 00 01 02 C8 7E 7E` | as above |
| Enable/disable infrared opening | `… 80 AA 00 01 0x 03|04 95 FC 7E` (not saved across power loss; use `L-2` to persist) | ack |

Passage feedback, pushed by the board (byte 7 identifies the event; ignore a
doubled leading `7E`; CRC need not be verified):

| Byte 7 | Meaning |
|---|---|
| `61` / `62` | Left / right passage — passed |
| `63` / `64` | Left / right passage — timeout (nobody passed) |
| `73` / `74` | Timeout while a person is inside the lane |
| `83` / `84` | Wrong-direction (reverse entry) alarm after left / right opened |
| `93` / `94` | Tailgating alarm after left / right opened |
| `95` | Infrared beam blocked while in standby |

Status queries (Modbus-style, address 01): door state `01 03 00 12 00 01 24 0F`
→ `01 03 02 00 0n AA 55` with n = 0 closed, 1/2 open A/B, 3/4 opening, 5/6
closing, 7 initialising, 8 someone pushing, 9 zero search; infrared state
`01 03 00 21 00 01 D4 00` → n = 0 none … 4 wrong direction, 5 tailgating, 6 IR
timeout closing, 7 intrusion, 8 passed normally; motor enable/disable and
brake `01 06 00 04|05 00 0n …`. Settings use `55 01 nn X1 X2 X3 AA 55`
(L menu) and `55 02 nn …` (D menu); `55 01 FF 00 00 00 AA 55` reads the supply
voltage, `55 01 FE …` resets, `55 01 FD 00 00 01 AA 55` reads the six infrared
pairs as a bit mask.

### 6.4 What the gate simulator must reproduce

- Reader side: `checkCard` and `heartbeat` posts to the box (entry and exit
  readers, base64 payloads, string values), the reader's relay closing only on
  `code "1"`, and the displayed `message`.
- Controller side over the virtual serial link: the acknowledgements above; a
  passage event after every open (`61`/`62`), or `63`/`64` when the simulated
  person does not pass; `83`/`84` and `93`/`94` on scripted wrong-direction and
  tailgating; `95` when a beam is blocked at rest; status-query replies; the
  fire-alarm state (open and held open) and power-loss state (open); fault
  codes E1–E30 as scripted faults; machine numbers 1–n on one line.
- Box side: anti-passback per band, adults-only rule at the gate reader
  (kids leave only with an adult — POS_RULES_RECONCILIATION C8), the voided-band
  deny list synced down, occupancy counting from `61`/`62` only (never from the
  open command), and `gate.fire_alarm` / `gate.fault` alerts to the Console.

### 6.5 Still unknown (supplier did not answer)

Wiring diagram and terminal voltages; the exact gate model datasheet (swing or
flap, lane width, IP rating, steel grade, anti-pinch as standard); firmware
version number; which QR reader ships with the gate and whether it is the one
that speaks the HTTP contract above; the TTL-to-Ethernet module model. All are
**confirm on site**; none blocks the simulator.

## 7. Wristband and receipt design references

- **Booth voucher** (sample shared 2026-09-20; the printed template in
  S2-07a matches it): "Oto — Kids Play Park · Central Phuket"; "★ YOU WON ★";
  prize line ("150 THB VOUCHER"); redemption sentence ("Show this QR at OTO
  Reception and get 150 THB off your ticket order."); "Cannot be combined with
  other offers."; a large QR; the voucher code `LW-YYMMDD-NNNN` (e.g.
  `LW-260917-0042`); Date, Booth, Staff (name + staff code, e.g. "Nok
  (S-014)"); "Single use · ใช้ได้ 1 ครั้ง"; "Redeem at Oto Play Park, Central
  Phuket". 80 mm receipt stock.
- **Wristband:** QR (signed band code) + human-readable short code, guest
  first name, session/expiry, kids on `.204` stock, adults on `.210` stock;
  colours per stock roll (**confirm on site**).
- **Sale receipt:** the prototype's receipt component is the layout source;
  the owner will share a printed bill for the abbreviated tax-invoice header.

## 8. Adapter interfaces this maps onto

`packages/contracts`: `Printer` (ESC/POS receipt; label printer for bands),
`ScanInput` (HID/CDC on the box → station channel), `PaymentTerminal` (GHL,
Digio), `QrPayment` (SCB API, section 7 of the plan), `Gate` (reader HTTP
server + GE-X2 serial client), `CashDrawer` (kick through the receipt printer),
`Button` (booth), `Badge/PIN` (booth sign-in). Each ships with a simulator and
a control panel in the Console.

## 9. Web research on the device models (recorded 2026-09-20)

_Filled in from the research pass; each fact carries its source. Anything
uncertain is marked so — see the "confirm on site" items above._

### 9.1 4B-2082A wristband printers

(pending — see the research note; this section is completed in the same
commit series)

### 9.2 Zebra DS22 series scanner

(pending)

### 9.3 Welltech G4 receipt printer

(pending)

### 9.4 Xprinter XP-80 series

(pending)

### 9.5 NEXGO N5 and PAX A920Pro — physical ECR link

(pending)

### 9.6 Box host notes (Raspberry Pi 5 vs Intel mini PC)

(pending)
