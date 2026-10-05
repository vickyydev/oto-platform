# End of Day settlement staging proof - 6 October 2026

API abc007af is live at dep-db20t0gm7kps73d2a4tg; POS de2f90ce at
dep-db2123qj9qps73abi4hg and Console de2f90ce at dep-db212467bikc73c266a0.
Reviewed real screenshots 05-staging-terminal-settlement.png,
06-staging-settlement-import.png and 07-staging-receipt-refresh-phone.png
are attached to SCRUM-215 as 11268, 11269 and 11270.

- The isolated ZZ TEST park from the round-2 note has two simulated
  terminal devices: PAX 01a10ddc-4228-7983-992a-1fb666074361 and NEXGO
  01a10ddc-45a4-76de-8c97-8ece21ad2486. TIDs ZZEODPAX1 and ZZEODGHL1.
- Matching local box source performed a QR sale of THB 690 and a card
  sale of THB 470. Guarded job job-db21156i0phs73cspo0g recorded their
  exact references and one THB 150 gateway fixture in this park only.
  Earlier fixture jobs failed an invoice format check and rolled back.
- Signed-in Run settlement matched one payment on each terminal. PAX
  awaiting_settlement became approved; its paidAt instant stayed identical.
- TID-filtered CSV downloaded through the UI had one approved PAX row.
- Console imported the documented H/D fixture: one matched THB 150 row,
  one unmatched THB 95 row. Reimport said already imported; no new batch.
  Combined read-back: three batches, zero unmatched recorded attempts,
  one unmatched evidence line. Unmatched evidence remains for review.
- The closed 5 October channel snapshot stayed byte-for-byte equal.
- Reprint reached printed, two copies, without manual reload. A 390x844
  phone viewport had no horizontal overflow. Audit contains settlement
  run/result and payment settlement confirmation.
- Physical terminal settle remains unsupported pending verified vendor
  responses. Import proof is a fixture, not bank/SFTP certification.
- A stale service-worker browser context initially served the old build;
  a fresh context with service workers blocked loaded verified staging JS.
- A real park-switch race showed the previous park's stations until
  refresh. Source fix passes 12 existing lane tests; staging retest follows.
  Settlement request wording also avoids claiming a completed batch is
  still waiting; the batch itself already updates correctly.

Real park days, stock, FWBooth1 and prior unresolved payment fixtures were
not changed. Retain these isolated fixtures through final closure proof,
then archive the QA fleet while preserving financial and audit history.
