# SCRUM-206 / S2-10a — the two EDC dialects, wire-level, from the vendor documents

READ-ONLY pass. Nothing edited, no git write commands, no servers.

## 0. Sources and how each was read

| Source | How read | Citation form used below |
|---|---|---|
| `imports/_vendor-docs/GHL-API-Integration-POS-to-SmartEDC-V1.4-SCB-Jan2025.pdf` (20 pp, "SMART POS API – Integration POS to SmartEDC for Siam Commercial Bank PCL", v1.4, last modified Sep 03 2024 — p.1; history table p.2) | `pdftotext -raw` and `-layout`; page-12 cell marks decoded out of the PDF's XObject dictionary with `pypdf` because they are not in the text layer | `GHL p.N` |
| `imports/_vendor-docs/Digio-TLV-LinkPOS-Spec.html` ("A920 Link-PoS-Spec", v2.21, 20 Oct 2025 — HTML ll.1‑6, l.163) | tags stripped **line-for-line**, so every line number below is the line number *in the original HTML file* | `Digio HTML:NNNN` (+ its own §) |
| `docs/architecture/DEVICE_INVENTORY.md` | **worktree file; `git status --porcelain` reports it clean, so it equals HEAD** | `DEVICE_INVENTORY.md:NN` |
| `packages/db/src/schema/fleet.ts`, `packages/db/src/seed/index.ts` | read at **HEAD** via `git show HEAD:<path>` (working tree is being edited by other agents) | `file:NN @HEAD` |
| `imports/_vendor-docs/README.md` | worktree | — |

The GHL PDF is **not committed** (`imports/` is local-only reference — `imports/_vendor-docs/README.md:19`,
`CLAUDE.md` repo-layout header). Fixtures written from it must live in the repo as
**hex/XML fixture files with citations**, not as a copy of the PDF.

---

## 1. Which terminal speaks which dialect (DEVICE_INVENTORY §2, §5)

| # | Device | Dialect | Link | Identity on file |
|---|---|---|---|---|
| 8 | EDC #1 NEXGO N5, SCB acquirer, app "SCB — OTO #1" | **GHL LinkPOS XML** | micro-USB OTG (handset's only wired port), USB serial | **TID `65703235`, MID `4648434010`** |
| 9 | EDC #2 NEXGO N5 | GHL LinkPOS XML | as above | **TID `65703236`, MID `4648434010`** |
| 10 | EDC #3 PAX A920Pro, deployed by Digio (Thailand), app "OTO — Sale / Void / Settlement" | **Digio Direct Terminal BER-TLV** | Type-C OTG as CDC-ACM, VID `2FB8` | **SN `1854355548`** — no TID/MID on file |
| 11 | EDC #4 PAX A920Pro | Digio BER-TLV | as above | **SN `1854355549`** — no TID/MID on file |

`DEVICE_INVENTORY.md:38-41`. Routing is per station: card → NEXGO, QR/wallet → PAX
(`DEVICE_INVENTORY.md:101-102`). Today both are **standalone** — staff key the card payment into
Pisell by hand — and ECR semi-integration is decision D3 (`DEVICE_INVENTORY.md:57-61`, `:79`).

Serial parameters, physical layer only (`DEVICE_INVENTORY.md:926-941`):
NEXGO `9600 / 8 / parity "none (sample code: odd)" / 1` — parity is **open, confirm on site**;
PAX `9600 8N1`, `/dev/serial/by-id/usb-PAX_Technology_*`.

The schema already carries all of this — `device.protocol` is documented to take
`ghl_linkpos` / `digio_tlv` (`packages/db/src/schema/fleet.ts:532-534 @HEAD`), and
`device.terminalId` / `device.merchantId` exist and are commented "Payment terminals only, from the
acquirer: TID and MID" (`fleet.ts:539-541 @HEAD`). The seed already creates EDC 1 as
`ghl_linkpos` with that TID/MID and EDC 3 as `digio_tlv` with that SN
(`packages/db/src/seed/index.ts:888-900 @HEAD`).

> **The single most load-bearing fact in this document:** the Digio PAX terminals have **no TID/MID
> on file**, and the GHL card SALE response **does not return TID or MID either** (§2.4 below). So
> `payment_attempt.tid` / `.mid` cannot be sourced from the wire in the card path — for GHL they come
> from `device.terminal_id` / `device.merchant_id`, and for Digio they come off the wire (tags 13/14)
> and should be **written back onto the device row** the first time a terminal answers.

---

# 2. Dialect A — GHL LinkPOS (NEXGO N5)

## 2.1 Transport and framing

- USB: "connect micro USB 2.0 to the port on the left side of SmartEDC … send-receive data through
  USB com port. *** USB COM Port: baud rate speeds for LinkPOS communication is recommended to use
  9600" — **GHL p.6**.
- The only concrete wire evidence in the document is the C# sample, **GHL p.18**:
  `BaudRate = 9600; Parity = Parity.Odd; StopBits = StopBits.One; DataBits = 8` → **9600 8-O-1**.
  (DEVICE_INVENTORY carries the same open question — `DEVICE_INVENTORY.md:87-88`, `:930`.)
- **There is no framing, no length prefix, no STX/ETX, no checksum.** The sample writes the XML
  string straight to the port (`serialPort.Write(text.ToString())`, GHL p.18) and reads with
  `sp.ReadExisting()` (GHL p.18-19). ⇒ the adapter and the simulator must **accumulate bytes until
  `</xml>`** and treat anything else as noise. No ACK/NAK layer exists.
- The TOC lists "Wi-Fi interface", "LAN Interface", "Bluetooth Interface" (**GHL p.4**) but v1.4
  ships **no content** for them — p.6 "Introduction" contains only the USB Port paragraph. Serial is
  the only documented transport. *(Consistent with DEVICE_INVENTORY: the NEXGO dock is a Wi-Fi
  router, so the handset is behind `192.168.1.x` NAT — `DEVICE_INVENTORY.md:38`, `:49-51`.)*

## 2.2 The envelope — exact element order

From the only literal message in the document, **GHL p.18**:

```xml
<xml><trade_type>…</trade_type><pos_ref_no>…</pos_ref_no><amount>…</amount><invoice_no>…</invoice_no><transaction_id>…</transaction_id><transaction_type>…</transaction_type><service_type>…</service_type><cashier>…</cashier></xml>
```

Three things a build agent will get wrong if it works from the parameter tables alone:

1. The **element order on the wire is the sample's order**, which is *not* the order of any table on
   pp.8/11/13/16/17. Encode in the sample's order; parse order-independently.
2. **`<cashier>` exists only in the sample** (GHL p.18) — it appears in no parameter table in the
   document. Send it (the field is how the terminal stamps the operator) and let the simulator accept
   and echo it; do not make it mandatory in the parser.
3. The sample sends **every** element on every message, empty for the ones the operation does not
   use. Safest simulator contract: **accept any subset, require only the fields the relevant table
   marks REQUIRED, ignore empty elements.**

> **Scope of what the document actually proves.** GHL p.18 is the **only literal message** in the
> whole PDF. It is a *request* builder, and it carries eight elements. It does **not** contain
> `card_approval_code` (needed by the card VOID, p.16) and it shows **no response XML at all**.
> Everything below that is written as XML — every response, and the `card_approval_code` element on
> the void — is **reconstructed from the parameter tables using the sample's `<xml>` wrapper and
> `<snake_case>` element convention**. The element *names*, *types* and *requiredness* are cited from
> the tables and are solid; the *wrapper and ordering* of responses are an inference. Mark the GHL
> fixtures as such, and get one captured real exchange from GHL Thailand or from the terminal on site
> before calling the GHL adapter verified. The Digio fixtures need no such caveat — that spec prints
> complete frames.

## 2.3 Amount format

`amount` is `Decimal`, example `100.25` (GHL p.8, p.11, p.16, p.17); the QUERY response types it
`Decimal (10.2)` with example `10000.25` (GHL p.14). ⇒ **THB major units, two decimals, `.` separator,
no thousands separator, no currency symbol.** The platform stores satang, so the adapter formats
`satang → (satang/100).toFixed(2)` on the way out and parses `Math.round(parseFloat(x)*100)` on the
way back, and the "approved amount ≠ requested → reject and void" check in the acceptance criteria
compares **satang after that round-trip**, never the strings.

## 2.4 SALE — card

**Request** (GHL p.8): `trade_type` String(32) = `CARD`; `amount` Decimal; `pos_ref_no` String(20),
"POS generates the number to reference the transaction (Unique)", e.g. `IV2018100100001`;
`transaction_type` String(4) = `SALE`. All four REQUIRED.

```xml
<xml><trade_type>CARD</trade_type><pos_ref_no>IV2018100100001</pos_ref_no><amount>100.25</amount><invoice_no></invoice_no><transaction_id></transaction_id><transaction_type>SALE</transaction_type><service_type></service_type><cashier>Jane Doe</cashier></xml>
```

**Response** (GHL p.8): `pos_ref_no` String(20) echoed; `response_code` String(2) from **SCB Host**;
`response_msg` String(32) (`SUCCESS`, `FAIL`); `invoice_no` String(20) from SmartEDC, e.g. `000001`;
`card_no` String(19) **masked**, e.g. `444433XXXXXX9887`; `amount` Decimal echoed;
`card_approval_code` String(6) from SCB Host, e.g. `123456`. All REQUIRED.

```xml
<xml><pos_ref_no>IV2018100100001</pos_ref_no><response_code>00</response_code><response_msg>SUCCESS</response_msg><invoice_no>000001</invoice_no><card_no>444433XXXXXX9887</card_no><amount>100.25</amount><card_approval_code>123456</card_approval_code></xml>
```

Decline fixture (`05` = Do not honor, GHL p.8):

```xml
<xml><pos_ref_no>IV2018100100001</pos_ref_no><response_code>05</response_code><response_msg>FAIL</response_msg><invoice_no></invoice_no><card_no></card_no><amount>100.25</amount><card_approval_code></card_approval_code></xml>
```

Partial-approval fixture — `10` "Partial approval" (GHL p.8). The acceptance criterion "partial
approval is refused and voided" is driven by this code **plus** an `amount` below the requested one:

```xml
<xml><pos_ref_no>IV2018100100001</pos_ref_no><response_code>10</response_code><response_msg>SUCCESS</response_msg><invoice_no>000002</invoice_no><card_no>444433XXXXXX9887</card_no><amount>50.00</amount><card_approval_code>123457</card_approval_code></xml>
```

**Not returned on a card sale: `terminal_id`, `merchant_id`, `transaction_id`, trace/RRN, card type,
entry mode, date, time.** The card SALE response is those seven fields and nothing else (GHL p.8).

**`***For POS, to ensure the pos_ref_no from request and response are matched`** (GHL p.8) — the
correlation key on this dialect is `pos_ref_no`, which is exactly the ticket's 12-char
`terminal_counter.next_ref` for GHL devices. See the length conflict in §2.9.

## 2.5 SALE — e-wallet / QR

**Request** (GHL p.11): `trade_type` String(32) ∈ `ALIPAY, ALIPAY+, WECHATPAY, TRUEMONEY, DOLFIN,
QRCS, THAIQRCODE`; `amount` Decimal; `pos_ref_no` String(20); `transaction_type` String(4) = `SALE`;
**`service_type` String(10) ∈ `SCAN`, `SHOWQR`** — REQUIRED.

**Response** (GHL p.11, repeated p.13): `pos_ref_no`; `response_code` String(2) where
**"`00` means SUCCESS, `01` means FAILED"** — generated by **SmartEDC**, *not* by the host, i.e. a
different code space from cards; `response_msg` String(32); `transaction_id` String(32) from the
e-wallet hosts, e.g. `1217752501201407033233368018`; `invoice_no` String(20), e.g.
`99999999123456123456`; `amount` Decimal. All REQUIRED. **No `card_no`, no `card_approval_code`.**

```xml
<xml><trade_type>THAIQRCODE</trade_type><pos_ref_no>240219235959</pos_ref_no><amount>100.25</amount><invoice_no></invoice_no><transaction_id></transaction_id><transaction_type>SALE</transaction_type><service_type>SHOWQR</service_type><cashier>Jane Doe</cashier></xml>
```
```xml
<xml><pos_ref_no>240219235959</pos_ref_no><response_code>00</response_code><response_msg>SUCCESS</response_msg><transaction_id>1217752501201407033233368018</transaction_id><invoice_no>99999999123456123456</invoice_no><amount>100.25</amount></xml>
```

### Which wallet supports which `service_type` (GHL p.12) — decoded, not readable as text

The p.12 matrix's marks are **not in the text layer**: each cell is a 2×2-pixel indexed image scaled
to fill the cell. Decoded from the page's XObject dictionary — `/Image78` and `/Image80` are solid
**green `#70AD47`**, `/Image82` is solid **red `#FF0000`** — and matched to the row labels by their
`cm` placement coordinates:

| EWALLET (GHL p.12) | "Integrate Tran_type" | B scan C (Scan) | C scan B (Show QR Code) |
|---|---|---|---|
| Alipay | `A` | green | green |
| Alipay+ | `X` | green | green |
| Wechat Pay | `W` | green | green |
| TrueMoney Wallet | `2` | green | green |
| Visa/Master QR | `E` | **RED** | green |
| ThaiQR Code | `T` | green | green |

Read as green = supported, red = not supported: **Visa/Master QR (`QRCS`) cannot do `SCAN`
(B-scan-C); it is `SHOWQR` only.** Every other listed wallet does both. `DOLFIN` appears in the
`trade_type` list (GHL p.11) but **has no row in this table** — its service types are undocumented.
Flag both as *[decoded from cell fills — confirm with GHL before relying on it in production]*; the
simulator should still enforce it, because enforcing it is the only way the adapter's validation gets
exercised.

The meaning of the single-letter "Integrate Tran_type" column (`A/X/W/2/E/T`) versus the word
`trade_type` values is **unresolved in the document**; the footnote only says "*** Please send request
`service_type` depends on table above" (GHL p.12). Send the word form (`ALIPAY` …) — that is what the
parameter tables and the C# sample use — and treat the letters as a vendor-internal code.

## 2.6 INQUIRY (`QUERY`) — and the hole in it

> **"Use Case ***Cannot QUERY for trade type CARD"** — GHL p.13.

This is the fact the ticket's design already anticipates. On a NEXGO card sale with **no final
response** there is *no* protocol-level inquiry: the acceptance criterion's "inquiry unavailable →
staff confirmation dialog, audited with the staff id" is **not a degraded path on this dialect, it is
the only path**. The inquiry rule applies in full only to Digio, and to GHL wallet/QR trade types.

**Request** (GHL p.13): `transaction_type` String(10) = `QUERY`; `trade_type` String(32) "Same as
Original Sale"; `invoice_no` String(20) — **NOT required**; `pos_ref_no` **String(12)** "Same as
Original Sale", example **`240219235959`** — REQUIRED.

```xml
<xml><trade_type>THAIQRCODE</trade_type><pos_ref_no>240219235959</pos_ref_no><amount></amount><invoice_no>99999999123456123456</invoice_no><transaction_id></transaction_id><transaction_type>QUERY</transaction_type><service_type></service_type><cashier>Jane Doe</cashier></xml>
```

**Response** (GHL p.13-14) — a wider record than the SALE response:
`pos_ref_no` String(12); `transaction_type` String(10) = `QUERY`; `trade_type` String(32);
`amount` Decimal(10.2); `response_code` String(2); `response_msg` String(32);
**`terminal_id` String(8)** e.g. `12345678`; **`merchant_id` String(15)** e.g. `123456789012345`;
`transaction_id` String(32); `invoice_no` String(20). All REQUIRED.

```xml
<xml><pos_ref_no>240219235959</pos_ref_no><transaction_type>QUERY</transaction_type><trade_type>THAIQRCODE</trade_type><amount>10000.25</amount><response_code>00</response_code><response_msg>Success</response_msg><terminal_id>65703235</terminal_id><merchant_id>4648434010</merchant_id><transaction_id>1217752501201407033233368018</transaction_id><invoice_no>99999999123456123456</invoice_no></xml>
```

TID/MID reach us **only through QUERY**, and QUERY exists **only for non-card** — hence the rule in
§1 that the card path takes TID/MID from `device`.

There is **no documented "still pending" response code** for QUERY. `00`/`01` is the whole space
(GHL p.13). The simulator therefore needs a third behaviour the document does not name — see §5.

## 2.7 VOID

Constraints, **GHL p.15**:
- `Use Case - ***Only Thai QR Code is unable to be voided`
- `- CARD type needs to be voided before cashier settlement all transactions`
- `- All e-Wallets transaction needs to be voided before 11PM`

So `THAIQRCODE` has **no void at all**; the "Advance terminal clock" control in the simulator panel
exists to prove the card-before-settlement and wallet-before-23:00 windows.

**Card void request** (GHL p.16): `trade_type` = `CARD`; **`invoice_no` String(20)**;
**`card_approval_code` String(6)**; `pos_ref_no` **String(32)**; `amount` Decimal;
`transaction_type` String(4) = `VOID`. All REQUIRED.
**Response** (GHL p.16): `pos_ref_no` String(32); `response_code` String(2) — here again
**"`00` means SUCCESS, `01` means FAIL"**, i.e. the *wallet* code space, not the ISO card space;
`response_msg`; `invoice_no`; `amount`.

```xml
<xml><trade_type>CARD</trade_type><pos_ref_no>IV2018100100001</pos_ref_no><amount>100.25</amount><invoice_no>000001</invoice_no><transaction_id></transaction_id><transaction_type>VOID</transaction_type><service_type></service_type><card_approval_code>123456</card_approval_code><cashier>Jane Doe</cashier></xml>
```
```xml
<xml><pos_ref_no>IV2018100100001</pos_ref_no><response_code>00</response_code><response_msg>SUCCESS</response_msg><invoice_no>000001</invoice_no><amount>100.25</amount></xml>
```

**Wallet void request** (GHL p.17): `trade_type`; **`invoice_no` String(20)**; `pos_ref_no`
String(32); `transaction_type` = `VOID`. **Response**: `pos_ref_no`; `response_code` `00`/`01`;
`response_msg`; **`transaction_id` String(32)**; `invoice_no`; `amount`.
Footnote both pages: `***For 3rd party mobile app, to ensure the transaction_id and the invoice_no
from request and response are matched`.

⇒ **The void key on this dialect is `invoice_no`** (+ `card_approval_code` for cards), *not*
`pos_ref_no` — `pos_ref_no` on a void is a **new** unique reference for the void itself ("3rd party
mobile app generates to reference the transaction (Unique)", GHL p.16/p.17). A build agent that reuses
the sale's `pos_ref_no` for its void will violate the uniqueness rule. The ticket's
`terminal_counter` must therefore mint a **fresh ref for the void attempt**, and the *sale's*
`invoice_no` must be persisted or the sale can never be voided.

## 2.8 Response codes

Two disjoint spaces on the same 2-character field:

- **Card `SALE`** — ISO-8583 style, "Response Code for Credit Card Type", **GHL pp.8-10**. Printed
  without leading zeros in the table but typed `String (2)` with examples `00, 01, 02, ...`, so
  transmit/compare zero-padded. Full list as printed: `0` approval (…"or that VIP PIN verification is
  valid"), `1`, `2`, `3`, `4` Pickup, `5` Do not honor, `6`, `7`, `8`, `9` Request in progress,
  **`10` Partial approval**, `11` VIP approval (p.8); `12,13,14,15,16,17,19,20,21,22,25,28,30,41,43,
  51,52,53,54,55,57,58,59,61,62,63,65,68,75,76,77,78,80,81,82,83,85,91,92,93,94` (p.9);
  `95,96,B1,N0,N3,N4,N7,P2,P5,P6,Q1,R0,R1,R3,XA,XD,Z3` (p.10).
  Approved = `00` only. `09` "Request in progress" and `10` "Partial approval" both need explicit
  handling; the ticket's rule already refuses and voids partials.
- **Wallet `SALE`, `QUERY`, and every `VOID`** — `00` SUCCESS / `01` FAILED, two values only
  (GHL p.11, p.13, p.16, p.17).

## 2.9 Contradictions and gaps in the GHL document — resolve before coding

| # | The conflict | Where | Suggested resolution |
|---|---|---|---|
| G1 | `pos_ref_no` is **String(20)** on SALE (`IV2018100100001`) but **String(12)** on QUERY (`240219235959`) and **String(32)** on VOID | GHL p.8 / p.13 / pp.16-17 | Mint **12 characters** — the intersection, and what the ticket already specifies ("12-char `pos_ref_no` for card/GHL devices"). A 12-char ref satisfies all three fields. Simulator should **reject >12** so the constraint is proved. |
| G2 | Card `response_code` is ISO; wallet & all void `response_code` is `00`/`01` — same field name | p.8 vs p.11/13/16/17 | The adapter must branch on `trade_type` **before** interpreting `response_code`. Single most likely defect in a first implementation. |
| G3 | No `QUERY` for `CARD` | p.13 | The inquiry rule cannot cover NEXGO card sales; that path goes to the audited staff-confirmation dialog. Do not invent a card QUERY in the simulator. |
| G4 | Parity: spec body says "9600 recommended" and says nothing about parity; the sample code sets **Odd** | p.6 vs p.18 | Make it device `settings`, default 8-O-1 per the sample, and confirm on site (`DEVICE_INVENTORY.md:930`, `:973-974`). |
| G5 | `cashier` in the sample, in no table | p.18 | Send it; never require it. |
| G6 | p.12 support matrix is pictures | p.12 | Encoded above; confirm with GHL. `DOLFIN` undocumented. |
| G7 | No timeout, retry, ACK, or "transaction in progress" semantics anywhere in the document | whole doc | Ours to define: see §5. |
| G8 | The only literal message in the PDF is a **request** builder with eight elements; **no response XML is printed anywhere**, and the card VOID needs a ninth element (`card_approval_code`) the sample does not have | p.18 vs p.16 | Response envelopes here are reconstructed from the tables. Capture one real exchange before signing the GHL adapter off. |

---

# 3. Dialect B — Digio Direct Terminal (PAX A920Pro), spec v2.21

## 3.1 Transport

`Baud Rate 9600 / Data bit 8 / Stop bit 1 / Parity None` — **Digio HTML:368-374 (§3 Integration Via
COM)**. Matches `DEVICE_INVENTORY.md:938`.

## 3.2 Framing — verified against the document's own examples

§4 (Digio HTML:376-398):

```
[0x3E 0x55] [BER length of content] [content] [1-byte CRC]
CRC = XOR of every byte from the first header byte through the last content byte.
```

Worked example in the spec (`Digio HTML:387-397`): content `"12345"` → `3E55 05 3132333435 5F`,
`0x3E^0x55^0x05^0x31^0x32^0x33^0x34^0x35 = 0x5F`. **Verified: computes to 0x5F.**

Length is BER long-form above 127 (`Digio HTML:421-457`): `0–127` one octet; `128–4095` → `81 80`
for 128; `4096–…` → `82 10 00`; `…` → `83 01 00 00`. (The table's row labels read `665535`/`665536`
— a typo for 65535/65536 — but the encodings shown are correct BER.) **Verified against every frame
example in the document: the declared length matches the actual content length in all 10 examples
I checked.**

> ### Do not copy the CRC byte out of the document's example frames.
> I recomputed the §4 rule over all ten full-frame examples. **Three match, seven do not:**
>
> | Example | Digio HTML line | length ok | CRC printed | CRC per §4 |
> |---|---|---|---|---|
> | §4 worked example `12345` | 397 | — | `5F` | `5F` ✅ |
> | §5.1.1 Terminal Info request | 552 | ✅ | `25` | `25` ✅ |
> | §5.1.2 Terminal Info response | 615 | ✅ | `2D` | `2D` ✅ |
> | §5.4.1 Sale request | 1278 | ✅ | `1F` | `1F` ✅ |
> | §5.13.2 Inquiry not-found response | 5099 | ✅ | `2B` | `2B` ✅ |
> | §5.4.2.1 Credit sale response | 1271 | ✅ | `1E` | **`1C`** ❌ |
> | §5.4.2.3 QR PromptPay response | 1584 | ✅ | `49` | **`4B`** ❌ |
> | §5.4.2.4 Alipay/WeChat response | 1702 | ✅ | `2A` | **`24`** ❌ |
> | §5.5.1 Void request | 2765 | ✅ | `6B` | **`6D`** ❌ |
> | §5.5.2.1 Void response | 2865 | ✅ | `6D` | **`67`** ❌ |
> | §5.13.1 Inquiry request | 5037 | ✅ | `50` | **`46`** ❌ |
>
> I tested the obvious alternative rules (XOR of content only, XOR of length+content, byte sum) —
> none of them reproduces the printed bytes either, and the differences are not a constant. The
> printed CRCs in those seven are simply wrong (hand-edited examples). **The §4 rule is the rule;
> the length encoding in the examples is trustworthy; the CRC byte in the examples is not.** Every
> fixture in §3.9 below is generated from the §4 rule, and my generator reproduces the Sale-request
> example byte-for-byte including its `1F`, which is the proof the generator is right.

## 3.3 Tag encoding — the trap

§4.1.1 states the standard BER multi-octet rule: "When the first octet of tag performs Logical AND
0x1F is equal to 0x1F, it indicates the tag have following octet" (`Digio HTML:418-420`).
**That rule does not describe the actual tag set.** Digio uses two kinds of tag:

- **Single binary octet** for the numeric tags: `01` amount, `03` POS user name, `04` reference no,
  `05`, `06`, `07`, `08`, `09`, `0A`, `0B`, `0D`, `0E`, `10`–`20`, `21` action code, `22` response
  code, `23`, `24`, `25`, `41` tip, `63` field-63.
- **Two ASCII characters** for the named tags: **`QR`** (`0x51 0x52`), `0M` merchant, `CN` channel
  type, `R1`/`R2`/`R3` reserved. Proven by the A18 example frame, which literally contains
  `…170F313233343531323334353132333435` **`QR`** `8194 3030…` (`Digio HTML:2699`) — `0x51 & 0x1F =
  0x11`, so a strict BER parser would mis-read it as tag `0x51`, length `0x52`.

⇒ **Parse with a known-tag table, not with generic BER.** Read one octet; if it is one of the
ASCII-named first bytes (`0x30 'Q' 'C' 'R'`-family) look ahead one more. Safest: a fixed tag table
per message type, which is all a simulator needs anyway.

Second trap: **the per-row "TLV for Sample Value" column is systematically corrupt.** It renders
`A` as `0x4C` (`'L'`) — e.g. §5.4.1 shows action `A0` as `21024C30` and §5.4.2.1 shows `A1` as
`21024C31` (`Digio HTML:831`, `:1067`) — and sometimes fails to hex-encode at all (`130889898903`
for TID, `Digio HTML:1202`, `:1552`, `:2851`), and sometimes prints the wrong tag byte (tag `05`
Payment Type rendered as `04024131`, `Digio HTML:867`; tag `41` Tip rendered as `0105…`,
`Digio HTML:966`). **The full-frame `Example :` lines are correct** — they carry `2102` `4131`
(`0x41` = `'A'`) and `1308 3839383938393033` (`Digio HTML:1271`). **Trust the Tag column and the
frame examples; ignore the per-row TLV column.**

## 3.4 Amounts

Tag `01` Amount, attribute `an`, "Amount in cent unit. Example: THB100.50 Value: 10050 **Maximum
length is 12 digits**" (`Digio HTML:836-841`). Encoded as **ASCII decimal digits**, not binary:
`10050` → `01 05 31 30 30 35 30`. ⇒ **satang as an ASCII string**, which is exactly what the platform
stores — no conversion, just `String(satang)`. (Contrast with GHL, §2.3.) Same for tag `41` Tip
Amount (`Digio HTML:961-967`).

§4.1.3 says integers use big-endian (`Digio HTML:458-460`), but **no field in any message in §5 is a
binary integer** — every one is attribute `a`/`an`/`ans`. Do not binary-encode anything.

## 3.5 Reference number

Tag `04`, `an`, **M**, sample `123456`, "Unique reference number from 3rd party. **6 digit**"
(`Digio HTML:853-859`, and repeated on every message). This is the ticket's
"6-digit rolling refs for QR/Digio devices". The simulator must **echo tag 04 unchanged** on every
response, including the not-found inquiry response — it is the correlation key on this dialect.

## 3.6 SALE — request

§5.4.1, `Digio HTML:811-967`:

| Tag | Field | Att | Req | Notes (line) |
|---|---|---|---|---|
| `21` | Action Code | an | M | `A0` = Request Sale (826-832) |
| `01` | Amount | an | M | satang ASCII, max 12 digits (835-841) |
| `03` | POS User Name | an | M | (844-850) |
| `04` | Reference No | an | M | 6 digit, unique (853-859) |
| `05` | Payment Type | an | **O** | "if you not set default will be select payment type screen" (862-868) |
| `06` | Request QR code data | an | O | **`01` = No, `02` = Yes** (871-877) |
| `23` | Sign on paper | an | O | `YES`; default is sign-on-screen (880-886) |
| `24` | Ref#1 | an | O | "Reference for Thai QR Standard" (889-895) |
| `25` | Ref#2 | an | O | ditto (898-904) |
| `63` | Field 63 Information | an | O | VAT-rebate block, 2+2+18+18+20+4+13 chars (907-1044) |
| `0M` | Merchant | an | O | multi-merchant 1–10, default 1 (916-922) |
| `CN` | Channel Type | an | O | **`00` NORMAL, `01` B-Scan-C, `02` C-Scan-B** (925-931) |
| `R1`/`R2`/`R3` | Reserved | an | O | Fleet card: product code / miles / liters (934-958, 1274-1276) |
| `41` | Tip Amount | an | O | satang (961-967) |

**Setting tag `05` is what makes the flow unattended** — leave it out and the terminal shows a payment
type chooser, which is wrong for a POS-driven tender. Always send it.

`CN` is Digio's equivalent of GHL's `service_type` (B-scan-C = we scan the customer's code;
C-scan-B = we show a QR).

## 3.7 SALE — responses, by payment type

Payment/action codes, from the **Appendix §6.1** (`Digio HTML:6506-6783`) — the authority, because
the inline comment on tag `05` disagrees with §5.4.2.4's heading about A4/A5:

`A0` Action Sale · **`A1` Sale Credit Card** · `A2` Gift Card · **`A3` Sale QR Thai STD** ·
**`A4` Sale Wechat** · **`A5` Sale Alipay** · `A6` QR Credit Card · `A7` IPP · `A8` ShopeePay ·
`A9` Payment by Cash · **`A10` Request Void** · `A11` Void Credit resp · `A12` Void IPP resp ·
`A13` Void QR Thai STD resp · `A14` Void WeChat resp · `A15` Void Alipay resp · `A16` Void Redeem SCB
Point resp · `A17` Void IPP resp · **`A18` Response QR code data** · `A19` Void QR Credit resp ·
`A20`–`A23` gift card · `A24` Void ShopeePay resp · `A25` Fleet Card · `A26` Void Fleet Card resp ·
`A27` Dolfin-Wallet · `A28` Void Dolfin resp · `A30`–`A32` redemption · `A33` Dolfin-Instalment ·
`A34` Void Dolfin-Instalment resp · `A35` True-Wallet · `A36` Void True-Wallet resp ·
`A37` Line-Pay-Wallet · `A38` Void Line-Pay resp · `A40`–`A43` prepaid · `A50`/`A51` bill payment ·
**`T0`/`T1` Terminal Info** · **`T2`/`T3` Inquiry Transaction** · `A52`/`A53` Refund ·
`A54`/`A55` Uplan · `A56`–`A59` pre-auth (+cancel) · `A60`/`A61` pre-auth complete ·
`A62`/`A63` offline sale · `A64`/`A65` tip adjust.

**⚠ A4/A5 conflict.** §6.1 (`:6548-6553`) and the tag-05 comment (`Digio HTML:868`) both say
**A4 = WeChat, A5 = Alipay**; the §5.4.2.4 *heading* says "Response Alipay (A4) and WeChat (A5)"
(`Digio HTML:1587`) while the body of that very section's tag-21 comment says "A4: Response from
WeChat, A5: Response from Alipay" (`Digio HTML:1608`). **Two against one: A4 = WeChat, A5 = Alipay.**
The park's wallet tenders are not in this ticket's acceptance criteria, so this only needs to be
right in the code comments and the simulator's menu — but write it down, and ask Digio.

**⚠ A18 conflict.** §6.1 says `A18` = "Response QR code data" (`:6604-6605`), matching the version
history "Add action code A18 for response QR code data" (`:117`) and the whole §"Response QR Code
Data" block (`:2568-2699`). But the §5.5.2.1 heading lists "Void Fleet Card(**A18**)"
(`Digio HTML:2768`) — while that same section's tag-21 comment lists the void codes as
"A11, A16, A17, **A26**, A28, A34, A36, A38, A58" (`Digio HTML:2789`) and §6.1 assigns
"Response from Void Fleet Card" to **`A26`** (`:6636-6637`). **A18 = QR code data; the heading is a
typo.**

### 3.7.1 Credit sale response — `A1` (§5.4.2.1, `Digio HTML:1047-1271`)

Tags, in the document's order: `21` action `A1` · `01` amount (satang) · `04` reference no ·
`22` response code · **`05` Transaction ID** · **`06` Approval Code** · `07` CardType
(`00` Visa, `01` MasterCard, `02` JCB, `03` UPI, `04` TPN/PromptCard — `:1122`) · `08` Application
Label · **`09` Card No — masked, e.g. `49215911****6014`** (`:1138`) · `0A` Card Holder Name ·
`0B` Trace No · `0D` AID · `0E` CVM type (`00` No CVM / `01` PIN / `02` Signature, `:1176`) ·
`11` Trans Date `YYYYMMDD` · `12` Trans Time `hh:mm` · **`13` TID** · **`14` MID** · `15` Batch No ·
`17` REF No (RRN) · `18` TSI · `19` TVR · `20` Ent Type · `41` Tip Amount. All **M**.

**Transaction ID (tag `05`) format is fixed and is the void key:** "Transaction ID from EDC. Please
keep this ID for VOID purpose. **Format is : TID(8)+yyMMddHHmmss(12)+random(4)**" (`Digio HTML:1104`)
— 24 characters. Note that it **embeds the TID**, so a Digio attempt carries the TID twice.

Note the document's own example frame for `A1` (`:1271`) predates tag `41` and omits it, even though
the table marks `41` **M**. Simulator: emit `41` only when the request carried a tip.

### 3.7.2 QR PromptPay response — `A3` (§5.4.2.3, `Digio HTML:1433-1584`)

`21` = `A3` · `04` ref · `22` response code · `01` amount · `05` Transaction ID ·
**`10` QR Reference Code — C, "Only exists if Response Code (Tag 22) returns with value `306`
(Enter QR reference code) before"** (`:1499`) · `11` Ref1 `[A-Z0-9]` · `12` Ref2 · `13` Ref3 ·
`14` Trans Date · `15` Trans Time · **`16` TID** · **`17` MID** · `18` Biller ID ·
`20` Bank Code (customer's banking app, e.g. `014`).

**The tag numbers move between payment types.** On `A1` the TID is tag `13` and the MID tag `14`; on
`A3` the TID is tag `16` and the MID tag `17`, and `13`/`14` mean Ref3/Trans Date. A shared "parse
TLV then look up tag 13" helper is a bug. **Parse per action code.**

### 3.7.3 QR payload — `A18` (§"Response QR Code Data", `Digio HTML:2568-2699`)

Sent when the sale request carried tag `06` = `02`. `21` = `A18` · `22` · `01` amount · `04` ref ·
`05` Transaction ID · **`06` QR Code Type** (`A3` QR Thai STD, `A4` Wechat, `A5` Alipay, `A6` QR
Credit Card — `:2635`) · `14` date · `15` time · `16` TID · `17` MID · **`QR` = the payload itself**,
attribute `an`, **M**.

Real payloads printed in the spec (`Digio HTML:2685-2698`) — these are the fixtures for the PAX-QR
offline-fallback acceptance criterion:

- **PromptPay (EMVCo):** `00020101021130630016A000000677010112011531104003947510002207711102115504300153852045311530376454041.005802TH5909Merchant162150711SDO771110216304A45D`
- QR Credit Card: `000201010212021642018600000109060415520486290002470131631580004000004061531321607640052044600000000001122251160002110206123456520453115303764540 41.005802TH5910TESTSIT16007Bangkok62360108100243630508100243630708771110216304D8D1` *(as printed; note the stray space — treat the printed credit-card and ShopeePay payloads as illustrative, the PromptPay one as canonical)*
- Alipay: `https://qr.alipay.com/bax09820gnnmftadzqsi0060`
- WeChat: `weixin://wxpay/bizpayurl?pr=S2UcRfd`
- ShopeePay: `00020101021239790016A90000000000000001031900203CsB0341012007110710431856278mmxpiLhJ9Bzk1hz0ghTR530376454041.005802TH5927Digio (Thailand), Co., Ltd.6007Bangkok6304C154`

⇒ **A QR sale is a two-response exchange**: the terminal answers `A18` with the payload first (so the
customer display can render it), then `A3` when the customer pays. The adapter's read loop must
therefore **keep reading after the first complete frame** and dispatch on tag `21`. The document's
A18 example frame (`:2699`) ends `…FFFFFFAB` — four trailing bytes where one CRC belongs; treat that
as document noise and generate the frame yourself.

## 3.8 INQUIRY — `T2` / `T3` (§5.13, `Digio HTML:4983-5099`)

"EDC will return the transaction back to POS when found the transaction in EDC" (`:4984`).

**Request:** `21` = `T2` (M) · `03` POS User Name (M) · `04` Reference No (M, 6 digit) ·
**`05` Transaction ID (O)** — "Transaction ID from EDC that you want to void" (a copy-paste from the
void section; it is the transaction being inquired).

**Response, found:** "the response follows with a sale message response" (`:5040`) — i.e. the terminal
replies with the *sale* response for that transaction's type, one of Credit / Gift Card / QR
PromptPay / WeChat / Alipay / QR Credit Card / IPP / ShopeePay / Fleet Card / Dolfin-Wallet /
Dolfin-Instalment / True-Wallet / Line-Pay-Wallet (`:5042-5054`). **So an approved inquiry returns an
`A1` (or `A3`…) frame, *not* a `T3` frame** — the adapter must accept either action code in reply to a
`T2`. This is exactly the "no final response → inquiry → approved inquiry completes the sale without
a second charge" acceptance criterion: the returned `A1` carries the same tag `05` Transaction ID and
tag `06` Approval Code as the lost response, so the attempt is completed, not re-charged.

**Response, not found:** `21` = `T3` · `22` = **`203`** ("Transaction not found", §6.2 `:6843-6844`) ·
`04` reference no. Example `3E551121025433220332303304063132333435362B` (`:5099` — CRC verified ✅).

**A `T2` inquiry is the only inquiry either vendor gives us, and it is Digio-only.** (§2.6.)

## 3.9 VOID — `A10` (§5.5, `Digio HTML:2702-2865`)

> "This request allows **only Credit Card, Alipay and WeChat**. If you send transaction ID that is not
> one of them, EDC will send response code **'333'** to POS. **Password for void <the Digio void password — vendor spec §5.5; configuration, never in the repository>**"
> — `Digio HTML:2703`.

**Request:** `21` = `A10` · `03` POS User Name · `04` Reference No (**a new 6-digit ref**) ·
`05` Transaction ID of the sale being voided · **`06` password, fixed `<the Digio void password — vendor spec §5.5; configuration, never in the repository>`**. All M.

**Response** `A11` (credit) / `A13` (QR PromptPay) / `A16`/`A17`/`A19`/`A26`/`A28`/`A34`/`A36`/`A38`/
`A58` per type (§5.5.2.1 heading, `:2768`): `21` · `22` · `04` · `01` amount · `05` Transaction ID ·
`11` Trans Date · `12` Trans Time · **`13` TID** · **`14` MID**. Alipay/WeChat voids are `A14`/`A15`
with a different shape (§5.5.2.2, `:2867`); ShopeePay void is `A24` (§5.2.2.3, `:2984` — the heading
is misnumbered, it belongs under 5.5.2).

**⚠ Void-scope conflict.** The §5.5 prose says void allows **only** Credit Card, Alipay and WeChat
(`:2703`), yet §5.5.2.1 documents a **Void QR PromptPay (A13)** response and §6.1 lists
`A13 Response from Void QR Thai STD` (`:6584-6585`). GHL states the opposite way round for its own
device — "Only Thai QR Code is unable to be voided" (GHL p.15). **Assume QR PromptPay cannot be
voided on either dialect** (the conservative, GHL-consistent read); the simulator should answer `333`
to a void of a `A3` transaction, and the till must not offer void on a PromptPay tender. Confirm with
Digio (02-026-3485, `DEVICE_INVENTORY.md:55`).

**Hard-coded password `<the Digio void password — vendor spec §5.5; configuration, never in the repository>` is in the vendor spec, not a secret of ours** — but it is still a
credential: put it in the adapter's config (env/device `settings`), never in a fixture file, and keep
it out of the `ops_run` allow-list projection.

## 3.10 Response codes (§6.2, `Digio HTML:6785-6852`)

`000` Transaction cancelled · `001` Broken pipe · `002` Invalid format · `003` Invalid data length ·
**`100` Transaction Success** · `2xx` Transaction error code returned by Bank · `201` Multiple
Merchant is not support · `202` Function is not support · **`203` Transaction not found** ·
`204` Transaction already voided · `205` Transaction already settle · **`306` Finalize required** ·
`400` Processing error · `401` Host timeout · `500` Terminal not ready.
Plus `333` for "void of an unsupported transaction type" (§5.5 prose, `:2703`) — **not in the §6.2
table**; add it.

**Approved is `100`, three characters — not `00`.** A build agent that shares a "success = 00" constant
across the two adapters gets every Digio sale wrong. `306` "Finalize required" pairs with tag `10`
QR Reference Code on the `A3` response (`:1499`) and is a *prompt*, not a failure.

## 3.11 Terminal Info — `T0`/`T1` (§5.1, `Digio HTML:516-615`)

Request `21`=`T0` + `04` ref. Response `21`=`T1` · `22` response code · `04` ref ·
`05` versionCode (e.g. `1.8.127`) · `06` serialNo (e.g. `0812345678`). Both example frames'
CRCs verify. **Use this as the adapter's health probe** — it is the only message with no financial
effect, so it is what `device.reachability` / the box's device-health poll should send, and what the
simulator answers when a terminal is "present but idle". It also gives the **serial number**, which
is the only identity the park's PAX rows carry (`DEVICE_INVENTORY.md:40-41`).

## 3.12 Validated fixture frames (generated from the §4 rule, not copied)

Generator reproduces the spec's §5.4.1 example byte-for-byte (`3E5521…41311F`, `Digio HTML:1278`),
which is the check that it is correct. Values below use the park's real TID/MID/SN from
`DEVICE_INVENTORY.md:38-41`.

```
TERMINFO_REQ    (16 B) 3E550C21025430040631323334303026
TERMINFO_RESP   (42 B) 3E552621025431220331303004063132333430300507312E382E313237060A313835343335353534382C

SALE_REQ_CARD_A1        (37 B) 3E5521210241300105313030353003084A616E6520446F650406313233343536050241311F
SALE_REQ_QR_A3_WITH_QR  (41 B) 3E5525210241300105313030353003084A616E6520446F65040631323334353705024133060230321E

SALE_RESP_APPROVED_A1  (233 B)
3E5581E42102413101053130303530040631323334353622033130300518363537303332333531383035303931383035303031323334060652303737343107023030080B5669736120437265646974091034393231353931312A2A2A2A363031340A084A6F686E20446F650B063030303038330D0E41303030303030303033313031300E02303211083230323630393233120531343A303513083635373033323335140F34363438343334303130303030303015023335170C373333333139333933303537180436383030190A38304130303438303030200F43686970204F6E6C696E652050696E1D
SALE_RESP_DECLINED_205  (28 B) 3E551821024131010531303035300406313233343537220332303502
SALE_RESP_CANCELLED_000 (28 B) 3E55182102413101053130303530040631323334353822033030300A
SALE_RESP_HOSTTIMEOUT   (28 B) 3E55182102413101053130303530040631323334353922033430310E

A18_QRDATA_PROMPTPAY   (256 B)
3E5581FB2103413138220331303001053130303530040631323334363005183138353433353535343832363039323331343035303030310602413314083230323630393233150531343A303516083138353433353535170F343634383433343031303030303030515281943030303230313031303231313330363330303136413030303030303637373031303131323031313533313130343030333934373531303030323230373731313130323131353530343330303135333835323034353331313533303337363435343034312E3030353830325448353930394D65726368616E7431363231353037313153444F373731313130323136333034413435441E
SALE_RESP_QR_A3_APPROVED (138 B)
3E558185210241330406313233343630220331303001053130303530051831383534333535353438323630393233313430353030303111074F544F30303031120632343039323314083230323630393233150531343A303616083138353433353535170F343634383433343031303030303030180F343634383433343031303030303030200330313467

VOID_REQ        (61 B) 3E5539210341313003084A616E6520446F65040631323334363105183635373033323335313830353039313830353030313233340606XXXXXXXXXXXX62

> The 12 `X`s above stand where the sample frame carried the void password ASCII-hex under tag `06` (redacted — configuration, never in the repository); the frame's length byte and trailing checksum are therefore no longer self-consistent for that sample.
VOID_RESP_A11   (99 B) 3E555F21034131312203313030040631323334363101053130303530051836353730333233353138303530393138303530303132333411083230323630393233120531343A303713083635373033323335140F34363438343334303130303030303062

INQ_REQ_T2      (52 B) 3E55302102543203084A616E6520446F65040631323334363205183635373033323335313830353039313830353030313233344A
INQ_RESP_T3_NOTFOUND (21 B) 3E551121025433220332303304063132333436322C
  (inquiry-found = re-send SALE_RESP_APPROVED_A1 with tag 04 set to the T2's reference)
```

In `A18_QRDATA_PROMPTPAY` the bytes `5152` before `8194` are the ASCII `QR` tag — see §3.3.
The `1D`/`1E`/`67`/`62`/`4A`/`2C` tails are the §4 CRCs, computed.

---

# 4. What the platform must store — per dialect

`payment_attempt` columns named in the ticket, sourced:

| Column | GHL / NEXGO (card) | GHL / NEXGO (wallet, QR) | Digio / PAX |
|---|---|---|---|
| `terminal_ref` (our ref) | `pos_ref_no`, **12 chars** (§2.9 G1) | same | tag `04`, **6 digits** (`Digio HTML:859`) |
| `tran_ref` (vendor's handle for the txn) | **`invoice_no`** (GHL p.8) — the void key | `transaction_id` (host) **and** `invoice_no` (EDC) — store **both**, the void key is `invoice_no` (GHL p.17) | tag **`05` Transaction ID**, 24 ch `TID(8)+yyMMddHHmmss(12)+random(4)` (`:1104`) — the void key |
| `approval_code` | `card_approval_code` String(6) (GHL p.8) — **required for the void** (GHL p.16) | not returned | tag `06` Approval Code (`:1113`) |
| `last4` | derive from `card_no` String(19), already masked `444433XXXXXX9887` (GHL p.8) | n/a | derive from tag `09` Card No, already masked `49215911****6014` (`:1138`) |
| `TID` | **not on the wire** → `device.terminal_id` (`65703235`/`65703236`) | only via `QUERY` resp `terminal_id` String(8) (GHL p.14) | tag `13` on `A1`/void, tag `16` on `A3`/`A18` (§3.7.2) |
| `MID` | **not on the wire** → `device.merchant_id` (`4648434010`) | only via `QUERY` resp `merchant_id` String(15) | tag `14` on `A1`/void, tag `17` on `A3`/`A18` |
| `payment_id` | — | `transaction_id` String(32) | tag `07` Payment ID on wallets (`:1657-1661`); tag `05` otherwise |
| amount confirmation | `amount` Decimal → ×100 → compare satang | same | tag `01` already satang ASCII |
| `provider` | `ghl` | `ghl` | `digio` |
| `raw QR payload` | n/a (SHOWQR renders on the terminal) | n/a | tag **`QR`** on the `A18` frame |

Also worth persisting, though not in the ticket's column list, because without them a later void or
dispute is impossible: **Digio** tag `17` REF No (RRN), tag `15` Batch No, tag `0B` Trace No, tag
`11`/`12` terminal-clock date+time; **GHL** nothing further exists to store on a card sale.

**Allow-list projection for the `ops_run` payload** (the ticket requires "the stored `ops_run`
payload contains only allow-listed fields", and "the PAN/PII redaction fixture passes"). Both dialects
hand us cardholder data that must **never** reach an `ops_run` row or a log:

- GHL: `card_no` — already masked by the terminal, but store only the last 4.
- Digio: **tag `09` Card No** (masked) and **tag `0A` Card Holder Name** — a real name
  (`Digio HTML:1143-1149`). Drop `0A` entirely; keep only last-4 of `09`.
- Digio: **tag `06` password `<the Digio void password — vendor spec §5.5; configuration, never in the repository>`** on a void request — never log the raw request frame of an
  `A10`, or redact tag `06`.
- Digio: tags `0D` AID, `0E` CVM, `18` TSI, `19` TVR are EMV terminal data, not PII — safe, and
  useful for disputes.
- The PAN/PII redaction fixture should be **a raw `A1` frame containing tag `09` and tag `0A`**, run
  through the projection, asserting neither the masked PAN nor `John Doe` survives.

---

# 5. What the simulator must answer, mapped to the acceptance criteria

Both simulators answer **the same bytes as the real terminals**, so only the serial link changes on
site (ticket: "the simulator answers on those same messages"). Each panel control below maps to a
documented response, except where marked *[ours — undocumented by the vendor]*.

| Panel control | GHL / NEXGO | Digio / PAX |
|---|---|---|
| **Approved** | card `response_code` `00` + `invoice_no` + `card_no` + `card_approval_code` (p.8); wallet `00` + `transaction_id` (p.11) | `A1` with tag `22` = `100` (§3.12 `SALE_RESP_APPROVED_A1`) |
| **Declined** | `05` Do not honor (p.8) / wallet `01` | `22` = `205` or any `2xx` (§6.2) |
| **Partial approval** | **`10`** + a lower `amount` (p.8) → adapter refuses and voids | no partial-approval code in §6.2 — *[ours: reply `100` with tag `01` below the requested amount]*, which drives the same refuse-and-void branch |
| **No final response** | write nothing back after the request *[ours — no timeout semantics in the doc, §2.9 G7]* | same *[ours]* |
| **Inquiry** | **impossible for `CARD`** (p.13) — the panel must grey it out and the till must go to the staff-confirmation dialog; for wallets, `QUERY` → `00`/`01` (p.13-14) | `T2` → the sale response `A1`/`A3` when found (`:5040-5054`), or `T3` + `22`=`203` when not (`:5099`) |
| **Inquiry unavailable** | *[ours: no answer to the `QUERY`]* — and the permanent state for cards | *[ours: no answer to the `T2`]*, or `22` = `500` Terminal not ready |
| **Timeout** | no bytes *[ours]* | `22` = `401` Host timeout (§6.2) |
| **Void** | card: `invoice_no` + `card_approval_code` + new `pos_ref_no` → `00`/`01` (p.16); wallet: `invoice_no` → `00`/`01` + `transaction_id` (p.17); **`THAIQRCODE` must be refused** (p.15) | `A10` + password `<the Digio void password — vendor spec §5.5; configuration, never in the repository>` → `A11` with `22`=`100`; **refuse with `333`** for a type outside credit/Alipay/WeChat (`:2703`) |
| **"Advance terminal clock"** | enforces "card void before cashier settlement" and "e-Wallet void before 11PM" (p.15) | enforces `205` "Transaction already settle" after a simulated settlement (`A?` §5.12, §6.2) |
| **QR on the display** | `service_type=SHOWQR` renders on the **terminal**, not on our display — GHL never returns a payload | **`A18` returns the payload in tag `QR`** → this is the PAX-QR offline fallback path in the acceptance criteria; use the spec's PromptPay payload (§3.7.3) |
| **Health / "terminal present"** | nothing documented *[ours: answer a `QUERY` for a non-existent ref]* | **`T0`/`T1` Terminal Info** (§3.11) — designed for exactly this ("for test connect edc device", `:517`) |

Reference-uniqueness test the ticket asks for: GHL requires `pos_ref_no` unique
(GHL p.8, p.11, p.16, p.17 — "Unique") and Digio requires tag `04` unique 6-digit
(`Digio HTML:859`). **6 digits roll over every 1,000,000 transactions and the void needs its own ref**
— so the per-terminal-per-day uniqueness test is a real constraint on the Digio counter, not a
formality, and voids/inquiries must draw from the same counter.

---

# 6. Open questions to carry into the build (nothing here is a blocker for fixtures)

1. **GHL parity** — spec silent, sample code says Odd (GHL p.6 vs p.18; `DEVICE_INVENTORY.md:930`,
   `:973-974`). Device `settings`, confirm on site.
2. **GHL card, no final response** — there is no inquiry (p.13). Confirm with GHL Thailand whether
   the LinkPOS app has any "last transaction" recall; if not, the audited staff-confirmation dialog is
   permanent for NEXGO cards.
3. **GHL `pos_ref_no` length** — 20 / 12 / 32 across three tables (§2.9 G1). 12 is safe; confirm.
4. **GHL p.12 matrix** — decoded from cell fills (§2.5); confirm Visa/Master QR is SHOWQR-only and
   ask what `DOLFIN` supports.
5. **GHL "pending" on QUERY** — only `00`/`01` documented; ask what a still-unpaid QR returns.
6. **Digio A4/A5** — WeChat vs Alipay, spec contradicts itself (§3.7).
7. **Digio void of QR PromptPay** — §5.5 prose forbids it, §5.5.2.1 and §6.1 document `A13` for it
   (§3.9). Assume forbidden; confirm with Digio 02-026-3485.
8. **Digio TID/MID** — not on file for either PAX (`DEVICE_INVENTORY.md:40-41`); they arrive on tags
   `13`/`14` (or `16`/`17`), so back-fill `device.terminal_id`/`merchant_id` on first response.
9. **Digio named tags** — confirm with Digio that `QR`, `0M`, `CN`, `R1`–`R3` really are two ASCII
   octets and not a doc rendering artefact (§3.3). The A18 example frame says they are.
10. **Neither vendor documents a timeout, retry or ACK layer.** The adapter's read-deadline, retry
    policy and "block the till" rule are ours; write them into `DEVICE_INVENTORY.md` §5 or
    `PAYMENT_GATEWAY.md` when chosen, so the next agent does not go looking for them in the PDFs.
