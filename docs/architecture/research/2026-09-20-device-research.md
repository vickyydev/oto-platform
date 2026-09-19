<!-- Research note written 2026-09-20 by a web-research pass (manufacturer pages, datasheets, integration write-ups; sources listed inline). Status: draft, not yet folded into docs/architecture/DEVICE_INVENTORY.md section 9. Facts marked uncertain are uncertain; "confirm on site" items stand. -->

# OTO Park device research — adapters and simulators

Researched 2026-09-20 from manufacturer documents, driver databases and integration write-ups.
Each bullet carries its source. Anything not directly confirmed for the exact model in the park is
marked **[inferred]** or **[unconfirmed]** — treat those as hypotheses to verify on site, not facts.

Local copies of the primary PDFs used (text-extracted with pypdf) live in this scratchpad:
`tspl.txt` (TSC TSPL/TSPL2 manual, 2014), `ds2278.txt` (Zebra DS2278 PRG MN-002915-19EN, 07/2026),
`xprinter80xx.txt` (Xprinter 80XX programmer manual), `xprinter_ip.txt` (Xprinter IP-config note),
`nexgo_n5.txt` (NEXGO N5 manual v5.1, 02/2023).

---

## 1. Wristband printers ×2 — "4B-2082A" (4BARCODE Technology Co., Ltd.)

### Identity and family
- Manufacturer is **4BARCODE Technology Co., Ltd.** (copyright holder of the family user manual).
  Source: family manual, p.1 — https://bordellproducts.com/uploads/1/2/1/9/121929864/usermanual.pdf
- The exact model **4B-2082A** exists in Seagull's driver catalogue ("4BARCODE 4B-2082A", driver v12.6,
  2026-08-04; feature table: status monitoring to the Windows spooler, font download, RFID encodings).
  No spec sheet on that page. Sources:
  https://www.bartendersoftware.com/resources/printer-drivers/4barcode/4barcode-4b-2082a ,
  https://forums.seagullscientific.com/support/downloads/drivers/4barcode/
- Sibling models in the same driver family: 4B-2052A, 4B-2054A…TM, 4B-2064A…TA, 4B-2082A…TA,
  4B-2083A–D, 4B-2084A…TD, 4B-3034A, 4B-3044A…TM, 4B-3062/3063/3064.
  Source: https://treexy.com/products/driver-fusion/database/printers/4barcode/
- **[inferred] Model-number scheme:** `4B-{2=203 dpi | 3=300 dpi}{ips}{width in inches}{variant}`.
  Anchor: 4B-2054A is confirmed 203 dpi / 5 ips (127 mm/s) / 4-inch (Arkscan 2054A = "4BARCODE 4B-2054A").
  Hence 4B-2082A ≈ **203 dpi, 8 ips, 2-inch (≈54–56 mm max media) direct thermal**. This matches the park's
  "~50 mm media, 203 dpi" note but is *not* published anywhere I could reach — confirm from the self-test page.
  Sources: https://www.arkscan.com/driver (driver appears as "4BARCODE 4B-2054A" or "Arkscan 2054A"),
  https://www.arkscan.com/product/shipping-label-printer/shipping-label-printer/2054a-thermal-shipping-label-printer
- The family is a **TSC TTP-24x-class clone**: the 4BARCODE manual is a lightly edited TSC manual
  (same Diagnostic Tool, AUTO.BAS, GAP/BLINE, LED sequences, "4MB Flash and 8MB SDRAM", "32-bit RISC CPU").
  Sources: family manual pp.15–36; Arkscan 2054A spec ("32-bit RISC CPU", "4MB Flash Memory, 8MB SDRAM").
- 4BARCODE also publishes a Windows Store "4BARCODE Printer Driver Utility V1"; the mobile "4BarCode" apps
  (package `com.xinye.barcode4`, developer website xprintertech.com) are a label-design app from the Xprinter
  (Xiamen Xinye) group — **[unconfirmed]** whether 4BARCODE hardware is an Xprinter-group product; it does not
  change the command language conclusion below.
  Sources: https://apps.microsoft.com/detail/9pk9ccj8mpxq , https://apps.apple.com/us/app/4barcode/id6443980426

### Command language — answers open decision D1
- The family manual states the printer runs the **TSPL2 programming language**
  ("TSPL2 programming language allows user to download an auto execution file (AUTO.BAS)…";
  "select gap or black mark sensor by GAP or BLINE command…refer to TSPL2 programming manual").
  Source: family manual §4.4 and §7.2.
- The 4-inch sibling's datasheet lists emulations **"TSPL, EPL, ZPL & DPL"**; Arkscan also ships a
  "Zebra Compatible Driver" and documents raw printing of a ZPL file on Linux (`lpr -P _4BARCODE_4B_2054A -o raw`).
  Sources: https://www.arkscan.com/product/shipping-label-printer/shipping-label-printer/2054a-thermal-shipping-label-printer ,
  https://www.arkscan.com/technical-support/download , https://www.arkscan.com/2054a-pdf-windows
- How emulation is selected: on TSC's own TSPL-EZ firmware the printer **auto-detects** TSPL2 / EPL2 / ZPL2 per job
  ("No switches or other setup is required, the printer simply recognizes which command language is being sent").
  **[inferred]** 4BARCODE firmware behaves the same (no explicit switch command is documented for it). Confirm on site by
  sending a TSPL job and a ZPL job back-to-back.
  Source: https://www.facebook.com/TSCAutoIDTechnology/posts/tscs-tspl-ez-is-powerful-printer-firmware-that-can-recognize-tspl2-epl2-and-zpl2/388360237842526/
- **Recommendation: code TSPL2 first.** It is the native language (status/query commands are TSPL-only), the
  label example below is complete, and the ZPL/EPL translators are lossy on clones. Keep the label builder behind an
  interface so a ZPL variant can be added if the on-site test shows TSPL quirks.

### Physical/spec (family-level; 2-inch values [inferred])
- Direct thermal only ("A" variants; "TA/TM" variants are thermal transfer). Speeds user-selectable 2–5 ips on the
  4-inch family; the 2082A's "8" implies 8 ips max **[inferred]**. Source: family manual §1; Treexy list.
- Media (4-inch sibling): width 20–112 mm, thickness 0.06–0.16 mm, length 10–2286 mm, roll OD 127 mm, gap or
  black-mark sensing; accepts roll, die-cut and fan-fold; wristband stock is just die-cut/black-mark media of the right
  width — nothing wristband-specific is documented. For the 2-inch unit expect roughly 20–58 mm media **[inferred]**.
  Source: Arkscan 2054A spec page above; family manual §3.2.
- Interfaces on the family board: USB, RS-232 DB-9 (9600 8N1 default), Ethernet (internal print-server option),
  SD card; power via external 24 V PSU (matches the park's 24 V 2.5 A note). Source: family manual §2.3.2, §4.2 defaults.
- Factory defaults: speed 5 ips, density 8, label 4"×7.08", gap 4.0 mm, direction 0, code page 850, country 001,
  tear mode ON, cutter/peel OFF, **IP address = DHCP**. Source: family manual §4.2 table.

### Network configuration
- "The default IP address is obtained by DHCP." Static IP is set with the Windows **Diagnostic Tool** (Printer
  Configuration → Ethernet Setup; works over USB, RS-232 or Ethernet "Discover Device" / "Change IP Address" /
  "Set Printer Name"; printer resets after setting). Source: family manual §3.6–3.7.
- A **web page** exists: "Web setup button — …explore and configure the printer settings and status or update the
  firmware with the IE or Firefox web browser". Source: family manual §3.7.3.
- Raw printing port is 9100 on TSC-class Ethernet modules and TSPL says the status/immediate commands "support
  RS-232, USB and Ethernet" — i.e. status polling works over the same TCP 9100 socket. **[unconfirmed for 4BARCODE]**
  that 9100 is enabled by default (it is on TSC); verify with `nc <ip> 9100` and `<ESC>!?`.
  Source: TSPL manual "Status Polling and Immediate Commands", p.78.
- The self-test page prints the IP: Arkscan: "press and hold the button on top of the printer for about 4 seconds…
  double beep… configuration page, which displays the printer's IP address" (Arkscan units have a beeper;
  the 4BARCODE manual describes the LED-colour variant below). Source: https://www.arkscan.com/driver

### Self-test / calibration / dump (power-on utilities, one FEED button + 3-colour LED)
- Hold FEED while powering on; LED cycles **blue → red (5 blinks) → purple (5 blinks) → blue (5 blinks) → solid blue**.
  Release during **red** = gap/black-mark calibration; during **purple** = calibration + **self-test printout** + dump
  mode; during **blue blinks** = factory initialisation; at **solid blue** = skip AUTO.BAS. Power-cycle to leave dump mode.
- Self-test printout contains: head check pattern, **model name and F/W version**, mileage, checksum, serial-port
  config, code page, country code, speed, darkness, label size, gap, sensor sensitivity, file count, memory.
  Source: family manual §4.1–4.4 (pp.22–28).
- LED meanings: solid blue ready; blinking blue paused/downloading; purple clearing memory; **solid red head open;
  blinking red error (head open, paper empty, paper jam, memory error)**. Source: family manual §6, §7.1.

### TSPL2 commands the adapter needs (from the TSC TSPL/TSPL2 manual, 2014 — `tspl.txt`)
- Status poll `ESC ! ?` (1B 21 3F) → **one byte**, bit-OR'd:
  `00` normal, `01` head open, `02` paper jam, `04` out of paper, `08` out of ribbon, `10` pause, `20` printing,
  `80` other error (documented combos 03, 05, 09, 0A, 0B, 0C, 0D). Works "at any time, even in the event of printer error".
- Extended status `ESC ! S` (fw ≥ V6.29 EZ) → `<STX>` + 4 ASCII bytes + `<ETX><CR><LF>`; byte1 message
  (`@` normal, `` ` `` pause, `B` backing, `C` cutting, `E` printer error, `F` form feed, `K` waiting print key,
  `L` waiting take label, `P` printing batch, `W` imaging); byte2 warning (`H` receive buffer full);
  byte3 error (`A` head overheat, `B` motor overheat, `D` head error, `H` cutter jam, `P` insufficient memory);
  byte4 error (`A` paper empty, `B` paper jam, `D` ribbon empty, `H` ribbon jam, `` ` `` head open).
  Example replies: `@@@@` normal, `E@@B` paper jam, `E@@b` jam + head open. **[unconfirmed]** that 4BARCODE firmware
  implements `ESC!S`; `ESC!?` is the safe baseline.
- Identity/queries: `~!T` → model name/number (ASCII); `~!I` → "code page, country" e.g. `437, 001`;
  `~!@` → mileage (ASCII, ends 0x0D); `~!A` → free memory (ASCII, ends 0x0D); `~!F` → file list (each 0x0D, end 0x1A).
- Control: `ESC!R` reset (deletes downloaded files); `ESC!F` feed one label (≥ V7.00); `ESC!.` cancel all printing
  (≥ V7.00); `ESC!P` pause / `ESC!O` un-pause (≥ V6.93); `ESC!C` restart skipping AUTO.BAS; `~!D` enter dump mode.
- Per-label acknowledgement: `SET RESPONSE ON` (≥ V7.09) makes the printer emit `{SS,NNNNN[,ID]}` after each label
  (SS = the same hex status codes as `ESC!?`, NNNNN = 00001…99999 counter), `SET RESPONSE "job1",BATCH` → one
  reply per job. **[unconfirmed]** on 4BARCODE firmware — test; fall back to polling `ESC!?` after `PRINT`.
- Layout: `SIZE w mm,h mm` · `GAP g mm,o mm` (or `BLINE` for black mark) · `DIRECTION 0|1` · `REFERENCE x,y` ·
  `DENSITY 0-15` · `SPEED n` · `CLS` · `PRINT copies[,dup]`.
- Barcode: `BARCODE x,y,"128",height,readable(0-3),rotation(0/90/180/270),narrow,wide,"content"`
  ("128" auto-switches subsets A/B/C; "128M" manual with `!104` style control codes).
- QR: `QRCODE x,y,ECC(L/M/Q/H),cellwidth(1-10),A|M,rotation,[M1|M2,S0-S8,]"content"` (use `M2` for phone readers;
  not supported on the oldest TSPL-only models — TSPL2 printers are fine).
- Text: `TEXT x,y,"font",rotation,xmul,ymul,[align,]"content"` with built-in bitmap fonts "1"…"5" (8×12 … 32×48 dots)
  and "0" scalable. Escape `"` inside strings as `\["]`.
- Bitmap: `BITMAP x,y,widthBytes,height,mode(0/1/2),<raw 1-bpp rows>` — 0 = black on TSC bitmaps (inverted vs PNG;
  verify on site). Use this for **Thai text**: the 2014 CODEPAGE table has 437/850/852/…/1250-1258/932/936/949/950/
  UTF-8/ISO-8859-x but **no Thai (874/TIS-620)**; the clean approach is host-side rendering (Noto Sans Thai → 1-bpp
  → `BITMAP`), or download a Thai TTF with the Diagnostic Tool and use `CODEPAGE UTF-8` + `TEXT …,"NotoThai.TTF"`.
- Windows driver name: "4BARCODE 4B-2082A" (Seagull). Linux/CUPS: Arkscan ships a Linux driver/PPD for its rebadges;
  community reports of using the TSC TTP-244 PPD with "stopped" jobs — for our adapter **bypass CUPS entirely** and
  write TSPL to TCP 9100 (or `/dev/usb/lp0` via `usblp` when on USB). Sources: https://www.arkscan.com/linux-printer-driver ,
  https://www.arkscan.com/technical-support/download

### Minimal TSPL2 wristband example (Code-128 + QR)
Assumes a 50 mm wide × 250 mm long wristband fed lengthwise, gap-sensed. **Replace `SIZE`/`GAP` with measured values**
(typical thermal wristbands are 25 mm × 254 mm; if the park's bands are 25 mm wide, use `SIZE 25 mm,254 mm` and halve
the x-coordinates). 203 dpi = 8 dots/mm, so 50 mm = 400 dots across.

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
Send as one TCP write to `<ip>:9100`, then read the socket for `{00,00001}` (SET RESPONSE) or poll `ESC!?` until it
returns `00`. Line endings: TSPL accepts `\r\n` or `\n`; use `\r\n`.

### Adapter parameters — 4B-2082A
```yaml
transport: tcp            # raw socket; USB fallback = /dev/usb/lp0 (usblp), not CUPS
host: <static IP on 192.168.88.x>   # printer defaults to DHCP → set static via DiagTool/web page
port: 9100                # [unconfirmed on 4BARCODE; TSC default]
language: TSPL2           # ZPL/EPL translation exists on the family but code TSPL first
line_ending: "\r\n"
encoding: ascii           # label text; Thai via BITMAP (host-rendered 1-bpp) or downloaded TTF + CODEPAGE UTF-8
dpi: 203                  # [inferred from model number; confirm on self-test page]
dots_per_mm: 8
media: { width_mm: 50, length_mm: 250, gap_mm: 3, sensing: gap }   # measure on site; may be 25 x 254
status_poll: "\x1b!?"     # 1 byte; 0x00 ready; bit flags 01 head-open 02 jam 04 paper-out 08 ribbon 10 pause 20 printing 80 other
status_ext:  "\x1b!S"     # optional, <STX>xxxx<ETX>\r\n; [unconfirmed on this firmware]
identify:    "~!T"        # model string; "~!I" codepage,country; "~!@" mileage
per_label_ack: "SET RESPONSE ON"   # expect "{SS,NNNNN}" per label; fallback to polling
cancel_all:  "\x1b!."     # feed one label "\x1b!F"; reset "\x1b!R"
cut_kick: none            # no cutter, no drawer on wristband printer; SET TEAR ON
timeouts: { connect_ms: 2000, write_ms: 5000, status_ms: 1000, job_complete_ms: 15000 }
concurrency: 1            # one TCP session at a time per printer
```

### Simulator must reproduce — 4B-2082A
- Listen on TCP 9100; accept **one** connection at a time (refuse/queue a second one).
- Parse a TSPL job: `SIZE`, `GAP`/`BLINE`, `DIRECTION`, `REFERENCE`, `DENSITY`, `SPEED`, `SET TEAR|RESPONSE`, `CLS`,
  `TEXT`, `BARCODE`, `QRCODE`, `BITMAP` (binary payload of `widthBytes*height` after the comma), `PRINT n[,m]`.
  Render a PNG per label (so tests can eyeball/compare) and count labels printed.
- Reply to immediate commands mid-stream and even while "in error": `ESC!?` → 1 status byte;
  `ESC!S` → `\x02@@@@\x03\r\n`-style 4-char status; `~!T` → e.g. `4B-2082A\r`; `~!I` → `850, 001\r`;
  `~!@`/`~!A` → numbers + `\r`; `~!F` → names + `\x1a`.
- Simulated states settable by a test hook: paper-out (0x04), head-open (0x01), paper-jam (0x02), pause (0x10),
  printing (0x20) held for a configurable duration per label at the configured ips.
- With `SET RESPONSE ON` emit `{00,00001}` … per label after each `PRINT`; with `BATCH` one line per job.
- Ignore unknown commands silently (real firmware does), keep a "dump mode" flag that echoes raw bytes if `~!D` is sent.
- Power-on defaults: DHCP-style unknown IP until "configured"; speed 5, density 8, code page 850, IP shown on a
  fake "self-test" endpoint.

### Unknowns to confirm on site — 4B-2082A
1. Model string, F/W version, dpi and max width from the self-test page (`~!T` over TCP once the IP is known).
2. Whether TCP 9100 is open by default and whether the web page (`http://<ip>/`) is present on this Ethernet module.
3. Wristband media geometry (width, length, gap vs black mark, print side) and whether the printer has a cutter option.
4. Whether `ESC!S`, `SET RESPONSE` and the ZPL/EPL translators are present in this firmware.
5. Actual print darkness/speed that gives scannable Code-128 at 8 ips on the wristband stock.
6. Whether the printer accepts a second TCP connection while printing (refuse vs. stall).

---

## 2. Barcode scanner — Zebra DS22 series (DS2208 corded / DS2278 cordless + CR2278-PC cradle)

### Models and arrangement
- Two models: **DS2208 (corded; USB, RS-232 or keyboard-wedge cable)** and **DS2278 (cordless; Bluetooth 4.0 with
  BLE; CR2278-PC presentation cradle)**; identical imager/decoding otherwise.
  Sources: https://www.zebra.com/us/en/products/scanners/general-purpose-handheld-scanners/ds2200-series.html ,
  https://www.zpsstore.com/blog/zebra-ds2208-ds2278-scanner-review-top-general-purpose-scanners/
- Cradle: "The CR2278-PC cordless presentation cradle serves as a charger, radio communication interface, and host
  communication interface… receiving digital scanner data via a Bluetooth radio, and sending that data to the host
  through an attached cable." Only the DS2278 works with the CR2278-PC. The cradle pairs point-to-point (one scanner);
  pairing on insertion ("Pair on Contacts") is enabled by default. Source: DS2278 PRG ch.1 and ch.6 (`ds2278.txt`).
- Radio: "Bluetooth Version 4.0 with BLE… Class 2: Minimum 30 ft (10 m) and up to 300 ft (100 m) when paired with
  CR2278 cradle… Serial Port and HID Profiles". Default host type is **Cradle Bluetooth Classic** (Cradle LE selectable;
  LE is "up to 7 times slower"). Source: DS2278 PRG Table 4-2 and ch.6.
- The scanner can also pair **directly** to a host without the cradle: HID Bluetooth Classic / HID BLE (keyboard),
  SPP Bluetooth Classic (serial), SSI (Zebra SDK). Source: DS2278 PRG ch.6 "Bluetooth Technology Profile Support".
- Auto-reconnect when out of range: default "Auto-Reconnect Immediately"; reconnect attempt interval default 30 s;
  optional "Beep on Reconnect Attempt" (5 high beeps every 5 s). Batch mode can buffer scans while out of range.
  Source: DS2278 PRG ch.6 (Auto-Reconnect, Reconnect Attempt Interval, Batch Mode).
- The DS2278's **Micro-USB port is charge-only**: "The Micro USB cable is a charge only cable… The digital scanner
  enumerates as a CDC device when the USB connector is plugged into a PC host" (only so charging starts; an
  "HID Device Conversion" bar code avoids the enumeration delay). Do not plan data over the scanner's micro-USB.
  Source: DS2278 PRG ch.1 "Charging Using the Micro USB Cable".

### USB host modes (set by scanning bar codes; the cradle cable carries them to the host)
- USB Device Type options: **USB Keyboard HID (default)**, IBM Table-Top USB, IBM Hand-Held USB, OPOS (IBM hand-held
  with full disable), **USB CDC Host**, **SSI over USB CDC**, SNAPI with/without imaging, USB HID POS (Win10 UWP).
  "When changing USB Device Types, the scanner resets and issues the standard startup beep sequences."
  Source: DS2278 PRG ch.8 "USB Device Type" (pp.8-5/8-6).
- CDC caveat: install a CDC driver first on Windows or the scanner can stall at enumeration; recovery = unplug/replug,
  or hold the trigger 10 s at power-up to boot with an alternate USB configuration, then scan another device type.
  On Linux `cdc_acm` is built in — no driver needed. Source: DS2278 PRG p.8-6.
- USB IDs (Symbol/Zebra VID **0x05E0**): **0x1200 = "Bar Code Scanner" (HID keyboard)**, **0x1701 = "Bar Code Scanner
  (CDC)"**, 0x1900 = "SNAPI Imaging Device". Linux CDC device node: `/dev/ttyACM0` (owned `root:dialout`).
  Sources: https://devicehunt.com/view/type/usb/vendor/05E0/device/1200 ,
  https://the-sz.com/products/usbid/index.php?v=0x05E0 ,
  https://michael.mulqueen.me.uk/2026/09/reading-barcodes-zebra-ds4308-usb-cdc/
- CDC wire format (observed on a DS4308, same firmware family): "There's no length field, no header, and, by default,
  no terminator on the wire"; "The baud rate is nominal… 8N1 defaults are fine"; a record is complete after ~0.5 s of
  silence unless a suffix is programmed. Source: mulqueen article above.
- Keystroke pacing in HID mode: **USB Keystroke Delay = No Delay (default) / Medium 20 ms / Long 40 ms** between
  emulated keystrokes; "USB Fast HID" can be enabled/disabled ("Disable this if there are problems with transmission");
  "USB CAPS Lock Override" preserves case regardless of Caps Lock. Source: DS2278 PRG pp.8-8/8-10.
- Country keyboard type matters for HID: the host must be set to the same layout the scanner emulates (default North
  American), otherwise symbols like `-`/`_`/`:` transpose. Source: DS2278 PRG ch.8 "USB Device Type" note → Appendix B.

### Suffix / Enter configuration
- Quick way: scan **"Add Enter Key (Carriage Return/Line Feed)"** (Miscellaneous Scanner Parameters) or "Tab Key".
  Source: DS2278 PRG p.5-31.
- Precise way: **Scan Data Transmission Format, parameter #235** — `*Data As Is (0)` default, `<DATA><SUFFIX 1> (1)`,
  `<DATA><SUFFIX 2> (2)`, `<DATA><SUFFIX 1><SUFFIX 2> (3)`, `<PREFIX><DATA> (4)` …; **Suffix 1 value default = 7013
  ("Enter")**, changed by scanning "Scan Suffix 1" then four numeric bar codes (Appendix I ASCII table; e.g. 7009 = Tab).
  Source: DS2278 PRG pp.5-33/5-34 and Table I-7.
- To *disable* Enter: set format back to "Data As Is (0)" (or "Data Format Cancel").
- Semantics of 7013 differ by host: in HID keyboard mode it is the **Enter keystroke** (no character is inserted; a browser
  sees `keydown key="Enter"`); the PRG notes "SSI interprets… 7013 … as CR only"; in plain USB CDC mode the mulqueen
  observation is *no terminator* unless a suffix is programmed — so the adapter must accept `\r`, `\n`, `\r\n` **or**
  a quiet-gap as the record delimiter. Sources: DS2278 PRG p.9-11 note; mulqueen article.
- 123Scan (Windows) builds a configuration bar code / pushes config over USB; Scan-To-Connect (Windows/Android)
  generates BT pairing bar codes; Scanner Control App (iOS/Android) for BLE. Source: DS2278 PRG ch.2.

### Symbologies, latency, iPad
- 2D: PDF417, MicroPDF417, DataMatrix, **QR Code**, MicroQR, Aztec, MaxiCode, Han Xin; 1D: Code 128/39/93/11, Codabar,
  MSI, UPC/EAN, I2of5, GS1 DataBar etc. Source: DS2278 PRG Table 4-2 "Symbol Decode Capability".
- Scan-to-host latency: **not published** by Zebra. Contributing factors documented: Bluetooth Classic vs LE (LE ≈ 7×
  slower), "Auto-Reconnect on Bar Code Data" adds a reconnection delay before the first characters, keystroke delay
  0/20/40 ms × characters. Budget ≈ 100–300 ms in HID mode for a 20-char code **[estimate — measure on site]**.
- iOS/iPad: the PRG's "Apple iOS Virtual Keyboard Toggle" (parameter #1114, double-press trigger opens/closes the iOS
  keyboard) applies to **Bluetooth HID direct to the iPad**; a cradle→USB HID keyboard on iPadOS is a hardware keyboard
  (iPadOS hides the on-screen keyboard while one is attached — general iPadOS behaviour, **[unconfirmed]** for this
  cradle; Safari receives keystrokes only into the focused field). Source: DS2278 PRG p.6-16/6-17.
- Linux SDK: Zebra "Scanner SDK for Linux" (CoreScanner daemon `cscore`) supports SNAPI, IBMHID, HIDKB; Debian packages
  including ARM (Raspbian/ARM7L documented; **[unconfirmed]** arm64 for Pi 5). Not needed if we use HID or CDC directly.
  Sources: https://techdocs.zebra.com/dcs/scanners/sdk-linux/about/ , https://techdocs.zebra.com/dcs/scanners/sdk-linux/setup/

### Recommended host-side handling
- **On the iPad/browser (current setup, HID keyboard):** a global `keydown` listener that accumulates printable keys and
  commits on `key === "Enter"`; treat a burst as one scan if inter-key gap < ~50 ms and total length ≥ 6; discard if the
  burst exceeds ~500 ms without Enter (typed by a human). Keep a hidden focused input as fallback for iPadOS.
- **On the Linux box (preferred for the branch agent):** either (a) leave HID keyboard mode and read
  `/dev/input/by-id/usb-Symbol_Technologies__Inc__2008_Symbol_Bar_Code_Scanner-event-kbd` via evdev with an exclusive
  grab (`EVIOCGRAB`) so keystrokes never reach a console/desktop; or (b) switch to **USB CDC Host** (05E0:1701 →
  `/dev/ttyACM0`, 8N1, baud irrelevant), program Suffix 1 = CR and use `\r` as the delimiter, with a 500 ms quiet-gap
  fallback. (b) gives clean byte records and a stable `/dev/serial/by-id/usb-Symbol_Technologies…` name; (a) needs no
  scanner reconfiguration. Both keep the cradle/BT arrangement unchanged.

### Adapter parameters — DS22xx
```yaml
transport_primary: usb-hid-keyboard   # cradle → USB; VID 0x05E0 PID 0x1200
transport_alternative: usb-cdc-acm    # scan "USB CDC Host"; VID 0x05E0 PID 0x1701 → /dev/ttyACM*, 8N1 (baud nominal)
suffix: enter                          # param 235 = 1 (<DATA><SUFFIX1>), Suffix1 = 7013
record_delimiters: ["\r\n", "\r", "\n"]
quiet_gap_ms: 500                      # CDC fallback when no suffix is programmed
keystroke_burst_gap_ms: 50             # HID: gap threshold between keys of one scan
keystroke_delay_setting: none          # 0 ms default; set 20 ms only if the iPad drops characters
min_len: 6
max_len: 128
symbologies_enabled: [code128, qr]     # disable the rest on the scanner to avoid false reads
keyboard_layout: us                    # host and scanner must match
reconnect: auto-immediately            # scanner default; Bluetooth Classic to cradle
```

### Simulator must reproduce — DS22xx
- Emit one scan as a burst of characters followed by the configured delimiter (`Enter` key event in HID mode; `\r` /
  `\r\n` / nothing in CDC mode), with a configurable inter-character delay (0 / 20 / 40 ms) and an optional first-scan
  reconnection delay (hundreds of ms) to mimic "Auto-Reconnect on Bar Code Data".
- Modes: `hid` (inject key events into the page/evdev) and `cdc` (a pty or TCP stream of raw bytes).
- Symbology behaviour: Code-128 and QR payloads; optional AIM/Symbol code-ID prefix (`]C0` for Code 128, `]Q1` for QR)
  when the "Transmit Code ID" option is simulated on.
- Fault injection: dropped characters at high burst rate, a human typing slowly (should not be treated as a scan),
  duplicate scan within 1 s (double trigger), out-of-range (no output for N seconds then batch flush of buffered scans).

### Unknowns to confirm on site — DS22xx
1. Which model is really installed (DS2208 corded vs DS2278 + CR2278-PC) and the exact cable (USB-A?) into the iPad.
2. Current programmed suffix (Enter only? CR/LF? prefix?), keystroke delay and keyboard country.
3. Whether the cradle is on a USB hub/adapter that also charges the iPad (power budget: cradle 500 mA typical).
4. Measured scan-to-Enter latency and whether any characters are lost at "No Delay".
5. Whether the site wants the scanner moved to the Linux box (CDC) or kept on the iPad (HID).

---

## 3. Receipt printer — WELLTECH G4 (80 mm, rebadged Xprinter XP-C260 family)

### Identity and spec
- Welltech (Thailand) lists "WELLTECH รุ่น G4 POS Direct Thermal Receipt Printer": **260 mm/s at 203 dpi**, 80 mm paper,
  auto cutter, **USB+LAN+WIFI**, RJ11 cash-drawer port, Windows XP–11 / Android / iOS / Mac / Linux, prints Thai
  ("รุ่นนี้อัพเกรดจาก XP-C260N" = "this model is upgraded from XP-C260N"; the page slug is `xp-c260m`).
  Source: https://www.welltechstore.com/product-page/xprinter-%E0%B8%A3-%E0%B8%99-xp-c260m-pos-direct-thermal-receipt-printer
- Welltech's driver page bundles the G1 (XP-N160II), G4, G5 and Xprinter XP-C300H under one
  "DRIVER & TOOL WELLTECH G series.rar" — i.e. the G series is Xprinter hardware with Welltech branding.
  Source: https://www.welltechstore.com/driver
- Xprinter XP-S260M/XP-C260 family spec: "Max. print speed: 260 mm/s"; "Column capacity: 576 dots/line (adjustable
  by command)"; "Paper width: 79.5±0.5mm"; cutter **Partial**; PSU "DC 24V/2.5A"; **"Cash drawer output: DC 24V/1A"**;
  "Emulation: ESC/POS"; "Input buffer: 128 Kbytes"; drivers Windows/JPOS/OPOS/Linux/Android/Mac; code pages listed
  are PC437/Katakana/PC850/860/863/865/West Europe/Greek/Hebrew/East Europe/Iran/WPC1252/PC866/PC852/PC858/IranII/
  Latvian/Arabic/PT151 — **Thai is not in the published list** (see Thai note below).
  Source: https://www.xprintertech.com/xp-s200m-xp-s260m-xp-s300m
- Windows driver: the XP-C260N "requires selecting XP-80C in the printer driver". Source: https://oemdrivers.com/printer-xprinter-xp-c260n

### ESC/POS conformance (Xprinter 80XX programmer manual — `xprinter80xx.txt`)
- `ESC @` initialise; `ESC = n` select peripheral (printer ignores data except DLE EOT/ENQ/DC4 when deselected).
- **Real-time status `DLE EOT n` (10 04 n), n = 1..4**, one byte each, "executed even when the printer is off-line, the
  receive buffer is full, or there is an error status":
  n=1 printer: bit2 (0x04) drawer open (per this manual "one or two cash drawer open"), bit3 (0x08) off-line;
  n=2 off-line: bit2 (0x04) cover open, bit3 (0x08) feeding by FEED button, bit5 (0x20) paper-end stop, bit6 (0x40) error;
  n=3 error: bit3 (0x08) auto-cutter error, bit5 (0x20) unrecoverable, bit6 (0x40) auto-recoverable;
  n=4 paper: bits2-3 (0x0C) near-end, bits5-6 (0x60) paper end. Fixed bits: bit1 and bit4 always 1 (so an idle "OK"
  reply is 0x12), bit0 and bit7 always 0.
- `DLE ENQ n` (n=1 recover & restart from the line where the error occurred, n=2 recover after clearing buffers —
  only effective after an auto-cutter error).
- `GS r n` transmit paper (n=1/49) or drawer (n=2/50) status — but this manual says "**This command just effect the
  serial interface**" → do not rely on it over LAN/USB; use DLE EOT.
- `GS a n` Automatic Status Back: enable bits (0x04 error, 0x10? per table: cover/online/error/paper groups) → printer
  pushes 4 status bytes on change. **[unconfirmed]** that ASB is delivered over the LAN interface on this firmware;
  poll DLE EOT as baseline and treat ASB as a bonus if it works.
- Cash drawer: `ESC p m t1 t2` (1B 70 m t1 t2), m = 0/48 → drawer pin 2, m = 1/49 → pin 5; on-time = t1×2 ms,
  off-time = t2×2 ms (if t2 < t1, off = t1×2 ms). Typical kick: `1B 70 00 19 FA` (50 ms on / 500 ms off).
- Cut: `GS V m` with m = 0/48 or 1/49 → **partial cut only ("Only the partial cut is available; there is no full cut")**;
  `GS V 66 n` feeds to cut position + n×vertical unit then partial-cuts. Send `GS V 66 0` (1D 56 42 00) as the canonical cut.
- Raster image: `GS v 0 m xL xH yL yH d1..dk` (1D 76 30 m …), m = 0 normal, 1 double-width, 2 double-height, 3 quad;
  width in bytes = xL + xH×256, height in dots.
- Code page: `ESC t n` (1B 74 n) with n = 0–10, 16–21 in this manual (0 PC437, 1 Katakana, 2 PC850, 3 PC860, 4 PC863,
  5 PC865, 6 West Europe, 7 Greek, 8 Hebrew, 9 PC755 East Europe, 10 Iran, 16 WPC1252, 17 PC866, 18 PC852, 19 PC858,
  20 IranII, 21 Latvian). Newer Xprinter firmware exposes many more pages; **Thai appears as code page 255 in
  Xprinter's own driver/utility mapping** ("255": "Thai") and Sunmi (also Xprinter-derived) maps 21 → CP874.
  Sources: https://github.com/receipt-print-hq/escpos-printer-db/issues/36 ,
  https://github.com/receipt-print-hq/escpos-printer-db/blob/master/data/profile/Sunmi-V2.yml
- QR: `GS ( k pL pH cn fn …` with cn = 49 (fn 65 model, 67 module size, 69 EC level, 80 store data, 81 print) — the
  standard Epson sequence; the 80XX manual documents the GS ( k family (pp.40–43 of the PDF). **[unconfirmed]** on the
  G4's firmware — the alternative is host-rendered raster, which always works.
- Thai text: because code-page numbers vary across Xprinter firmware and Thai combining marks (above/below vowels,
  tone marks) render poorly on single-byte code pages, **render Thai lines on the host (Noto Sans Thai) and send them as
  `GS v 0` raster**; use code page 255 only if the self-test page lists it and a test print looks right.

### Network / WiFi / web page
- Factory default IP **192.168.123.100**; self-test: "turn off the printer, then turn on the printer while holding down
  the FEED button, 2 or 3 seconds later, release" → prints a page titled "self test" with the IP.
  Source: Xprinter "How to configure IP address for Ethernet port printers" (`xprinter_ip.txt`),
  https://filedn.com/l3YHTxXEORjSP7vqHLwob1f/Xprinter/Tech%20Docs/configure%20IP%20address%20printable.pdf
- Three ways to change the IP: (a) the Windows test tool ("Port NET, Printer Type XP-80, Local IP, Printer IP, New IP →
  set up IP"; may fail through a router — use a switch or direct cable); (b) a **vendor-specific command over USB/serial**
  `1F 1B 1F 91 00 49 50 ip1 ip2 ip3 ip4` (example `1F1B1F91004950C0A81364` = 192.168.19.100), printer beeps once;
  (c) **web page** `http://192.168.123.100` → "Configuration" → IP/subnet/gateway → Save ("only the printers and computer
  within the same network segment are allowed to enter the WEB configuration interface"). The web UI on Xprinter LAN
  boards also offers Fixed IP vs DHCP Client. Source: same document; https://support.skyservice.pro/en/xprinter-wi-fi-setup/
- WiFi: Welltech/Xprinter WiFi models are configured with an Xprinter WiFi utility or via the web page after a wired
  connection; details for the G4 were not reachable **[unconfirmed]**. For a fixed till, **use the LAN port** and leave WiFi off.
- Raw print port **9100**; one session at a time (see §6).

### Adapter parameters — Welltech G4
```yaml
transport: tcp
host: <static IP>            # factory 192.168.123.100 → set via web page or test tool
port: 9100
language: ESC/POS
dots_per_line: 576           # 80 mm paper, 72 mm print width, 203 dpi
paper_width_mm: 80
encoding_ascii: cp437        # ESC t 0
encoding_thai: raster        # host-rendered GS v 0; optional trial: ESC t 255 + TIS-620 bytes [unconfirmed]
init: "\x1b@"
status_poll: ["\x10\x04\x01", "\x10\x04\x02", "\x10\x04\x03", "\x10\x04\x04"]   # 1 byte each; idle OK = 0x12
status_bits: { online: {n: 1, bit: 3, set_means: offline}, cover_open: {n: 2, bit: 2}, paper_end: {n: 2, bit: 5},
               error: {n: 2, bit: 6}, cutter_error: {n: 3, bit: 3}, near_end: {n: 4, bits: [2,3]}, paper_out: {n: 4, bits: [5,6]} }
asb: optional                # GS a; verify over LAN before relying on it
cut: "\x1dV\x42\x00"          # GS V 66 0 (partial); "\x1dV\x01" also partial
drawer_kick: "\x1bp\x00\x19\xfa"   # ESC p 0 25 250 → pin 2, 50 ms on / 500 ms off; drawer 24 V 1 A RJ11
drawer_status: "\x10\x04\x01"       # bit 2
qr: gs_paren_k_or_raster     # prefer raster
image: "\x1dv0"              # GS v 0 m xL xH yL yH
timeouts: { connect_ms: 2000, write_ms: 5000, status_ms: 800, drain_after_cut_ms: 300 }
concurrency: 1
```

### Simulator must reproduce — Welltech G4
- TCP 9100, single session, byte-stream ESC/POS parser tolerant of interleaved `DLE EOT n` (answer immediately with the
  one status byte, even in error state, even mid-command), `DLE ENQ`, `ESC @`, `ESC t`, `ESC !`, `GS !`, `ESC a`, `ESC d`,
  `LF`, `GS V`, `GS v 0`, `GS ( k`, `ESC p`, `GS a`, `GS r`.
- Render a receipt image (576 px wide) per cut so tests can assert content; keep a cut counter and a drawer-kick log with
  pulse timings.
- Status model with fixed bits (bit1, bit4 = 1) and injectable faults: cover open, paper near-end, paper out, cutter error,
  offline; when paper out, refuse to render further lines until "paper loaded".
- Optional ASB push of 4 bytes on state change when `GS a` enabled.
- Vendor extras: respond to the `1F 1B 1F 91 00 49 50 …` IP-set command with a "beep" log entry; a fake "self-test" that
  returns the model, firmware, IP and the code-page list (so the Thai code-page probe can be tested).

### Unknowns to confirm on site — Welltech G4
1. Firmware string and code-page list on the self-test page (does "255 Thai" or any Thai page exist?).
2. Whether ASB (`GS a`) and `GS ( k` QR work over LAN on this firmware.
3. Exact drawer pulse the SCB/park drawer needs (some drawers need ≥ 100 ms on-time).
4. Whether the LAN board offers DHCP and the web page (`http://<ip>/`) — and its password, if any.
5. Behaviour of a second TCP connection during a job (refused vs. stalled) and whether the socket closes after idle.

---

## 4. Kitchen/receipt printers ×3 — Xprinter XP-80 series (XP-80C / XP-T80Q / XP-80A / XP-Q80C…)

- Xprinter's 80 mm desktop range shares the ESC/POS command set above. Reference model specs:
  **XP-Q80C**: 230 mm/s; "576 dots/line or 512 dots/line"; interfaces "USB / USB+Serial (Optional: USB+Bluetooth/
  USB+Wifi)" and "Lan (Optional: USB+Lan)"; cutter **Partial**, 1.5 M cuts; "Cash drawer output: DC 24V/1A";
  "Printer input DC 24V/2.5A"; emulation "ESC / POS"; buffer 64/256 KB; code-page list identical to the C260 family
  (no Thai listed). Source: https://www.xprintertech.com/xp-q80c
- **XP-80C** is the classic 80 mm model; sold as USB, USB+Serial, USB+Serial+LAN, and LAN-only variants; the XP-80C
  driver is also what the C260 family uses. Sources: https://www.xprintertech.com/all-products/xprinter-xp-80c ,
  https://oemdrivers.com/printer-xprinter-xp-c260n
- **XP-T80B** (USB+LAN) and **XP-N160II** (USB) are the ones Welltech Thailand stocks; XP-T80Q exists with USB+LAN
  variants (manual on manuals.plus, not reachable from here). Sources: https://www.welltechstore.com/receiptprinter ,
  https://manuals.plus/xprinter/xp-t80q-thermal-receipt-printer-manual
- Which models have Ethernet: any model whose suffix/variant includes "L"/"LAN" or is listed as "USB+LAN"; XP-80C-L,
  XP-T80B/Q (USB+LAN), XP-Q80C LAN option, XP-C260 family (USB+LAN / +WiFi). Kitchen units are almost certainly
  USB+LAN variants since they are on the switch — confirm from the rear panel (RJ45 present) and self-test page.
- Default IP, self-test, IP-change methods, web page: **identical to §3** (192.168.123.100; FEED at power-on; test tool /
  `1F 1B 1F 91 00 49 50 ip` / web "Configuration"). Source: `xprinter_ip.txt`.
- Status commands, cut, drawer, raster, code pages: **identical to §3** (same 80XX programmer manual applies; `GS r` is
  serial-only; `GS V` partial only).
- Telling the model apart: the self-test page prints the model/firmware/interface/IP; the rating label on the underside
  carries the model and serial **[general practice — [unconfirmed] label format]**; the Windows driver name is not reliable
  (many models install as "XP-80C").
- Thai: same guidance as §3 — raster for Thai, code page probe only as an experiment.

### Adapter parameters — XP-80 series
```yaml
# same as Welltech G4 except:
model_hint: XP-80C | XP-T80Q | XP-80A | XP-Q80C   # read from self-test page
dots_per_line: 576            # some units are 512 — read from self-test/config
speed_mm_s: 200-260           # model dependent; irrelevant to protocol
drawer_kick: "\x1bp\x00\x19\xfa"   # kitchen printers usually have no drawer — leave unused
kitchen_bell: "\x07"          # BEL — some firmwares beep; [unconfirmed]
```

### Simulator must reproduce — XP-80 series
- Same as the G4 simulator with per-instance config for `dots_per_line` (576/512) and optionally a slower "print" delay
  per line to mimic 200–230 mm/s; three instances on distinct ports/IPs so routing (receipt vs kitchen 1/2) can be tested.
- Fake self-test output that names a distinct model per instance ("XP-80C", "XP-T80Q") to exercise the model-detection code.

### Unknowns to confirm on site — XP-80 series
1. Exact model and interface variant of each of the three units (rear panel + self-test page).
2. 576 vs 512 dots/line per unit.
3. Whether all three are on LAN (vs one on USB) and their current IPs (all may still be 192.168.123.100 → conflicts!).
4. Cutter presence on kitchen units (some kitchen installs use tear-bar only).

---

## 5. Card terminals — NEXGO N5 ×2 (GHL LinkPOS) and PAX A920Pro ×2 (Digio Direct Terminal)

### NEXGO N5 (Shenzhen Xinguodu Technology)
- Terminal: Android 7.x; **"Peripheral Ports: 1 x Micro-USB OTG"** — the only wired port on the handset (plus
  SIM/SAM/SD); 5200 mAh; 4G/3G/2G, Wi-Fi 2.4 G (5 G optional), Bluetooth; 58 mm built-in printer; adapter 5 V/2 A.
  Source: NEXGO N5 datasheet https://www.nexgoglobal.com/es/static/upload/file/20230301/1677654379518228.pdf ;
  N5 user manual v5.1 https://www.nexgoglobal.com/es/static/upload/file/20230301/1677654357630880.pdf (`nexgo_n5.txt`)
- Three official docks (pogo-pin cradle, Micro-USB 5 V/2 A input, 1.2 A charge):
  1. **Charging Docking Station** — charge only.
  2. **Wi-Fi Docking Station** — "a charger and also served as a **router** that provides Wi-Fi to terminals";
     RJ45 LAN 10/100 in; "LAN Port IP 192.168.1.1", login http://192.168.1.1, username "null", password
     "Nexgo300130", SSID = "NEXGO" + last 4 of MAC, 802.11b/g/n. → **The terminal is not on the wire**: it joins the
     dock's Wi-Fi and sits behind the dock's NAT (192.168.1.x) unless the dock is bridged **[unconfirmed]**. So "LAN via
     docking station" does **not** give the N5 an address on 192.168.88.x by default.
  3. **Multifunctional Docking Station** — "Five peripheral ports on the bottom, including the RS232, LAN port, and
     USB-A ports. It is available to connect multiple devices, like the cashier": RJ45 LAN 10/100, **RJ45-jack RS232**,
     2× USB-A 2.0 host. Whether the LAN is presented to the terminal as Ethernet over the pogo pins is **not stated
     [unconfirmed]** — the wording implies yes; verify in Android Settings when docked. Dock size 191×89.72×67.10 mm.
  Source: datasheet p.3 and manual p.13–14.
- **ECR physical link for GHL LinkPOS ("USB serial"):** the handset's **Micro-USB OTG** port (USB-A→Micro-B cable to the
  Linux box, terminal in USB *device* role). How the N5 exposes a serial channel (CDC-ACM gadget → `/dev/ttyACM*`,
  vs. an Android "accessory"/vendor driver) and its **VID/PID are not published** — GHL's integration notes (Xilnex KB)
  cover only the software/certificate setup, not the cable/driver. **[unconfirmed — ask GHL for the Windows driver INF;
  the VID/PID in it tells us whether Linux `cdc_acm` will bind.]**
  Source: https://support.xilnex.com/portal/en/kb/articles/setting-up-ghl-nexgo
- Alternative ECR path: the Multifunctional dock's RS232 (RJ45 jack; needs NEXGO's RJ45→DB9 cable and a USB-RS232
  adapter on the Linux box). Whether GHL LinkPOS supports the dock serial path and its baud rate: **[unconfirmed]**.
- Whether ECR mode must be enabled in the terminal app: GHL's LinkPOS app has an integration/terminal-ID/certificate
  setup done via the GHL portal (per Xilnex KB); a physical "ECR/integration mode" switch on the handset is **[unconfirmed]**
  — confirm with GHL Thailand.
- Power: the handset charges through the dock pogo pins or its Micro-USB; if the Micro-USB is used for ECR data the dock
  must supply charge (or the box's USB port must, 5 V ≥ 1 A) **[inferred]**.

### PAX A920Pro
- Terminal: "PAX Biz powered by Android 8.1"; **"Ports: 1 Type-C OTG | 6 PIN POGO PIN"**; comms "4G + Wi-Fi 2.4GHz +
  Bluetooth" (optional 5 GHz + BT 5.0); 5150 mAh; adapter 5 V/2 A; top-side barcode scanner.
  Source: PAX A920Pro datasheet https://www.pax.us/wp-content/uploads/2023/12/A920Pro-Datasheet.pdf
- Bases: **L920Pro-BC** charging base — 1 power port (Type-C), **no Ethernet**; **L920Pro-BE** "Charging + Wireless" —
  Wi-Fi 5 GHz + BT 5.0, **1 RS232 (RJ45)**, **1 Ethernet (RJ45)**, 1 power (Type-C), **1 Type-C (Device)**, 1 USB (Host).
  Older A920 bases: L920-BC (charge only, Micro-USB), L920-BE (RS232 RJ45, Ethernet RJ45 100M, Micro-USB device, USB-A host),
  and reseller-listed L920-BM/-BF (RS232, Ethernet, 2× USB host). Bases are "not included with the A920 device".
  Sources: A920Pro datasheet; https://www.pax.us/wp-content/uploads/2023/01/L920-Data-Sheet.pdf ;
  https://www.discountcreditcardsupply.com/products/pax-a920-multifunctional-charging-base ;
  https://help.posspecialists.com/portal/en/kb/articles/pax-a920-setup-guide
- **Ethernet via dock reaches the terminal** (on -BE/-BM bases): "To connect the A920 to a local network with an Ethernet
  connection, you must use the device with the L920 base"; Settings (password 9876 or pax9876@@) → Ethernet →
  Ethernet Configuration → Static/DHCP; the terminal "keeps the same IP setting" when lifted (falls back to Wi-Fi).
  So Ethernet is standard **only with the -BE/-BM base, not the -BC charging base**.
  Sources: https://help.posspecialists.com/portal/en/kb/articles/pax-a920-setup-guide ,
  https://support.heartlandretail.us/en/articles/4551123-pax-a920-setup-guide
- **ECR physical link:** PAX apps expose "Host/ECR Communication" with **USB / Ethernet / Serial** choices (e.g. PXRetailer
  Setup Menu, password pax12345: "Make sure 'USB' is checked (ethernet and serial should not be selected)").
  In USB mode the handset is a USB *device* on its **Type-C OTG** port and enumerates as a CDC-ACM serial port:
  Windows uses "PAX Technology USB Serial Port (CDC)" (`paxcdc.inf`, v1.1.1.0 2020) with **VID 0x2FB8** and a wide PID
  range (0102, 010C, 010D … 2FFA, some multi-interface `&MI_xx`) plus VID 9908/PID 9030. On Linux `cdc_acm` binds these
  → `/dev/ttyACM*`. **[unconfirmed]** exact PID of the A920Pro in Digio's build and whether Digio's "Direct Terminal"
  app selects USB-CDC or the base RS232 — ask Digio for their ECR cable/driver note.
  Sources: https://certek.com/kb4/knowledge-base/programming-the-pax-a920-pro/ ,
  https://treexy.com/products/driver-fusion/database/ports-com-lpt-serial/pax-technology/usb-serial-port-cdc/
- Alternative ECR paths on the L920Pro-BE base: RS232 (RJ45 jack → PAX RJ45-DB9 cable → USB-RS232 adapter on the box) or
  the base's "Type-C (Device)" port (base-to-host USB) **[unconfirmed]** whether the device port relays the handset's CDC.
- Whether ECR mode must be enabled: yes — the Host/ECR Communication setting in the payment app selects the transport;
  Digio's app will have an equivalent (menu names unknown **[unconfirmed]**).

### Adapter parameters — card terminals (physical layer only; message formats are already specified)
```yaml
nexgo_n5:
  ecr_transport: usb-serial            # handset Micro-USB OTG (USB device role); VID/PID unknown → get from GHL driver INF
  linux_device: /dev/serial/by-id/<to be discovered>   # expect cdc_acm → ttyACM*; else vendor driver → escalate
  serial: { baud: <from GHL LinkPOS spec>, data: 8, parity: N, stop: 1 }   # LinkPOS XML doc governs
  alt_transport: dock-rs232            # Multifunctional dock RJ45-RS232 → DB9 → USB-RS232 adapter [unconfirmed support]
  lan: dock-wifi-router                # handset behind dock NAT 192.168.1.x; not addressable on 192.168.88.x by default
  power: dock-pogo or micro-usb 5V/2A
pax_a920pro:
  ecr_transport: usb-cdc-acm           # handset Type-C OTG; VID 0x2FB8, PID per unit (0102…2FFA) or 9908:9030
  linux_device: /dev/serial/by-id/usb-PAX_Technology_*   # verify name; add udev SYMLINK by serial
  serial: { baud: <from Digio Direct Terminal spec>, data: 8, parity: N, stop: 1 }   # BER-TLV doc governs
  alt_transport: base-rs232 (L920Pro-BE RJ45) | base-type-c-device
  lan: ethernet-via-base               # only with L920Pro-BE/-BM; Settings → Ethernet (pw 9876 / pax9876@@)
  terminal_setting: "Host/ECR Communication = USB"   # app-specific menu; Digio's equivalent to confirm
  power: base pogo (Type-C 5V/2A into base) or Type-C direct
```

### Simulator must reproduce — card terminals (transport behaviour)
- A pty/`socat` virtual serial device per terminal so the adapter opens `/dev/serial/by-id/...`-style paths; emulate
  hot-plug (device disappears when the handset is lifted/powered off, reappears with a new `ttyACM` number → tests that
  the adapter re-resolves by-id symlinks, not raw numbers).
- Framing timing: the real handset only answers while its ECR app is in the foreground/ready — simulate "not ready"
  (no reply/timeout), "busy" and slow customer interaction (30–90 s before the response frame).
- Message-level behaviour is out of scope here (LinkPOS XML / Digio BER-TLV specs already held).

### Unknowns to confirm on site — card terminals
1. Which dock each terminal actually sits in (NEXGO: charging vs Wi-Fi-router vs multifunctional; PAX: L920Pro-BC vs -BE).
2. NEXGO ECR: cable in use today (Micro-USB to what?), and `lsusb` VID/PID with the LinkPOS app in ECR mode.
3. PAX ECR: `lsusb` VID/PID in Digio's ECR mode; whether it is CDC (`cdc_acm`) or needs a vendor driver.
4. Whether the PAX handsets show an "Ethernet" interface when docked (i.e. the base is a -BE/-BM), and their IPs.
5. Whether GHL/Digio require a specific baud rate or handshake lines (DTR/RTS) on the serial link.
6. Whether either bank app supports TCP/IP ECR (which would remove the USB tether entirely).

---

## 6. Print-server host — Raspberry Pi 5 vs Intel mini PC (brief)

- **Raw 9100 is single-session.** "A raw print port serves one session at a time, so a second client is refused or left
  waiting"; recommended: open one connection per job, explicit connect/write timeouts, TCP keepalive, never leave a socket
  open, and make sure no forgotten CUPS/Windows queue elsewhere holds the port. Applies to all four printers above.
  Sources: https://www.proxynodes.com/guides/network-printer-port-9100 ,
  https://industrialmonitordirect.com/blogs/knowledgebase/proxying-escpos-thermal-printer-traffic-from-pos-systems
- **ModemManager grabs USB serial ports** (probes `ttyACM`/`ttyUSB` as modems; Raspberry Pi OS Bookworm ships it with
  NetworkManager and Pi 5 users report `ttyACM0` problems fixed by `systemctl stop ModemManager`). Fix with a udev rule on
  the **usb** subsystem (not tty): `ATTRS{idVendor}=="05e0", ATTRS{idProduct}=="1701", ENV{ID_MM_DEVICE_IGNORE}="1"`
  (repeat for 2fb8 PAX, NEXGO VID once known), or `systemctl disable --now ModemManager` since the box has no modem.
  Sources: https://modemmanager.org/docs/modemmanager/port-and-device-detection/ ,
  https://www.downtowndougbrown.com/2016/10/fix-for-usb-serial-port-being-opened-by-modemmanager-at-startup/ ,
  https://forums.raspberrypi.com/viewtopic.php?t=360121
- **brltty (Ubuntu desktop on an Intel NUC)** claims CP210x/FTDI USB-UART adapters (`ttyUSB0` "kidnapped" seconds after
  plug-in). Fix: `apt remove brltty` or comment its udev rules. Use Ubuntu Server / Debian without brltty for the box.
  Sources: https://bugs.launchpad.net/bugs/1958224 , https://support.arduino.cc/hc/en-us/articles/29350073597468-Resolve-BRLTTY-conflict-on-Linux
- **Stable device names:** open `/dev/serial/by-id/usb-<vendor>_<product>_<serial>-if00` (udev creates these by default)
  rather than `/dev/ttyACM0`; where two identical devices have no serial number, pin by port path (`/dev/serial/by-path/`)
  or write `SYMLINK+=` rules keyed on `ATTRS{serial}`/`KERNELS`. Add the service user to `dialout` (CDC nodes are
  `root:dialout`). Source: mulqueen article (dialout ownership); Debian udev defaults.
- **HID scanner on the box:** keep it out of the console — read `/dev/input/by-id/*-event-kbd` with an exclusive grab
  (evdev `EVIOCGRAB`); or switch the scanner to CDC (§2). (Recommendation; no vendor source.)
- **node-serialport:** `@serialport/bindings-cpp` ships prebuilt binaries via `prebuildify-cross` for major platforms,
  including linux-arm64; when the Node ABI has no prebuild it falls back to `node-gyp` (needs `build-essential`,
  `python3`). Pin the Node LTS that has prebuilds and install `build-essential` on the Pi anyway. `NODE_MODULE_VERSION`
  mismatch errors mean the binary was built for a different Node — rebuild. Sources: https://serialport.io/docs/guide-installation/ ,
  https://serialport.io/docs/guide-platform-support/
- **ESC/POS libraries:** `escpos` (lsongdev) — last publish 3.0.0-alpha.6 six years ago, avoid; `node-thermal-printer`
  actively used (13.6 k weekly downloads); `esc-pos-encoder` ≥ 3.0 is a wrapper around `ReceiptPrinterEncoder`
  (`@point-of-sale/receipt-printer-encoder`) — a pure command encoder we can pair with Node's `net` (TCP 9100) and our own
  status poller. For TSPL, no library: string templates + `Buffer` for `BITMAP`.
  Sources: https://npmtrends.com/esc-pos-encoder-vs-escpos-vs-node-printer-vs-node-thermal-printer ,
  https://www.npmjs.com/package/esc-pos-encoder , https://www.npmjs.com/package/escpos
- **Pi 5 vs NUC:** functionally equivalent for four TCP printers + two USB serial terminals + one scanner. Pi 5: cheaper,
  arm64 (check every native module has arm64 prebuilds), SD-card wear (use an NVMe HAT or USB SSD), no RTC battery by
  default (needs NTP), and the ModemManager note above. Intel NUC: x86_64 prebuilds universal, more USB ports, easier to
  run Docker images unmodified; beware brltty on Ubuntu Desktop images. Either way run the adapter as a systemd service
  with `Restart=always` and udev-triggered device discovery, not fixed `/dev/ttyACMn` names.

---

## Cross-device summary of what changed vs. the park's hardware note
| Item in note | Finding |
|---|---|
| 4B-2082A language "unconfirmed (ZPL/EPL2/custom)" | **TSPL2 native** (TSC-class clone); EPL/ZPL/DPL translators exist on the family; auto-detect [inferred]. Code TSPL2. |
| 4B-2082A "203 dpi typical, ~50 mm" | 203 dpi and 2-inch **inferred** from the model-number scheme; family manual confirms DHCP default, web page, Diagnostic Tool, LED/self-test procedure. |
| DS22 "Bluetooth to cradle, USB HID keyboard, string + Enter" | Correct for DS2278 + CR2278-PC; Enter is Suffix 1 = 7013 (param 235); alternative USB CDC (05E0:1701 → ttyACM) available by scanning one bar code. |
| Welltech G4 | Rebadged **Xprinter XP-C260N/M**; 260 mm/s, 576 dots, partial cut only, drawer 24 V/1 A, default IP 192.168.123.100, web config; Thai best done as raster. |
| Xprinter XP-80 ×3 | Same protocol/IP defaults; `GS r` serial-only; model must be read from the self-test page. |
| NEXGO N5 "LAN via docking station" | Handset has **Micro-USB OTG only**; the Wi-Fi dock is a *router* (handset behind 192.168.1.x NAT); multifunctional dock has RS232/LAN/USB-A. ECR USB VID/PID unknown → ask GHL. |
| PAX A920Pro | **Type-C OTG** + pogo; USB ECR = CDC-ACM (VID 0x2FB8, `paxcdc.inf`); Ethernet only via L920Pro-BE/-BM base (Settings → Ethernet), not the -BC charging base. |
