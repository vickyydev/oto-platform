-- S2-14a round 4 (plan docs/progress/plans/wallet/PLAN.md §2.6) — offline
-- spend under the cap.
--
-- wallet_overdraft: a wallet a box spent with its link down reached the
-- platform holding less than the box took — two boxes spending one wallet in
-- one outage, or a spend online meanwhile. The spend is filed (the money was
-- promised at the counter), the wallet's balance never goes below zero (its
-- CHECKs stand), and the overdraft — wallet, box, station, amount — is named
-- on the anomaly with a critical alert.
--
-- The check constraint is widened; no data is rewritten.
--
-- Undo: put the 0037 list back (no row can hold the new kind unless a box
-- has synced an overdraft; delete those rows first).

ALTER TABLE "edge"."sync_anomaly" DROP CONSTRAINT "sync_anomaly_kind_check";--> statement-breakpoint
ALTER TABLE "edge"."sync_anomaly" ADD CONSTRAINT "sync_anomaly_kind_check" CHECK ("edge"."sync_anomaly"."kind" in ('clock_recomputed','duplicate_replay','sequence_gap','merge','epoch_regressed','late_arrival','receipt_collision','revoked_actor','wallet_overdraft'));
