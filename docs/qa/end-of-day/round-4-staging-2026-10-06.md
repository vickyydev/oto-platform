# End of Day final staging walkthrough - 6 October 2026

API/POS/Console 581c7c4a deployed successfully. API b61448cf then deployed
the recorded fixture import job at dep-db21h2flot8c73dfng20. Reviewed cards
08-staging-cash-close-walkthrough.png (11271), 09-staging-health-audit.png
(11272) and 10-staging-fixture-import-job.png (11273) are attached and named
on SCRUM-215. The ticket remains Testing for the final all-payments export.

## Isolated closing walkthrough

The existing ZZ TEST park clock was changed from 05:00 to 00:00 by guarded
job-db21dgek1f9s738o8gk0, so 6 October could be closed without reopening the
locked 5 October snapshot. A temporary branch-manager grant let the seeded
manager be selected as witness/approver on this QA park only. Revoke the
grant and archive this QA fleet after export proof. No shared Central data
was seeded/reset, and no earlier unresolved payment fact was changed.

Through the real signed-in Cash dialog, a THB 100 safe drop and THB 60
paid-out were recorded with a second person. The day read expected cash
minus THB 160 and float THB 6000 carried from the earlier close. Count 5890
showed THB 50 over; count 5840 balanced. All other actuals were zero; float
left was 5000. Close produced ZEOD-EOD-000003, automatically reached
printed on the simulator, and made the day read-only. Duplicate POST close
returned 409. A 7 October read carried 500000 satang from 6 October.

The UI-only count inputs briefly belonged to Central after a page reload,
because the prototype resets park choice on load. This was caught before
any close or cash write. The QA park was explicitly selected again, and
its minus160 expected amount verified before closing. Reload persistence
was not changed. The repaired park selection waits for server confirmation
and restores only the selected park's counter; the QA counter appeared
without the previous manual Refresh workaround.

Activity read-back and the real filtered screen contain end_of_day.close,
cash_movement.paid_out, cash_movement.safe_drop, settlement.run,
settlement.result and payment.settlement_confirmed. The revised single
branch count follows SCRUM-488; no drawer cash_session is claimed.

## Demo and fixture job

Health visibly offers Add demo sales to Central (today). Its write path
was exercised in disposable databases: 52 existing EOD/ops tests, including
11 sales, two TIDs, wallet grant/spend, voucher redemption, partial refund,
concurrent/repeated seed, reset/reseed, access guards and audit. The card
labels that result LOCAL, distinct from the real staging Health screen.

A new one-row unmatched H/D fixture was imported from Console on b61448cf.
Health reports job:settlement.2c2p_fixture_import successful. Reimport shows
already imported and keeps four batches; no duplicate financial payment.
This is an on-demand fixture job, not SFTP or production bank-file support.
The original matched QR/PAX proof remains the controlled new simulation,
not a claim that an unrelated historical seed attempt was settled.

## Final findings

The per-TID CSV exports the approved simulated terminal rows. The audit
found that a mandatory TID excluded gateway QR attempts with no TID;
an optional all-card-and-QR export is under repair and needs final proof.
CI 37373685349 and 37375835327 failed the missing settlement-line parent
entry and a print Vitest worker result-reporting timeout. The schema
contract is fixed in b61448cf (14/14 checks). Print raster test files now
run sequentially, retaining every test and timeout; 268/268 pass locally
with print typecheck/lint. This configuration still needs landing and CI.
Neither prior CI run is green.
