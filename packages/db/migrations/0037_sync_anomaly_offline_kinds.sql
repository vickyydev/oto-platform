-- Offline selling, Round 4 (plan docs/progress/plans/offline/PLAN.md §2.6,
-- OD-4 and OD-9) — two caveats a replayed sale can be filed with.
--
-- receipt_collision: a sale a box numbered offline arrived to find its printed
-- number already used in the station's series, and was filed under the next
-- free one. Both numbers are on the anomaly and on the audit row.
--
-- revoked_actor: a fact made by an account whose shift token was revoked
-- before the fact happened. It is applied anyway — a sale that happened is
-- filed, not lost — and an alert goes with it.
--
-- The check constraint is widened; no data is rewritten.

ALTER TABLE "edge"."sync_anomaly" DROP CONSTRAINT "sync_anomaly_kind_check";--> statement-breakpoint
ALTER TABLE "edge"."sync_anomaly" ADD CONSTRAINT "sync_anomaly_kind_check" CHECK ("edge"."sync_anomaly"."kind" in ('clock_recomputed','duplicate_replay','sequence_gap','merge','epoch_regressed','late_arrival','receipt_collision','revoked_actor'));
