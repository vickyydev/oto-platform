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
