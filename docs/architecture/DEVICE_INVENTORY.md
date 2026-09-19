# Device inventory and protocols — what the adapters and simulators must match

_Written 2026-09-20 from the park's hardware reference ("OTO Park — Hardware
Developer Reference v1.0", Floresta branch, 28 May 2026, kept locally as
`imports/_vendor-docs/OTO-Hardware-Developer-Reference-v1.0-2026-05-28.html`),
the four gate documents shared the same day, the two terminal specifications
already on file, and the web research recorded in section 9. Section 9 is
folded in from `docs/architecture/research/2026-09-20-device-research.md` and
supersedes the hardware reference where the two disagree; each such correction
is marked in place. Confidential: contains the park's LAN layout and terminal
identifiers._

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
| 1 | Barcode scanner | Zebra **DS2278** cordless with the **CR2278-PC** cradle — the DS22 series' cordless pair (corded sibling is the DS2208; **confirm on site** which is installed, §9.2) | Bluetooth Classic to the cradle; cradle to host as USB HID keyboard (VID `05E0` PID `1200`), data + Suffix 1 = `7013` "Enter" (parameter #235, programmable); switchable to USB CDC (PID `1701`) by scanning one bar code | USB | — | Wristband check at the gate, voucher QR at the till; later staff badges |
| 2 | Wristband printer #1 | 4B-2082A direct-thermal label printer (4BARCODE; TSC TTP-24x-class clone, 203 dpi / 8 ips / 2 in **[inferred]** — §9.1) | TCP 9100, **TSPL2** (the native language per §9.1; ZPL/EPL emulation kept as a switch) | LAN + USB, 24 V 2.5 A | `192.168.88.204` | Kids' bands, reception |
| 3 | Wristband printer #2 | 4B-2082A | as above | LAN + USB | `192.168.88.210` | Adult bands / kiosk |
| 4 | Receipt printer #1 | Welltech G4 — a rebadged **Xprinter XP-C260 family** unit ("upgraded from XP-C260N"), 80 mm, 260 mm/s, 576 dots/line, **partial cut only**, drawer port 24 V 1 A RJ11 (§9.3) | ESC/POS over TCP 9100 | LAN + USB + Wi-Fi | `192.168.88.202` | Main counter |
| 5 | Receipt printer #2 | Xprinter XP-80 series (exact model **confirm on site**, D6) | ESC/POS over TCP 9100 | LAN | `192.168.88.206` | F&B / kitchen |
| 6 | Receipt printer #3 | Xprinter XP-80 series | ESC/POS over TCP 9100 | LAN | `192.168.88.207` | Secondary counter |
| 7 | Receipt printer #4 | Xprinter XP-80 series | ESC/POS over TCP 9100 | LAN | `192.168.88.208` | Bar / F&B |
| 8 | EDC #1 | NEXGO N5, Android smart POS, SCB acquirer, app "SCB — OTO #1" | GHL LinkPOS XML over USB serial on the handset's **micro-USB OTG** port, its only wired port (spec on file; USB VID/PID unpublished — §9.5) | 4G + Wi-Fi + BT; the Wi-Fi dock is a **router**, so the handset sits behind its `192.168.1.x` NAT, not on `192.168.88.0/24` | TID `65703235`, MID `4648434010` | Cards (chip, tap, swipe, UnionPay), PromptPay via the SCB app |
| 9 | EDC #2 | NEXGO N5 | as above | as above | TID `65703236`, MID `4648434010` | as above |
| 10 | EDC #3 | PAX A920Pro, deployed by Digio (Thailand), app "OTO — Sale / Void / Settlement" | Digio Direct Terminal BER-TLV over USB serial — handset **Type-C OTG** enumerating as CDC-ACM (VID `2FB8`; spec on file — §9.5) | 4G + Wi-Fi + BT 5.0; Ethernet only through an **L920Pro-BE/-BM** base (the -BC charging base has no RJ45) | SN `1854355548` | Mobile payments: QR, wallets, cards |
| 11 | EDC #4 | PAX A920Pro | as above | as above | SN `1854355549` | as above |

**Corrected by research (§9).** Rows 1, 4 and 8–11 above were wrong or
incomplete in the hardware note. The scanner is the cordless DS2278 with a
CR2278-PC cradle, and the trailing Enter is a programmed suffix (parameter
#235, Suffix 1 = `7013`), not a fixed property of the cradle — it can be
changed or removed. The Welltech G4 is Xprinter XP-C260 hardware under
Welltech branding, which is why the Xprinter programmer manual governs it. The
NEXGO N5 has no Ethernet of its own: "LAN via docking station" is a Wi-Fi
router dock, so the ECR link is the handset's micro-USB OTG port. The PAX
A920Pro has no back-plate port; Ethernet comes only from a -BE/-BM base, and
its ECR link is Type-C OTG as CDC-ACM. The "confirm on site" markers on these
rows still stand.

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
| D1 | 4B-2082A command language (ZPL, EPL2 or custom) | Answered by §9.1: the family is a TSC TTP-24x-class clone whose manual names **TSPL2** as the native language; the 4-inch sibling lists TSPL/EPL/ZPL/DPL emulations and TSC firmware auto-detects the language per job (**[inferred]** for 4BARCODE). Code TSPL2 first behind a label-builder interface, keep ZPL as a switch; the printer simulator parses TSPL. **Confirm on site** with a test label and a back-to-back TSPL/ZPL job. |
| D2 | iPad POS as PWA or Capacitor because the cradle is USB HID into the iPad | Avoided by architecture: **the scanner plugs into the box, not the iPad**. The box reads the HID device (`05E0:1200`, read through evdev with an exclusive grab) or the USB-CDC serial device (`05E0:1701` on `/dev/ttyACM*`, selected by scanning one bar code — §9.2) and publishes scan events on the station channel; the till, display, gate and kiosk receive scans the same way, online or offline. HID-into-iPad stays as a fallback path only. |
| D3 | EDC integration level (standalone vs ECR) | ECR semi-integration on the box: NEXGO via GHL LinkPOS XML, PAX via Digio Direct Terminal, both over USB serial to the box, both with a simulator that speaks the same messages. Manual recording remains first-class for any terminal that is not tethered. |
| D4 | Wristband barcode format (Code 128 / Code 39 / QR) and payload | Band code = station-prefixed ULID + HMAC (PROJECT_CONTEXT §8). Printed as a **QR** (primary, fits the signed payload) plus a short human-readable code line; the Zebra reads both. The gate reader is a QR reader (the gate board itself cannot read codes — §6). |
| D5 | Offline sync engine (PowerSync vs ElectricSQL) | Neither. Box facts with per-box sequence numbers, a durable outbox, journal epochs and a station session document (SPRINT_2_PLAN "Design decisions"); no third-party sync engine. |
| D6 | Xprinter exact model | **Confirm on site** from the **self-test page** (hold FEED while powering on), which prints model, firmware, interface and IP — not from the Windows driver name, which reads "XP-80C" on most of the family (§9.4). Read 576 vs 512 dots/line per unit at the same time. ESC/POS behaviour is the same across the XP-80 family; the adapter is model-agnostic. |

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

_Filled in from the research pass
(`docs/architecture/research/2026-09-20-device-research.md`); each fact carries
its source. The research note's uncertainty markers are carried over verbatim:
**[inferred]** means derived from a sibling model or a family document, and
**[unconfirmed]** means not verified for the unit in the park. Neither is a
fact until the bench check; see the "confirm on site" lists._

### 9.1 4B-2082A wristband printers

- The maker is **4BARCODE Technology Co., Ltd.**; the family user manual is
  the only public document that covers this line. Source:
  https://bordellproducts.com/uploads/1/2/1/9/121929864/usermanual.pdf
- The exact model exists in Seagull's driver catalogue as "4BARCODE 4B-2082A"
  (driver v12.6, 2026-08-04) but carries no spec sheet there. Siblings in the
  same driver family: 4B-2052A, 4B-2054A, 4B-2064A, 4B-2083A–D, 4B-2084A,
  4B-3034A, 4B-3044A, 4B-3062/3063/3064. Sources:
  https://www.bartendersoftware.com/resources/printer-drivers/4barcode/4barcode-4b-2082a ,
  https://treexy.com/products/driver-fusion/database/printers/4barcode/
- The family is a **TSC TTP-24x-class clone**: the 4BARCODE manual is a
  lightly edited TSC manual (same Diagnostic Tool, AUTO.BAS, GAP/BLINE
  handling, LED sequences, "32-bit RISC CPU, 4 MB Flash, 8 MB SDRAM"). That is
  why the TSC TSPL/TSPL2 manual is the working reference for the commands
  below. Sources: family manual pp.15–36;
  https://www.arkscan.com/product/shipping-label-printer/shipping-label-printer/2054a-thermal-shipping-label-printer
- **Command language: TSPL2 is native** — answers open decision D1. The family
  manual names it twice ("TSPL2 programming language allows user to download
  an auto execution file (AUTO.BAS)…"; "select gap or black mark sensor by GAP
  or BLINE command… refer to TSPL2 programming manual"). The 4-inch sibling's
  datasheet lists emulations "TSPL, EPL, ZPL & DPL" and Arkscan (the same
  hardware rebadged) documents raw ZPL printing on Linux. TSC's own TSPL-EZ
  firmware auto-detects TSPL2 / EPL2 / ZPL2 per job with no switch command;
  **[inferred]** that 4BARCODE firmware behaves the same, as none is
  documented. Sources: family manual §4.4, §7.2;
  https://www.arkscan.com/technical-support/download ;
  https://www.facebook.com/TSCAutoIDTechnology/posts/tscs-tspl-ez-is-powerful-printer-firmware-that-can-recognize-tspl2-epl2-and-zpl2/388360237842526/
- **Recommendation: code TSPL2 first.** It is the native language, the status
  and query commands below exist only in TSPL, and the ZPL/EPL translators on
  clones are lossy. Keep the label builder behind an interface so a ZPL
  variant can be added if the bench test shows TSPL quirks.
- Geometry is **[inferred]** from the model-number scheme
  `4B-{2 = 203 dpi | 3 = 300 dpi}{ips}{width in inches}{variant}`, anchored on
  the confirmed 4B-2054A (203 dpi, 5 ips, 4 inch): the 4B-2082A is then
  **203 dpi, 8 ips, 2 inch (roughly 20–58 mm media), direct thermal**. That
  agrees with the park's "~50 mm media, 203 dpi" note, but it is published
  nowhere reachable — read it off the self-test page. Sources:
  https://www.arkscan.com/driver ; Arkscan 2054A spec page above.
- Media on the 4-inch sibling: width 20–112 mm, thickness 0.06–0.16 mm, length
  10–2286 mm, roll OD 127 mm, gap or black-mark sensing, roll/die-cut/fan-fold.
  Wristband stock is just die-cut or black-mark media of the right width —
  nothing wristband-specific is documented anywhere in the family. Source:
  Arkscan 2054A spec page; family manual §3.2.
- Board interfaces: USB, RS-232 DB-9 (9600 8N1 default), Ethernet (internal
  print-server option), SD card; external 24 V PSU, which matches the park's
  24 V 2.5 A note. Source: family manual §2.3.2, §4.2.
- Factory defaults: speed 5 ips, density 8, label 4 in x 7.08 in, gap 4.0 mm,
  direction 0, **code page 850**, country 001, tear mode on, cutter and peeler
  off, **IP address by DHCP**. A static address is set with the Windows
  Diagnostic Tool (Printer Configuration → Ethernet Setup; works over USB,
  RS-232 or Ethernet via Discover Device / Change IP Address / Set Printer
  Name) or from the printer's own web page ("Web setup button… with the IE or
  Firefox web browser"); the printer resets after the change. Source: family
  manual §3.6–3.7, §4.2.
- Raw port 9100 is the TSC-class default, and TSPL states that the status and
  immediate commands "support RS-232, USB and Ethernet" — i.e. status polling
  shares the print socket. **[unconfirmed for 4BARCODE]** that 9100 is open out
  of the box; verify with `nc <ip> 9100` and `ESC ! ?`. Source: TSC TSPL/TSPL2
  manual, "Status Polling and Immediate Commands", p.78.
- Power-on utilities (one FEED button, three-colour LED): hold FEED while
  powering on; the LED runs blue → red (5 blinks) → purple (5 blinks) → blue
  (5 blinks) → solid blue. Release during **red** = gap/black-mark
  calibration; during **purple** = calibration plus **self-test printout** plus
  dump mode; during **blue blinks** = factory initialisation; at solid blue =
  skip AUTO.BAS. Power-cycle to leave dump mode. The self-test page carries
  the head check pattern, **model name and firmware version**, mileage,
  checksum, serial-port config, code page, country code, speed, darkness,
  label size, gap, sensor sensitivity, file count and memory. LED meanings:
  solid blue ready, blinking blue paused or downloading, purple clearing
  memory, solid red head open, blinking red error (head open, paper empty,
  paper jam, memory error). Source: family manual §4.1–4.4, §6, §7.1.
- Status: `ESC ! ?` (`1B 21 3F`) returns **one byte**, bit-OR'd — `00` normal,
  `01` head open, `02` paper jam, `04` out of paper, `08` out of ribbon,
  `10` pause, `20` printing, `80` other error — and is answered "at any time,
  even in the event of printer error". `ESC ! S` (firmware ≥ V6.29 EZ) returns
  `<STX>` + four ASCII status characters + `<ETX><CR><LF>` (`@@@@` normal,
  `E@@B` paper jam, `E@@b` jam plus head open); **[unconfirmed]** on 4BARCODE
  firmware, so `ESC!?` is the baseline. Queries: `~!T` model name, `~!I` code
  page and country (e.g. `437, 001`), `~!@` mileage, `~!A` free memory, `~!F`
  file list. Control: `ESC!R` reset (deletes downloaded files), `ESC!F` feed
  one label, `ESC!.` cancel all printing, `ESC!P`/`ESC!O` pause and un-pause,
  `ESC!C` restart skipping AUTO.BAS, `~!D` dump mode. Source: TSC TSPL/TSPL2
  manual (2014).
- Per-label acknowledgement: `SET RESPONSE ON` (≥ V7.09) makes the printer
  emit `{SS,NNNNN[,ID]}` after each label, where SS is the same hex status as
  `ESC!?` and NNNNN a 00001–99999 counter; `SET RESPONSE "job1",BATCH` gives
  one reply per job. **[unconfirmed]** on this firmware — fall back to polling
  `ESC!?` after `PRINT`. Source: TSC TSPL/TSPL2 manual.
- Label commands the builder needs: `SIZE w mm,h mm`, `GAP g mm,o mm` (or
  `BLINE` for black mark), `DIRECTION 0|1`, `REFERENCE x,y`, `DENSITY 0-15`,
  `SPEED n`, `CLS`, `PRINT copies[,dup]`;
  `BARCODE x,y,"128",height,readable,rotation,narrow,wide,"content"` ("128"
  auto-switches subsets); `QRCODE x,y,ECC,cellwidth,A|M,rotation[,M2,S0-S8],
  "content"` (use model `M2` for phone cameras);
  `TEXT x,y,"font",rotation,xmul,ymul,"content"` with bitmap fonts "1"–"5" and
  scalable "0" (escape a `"` inside a string as `\["]`);
  `BITMAP x,y,widthBytes,height,mode,<raw 1-bpp rows>`. Source: TSC TSPL/TSPL2
  manual.
- **Thai:** the 2014 `CODEPAGE` table lists 437/850/852/1250–1258/932/936/949/
  950/UTF-8/ISO-8859-x but **no Thai page (874/TIS-620)**. Render Thai
  host-side (Noto Sans Thai → 1-bpp) and send it as `BITMAP`, or download a
  Thai TTF with the Diagnostic Tool and use `CODEPAGE UTF-8` with
  `TEXT …,"NotoThai.TTF"`. Mode-0 bitmaps are inverted relative to a PNG
  (0 = black) — verify on site. Source: TSC TSPL/TSPL2 manual.
- Linux: **bypass CUPS**. Arkscan ships a Linux driver/PPD for its rebadges,
  but community reports of driving these through the TSC TTP-244 PPD end in
  stopped jobs; write TSPL straight to TCP 9100, or to `/dev/usb/lp0` (usblp)
  when on USB. Sources: https://www.arkscan.com/linux-printer-driver ,
  https://www.arkscan.com/technical-support/download

Minimal wristband label in the recommended language (TSPL2, Code 128 plus QR).
203 dpi is 8 dots/mm, so a 50 mm band is 400 dots across. **The `SIZE` and
`GAP` values are placeholders** — measure the park's stock first (typical
thermal wristbands are 25 mm x 254 mm; if the bands are 25 mm wide, use
`SIZE 25 mm,254 mm` and halve the x coordinates).

```
SIZE 50 mm,250 mm
GAP 3 mm,0 mm
DIRECTION 1
REFERENCE 0,0
DENSITY 10
SPEED 4
SET TEAR ON
SET RESPONSE ON
CLS
TEXT 24,24,"3",0,1,1,"OTO PARK  HKT Central"
TEXT 24,60,"4",0,1,1,"CHILD  Nong Mai  (6)"
TEXT 24,100,"3",0,1,1,"Guardian 081-234-5678"
BARCODE 24,150,"128",90,1,0,2,2,"WB-20260920-000123"
QRCODE 24,280,M,6,A,0,M2,S7,"https://oto.example/w/WB-20260920-000123"
TEXT 24,560,"2",0,1,1,"Valid 20 Sep 2026 until 18:00"
PRINT 1,1
```

Send it as one TCP write to `<ip>:9100`, then read the socket for `{00,00001}`
(when `SET RESPONSE` works) or poll `ESC ! ?` until it returns `00`. TSPL
accepts `\r\n` or `\n`; use `\r\n`.

#### Adapter parameters — 4B-2082A

```yaml
transport: tcp            # raw socket; USB fallback = /dev/usb/lp0 (usblp), not CUPS
host: <static IP on 192.168.88.x>   # printer defaults to DHCP -> set static via DiagTool/web page
port: 9100                # [unconfirmed on 4BARCODE; TSC default]
language: TSPL2           # ZPL/EPL translation exists on the family but code TSPL first
line_ending: "\r\n"
encoding: ascii           # label text; Thai via BITMAP (host-rendered 1-bpp) or downloaded TTF + CODEPAGE UTF-8
dpi: 203                  # [inferred from model number; confirm on self-test page]
dots_per_mm: 8
media: { width_mm: 50, length_mm: 250, gap_mm: 3, sensing: gap }   # measure on site; may be 25 x 254
status_poll: "\x1b!?"     # 1 byte; 0x00 ready; bit flags 01 head-open 02 jam 04 paper-out 08 ribbon 10 pause 20 printing 80 other
status_ext:  "\x1b!S"     # optional, <STX>xxxx<ETX>\r\n; [unconfirmed on this firmware]
identify:    "~!T"        # model string; "~!I" codepage,country; "~!@" mileage; "~!A" free memory
per_label_ack: "SET RESPONSE ON"   # expect "{SS,NNNNN}" per label; fallback to polling [unconfirmed]
cancel_all:  "\x1b!."     # feed one label "\x1b!F"; reset "\x1b!R"; pause "\x1b!P" / resume "\x1b!O"
cut_kick: none            # no cutter, no drawer on the wristband printer; SET TEAR ON
timeouts: { connect_ms: 2000, write_ms: 5000, status_ms: 1000, job_complete_ms: 15000 }
concurrency: 1            # one TCP session at a time per printer
```

#### Simulator must reproduce — 4B-2082A

- Listen on TCP 9100 and accept **one** connection at a time (refuse or queue
  a second one).
- Parse a TSPL job: `SIZE`, `GAP`/`BLINE`, `DIRECTION`, `REFERENCE`,
  `DENSITY`, `SPEED`, `SET TEAR|RESPONSE`, `CLS`, `TEXT`, `BARCODE`, `QRCODE`,
  `BITMAP` (binary payload of `widthBytes * height` after the comma),
  `PRINT n[,m]`. Render a PNG per label so tests can compare, and count labels.
- Answer immediate commands mid-stream and while "in error": `ESC!?` → one
  status byte; `ESC!S` → `\x02@@@@\x03\r\n`; `~!T` → `4B-2082A\r`; `~!I` →
  `850, 001\r`; `~!@` and `~!A` → numbers plus `\r`; `~!F` → names ending
  `\x1a`.
- States settable by a test hook: paper-out (`0x04`), head-open (`0x01`),
  paper-jam (`0x02`), pause (`0x10`), printing (`0x20`) held for a
  configurable duration per label at the configured ips.
- With `SET RESPONSE ON`, emit `{00,00001}` and onward after each `PRINT`;
  with `BATCH`, one line per job.
- Ignore unknown commands silently, as the real firmware does, and keep a dump
  mode flag that echoes raw bytes after `~!D`.
- Power-on defaults: no IP until "configured", speed 5, density 8, code page
  850, and a fake self-test endpoint that reports model, firmware and IP.

#### Confirm on site — 4B-2082A

1. Model string, firmware version, dpi and maximum width from the self-test
   page (or `~!T` over TCP once the IP is known).
2. Whether TCP 9100 is open by default and whether the web page
   (`http://<ip>/`) exists on this Ethernet module.
3. Wristband media geometry — width, length, gap versus black mark, print side
   — and whether a cutter option is fitted.
4. Whether `ESC!S`, `SET RESPONSE` and the ZPL/EPL translators exist in this
   firmware (send a TSPL job and a ZPL job back to back).
5. The darkness and speed that give a scannable Code 128 at 8 ips on the
   park's band stock.
6. Whether the printer refuses or stalls a second TCP connection during a job.

### 9.2 Zebra DS22 series scanner

- The series is two models with the same imager and decoder: **DS2208**
  (corded — USB, RS-232 or keyboard-wedge cable) and **DS2278** (cordless,
  Bluetooth 4.0 with BLE, used with the CR2278-PC presentation cradle). The
  park's unit is described as cordless with a cradle, so it is the DS2278 pair
  — **confirm on site**. Sources:
  https://www.zebra.com/us/en/products/scanners/general-purpose-handheld-scanners/ds2200-series.html ,
  https://www.zpsstore.com/blog/zebra-ds2208-ds2278-scanner-review-top-general-purpose-scanners/
- The cradle is the host interface, not just a charger: "The CR2278-PC
  cordless presentation cradle serves as a charger, radio communication
  interface, and host communication interface… receiving digital scanner data
  via a Bluetooth radio, and sending that data to the host through an attached
  cable." Only the DS2278 pairs with it; pairing is point-to-point and "Pair
  on Contacts" (pair when inserted) is on by default. Source: DS2278 Product
  Reference Guide MN-002915-19EN (07/2026), ch.1 and ch.6.
- Radio: "Bluetooth Version 4.0 with BLE… Class 2: Minimum 30 ft (10 m) and up
  to 300 ft (100 m) when paired with CR2278 cradle… Serial Port and HID
  Profiles". Default host type is **Cradle Bluetooth Classic**; Cradle LE is
  selectable but "up to 7 times slower". The scanner can alternatively pair
  straight to a host as HID Bluetooth Classic / HID BLE (keyboard), SPP
  (serial) or SSI (Zebra SDK). Source: DS2278 PRG Table 4-2, ch.6.
- Out-of-range handling: "Auto-Reconnect Immediately" is the default, the
  reconnect attempt interval defaults to 30 s, "Beep on Reconnect Attempt" is
  optional, and batch mode can buffer scans while out of range. Source: DS2278
  PRG ch.6.
- The DS2278's own **micro-USB port is charge-only**: "The Micro USB cable is
  a charge only cable… The digital scanner enumerates as a CDC device when the
  USB connector is plugged into a PC host" (only so that charging starts). Do
  not plan data over it. Source: DS2278 PRG ch.1.
- USB device types, all set by scanning a configuration bar code and carried to
  the host over the cradle cable: **USB Keyboard HID (default)**, IBM
  Table-Top, IBM Hand-Held, OPOS, **USB CDC Host**, SSI over USB CDC, SNAPI
  with or without imaging, USB HID POS. "When changing USB Device Types, the
  scanner resets and issues the standard startup beep sequences." Source:
  DS2278 PRG ch.8, pp.8-5/8-6.
- CDC caveat: on Windows the CDC driver must be installed first or the scanner
  can stall at enumeration (recovery: unplug and replug, or hold the trigger
  10 s at power-up to boot an alternate USB configuration, then scan another
  device type). On Linux `cdc_acm` is built in and no driver is needed.
  Source: DS2278 PRG p.8-6.
- USB IDs under the Symbol/Zebra vendor **0x05E0**: **`0x1200` "Bar Code
  Scanner" (HID keyboard)**, **`0x1701` "Bar Code Scanner (CDC)"**, `0x1900`
  SNAPI imaging. The CDC node on Linux is `/dev/ttyACM0`, owned
  `root:dialout`. Sources:
  https://devicehunt.com/view/type/usb/vendor/05E0/device/1200 ,
  https://the-sz.com/products/usbid/index.php?v=0x05E0 ,
  https://michael.mulqueen.me.uk/2026/09/reading-barcodes-zebra-ds4308-usb-cdc/
- CDC wire format, observed on a DS4308 of the same firmware family: "There's
  no length field, no header, and, by default, no terminator on the wire"; the
  baud rate is nominal and 8N1 defaults are fine; a record is complete after
  roughly 0.5 s of silence unless a suffix is programmed. Source: mulqueen
  article above.
- HID pacing: **USB Keystroke Delay = No Delay (default) / Medium 20 ms /
  Long 40 ms** between emulated keystrokes; "USB Fast HID" can be turned off
  "if there are problems with transmission"; "USB CAPS Lock Override"
  preserves case. The host keyboard layout must match the layout the scanner
  emulates (default North American) or symbols such as `-`, `_` and `:`
  transpose. Source: DS2278 PRG pp.8-8/8-10 and Appendix B.
- **The Enter is configuration, not a fixed behaviour.** Quick route: scan
  "Add Enter Key (Carriage Return/Line Feed)" under Miscellaneous Scanner
  Parameters. Precise route: **Scan Data Transmission Format, parameter #235**
  — `Data As Is (0)` default, `<DATA><SUFFIX 1> (1)`, `<DATA><SUFFIX 2> (2)`,
  `<DATA><SUFFIX 1><SUFFIX 2> (3)`, `<PREFIX><DATA> (4)` — with **Suffix 1
  defaulting to `7013` ("Enter")**, changed by scanning "Scan Suffix 1" plus
  four numeric bar codes (`7009` is Tab). Setting the format back to
  `Data As Is (0)` removes it. Source: DS2278 PRG pp.5-31, 5-33/5-34,
  Table I-7.
- What `7013` means depends on the host mode: in HID keyboard mode it is an
  **Enter keystroke** (no character is inserted; a browser sees
  `keydown key="Enter"`); the PRG notes that "SSI interprets… 7013… as CR
  only"; in plain USB CDC mode the observation above is *no terminator at all*
  unless a suffix is programmed. The adapter must therefore accept `\r`, `\n`,
  `\r\n` **or** a quiet gap as the record delimiter. Sources: DS2278 PRG
  p.9-11; mulqueen article.
- Symbologies: 2D PDF417, MicroPDF417, DataMatrix, **QR Code**, MicroQR,
  Aztec, MaxiCode, Han Xin; 1D Code 128/39/93/11, Codabar, MSI, UPC/EAN,
  I2of5, GS1 DataBar and others. Source: DS2278 PRG Table 4-2.
- Scan-to-host latency is **not published** by Zebra. The documented
  contributors are Bluetooth Classic versus LE (LE about 7x slower),
  "Auto-Reconnect on Bar Code Data" adding a reconnection delay before the
  first characters, and keystroke delay 0/20/40 ms per character. Budget
  roughly 100–300 ms in HID mode for a 20-character code — **[estimate,
  measure on site]**.
- iPad: the PRG's "Apple iOS Virtual Keyboard Toggle" (parameter #1114,
  double-press of the trigger) applies to **Bluetooth HID straight to the
  iPad**. A cradle-to-USB HID keyboard is an ordinary hardware keyboard to
  iPadOS, which hides the on-screen keyboard while one is attached
  (**[unconfirmed]** for this cradle) and delivers keystrokes only to the
  focused field in Safari. Source: DS2278 PRG pp.6-16/6-17.
- Zebra's "Scanner SDK for Linux" (CoreScanner daemon) supports SNAPI, IBMHID
  and HIDKB with Debian packages including ARM (Raspbian/ARM7L documented,
  **[unconfirmed]** for arm64 on a Pi 5). It is not needed if we read HID or
  CDC directly. Sources: https://techdocs.zebra.com/dcs/scanners/sdk-linux/about/ ,
  https://techdocs.zebra.com/dcs/scanners/sdk-linux/setup/
- **Mode recommendation: put the scanner on the box in USB CDC Host mode**
  (`05E0:1701` → `/dev/ttyACM*`, 8N1, baud irrelevant), with Suffix 1 = CR and
  a 500 ms quiet-gap fallback. It gives clean byte records and a stable
  `/dev/serial/by-id/usb-Symbol_Technologies…` name, and it needs one bar code
  to set. If the scanner must stay unreconfigured, read HID keyboard mode on
  the box through `/dev/input/by-id/…-event-kbd` with an exclusive evdev grab
  (`EVIOCGRAB`) so keystrokes never reach a console. Either way the cradle and
  Bluetooth arrangement are unchanged. On the iPad fallback path, a global
  `keydown` listener accumulates printable keys and commits on
  `key === "Enter"`, treating a burst as one scan when the inter-key gap is
  under about 50 ms and the length is at least 6, and discarding bursts longer
  than about 500 ms without Enter (a human typing); keep a hidden focused
  input for iPadOS.

#### Adapter parameters — DS22xx

```yaml
transport_primary: usb-cdc-acm        # recommended: scan "USB CDC Host"; VID 0x05E0 PID 0x1701 -> /dev/ttyACM*, 8N1 (baud nominal)
transport_alternative: usb-hid-keyboard   # cradle -> USB as-is; VID 0x05E0 PID 0x1200; read via evdev with EVIOCGRAB
suffix: enter                         # param 235 = 1 (<DATA><SUFFIX1>), Suffix1 = 7013; removable by setting format 0
record_delimiters: ["\r\n", "\r", "\n"]
quiet_gap_ms: 500                     # CDC fallback when no suffix is programmed
keystroke_burst_gap_ms: 50            # HID: gap threshold between keys of one scan
keystroke_delay_setting: none         # 0 ms default; set 20 ms only if the iPad drops characters
min_len: 6
max_len: 128
symbologies_enabled: [code128, qr]    # disable the rest on the scanner to avoid false reads
keyboard_layout: us                   # host and scanner must match
reconnect: auto-immediately           # scanner default; Bluetooth Classic to the cradle
latency_budget_ms: 100-300            # [estimate; measure on site]
```

#### Simulator must reproduce — DS22xx

- One scan as a burst of characters followed by the configured delimiter (an
  Enter key event in HID mode; `\r`, `\r\n` or nothing in CDC mode), with a
  configurable inter-character delay (0 / 20 / 40 ms) and an optional
  first-scan reconnection delay of a few hundred ms to mimic "Auto-Reconnect
  on Bar Code Data".
- Two modes: `hid` (inject key events into the page or evdev) and `cdc` (a pty
  or TCP stream of raw bytes).
- Code 128 and QR payloads, with an optional Symbol code-ID prefix (`]C0` for
  Code 128, `]Q1` for QR) when "Transmit Code ID" is simulated on.
- Fault injection: dropped characters at a high burst rate, a human typing
  slowly (must not be treated as a scan), a duplicate scan within 1 s (double
  trigger), and out-of-range — no output for N seconds, then a batch flush of
  buffered scans.

#### Confirm on site — DS22xx

1. Which model is installed (DS2208 corded versus DS2278 with CR2278-PC) and
   the exact cable into the host.
2. The suffix programmed today (Enter only? CR/LF? a prefix?), the keystroke
   delay and the keyboard country setting.
3. Whether the cradle is on a hub or adapter that also charges the iPad
   (cradle draw is about 500 mA).
4. Measured scan-to-Enter latency and whether characters are lost at "No
   Delay".
5. Whether the site agrees to move the scanner to the box in CDC mode or wants
   it kept on the iPad in HID mode.

### 9.3 Welltech G4 receipt printer

- **The G4 is a rebadged Xprinter XP-C260 family printer.** Welltech
  (Thailand) lists "WELLTECH รุ่น G4 POS Direct Thermal Receipt Printer" at
  **260 mm/s, 203 dpi**, 80 mm paper, auto cutter, USB + LAN + WiFi, RJ11
  cash-drawer port, drivers for Windows XP–11 / Android / iOS / Mac / Linux,
  and says "รุ่นนี้อัพเกรดจาก XP-C260N" ("this model is upgraded from
  XP-C260N"); the page slug is `xp-c260m`. Source:
  https://www.welltechstore.com/product-page/xprinter-%E0%B8%A3-%E0%B8%99-xp-c260m-pos-direct-thermal-receipt-printer
- Welltech's own driver page bundles the G1 (XP-N160II), G4, G5 and Xprinter
  XP-C300H in one "DRIVER & TOOL WELLTECH G series.rar", confirming the G
  series is Xprinter hardware with Welltech branding. Source:
  https://www.welltechstore.com/driver
- The XP-S260M/XP-C260 family spec gives: max print speed 260 mm/s; **column
  capacity 576 dots/line** (adjustable by command); paper width 79.5 ± 0.5 mm;
  cutter **partial**; PSU 24 V/2.5 A; **cash-drawer output 24 V/1 A**;
  emulation **ESC/POS**; input buffer 128 KB. The published code-page list is
  PC437 / Katakana / PC850 / 860 / 863 / 865 / West Europe / Greek / Hebrew /
  East Europe / Iran / WPC1252 / PC866 / PC852 / PC858 / IranII / Latvian /
  Arabic / PT151 — **Thai is not on it**. Source:
  https://www.xprintertech.com/xp-s200m-xp-s260m-xp-s300m
- The Windows driver for the XP-C260N is the XP-80C driver, which is why the
  driver name tells you nothing about the model. Source:
  https://oemdrivers.com/printer-xprinter-xp-c260n
- ESC/POS basics from the Xprinter 80XX programmer manual: `ESC @` initialise;
  `ESC = n` select peripheral (when deselected the printer ignores everything
  except `DLE EOT`, `ENQ` and `DC4`).
- **Real-time status `DLE EOT n` (`10 04 n`), n = 1–4**, one byte each,
  "executed even when the printer is off-line, the receive buffer is full, or
  there is an error status": n=1 printer — bit 2 (`0x04`) drawer open, bit 3
  (`0x08`) off-line; n=2 off-line — bit 2 cover open, bit 3 feeding by button,
  bit 5 (`0x20`) paper-end stop, bit 6 (`0x40`) error; n=3 error — bit 3
  auto-cutter error, bit 5 unrecoverable, bit 6 auto-recoverable; n=4 paper —
  bits 2–3 (`0x0C`) near-end, bits 5–6 (`0x60`) paper end. Bits 1 and 4 are
  always 1 and bits 0 and 7 always 0, so an idle "OK" reply is `0x12`.
  `DLE ENQ n` recovers from an error (n=1 restart from the line that failed,
  n=2 after clearing buffers; only effective after an auto-cutter error).
  Source: Xprinter 80XX programmer manual.
- `GS r n` (transmit paper or drawer status) is documented as "This command
  just effect the serial interface" — **do not rely on it over LAN or USB**;
  use `DLE EOT`. `GS a n` (Automatic Status Back) can push four status bytes
  on change, but **[unconfirmed]** whether ASB is delivered over the LAN
  interface on this firmware: poll `DLE EOT` as the baseline and treat ASB as
  a bonus. Source: same manual.
- Cash drawer: `ESC p m t1 t2` (`1B 70 m t1 t2`), m = 0/48 for drawer pin 2 and
  1/49 for pin 5, on-time `t1 x 2 ms`, off-time `t2 x 2 ms` (if t2 < t1 the
  off-time becomes `t1 x 2 ms`). Typical kick `1B 70 00 19 FA` = 50 ms on,
  500 ms off. Source: same manual.
- Cut: `GS V m` (m = 0/48 or 1/49) — the manual is explicit that "Only the
  partial cut is available; there is no full cut". `GS V 66 n` feeds to the
  cut position plus n vertical units and then partial-cuts; send
  `GS V 66 0` (`1D 56 42 00`) as the canonical cut. Source: same manual.
- Raster image: `GS v 0 m xL xH yL yH d1…dk` (`1D 76 30 m …`) with m = 0
  normal, 1 double-width, 2 double-height, 3 quadruple; width in bytes is
  `xL + xH * 256`, height in dots. Source: same manual.
- Code pages: `ESC t n` (`1B 74 n`) with n = 0–10 and 16–21 in this manual
  (0 PC437, 1 Katakana, 2 PC850, 3 PC860, 4 PC863, 5 PC865, 6 West Europe,
  7 Greek, 8 Hebrew, 9 PC755, 10 Iran, 16 WPC1252, 17 PC866, 18 PC852,
  19 PC858, 20 IranII, 21 Latvian). Newer Xprinter firmware exposes more:
  **Thai appears as code page 255 in Xprinter's own driver/utility mapping**,
  and Sunmi (also Xprinter-derived) maps 21 to CP874. Sources:
  https://github.com/receipt-print-hq/escpos-printer-db/issues/36 ,
  https://github.com/receipt-print-hq/escpos-printer-db/blob/master/data/profile/Sunmi-V2.yml
- **Thai conclusion: rasterise.** Because the code-page number varies across
  Xprinter firmware and Thai combining marks (upper and lower vowels, tone
  marks) render badly on single-byte code pages, render Thai lines host-side
  with Noto Sans Thai and send them as `GS v 0` raster. Try `ESC t 255` with
  TIS-620 bytes only as an experiment, and only if the self-test page lists a
  Thai page. Same conclusion for Chinese and Cyrillic fixtures.
- QR: the standard Epson `GS ( k` family (cn = 49, fn 65 model, 67 module
  size, 69 error correction, 80 store, 81 print) is documented in the 80XX
  manual but **[unconfirmed]** on the G4's firmware; host-rendered raster
  always works and is the safe default. Source: same manual, pp.40–43.
- Network: factory default IP **192.168.123.100**. Self-test: "turn off the
  printer, then turn on the printer while holding down the FEED button, 2 or 3
  seconds later, release" prints a page titled "self test" carrying the IP.
  Three ways to change the address — (a) the Windows test tool (Port NET,
  Printer Type XP-80, Local IP, Printer IP, New IP; may fail through a router,
  so use a switch or a direct cable); (b) a vendor command over USB or serial,
  `1F 1B 1F 91 00 49 50 ip1 ip2 ip3 ip4` (e.g. `1F1B1F91004950C0A81364` =
  192.168.19.100), after which the printer beeps once; (c) the web page at
  `http://192.168.123.100` → Configuration → IP / subnet / gateway → Save,
  reachable "only [by] printers and computer within the same network segment",
  which also offers fixed IP versus DHCP. Sources:
  https://filedn.com/l3YHTxXEORjSP7vqHLwob1f/Xprinter/Tech%20Docs/configure%20IP%20address%20printable.pdf ,
  https://support.skyservice.pro/en/xprinter-wi-fi-setup/
- WiFi on the G4 is configured through an Xprinter WiFi utility or the web
  page after a wired connection; the G4-specific procedure was not reachable
  **[unconfirmed]**. For a fixed till, use the LAN port and leave WiFi off.
- Raw print port is **9100**, one session at a time (§9.6).

#### Adapter parameters — Welltech G4

```yaml
transport: tcp
host: <static IP>            # factory 192.168.123.100 -> set via web page or test tool
port: 9100
language: ESC/POS
dots_per_line: 576           # 80 mm paper, 72 mm print width, 203 dpi
paper_width_mm: 80
encoding_ascii: cp437        # ESC t 0
encoding_thai: raster        # host-rendered GS v 0; optional trial: ESC t 255 + TIS-620 bytes [unconfirmed]
init: "\x1b@"
status_poll: ["\x10\x04\x01", "\x10\x04\x02", "\x10\x04\x03", "\x10\x04\x04"]   # 1 byte each; idle OK = 0x12
status_bits: { online: {n: 1, bit: 3, set_means: offline}, drawer_open: {n: 1, bit: 2},
               cover_open: {n: 2, bit: 2}, paper_end: {n: 2, bit: 5}, error: {n: 2, bit: 6},
               cutter_error: {n: 3, bit: 3}, near_end: {n: 4, bits: [2,3]}, paper_out: {n: 4, bits: [5,6]} }
error_recover: ["\x10\x05\x01", "\x10\x05\x02"]   # DLE ENQ 1 / 2, after a cutter error
asb: optional                # GS a; verify over LAN before relying on it [unconfirmed]
gs_r: unusable-over-lan      # "just effect the serial interface"
cut: "\x1dV\x42\x00"         # GS V 66 0 (partial); GS V 1 is also partial; no full cut exists
drawer_kick: "\x1bp\x00\x19\xfa"   # ESC p 0 25 250 -> pin 2, 50 ms on / 500 ms off; drawer 24 V 1 A RJ11
drawer_status: "\x10\x04\x01"      # bit 2
qr: gs_paren_k_or_raster     # prefer raster
image: "\x1dv0"              # GS v 0 m xL xH yL yH
timeouts: { connect_ms: 2000, write_ms: 5000, status_ms: 800, drain_after_cut_ms: 300 }
concurrency: 1
```

#### Simulator must reproduce — Welltech G4

- TCP 9100, single session, a byte-stream ESC/POS parser tolerant of
  interleaved `DLE EOT n` — answer immediately with the one status byte, even
  in an error state and even mid-command — plus `DLE ENQ`, `ESC @`, `ESC t`,
  `ESC !`, `GS !`, `ESC a`, `ESC d`, `LF`, `GS V`, `GS v 0`, `GS ( k`,
  `ESC p`, `GS a` and `GS r`.
- Render a 576 px wide receipt image per cut so tests can assert content; keep
  a cut counter and a drawer-kick log with the pulse timings.
- A status model with the fixed bits (1 and 4 set) and injectable faults:
  cover open, paper near-end, paper out, cutter error, off-line. While paper
  is out, refuse to render further lines until "paper loaded".
- Optional ASB push of four bytes on state change when `GS a` is enabled.
- Vendor extras: accept the `1F 1B 1F 91 00 49 50 …` IP-set command and log a
  "beep"; expose a fake self-test that returns model, firmware, IP and the
  code-page list, so the Thai code-page probe can be exercised.

#### Confirm on site — Welltech G4

1. The firmware string and code-page list on the self-test page — does a Thai
   page (255 or otherwise) exist at all?
2. Whether ASB (`GS a`) and QR (`GS ( k`) work over LAN on this firmware.
3. The drawer pulse this park's drawer actually needs (some need 100 ms or
   more of on-time).
4. Whether the LAN board offers DHCP and a web page, and whether it has a
   password.
5. What a second TCP connection does during a job (refused versus stalled) and
   whether the socket closes after an idle period.

### 9.4 Xprinter XP-80 series

- Xprinter's 80 mm desktop range shares the ESC/POS command set in §9.3, so
  the adapter is one implementation with per-unit configuration. Reference
  model **XP-Q80C**: 230 mm/s; "576 dots/line or 512 dots/line"; interfaces
  "USB / USB+Serial (Optional: USB+Bluetooth/USB+Wifi)" and "Lan (Optional:
  USB+Lan)"; cutter **partial**, 1.5 M cuts; cash-drawer output 24 V/1 A;
  input 24 V/2.5 A; emulation ESC/POS; buffer 64/256 KB; the same code-page
  list as the C260 family, again **with no Thai**. Source:
  https://www.xprintertech.com/xp-q80c
- **XP-80C** is the classic 80 mm model, sold as USB, USB+Serial,
  USB+Serial+LAN and LAN-only variants; its driver is also the driver the C260
  family uses, so the installed driver name identifies nothing. Sources:
  https://www.xprintertech.com/all-products/xprinter-xp-80c ,
  https://oemdrivers.com/printer-xprinter-xp-c260n
- The models Welltech Thailand stocks are **XP-T80B** (USB+LAN) and
  **XP-N160II** (USB); XP-T80Q exists in USB+LAN variants. Sources:
  https://www.welltechstore.com/receiptprinter ,
  https://manuals.plus/xprinter/xp-t80q-thermal-receipt-printer-manual
- Which models have Ethernet: any variant whose suffix includes "L"/"LAN" or
  that is listed as "USB+LAN" — XP-80C-L, XP-T80B/Q, the XP-Q80C LAN option,
  the XP-C260 family. The park's three kitchen and counter units are almost
  certainly USB+LAN variants because they sit on the switch, but that is an
  inference — confirm from the rear panel (RJ45 present) and the self-test
  page.
- Default IP, self-test procedure, the three IP-change methods and the web
  page are **identical to §9.3** (192.168.123.100; FEED held at power-on; test
  tool, `1F 1B 1F 91 00 49 50 ip1 ip2 ip3 ip4`, or the web Configuration
  page). Source: Xprinter "How to configure IP address for Ethernet port
  printers".
- Status commands, cut, drawer kick, raster and code pages are **identical to
  §9.3** — the same 80XX programmer manual applies: `GS r` is serial-only,
  `GS V` is partial-cut only, `DLE EOT n` is the status baseline.
- Telling the models apart: the self-test page prints model, firmware,
  interface and IP; the rating label on the underside carries model and serial
  (**[unconfirmed]** label format); the Windows driver name is unreliable
  because many models install as "XP-80C".
- Thai: same conclusion as §9.3 — rasterise with `GS v 0`, and treat a Thai
  code page as an experiment only.

#### Adapter parameters — XP-80 series

```yaml
# identical to the Welltech G4 block in 9.3 except:
model_hint: XP-80C | XP-T80B | XP-T80Q | XP-80A | XP-Q80C   # read from the self-test page, not the driver name
dots_per_line: 576            # some units are 512 - read from the self-test/config page per unit
speed_mm_s: 200-260           # model dependent; irrelevant to the protocol
drawer_kick: "\x1bp\x00\x19\xfa"   # kitchen units usually have no drawer - leave unused
kitchen_bell: "\x07"          # BEL; some firmwares beep [unconfirmed]
hosts:                        # current park addresses (section 2)
  - { role: kitchen, host: 192.168.88.206 }
  - { role: counter-2, host: 192.168.88.207 }
  - { role: bar, host: 192.168.88.208 }
```

#### Simulator must reproduce — XP-80 series

- Everything the G4 simulator does, with per-instance configuration for
  `dots_per_line` (576 or 512) and an optional slower per-line print delay to
  mimic 200–230 mm/s.
- Three instances on distinct ports or addresses so routing (receipt versus
  kitchen versus bar) can be tested, each with a fake self-test naming a
  different model ("XP-80C", "XP-T80Q") to exercise model detection.
- A unit with no cutter, so the adapter's tear-bar path is covered.

#### Confirm on site — XP-80 series

1. The exact model and interface variant of each of the three units (rear
   panel plus self-test page).
2. 576 versus 512 dots/line per unit.
3. Whether all three are on LAN rather than one on USB, and their current
   addresses — all three may still be on the factory 192.168.123.100, which
   would collide.
4. Whether the kitchen units have cutters or tear bars only.

### 9.5 NEXGO N5 and PAX A920Pro — physical ECR link

This section covers only the cable and the device node. The message formats
are already specified in §5 (GHL LinkPOS XML, Digio Direct Terminal BER-TLV).

**NEXGO N5 (Shenzhen Xinguodu Technology)**

- The handset runs Android 7.x and its ports are "**1 x Micro-USB OTG**" plus
  SIM/SAM/SD — that is the only wired port on the terminal. 5200 mAh battery,
  4G/3G/2G, Wi-Fi 2.4 GHz (5 GHz optional), Bluetooth, 58 mm built-in printer,
  5 V/2 A adapter. Sources: NEXGO N5 datasheet
  https://www.nexgoglobal.com/es/static/upload/file/20230301/1677654379518228.pdf ;
  N5 user manual v5.1
  https://www.nexgoglobal.com/es/static/upload/file/20230301/1677654357630880.pdf
- There are three official docks, all pogo-pin cradles with a micro-USB
  5 V/2 A input and 1.2 A charging: (1) **Charging Docking Station**, charge
  only; (2) **Wi-Fi Docking Station** — "a charger and also served as a
  **router** that provides Wi-Fi to terminals", with an RJ45 LAN 10/100 input,
  "LAN Port IP 192.168.1.1", web login at http://192.168.1.1 (user "null",
  password "Nexgo300130"), SSID "NEXGO" plus the last four of the MAC;
  (3) **Multifunctional Docking Station** — "Five peripheral ports on the
  bottom, including the RS232, LAN port, and USB-A ports", i.e. RJ45 LAN
  10/100, an RJ45-jack RS232 and two USB-A 2.0 host ports. Source: datasheet
  p.3, manual pp.13–14.
- **Cabling conclusion: the hardware note's "LAN via docking station" is
  wrong.** On the Wi-Fi dock the handset joins the dock's own Wi-Fi and sits
  behind its `192.168.1.x` NAT, so it has no address on `192.168.88.0/24`
  unless the dock is bridged (**[unconfirmed]** whether it can be). On the
  multifunctional dock, whether the LAN is presented to the terminal as
  Ethernet over the pogo pins is **not stated [unconfirmed]** — the wording
  implies it is; check Android Settings while docked.
- **ECR link: the handset's micro-USB OTG port**, USB-A to micro-B into the
  box, terminal in USB device role. How the N5 exposes the serial channel
  (a CDC-ACM gadget giving `/dev/ttyACM*`, or an Android accessory or vendor
  driver) and its **VID/PID are not published**; GHL's integration notes cover
  only the software, certificate and terminal-ID setup, not the cable or
  driver. **[unconfirmed — ask GHL Thailand for the Windows driver INF; the
  VID/PID in it says whether Linux `cdc_acm` will bind.]** Source:
  https://support.xilnex.com/portal/en/kb/articles/setting-up-ghl-nexgo
- Alternative ECR path: the multifunctional dock's RS232 (RJ45 jack, needing
  NEXGO's RJ45-to-DB9 cable and a USB-RS232 adapter on the box). Whether GHL
  LinkPOS supports the dock serial path, and at what baud, is
  **[unconfirmed]**.
- Whether an "ECR/integration mode" must be switched on in the handset is
  **[unconfirmed]** — GHL's LinkPOS setup is done through the GHL portal;
  confirm with GHL Thailand.
- Power: if the micro-USB carries ECR data, charging must come from the dock
  pogo pins, or the box's USB port must supply 5 V at 1 A or more
  **[inferred]**.

**PAX A920Pro**

- "PAX Biz powered by Android 8.1"; ports are "**1 Type-C OTG | 6 PIN POGO
  PIN**"; 4G, Wi-Fi 2.4 GHz, Bluetooth (optional 5 GHz and BT 5.0); 5150 mAh;
  5 V/2 A adapter; a top-side barcode scanner. Source: A920Pro datasheet
  https://www.pax.us/wp-content/uploads/2023/12/A920Pro-Datasheet.pdf
- Bases are sold separately and decide what wired ports exist:
  **L920Pro-BC** charging base has one Type-C power port and **no Ethernet**;
  **L920Pro-BE** "Charging + Wireless" adds Wi-Fi 5 GHz and BT 5.0, **one
  RS232 (RJ45)**, **one Ethernet (RJ45)**, one power Type-C, one Type-C
  device port and one USB host port. The older A920 bases are L920-BC (charge
  only) and L920-BE (RS232 RJ45, Ethernet 100M, micro-USB device, USB-A host),
  with reseller-listed L920-BM/-BF variants. Sources: A920Pro datasheet;
  https://www.pax.us/wp-content/uploads/2023/01/L920-Data-Sheet.pdf ;
  https://www.discountcreditcardsupply.com/products/pax-a920-multifunctional-charging-base
- **Cabling conclusion: Ethernet reaches the handset only through a -BE/-BM
  base**, not the -BC charging base and not a back-plate port: "To connect the
  A920 to a local network with an Ethernet connection, you must use the device
  with the L920 base", then Settings (password 9876 or pax9876@@) → Ethernet →
  Ethernet Configuration → Static or DHCP; the terminal keeps the IP setting
  when lifted and falls back to Wi-Fi. Sources:
  https://help.posspecialists.com/portal/en/kb/articles/pax-a920-setup-guide ,
  https://support.heartlandretail.us/en/articles/4551123-pax-a920-setup-guide
- **ECR link: Type-C OTG as a CDC-ACM serial port.** PAX apps expose a
  "Host/ECR Communication" setting with USB / Ethernet / Serial choices (in
  PXRetailer's Setup Menu, password pax12345: "Make sure 'USB' is checked
  (ethernet and serial should not be selected)"). In USB mode the handset is a
  USB device on its Type-C port; Windows binds "PAX Technology USB Serial Port
  (CDC)" (`paxcdc.inf`, v1.1.1.0, 2020) with **VID `0x2FB8`** across a wide PID
  range (0102, 010C, 010D … 2FFA, some multi-interface `&MI_xx`), plus VID
  9908 / PID 9030; Linux `cdc_acm` binds these to `/dev/ttyACM*`.
  **[unconfirmed]** which PID the A920Pro presents in Digio's build, and
  whether Digio's Direct Terminal app selects USB-CDC or the base RS232 — ask
  Digio for their ECR cable and driver note. Sources:
  https://certek.com/kb4/knowledge-base/programming-the-pax-a920-pro/ ,
  https://treexy.com/products/driver-fusion/database/ports-com-lpt-serial/pax-technology/usb-serial-port-cdc/
- Alternative ECR paths on the -BE base: RS232 (RJ45 jack → PAX RJ45-to-DB9
  cable → USB-RS232 adapter on the box), or the base's own "Type-C (Device)"
  port — **[unconfirmed]** whether that port relays the handset's CDC.
- ECR mode must be enabled in the payment app; Digio's menu names are
  **[unconfirmed]**.

#### Adapter parameters — card terminals (physical layer only)

```yaml
nexgo_n5:
  ecr_transport: usb-serial            # handset micro-USB OTG (USB device role); VID/PID unknown -> get from the GHL driver INF
  linux_device: /dev/serial/by-id/<to be discovered>   # expect cdc_acm -> ttyACM*; a vendor driver would be an escalation
  serial: { baud: 9600, data: 8, parity: "none (sample code: odd)", stop: 1 }   # LinkPOS XML spec governs; parity confirm on site (section 5)
  alt_transport: dock-rs232            # multifunctional dock RJ45-RS232 -> DB9 -> USB-RS232 adapter [unconfirmed support]
  lan: dock-wifi-router                # handset behind the dock's 192.168.1.x NAT; not addressable on 192.168.88.x
  power: dock-pogo or micro-usb 5V/2A  # micro-USB carrying data means charging must come from the dock [inferred]
  terminal_setting: "GHL LinkPOS enabled on the TID via the GHL portal"   # a handset-side ECR switch is [unconfirmed]
pax_a920pro:
  ecr_transport: usb-cdc-acm           # handset Type-C OTG; VID 0x2FB8, PID per unit (0102...2FFA) or 9908:9030
  linux_device: /dev/serial/by-id/usb-PAX_Technology_*   # verify the name; add a udev SYMLINK keyed on the serial
  serial: { baud: 9600, data: 8, parity: none, stop: 1 }   # Digio Direct Terminal BER-TLV spec governs
  alt_transport: base-rs232 (L920Pro-BE RJ45) | base-type-c-device   # [unconfirmed] whether the base device port relays the CDC
  lan: ethernet-via-base               # only with an L920Pro-BE/-BM base; Settings -> Ethernet (pw 9876 / pax9876@@)
  terminal_setting: "Host/ECR Communication = USB"   # app-specific menu; Digio's equivalent to confirm
  power: base pogo (Type-C 5V/2A into the base) or Type-C direct
common:
  open_by_id_not_ttyACMn: true         # renumbering on hot-plug is normal
  log_raw_bytes: both-directions       # PROJECT_CONTEXT section 7.1
  timeouts: { open_ms: 2000, idle_read_ms: 500, customer_interaction_ms: 120000 }
```

#### Simulator must reproduce — card terminals (transport behaviour)

- A pty (or `socat`) virtual serial device per terminal, so the adapter opens
  a `/dev/serial/by-id/…`-style path exactly as it will on the box.
- Hot-plug: the device disappears when the handset is lifted or powered off
  and reappears with a different `ttyACM` number, proving the adapter
  re-resolves by-id symlinks rather than raw numbers.
- Readiness and timing: the real handset only answers while its ECR app is in
  the foreground, so simulate "not ready" (no reply, then timeout), "busy",
  and a slow customer taking 30–90 s before the response frame — the case that
  drives the inquiry-on-no-response rule in S2-10a.
- Message-level behaviour stays out of scope here; the LinkPOS XML and Digio
  BER-TLV specs in §5 govern it.

#### Confirm on site — card terminals

1. Which dock each terminal actually sits in (NEXGO: charging, Wi-Fi-router or
   multifunctional; PAX: L920Pro-BC or -BE).
2. NEXGO ECR: the cable in use today (micro-USB to what?) and the `lsusb`
   VID/PID with the LinkPOS app in ECR mode.
3. PAX ECR: the `lsusb` VID/PID in Digio's ECR mode, and whether it binds
   `cdc_acm` or needs a vendor driver.
4. Whether the PAX handsets show an Ethernet interface when docked (i.e. the
   base is a -BE/-BM), and their addresses.
5. Whether GHL or Digio require a specific baud rate or handshake lines
   (DTR/RTS) — and the NEXGO parity question already open in §5.
6. Whether either bank app supports TCP/IP ECR, which would remove the USB
   tether altogether.

### 9.6 Box host notes (Raspberry Pi 5 vs Intel mini PC)

- **Raw port 9100 is single-session.** "A raw print port serves one session at
  a time, so a second client is refused or left waiting." Open one connection
  per job, set explicit connect and write timeouts, use TCP keepalive, never
  leave a socket open, and make sure no forgotten CUPS or Windows queue
  elsewhere is holding the port. This applies to all four printers above.
  Sources: https://www.proxynodes.com/guides/network-printer-port-9100 ,
  https://industrialmonitordirect.com/blogs/knowledgebase/proxying-escpos-thermal-printer-traffic-from-pos-systems
- **ModemManager grabs USB serial ports.** It probes `ttyACM`/`ttyUSB` as
  modems; Raspberry Pi OS Bookworm ships it, and Pi 5 users report `ttyACM0`
  problems that stop when ModemManager does. Fix with a udev rule on the
  **usb** subsystem (not tty):
  `ATTRS{idVendor}=="05e0", ATTRS{idProduct}=="1701",
  ENV{ID_MM_DEVICE_IGNORE}="1"` (repeat for `2fb8` for PAX and for the NEXGO
  VID once it is known), or simply `systemctl disable --now ModemManager`
  since the box has no modem. Sources:
  https://modemmanager.org/docs/modemmanager/port-and-device-detection/ ,
  https://www.downtowndougbrown.com/2016/10/fix-for-usb-serial-port-being-opened-by-modemmanager-at-startup/ ,
  https://forums.raspberrypi.com/viewtopic.php?t=360121
- **brltty does the same on Ubuntu desktop images** (an Intel mini PC risk): it
  claims CP210x and FTDI USB-UART adapters seconds after plug-in. Remove it
  (`apt remove brltty`) or comment out its udev rules; better, run Ubuntu
  Server or Debian, which do not ship it. Sources:
  https://bugs.launchpad.net/bugs/1958224 ,
  https://support.arduino.cc/hc/en-us/articles/29350073597468-Resolve-BRLTTY-conflict-on-Linux
- **Stable device names:** open `/dev/serial/by-id/usb-<vendor>_<product>_
  <serial>-if00`, which udev creates by default, rather than `/dev/ttyACM0`.
  Where two identical devices carry no serial number, pin them by port path
  (`/dev/serial/by-path/`) or write `SYMLINK+=` rules keyed on
  `ATTRS{serial}`/`KERNELS`. CDC nodes are `root:dialout`, so the service user
  must be in `dialout`.
- **HID scanner on the box:** keep it out of the console by reading
  `/dev/input/by-id/*-event-kbd` with an exclusive grab (evdev `EVIOCGRAB`),
  or switch the scanner to CDC per §9.2. (Recommendation; no vendor source.)
- **node-serialport:** `@serialport/bindings-cpp` ships prebuilt binaries for
  major platforms including linux-arm64, falling back to `node-gyp`
  (`build-essential`, `python3`) when the Node ABI has no prebuild. Pin the
  Node LTS that has prebuilds, and install `build-essential` on the Pi anyway;
  a `NODE_MODULE_VERSION` mismatch means the binary was built for a different
  Node and must be rebuilt. Sources:
  https://serialport.io/docs/guide-installation/ ,
  https://serialport.io/docs/guide-platform-support/
- **ESC/POS libraries:** `escpos` (lsongdev) last published 3.0.0-alpha.6 six
  years ago — avoid; `node-thermal-printer` is actively used (about 13.6 k
  weekly downloads); `esc-pos-encoder` 3.0 and later is a wrapper around
  `@point-of-sale/receipt-printer-encoder`, a pure command encoder that pairs
  well with Node's `net` for TCP 9100 plus our own status poller. For TSPL
  there is no library worth taking: string templates plus `Buffer` for
  `BITMAP`. Sources:
  https://npmtrends.com/esc-pos-encoder-vs-escpos-vs-node-printer-vs-node-thermal-printer ,
  https://www.npmjs.com/package/esc-pos-encoder
- **Pi 5 versus Intel mini PC:** functionally equivalent for four TCP printers,
  two USB serial terminals and one scanner. The Pi 5 is cheaper and arm64
  (check every native module has an arm64 prebuild), wears SD cards (use an
  NVMe HAT or a USB SSD), has no RTC battery by default (depends on NTP, which
  matters for the business-day and offline-journal rules) and carries the
  ModemManager issue. The mini PC gets universal x86_64 prebuilds, more USB
  ports and unmodified Docker images, but watch for brltty on desktop images.
  Either way, run the adapter as a systemd service with `Restart=always` and
  udev-triggered device discovery, never fixed `/dev/ttyACMn` names.

#### Adapter parameters — box host

```yaml
os: Debian/Raspberry Pi OS (Pi 5) or Ubuntu Server (mini PC)   # avoid desktop images (brltty)
service: systemd unit, Restart=always, device discovery by udev event
serial_paths: /dev/serial/by-id/*        # never /dev/ttyACMn
user_groups: [dialout]                   # CDC nodes are root:dialout
udev_rules:
  - 'SUBSYSTEM=="usb", ATTRS{idVendor}=="05e0", ATTRS{idProduct}=="1701", ENV{ID_MM_DEVICE_IGNORE}="1"'
  - 'SUBSYSTEM=="usb", ATTRS{idVendor}=="2fb8", ENV{ID_MM_DEVICE_IGNORE}="1"'
  - '# repeat for the NEXGO VID once known; or disable ModemManager entirely'
modemmanager: disabled
cups: not used                           # printers are driven on raw 9100 / /dev/usb/lp0
printer_socket: { one_connection_per_job: true, keepalive: true, reuse: false }
node: LTS with @serialport/bindings-cpp prebuilds; build-essential + python3 installed
escpos_encoder: "@point-of-sale/receipt-printer-encoder"   # plus our own status poller over net
tspl: hand-built strings + Buffer for BITMAP
clock: NTP required (no RTC on a Pi 5 by default)
```

#### Simulator must reproduce — box host

- Single-session TCP 9100 endpoints, so a second connection attempt during a
  job behaves as the real printers do and the "one connection per job" rule is
  actually exercised.
- Virtual serial devices exposed under a `by-id`-style path, with hot-plug
  renumbering as in §9.5.
- A device-discovery event stream, so the agent's udev-triggered discovery
  path is the same code in the simulator and on the box.

#### Confirm on site — box host

1. Which host the branch gets (Pi 5 per counter, as our design assumes, or the
   reference's single Intel mini PC print server at 192.168.88.100).
2. Whether ModemManager or brltty is present on the chosen image, and that the
   udev ignore rules take effect for the real VID/PIDs.
3. That every native module in the agent has an arm64 prebuild, if the Pi is
   chosen.
4. Power and mounting per counter, and whether the box gets a wired switch
   port alongside the printers.

### 9.7 What the tickets take from this

- **S2-04 (stations, boxes and devices).** Device kinds, models and roles for
  the `device` table and the setup wizard's device steps: two label printers
  (§9.1) and four ESC/POS receipt printers (§9.3, §9.4) at the addresses in
  section 2, one scanner offered as camera / paired to this iPad / attached to
  the box (§9.2), two card terminals and two QR terminals on USB serial
  (§9.5), one gate (§6). Reachability and paper status in the heartbeat come
  from the status commands in §9.3 (`DLE EOT n`) and §9.1 (`ESC ! ?`); the
  test-print command routes to the adapters in §9.1 and §9.3.
- **S2-06 (print pipeline, printer and scanner simulators).** The printer
  adapters and their fault model: TSPL2 for the wristband printers with the
  label example in §9.1, ESC/POS for receipts with the cut, drawer-kick and
  status bytes in §9.3 (and the per-unit `dots_per_line` in §9.4); Thai,
  Chinese and Cyrillic rasterised host-side rather than by code page (§9.3),
  which is what the "สวัสดี OTO Park" and "Привет" fixtures test. The
  simulators must answer the exact bytes in each "Simulator must reproduce"
  block, including paper-out and unreachable injection. The scanning service
  takes its input model from §9.2: CDC records delimited by `\r` or a 500 ms
  quiet gap, HID bursts committed on Enter, and the button key distinguished
  from a scanner's Enter because the suffix is a known, programmable value.
- **S2-10a (EDC tenders).** The serial links in §9.5: NEXGO over the handset's
  micro-USB OTG with an unpublished VID/PID, PAX over Type-C OTG as CDC-ACM
  (VID `2FB8`), both opened by `by-id` path, both logged raw in both
  directions. The transport-level simulator behaviour there — not ready, busy,
  a 30–90 s customer, hot-plug renumbering — is what makes the
  inquiry-on-no-response rule testable.
- **S2-12 (gate).** Section 6 is the gate's own reference: the reader's
  `checkCard` and `heartbeat` HTTP contract, the dry-contact open on
  `L-OP`/`R-OP`/`COM`, and the GE-X2 serial frames and passage events that the
  gate simulator emits. From section 9 it takes the QR payload side (the band
  code printed by §9.1 and read by the §9.2 scanner at the till) and the box
  host rules in §9.6 for the RS485/RS232 adapter's device path.
