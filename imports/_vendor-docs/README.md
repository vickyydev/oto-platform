# imports/_vendor-docs/ — device and provider documentation

The device adapters are written before anyone is on site with the hardware, so
these documents are what make that code accurate. Drop whatever you have:

| Device / provider | Document wanted |
|---|---|
| NEXGO N5 card terminal | GHL "LinkPOS" integration spec (XML over serial) + sample messages |
| PAX A920Pro terminal | Digio "Direct Terminal" spec (BER-TLV over serial) + tag list |
| Entrance gate | Controller protocol document (GE-X2, 2021) and the HX-X1 manual |
| Wristband printer 4B-2082A | TSPL/command manual, band stock dimensions |
| Receipt / kitchen printers (Xprinter, Welltech G4) | ESC/POS command manual, status/paper-sensor codes |
| Scanner (Zebra DS22 series) | Programming guide (serial-mode barcodes) |
| 2C2P | Direct API + Redirect API docs, sandbox merchant ID/secret (secret goes in `.env`, not here) |
| Router | Make/model + admin guide (static DNS, DHCP reservations) |

PDFs, Word files, photos of labels and sample receipts/wristbands are all useful.

## Received (local only — the files themselves are not committed)

| Date | File | Covers |
|---|---|---|
| 2026-09-19 | `GHL-API-Integration-POS-to-SmartEDC-V1.4-SCB-Jan2025.pdf` | NEXGO N5 / LinkPOS: XML messages over USB serial at 9600 (sample code: 8 data bits, odd parity, 1 stop); `SALE`, `QUERY`, `VOID`; trade types CARD and e-wallets (ALIPAY, ALIPAY+, WECHATPAY, TRUEMONEY, DOLFIN, QRCS, THAIQRCODE); `service_type` SCAN or SHOWQR; ISO response codes for cards, 00/01 for wallets; no QUERY for CARD; Thai QR cannot be voided; card voids before settlement, wallet voids before 23:00 |
| 2026-09-19 | `Digio-TLV-LinkPOS-Spec.html` (A920 Link-POS spec v2.21) | PAX A920Pro / Direct Terminal: COM 9600 8N1; frame = header `3E55` + BER length + BER-TLV content + 1-byte XOR checksum; action codes for terminal info (T0/T1), login/logout, sale per payment type (credit A1, gift A2, QR PromptPay A3, Alipay A4, WeChat A5, QR credit A6, IPP A7, ShopeePay A8, wallets A27/A35/A37), voids (A11, A13 …), gift card, redemption, pre-auth; tags 21 action, 22 response code, 04 reference number |

| 2026-09-20 | `OTO-Hardware-Developer-Reference-v1.0-2026-05-28.html` | The park's hardware note (Floresta branch, by the park's hardware specialist): device inventory with LAN addresses, roles, terminal ids, photos of labels, sample print code, and six open decisions. Summarised (without photos) in `docs/architecture/DEVICE_INVENTORY.md` |
| 2026-09-20 | Gate documents shared in chat — `Gate_Interface_Specification_EN.pdf` (reader HTTP contract), `GE-X2-Communication-Protocol-EN.pdf` (serial protocol 2021-12-01), `HX-X1_Control_Driver_Manual_EN.pdf` (BB-TC-01-V1.08), `GE-X2_Supplier_Answers_EN.pdf` | Their content is captured in `docs/architecture/DEVICE_INVENTORY.md` §6. **Drop the four PDFs into this folder** so the originals are on disk too. |
| 2026-09-20 | Booth voucher sample (image shared in chat) | Layout captured in `docs/architecture/DEVICE_INVENTORY.md` §7; drop the image here as `voucher-sample-2026-09-17.jpg` |

Still wanted: wristband printer command manual (4B-2082A), receipt printer
ESC/POS manuals (Welltech G4, Xprinter model), scanner programming guide
(Zebra DS22xx), the gate reader's own manual (which reader ships with the gate),
SCB Developer Portal sandbox credentials (into `.env`, not here), a printed
sale receipt for the tax-invoice header.
