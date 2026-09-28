# Physical booth walkthrough - 28 September 2026

[Open the 15-step walkthrough](oto-booth-walkthrough.pdf).

Live staging was inspected at 23:12-23:16 Bangkok time after the owner's
physical Pi update and bench testing. Screenshots show the existing setup;
the reference forms were cancelled without saving. No spins, vouchers or
configuration changes were created for this walkthrough. A diagnostic log
refresh collected the box's recent messages.

## Verified snapshot

- Branch: Oto Play Park, Central Floresta.
- Physical box: FortuneWheelBox, slot booth-1, hostname booth, online.
- Station/booth: FWBooth1, receipt prefix B1, on that physical box.
- Printer: Booth Voucher Printer, LAN 192.168.192.168:9100, reachable, paper OK.
- Classic wheel (v1), published configuration 5 and running configuration 5.
- Seven active prizes; their chances total 100%.
- Trading day 28 September: 24 spins, 24 printed vouchers, zero redeemed.
- Nine spins name staff; 15 earlier spins are unattributed. One older spin
  carries the Console's Clock uncertain flag.
- At 22:57, three successful print messages occurred while cloud calls failed.
  The corresponding outcomes, ending 3NR3, BPJM and SE26, are now in the
  cloud ledger as Printed. Recent heartbeats show zero unsynced items.

The current draft matches version 5's prizes and chances, with one pending
sort-order value on the 300 THB prize. It was not published or changed.
Three gift prizes have no cost entered; this is visible in the screenshot.
The counts exclude other booths and older records. They are a dated snapshot,
not a permanent total. The reported agent version is 0.1.0; that display alone
does not establish the installed release commit.

## Sharing and demonstration

The Desktop's `OTO Booth Walkthrough` folder contains the PDF, 15 numbered
PNGs and a ZIP containing both. The PDF preserves screenshots of staging
with document captions and numbered badges; the UI evidence is not retouched.
Every page was rendered and visually checked. This documentation-only change
does not alter an application package and requires no application test run
or deployment.

For the physical video, show a fresh red-button press, the revealed prize,
the paper printing, and then refresh Vouchers for FWBooth1 and match the
slip's final four characters. No sign-in PIN or box claim code belongs in
the recording. The latest captured example ends N7BZ (200 THB, 23:12).

Tracked as a follow-up under SCRUM-451, linked to SCRUM-198. Staging screenshots
`02-online-box.png`, `07-seven-prizes.png`, `11-spins.png`, `14-box-log.png`
and `15-heartbeats.png` are attached as Jira attachments 10849-10853 and named
in the progress comment. The ticket returned through Testing to Deployed after
the physical evidence review. The existing
bench-round implementation and deployment evidence remain in
[bench-round-1](../bench-round-1/README.md).
