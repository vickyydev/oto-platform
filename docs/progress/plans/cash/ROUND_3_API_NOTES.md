# End of Day round 3 — API integration notes

Scope: SCRUM-215 settlement API/model slice. This note is a checkpoint for the POS, Console and box-agent lanes; it is not staging proof.

## Contract

- `GET /branches/:branchId/settlements?date=YYYY-MM-DD` returns `SettlementSummary`: branch/date, active terminal `devices` (`id`, `label`, `tid`, `provider`), `batches`, `lines`, and `unmatchedAttempts`. It requires `pos:cash:read` in the branch.
- `POST /branches/:branchId/settlements/terminal-runs` takes `{date,deviceId}` and returns `{batchId,commandId,state:"pending"}`. It requires `pos:payment:settle` and queues a `terminal_settle` box command `{batchId,deviceId,businessDate}`. Send an `Idempotency-Key` for a retryable UI action.
- `POST /settlements/batches/:batchId/terminal-result` uses the existing box credential, never a caller-supplied box identity. It takes `TerminalSettlementResultBody` from `@oto/shared`: `outcome`, `deviceId`, optional `tid`/`mid`/`batchRef`, allowlisted card/QR `lines`, optional `errorCode`. It returns `{batchId,replayed,state,matched,unmatched,mismatched}`. The accepted result finalizes the associated box command in the same transaction. Identical callback replay succeeds; changed-body replay is refused.
- `GET /branches/:branchId/settlements/export?date=YYYY-MM-DD&tid=...` downloads a UTF-8 CSV with columns `business_date,tid,method,amount_satang,approval_code,invoice_no,tran_ref,status`; one row per approved till card/QR attempt for that TID. Cells escape spreadsheet formula prefixes. It excludes raw provider payload and card data.
- `POST /branches/:branchId/settlements/2c2p-import` takes `{date,fileName,csv}` (max two million characters) and returns the same result shape. It requires `pos:payment:settle`. The selected branch and date scope matching; the file itself has no date field. The file hash is the idempotency key, and importing identical bytes for another day is refused.

The importer accepts **only the documented H/D fixture**, header `TYPE_TABLE,invoiceNo,tranRef,paymentID,amount,currencyCode,transactionType,method`, one `H` row, then at most 10,000 `D` rows. It accepts THB and `payment`/`refund`/`chargeback` transaction types. A non-payment line is shown for review and never confirms an attempt. This is deliberately not a claim that a live 2C2P SFTP file is compatible: production field mapping is excluded from S2-15a and must be verified against an actual provider file.

## Money and replay invariants

Evidence matches by any recorded reference, then checks every other mutually known reference, TID when present, and exact satang amount. A terminal-supplied new reference can therefore accompany an older offline attempt that only held its terminal reference. Equal amount alone never matches. Duplicate/ambiguous, missing, amount-mismatched and reference-mismatched evidence remains visible for review, including the terminal reference itself. Concurrent batches for the same branch/day serialize their match decisions. Only a matched Digio `awaiting_settlement` attempt becomes `approved`; it keeps its original `paidAt`, `businessDate`, amount and sale. Settlement never pays again or rewrites a frozen End of Day snapshot. `settlement.run`, `settlement.result` and confirmed-attempt actions are audited.

The box callback checks the credential's operator/branch against the batch and its box against the original command, so reassignment of the terminal does not invalidate a durable result from the box that ran it. The callback route has a 16 MB body limit for a schema-valid 10,000-line batch. The box runner must retain a pending callback across restart until both callback and command acknowledgement succeed. The API's existing command-ack endpoint accepts an already-final command as an idempotent replay.

## Staging proof path

The existing `seed:demo-day` PAX `awaiting_settlement` row predates the simulator's recorded terminal history. A new simulator `terminal_settle` run does **not** honestly contain that historical row. For staging, create a new simulated card/QR sale through the terminal, then run settlement and verify the returned line/reference, attempt state, audit and CSV. To prove the historical seeded row specifically, use explicit fixture evidence that carries its recorded reference and amount; never assert that an empty terminal batch reconciled it. An unmatched 2C2P fixture line should produce an `attention` batch and remain on the match view.

Physical Digio/GHL settlement transport remains unsupported until its actual terminal wire protocol and vendor response fields are verified on site. An unsupported result is visible; it does not manufacture matched lines or approve attempts.
