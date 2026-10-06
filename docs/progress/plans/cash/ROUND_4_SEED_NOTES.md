# End of Day round 4 — demo-day fixture checkpoint

This checkpoint covers only the `seed:demo-day` source and its existing EOD test file. No staging data was written.

The nine existing sale keys, amounts and unresolved states remain. Two new sales bring the day to eleven:

- A socks sale paid wholly from a wallet tender. One THB 350 grant is linked to the earlier paid-adult `card-pax` sale; the wallet's grant and merchandise spend entries, wallet attempt and final balance agree. This is explicit fixture credit, not a claim that the old hand-built sale lines were run through the live per-person grant service.
- A ticket sale applies the seeded THB 100 discount voucher definition. The discount is recorded as promo, its cash attempt takes the reduced gross, and a manual-issued voucher has redemption history. There is no invented voucher tender button; the default till tenders remain cash, card and QR. Voucher claim values are generated at insertion and never logged by this seed.

A THB 100 partial cash refund against the first cash sale uses the station's refund series, one completed cash allocation and the seeded Central manager as approver. It reduces the original sale's End of Day cash line, following the prototype's rule.

Each scenario and the refund write inside their own transaction. Stable sale/action IDs make repeated runs on the same date no-ops. A demo reset retains voucher redemption history, so the voucher sale's ID includes its newly allocated receipt generation; reseeding after reset creates a new voucher identity without reusing the earlier one. The voucher's actual claim value is never written in a log, test assertion or document.

The seed's PAX device has no configured physical TID. Newly inserted PAX attempts get the clearly demo-only `DEMOPAX1` TID and `payload.fixtureTid: true` so the two-terminal EOD and CSV exercise can be run without changing the device settings or rewriting already-seeded attempts. Existing attempts with a null TID stay as they were.

`seedDemoDay` takes a `Db` connection and opens per-scenario transactions itself. An ops/Health test-control route should call it with `app.db` after its access checks, outside an enclosing `withTx`; the test-control UI and its route are owned by the integration lane. The existing EOD test file runs the seed twice on an isolated date, checks card/QR/cash/credit sums, voucher and wallet ledgers and the refund, then resets and reseeds to exercise retained voucher history.
