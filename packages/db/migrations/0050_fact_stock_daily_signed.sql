-- S2-14b round 4 (plan docs/progress/plans/stock/PLAN.md §2.5) — the daily
-- stock fact is the ledger's own arithmetic by business date, signed.
--
-- analytics.fact_stock_daily is written from pos.stock_movement per branch,
-- item and business date: opening = every movement dated before the day,
-- closing = opening + the day's movements, exactly. 0048 carried a CHECK that
-- opening and closing are never below zero, borrowed from the level's own
-- rule. The level never is — it moves in the order movements ARRIVE — but a
-- day's sum is taken in BUSINESS-DATE order, and the two differ when a
-- movement arrives after a later-dated one: a box's offline sale from
-- yesterday synced this morning after today's delivery, or a card approved
-- today on a sale committed yesterday. Yesterday's ledger then truly closes
-- short (it sold what it had not yet received on the record), and the CHECK
-- would refuse the one honest figure — the daily job would fail for that day
-- for ever. The CHECK is dropped; nothing is rewritten.
--
-- Undo: re-add the CHECK (fails while any row is negative; delete or rewrite
-- those days first).

ALTER TABLE "analytics"."fact_stock_daily" DROP CONSTRAINT "fact_stock_daily_closing_check";
