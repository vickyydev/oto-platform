-- S2-14b round 3 (plan docs/progress/plans/stock/PLAN.md §2.4) — stock sold
-- offline past what the record held.
--
-- stock_oversold: a sale a box took with its link down reached the platform
-- wanting more of an item than the record held — two boxes selling the same
-- last units in one outage, or a counter online selling them meanwhile. The
-- sale is filed (it was paid), the level floors at zero with the rest recorded
-- as the movement's shortfall (0048's never-negative choice), and the item,
-- size, place, box, station and short quantity are named on the anomaly with
-- a critical alert.
--
-- The check constraint is widened; no data is rewritten. The `stock` cache
-- scope this round adds is served by GET /box/v1/cache only and never written
-- to edge.sync_change, so the change-feed scope list is not touched.
--
-- Undo: put the 0046 list back (no row can hold the new kind unless a box has
-- synced an oversold sale; delete those rows first).

ALTER TABLE "edge"."sync_anomaly" DROP CONSTRAINT "sync_anomaly_kind_check";--> statement-breakpoint
ALTER TABLE "edge"."sync_anomaly" ADD CONSTRAINT "sync_anomaly_kind_check" CHECK ("edge"."sync_anomaly"."kind" in ('clock_recomputed','duplicate_replay','sequence_gap','merge','epoch_regressed','late_arrival','receipt_collision','revoked_actor','wallet_overdraft','stock_oversold'));
