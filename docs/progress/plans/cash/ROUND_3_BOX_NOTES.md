# End of Day round 3: box terminal settlement

Checkpoint: 6 October 2026. Worktree `oto-pos-eod-settlement-box`, branch
`feat/eod-settlement-box`, based on `33681345`. Not committed or deployed by
this workstream; the integrating session owns landing, Jira and staging.

## Contract

`terminal_settle` receives `{batchId, deviceId, businessDate}`. The box posts
its result to `POST /settlements/batches/:batchId/terminal-result` using its
existing authenticated transport before acknowledging the command. Results
match the platform settlement contract: settled/unsupported/failed, device,
optional terminal identities and batch reference, and card/QR transaction lines.
A rejected or lost callback leaves the command unacknowledged. The box saves
settlement handouts before execution and the exact result before posting.
Its regular command tick (including startup) drains that durable queue without
platform redelivery. Up to five entries run per drain and failures rotate;
at 100 pending entries, polling excludes new settlements but still takes other
commands. The entry is removed only after callback and command acknowledgement
are accepted. Overlapping/nested command ticks coalesce without deadlocking.

The simulator holds its recorded transactions and batches in the existing
box runtime store, per device. References, amounts and approvals come from
transactions actually taken by the simulator. Declines, voids, already-settled
transactions and other business dates are excluded. Business date uses the
branch timezone and day start. Terminal identities are captured with the
transaction; mixed identities fail explicitly. SIM-prefixed batch references
make simulation visible. A retried batch returns its saved result even after
restart; a changed date under the same batch id is refused. Settlement and
sales use the same per-device queue. Voids after settlement are refused.

## Physical terminal limit, verified from supplied vendor documents

The local Digio-TLV-LinkPOS-Spec.html, version 2.21, section 5.12 specifies S0
request and S1 response. The response carries aggregate sale/refund counts and
amounts, not transaction-level references. Its settlement tags SA through SP
and merchant tag 0M are not hexadecimal BER-TLV tags; examples contain those
literal tags and disagree with action-code hex in the tables. The existing
encoder implements the document's numeric BER-TLV transport, so inventing an
encoding for these tags would risk issuing a wrong financial command. A
confirmed wire capture or corrected specification is required before enabling
physical Digio settlement. GHL LinkPOS 1.4 supplies sale/query/void but no
settlement command. Both physical adapters explicitly return unsupported and
open no serial link for settlement. This is not physical settlement proof.

## Verification

Existing terminal simulator tests cover a batch larger than the former
20-record diagnostic history limit, persistence across controller restart,
identical replay, exclusion of declines/voids/other dates/devices, refusing a
void after settlement, preserving the original TID, branch day start, and a
lost callback recovered by a new agent startup with no queued cloud command.
Paid GHL wallet tenders appear on the QR settlement line, with the same
references as their recorded payment result. Existing adapter,
fixture, serial channel, reference-counter, runner, clock measurement, epoch
adoption and store-recovery suites passed: 143 tests, zero failures.
Box package typecheck (source and tests), scoped ESLint and diff check passed.
The integrating session still needs combined API checks and staging evidence;
no deployment or physical-terminal success is claimed.
