# Internal record — not part of Anthony's document

14 October 2026. Three parts: the rulings made on the project side today,
the items being answered or arranged personally (no need to ask the owner),
and the production-arrangement checklist for gateways, gates and hardware.

## 1. Rulings recorded today (project side)

- **Prepaid lunch refunds (was A2 / SCRUM-481):** refunding prepaid lunch
  money removes the unspent credit, and the refund is refused once the
  credit has been spent. SCRUM-481 is now buildable.
- **Camp walk-ups (was A5 / events plan Q5):** a child joining a camp
  partway through is charged one day's price once and registered from that
  day to the end.
- **Part-paid sales (was A6 / SCRUM-416):** the shipped rule stands — a
  manager refunds everything taken and the sale closes as cancelled
  ("voided"), day-end balancing automatically.
- **Opening stock (was A8 / SCRUM-485):** per-storage-place opening is the
  PROTOTYPE'S OWN rule, ported as-is (each place's first count is that
  place's opening — prototype StockTakeFlow, recorded in the stock
  service's header). Nothing to ask; SCRUM-485's open half is settled.
- **Extra play time and child care (was C1 / SCRUM-493 note):** the
  prototype defines no extra-time behaviour at all (the decision note says
  so explicitly), so there is no ported rule to follow. Ruling: care
  (drop-off/nanny) time stays separate from play-time extensions — care
  carries its own charges.
- **Printed receipts (was C3):** printed receipts gain discount lines.
  This is a small new build item (print templates) — ticketed.

## 2. Answering personally — kept here so nothing is lost

- Old staff records' times (Bangkok/UTC/mixed) — needed before SCRUM-274's
  timezone migrations.
- Who receives urgent out-of-hours alerts, and how (first + backup).
- The final data handover: Radar database copy, the wheel's database, the
  staff app's final export, stored files/photos. Pisell/Papaya stay
  uncancelled until the history export is done.
- The switch date and the old systems' edit freeze.
- The published legacy voucher codes and campaign windows (unblocks
  SCRUM-426).
- "Omni"/Marketing Hub: who consumes Radar's marketing summary feed and
  whether it continues (decides the feed's platform read vs retirement).
- Whether anything still uses the old shared staff-directory connection.
- The Xero test organisation and the person for the one connection test.
- For the record, built on the earlier direction: the booking site shows a
  returning family's saved children only after a one-time SMS code.
- The 13 October document (116 points) stays the full reference; ~70
  technical points are adopted team defaults (register entry of 14 Oct);
  the 7 Inbox questions travel with the Inbox story; the 21 optional staff
  app refinements need no answer.

## 3. Gateways, gates and hardware — what actually remains

Nothing in these areas is an open design question: the 2C2P integration is
built whole against the sandbox (QR, webhook, inquiry, refunds, settlement
import), every device adapter is written against its real protocol with a
simulator speaking the same dialect, and the gate/reader logic is delivered.
What remains is ARRANGEMENTS, not decisions:

- **2C2P production go-live:** production merchant credentials, the QR
  channel enabled on the account, return URLs registered. Configuration
  only (PAYMENT_GATEWAY.md §5).
- **Terminal capability:** whether the park's card terminals support
  refund-to-card (feeds question B2 in Anthony's document).
- **Vendor device documents:** the confirm-on-site list in
  DEVICE_INVENTORY.md (printers, HX-X1, gate reader, scanner) is checked
  against real cables at the park — the on-site phase, not a sprint.
- **Hardware on hand:** a Raspberry Pi 5 (and iPad) available for the next
  bench moment — S2-24 stays paused at the bench freeze until then; two
  small box fixes (447 epoch, 467 installer) also want that bench moment.
- **Domain/DNS:** who controls the otoplay domains, for the real staging
  domain and the Radar hostname redirect (printed QR posters point at the
  old host).
