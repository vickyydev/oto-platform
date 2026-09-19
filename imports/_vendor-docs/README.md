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

Still wanted: gate controller protocol (GE-X2) and HX-X1 manual, wristband printer
TSPL manual, receipt printer ESC/POS manual, scanner programming guide, 2C2P
sandbox credentials (into `.env`, not here).
