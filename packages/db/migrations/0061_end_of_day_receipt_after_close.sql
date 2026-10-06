-- S2-15a follow-up (plan docs/progress/plans/cash/PLAN.md §2 "Who closes";
-- SCRUM-215) — a day closed away from a printing counter gets its End of Day
-- receipt later. Any holder of pos:cash:day_close may close; when the session
-- has no counter, or its counter has no box or no receipt series, the day
-- closes without a receipt number and the first print from a counter numbers
-- it on that counter's series.
--
-- pos.end_of_day stays append-only, with one narrow exception: a row closed
-- WITHOUT a receipt may have its receipt number and closing counter written
-- once (both together, as end_of_day_receipt_check already requires), with
-- updated_at. Every other column, and any second write of the receipt, is
-- still refused exactly as before (P0001). DELETE is unchanged: refused except
-- under the demo reset's purge flag (oto.cash_ledger_purge).
--
-- pos.cash_movement keeps pos.cash_ledger_append_only(); only end_of_day's
-- trigger moves to its own function.
--
-- Undo: CREATE TRIGGER "end_of_day_append_only" back on
-- "pos"."cash_ledger_append_only"() (DROP the trigger first), then DROP
-- FUNCTION "pos"."end_of_day_append_only"(). Rows that were numbered after
-- their close keep their number.

CREATE FUNCTION "pos"."end_of_day_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('oto.cash_ledger_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.receipt_number IS NULL AND OLD.receipt_station_id IS NULL
     AND NEW.receipt_number IS NOT NULL AND NEW.receipt_station_id IS NOT NULL
     AND (to_jsonb(NEW) - 'receipt_number' - 'receipt_station_id' - 'updated_at')
       = (to_jsonb(OLD) - 'receipt_number' - 'receipt_station_id' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pos.% is append-only: a closed day and a recorded paid-out or safe drop are never edited or removed', TG_TABLE_NAME;
END $$;
--> statement-breakpoint
DROP TRIGGER "end_of_day_append_only" ON "pos"."end_of_day";
--> statement-breakpoint
CREATE TRIGGER "end_of_day_append_only" BEFORE UPDATE OR DELETE ON "pos"."end_of_day"
FOR EACH ROW EXECUTE FUNCTION "pos"."end_of_day_append_only"();
