# SCRUM-966 / SCRUM-945 slip baseline design checkpoint

14 November 2026. Design only; no source edits or tests yet. Isolated worktree `C:/oto-lanes/codex-slip-baseline-20261114`, branch `lane/codex-slip-baseline-20261114`, base `f7df3150f9405dd6aa3480d11c6ab166abf345b2`.

## Confirmed cause and boundaries

`party-slips.ts` currently replaces the previous station document with the current plan whenever its composer/source mark differs. That suppresses a real edit made before the first tick after a release. The JSONB held field currently contains rendered lines/orderRef only; rendered text cannot reconstruct semantic choice, audience, provenance or routing. Existing tests already insert/update/delete this unrestricted held JSON, so optional semantic data needs no database migration. `readPartyPlan` also reports source legacy when no seam row was returned; using that synthetic source creates a false composer transition on disappear/return.

Sole source ownership is `apps/api/src/services/party-slips.ts`, `party-plan.ts` and dedicated API slip tests/review pins. Shared schema imports may be used, but no shared composer/pricing changes are planned. No party-settlement, refunds, app editor or applied migration edits. No composer generation bump merely to add baseline bookkeeping. Preserve cancelled/no-package handling, reprint rules, source locks, station independence, idempotency and all owner holds.

## Prospective stored snapshot

Extend the existing held JSON with an optional `composeInput` carrying `version: 1`. Capture the serializable composition input contract: semantic setMenu/barItems, kitchen timing, counts, cake, partyName/location and the resolved code-to-prep-station map (including explicit null for an absent live code). Do not store the full event/settlement/customer row, money calculations, separate family/allergy/contact columns or a current catalogue lookup instruction. Existing kitchen notes already used on the printed slip remain part of the semantic input. Strip irrelevant line price/onTillMenu/lineId fields; retain audience, origin, choices, quantities and notes consumed by composition. The print clock is supplied when recomposing; it is already excluded from the content fingerprint.

Use existing shared Zod plan schemas to validate the supported version and fields at the JSON boundary. A valid snapshot requires a complete routing entry for each referenced code. Unknown version, malformed input or missing routing is historical fallback, never a crash or partial guess. Keep the existing lines/orderRef alongside it. Represent known empty output with empty rendered lines plus the versioned null-plan snapshot and fingerprint `none`; decode that fingerprint as null before diffing. This lets a cancelled/void station carry an explicit prospective empty state without a new column or public contract.

Capture at actual print, actual change and an explicit historical rebase. Each station retains its own semantic snapshot even though the input contains both stations' plan fields. Do not refresh an unchanged station from unrelated current edits unless its baseline itself is being normalized safely.

## Upgrade algorithm

1. Read actual previous print/change documents and sources under the existing party/day transaction lock.
2. Matching source + current composer keeps current behavior. Matching source + a valid older snapshot recomposes the PREVIOUS semantic input under current code, using its saved routing map, then compares that result with the real CURRENT plan using current routing. This preserves a staff edit and a routing change while suppressing presentation-only composer changes.
3. Normalize that station's baseline to the new composer and recomposed previous held document/snapshot, even if no change prints. Do not normalize it to the current plan first. All writes stay in the same existing transaction. If change slips print, their existing change:run source and the current snapshot replace the normalized mark only for the stations sent those slips.
4. No snapshot, invalid snapshot or source mismatch uses the established release rebase-to-current behavior, with an explicit historical-fallback audit reason. Capture the current snapshot at that rebase so future upgrades are protected. The pre-existing release-window limitation remains: an edit already swallowed without an old semantic snapshot cannot be reconstructed. No claim otherwise.
5. Cancellation uses the actual held lines for VOID, preserving established behavior. It stores a known-empty semantic state after the change, so a returned plan can generate UPDATED correctly.

## Missing row is not a composer

Add internal `rowPresent` metadata to PartyPlanRead; leave public plan/status responses unchanged. Seam missing/not-granted remains unknown/refused as today. A missing plan row still follows the existing absent/void behavior; this is not a policy change making every no_package unknown.

When rowPresent is false, do not derive a new epoch from the compatibility source legacy. Retain the previous station mark's composer when recording its cancellation/empty state. If a historical station has no composer mark, do not invent one merely to store that missing read; its actual VOID/change document still records the empty state. On return, a known-empty latest change source is compared as null, rather than being replaced by the current nonempty plan. This narrow empty-state case is supportable from actual recorded change documents and does not reconstruct a missing old semantic plan. A real legacy row remains a known source and retains normal behavior.

## Planned adversarial proof

Whole API files only, serial embedded PostgreSQL after the coordinated heavy slot is free. First reproduce the existing loss on the unmodified service, then pin:

- unchanged semantic plan across composer upgrade: no VOID/UPDATED; mark normalized once;
- genuine edit before first post-upgrade tick: prior composed choice/quantity removed and current plan updated;
- routing change across upgrade: saved before routing versus current after routing, each affected station correct;
- one-station-only change leaves the other station unchanged;
- missing row and returned same/changed plans retain the prior composer and compare against the actual void/empty state;
- cancellation across an upgrade voids actual held lines;
- historical no-snapshot, malformed snapshot, unsupported version and source mismatch take the explicit established fallback once;
- known empty station, null-plan snapshot, retry/action-id replay and concurrent tick/print preserve idempotency;
- real legacy source is distinct from a missing row; no public response schema or owner-held behavior change.

Run the complete `apps/api/test/party-slips.test.ts`, the new scoped review file, relevant whole party-plan reader tests if found, zero-output API types and touched-file lint. Shared prep-slips whole suite only if its code changes. Existing tests that simulate historical missing marks remain as historical-fallback coverage, not weakened. Native staging proof and inspected evidence after root-approved landing will be bounded to simulated/queued records; physical printer acceptance remains unclaimed.

Implementation awaits root design review. BEO agent currently owns the heavy slot after deposit install release; this lane is light read/design only. No landing before app844 and root source review.
