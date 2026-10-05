# End of Day round 4 — demo-day fixture checkpoint

This checkpoint covers `seed:demo-day`, its existing EOD tests and the guarded Console Health test control. No staging demo seed or reset was run.

The nine existing sale keys, amounts and unresolved states remain. Two new sales bring the day to eleven:

- A socks sale paid wholly from a wallet tender. One THB 350 grant is linked to the earlier paid-adult `card-pax` sale; the wallet's grant and merchandise spend entries, wallet attempt and final balance agree. This is explicit fixture credit, not a claim that the old hand-built sale lines were run through the live per-person grant service.
- A ticket sale applies the seeded THB 100 discount voucher definition. The discount is recorded as promo, its cash attempt takes the reduced gross, and a manual-issued voucher has redemption history. There is no invented voucher tender button; the default till tenders remain cash, card and QR. Voucher claim values are generated at insertion and never logged by this seed.

A THB 100 partial cash refund against the first cash sale uses the station's refund series, one completed cash allocation and the seeded Central manager as approver. It reduces the original sale's End of Day cash line, following the prototype's rule.

Each scenario and the refund write inside their own transaction. Stable sale/action IDs make repeated runs on the same date no-ops. A demo reset retains voucher redemption history, so the voucher sale's ID includes its newly allocated receipt generation; reseeding after reset creates a new voucher identity without reusing the earlier one. The voucher's actual claim value is never written in a log, test assertion or document.

The seed's PAX device has no configured physical TID. Newly inserted PAX attempts get the clearly demo-only `DEMOPAX1` TID and `payload.fixtureTid: true` so the two-terminal EOD and CSV exercise can be run without changing the device settings or rewriting already-seeded attempts. Existing attempts with a null TID stay as they were.

`seedDemoDay` takes a `Db` connection and opens per-scenario transactions itself. The Health `demo.day` test control calls it with `app.db` after platform-wide access and `OPS_TEST_CONTROLS` checks. It is audited, clearly names Central and does not reset existing records. Per-action advisory locks serialize concurrent seeds. The existing EOD test runs two concurrent seeds on an isolated date, checks a repeated run, card/QR/cash/credit sums, voucher and wallet ledgers and refund, then resets and reseeds to exercise retained voucher history.

Verification: existing EOD and ops API files pass 52/52; DB/API/POS/Console typecheck, scoped lint and both frontend builds pass. The branch-switch race found during staging is repaired separately in the same release: server confirmation precedes park publication, and stale station results cannot restore the previous park. Its existing lane file passes 12/12. Staging verification of the new control and park switch remains after deployment. Do not press the demo seed control against shared Central merely to take a screenshot; the write path was exercised against disposable test databases.
