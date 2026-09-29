-- UNDO of 0021_voucher_redemption — run by hand, never by the migrator
-- (README.md beside this file says why it lives here and not in 0021).
--
-- 0021 (S2-10b, SCRUM-207) gave a booth voucher a HOLD — five columns on
-- promo.voucher (redeemed_station_id, held_sale_id, held_station_id,
-- held_by_account_id, held_at) with their foreign keys, their indexes and
-- voucher_hold_check — an append-only ledger promo.voucher_redemption, a
-- guessing throttle promo.redemption_throttle, and the trigger on pos.sale
-- that lets a voided sale's held voucher go.
--
-- WHAT THIS FILE TAKES WITH IT. Two later migrations stand on those objects
-- and go with them, there being nothing of theirs left to keep once the
-- tables are gone: 0023 (the TRUNCATE trigger on the ledger, on 0021's
-- function) and 0024 (recent_miss_code_hashes on the throttle). Nothing else
-- since depends on them: 0026's promo.voucher_miss stands on core tables
-- only, and no view reads any of these (no CREATE VIEW in migrations/ up to
-- 0034).
--
-- NOT REVERSIBLE — read before running:
--  * THE LEDGER ROWS. promo.voucher_redemption is the record of who held,
--    applied, used up and released which voucher, at which till, for which
--    sale; promo.voucher's own columns are only the mirror of the present.
--    Dropping the table is dropping that record, and nothing else holds it.
--    Copy it out first if it may ever be asked for — a plain copy, with no
--    trigger on it, since the append-only rule stays with the original:
--      CREATE TABLE "public"."voucher_redemption_before_undo_0021" AS
--        SELECT * FROM "promo"."voucher_redemption";
--    (or pg_dump -t promo.voucher_redemption to a file).
--  * A VOUCHER HELD AT THE MOMENT OF RUNNING loses its hold with the columns:
--    the sale that held it can no longer use it up as a hold, and the voucher
--    stays 'issued', free to be redeemed again. The guard at the top refuses
--    to run while any voucher is held, so that this is a decision and not a
--    side effect: run it when no till is mid-sale with a voucher, or release
--    the holds first, knowingly.
--  * WHERE A USED-UP VOUCHER WAS REDEEMED: redeemed_station_id goes. When, by
--    whom, at which branch and on which sale stay — 0012's redeemed_at,
--    redeemed_by_account_id, redeemed_branch_id and sale_id are untouched.
--  * The throttle's memory of the last minute's misses and any lock in force,
--    which nothing needs a minute later.
--
-- RUN AS THE TABLES' OWNER (the migration role, not the api's), as one
-- transaction:
--   psql "$DATABASE_URL" -1 -f packages/db/migrations/undo/0021_voucher_redemption.sql
-- The append-only triggers refuse UPDATE, DELETE and TRUNCATE of the ledger;
-- DROP TABLE is none of those, and is the owner's to run.
--
-- AFTERWARDS: the rows for 0021, 0023 and 0024 stay in
-- drizzle.__drizzle_migrations, and the migrator re-applies nothing below its
-- high-water mark — the way forward is a new forward migration, not a re-run
-- of 0021 (README.md).

-- 0. Refuse while a voucher is held for a sale in progress (see above).
DO $$
DECLARE held integer;
BEGIN
  SELECT count(*) INTO held FROM "promo"."voucher" WHERE "held_sale_id" IS NOT NULL;
  IF held > 0 THEN
    RAISE EXCEPTION 'undo 0021 refused: % voucher(s) are held for a sale in progress; run when no till is mid-sale with a voucher, or release the holds first', held;
  END IF;
END $$;

-- 1. A voided sale no longer lets a voucher go: the trigger, then its function.
DROP TRIGGER "sale_void_releases_vouchers" ON "pos"."sale";
DROP FUNCTION "promo"."release_vouchers_on_void"();

-- 2. The ledger. Its row trigger (0021) and its statement trigger (0023) go
--    with the table; the function they share goes once both are gone.
DROP TABLE "promo"."voucher_redemption";
DROP FUNCTION "promo"."voucher_redemption_append_only"();

-- 3. The throttle, 0024's column included.
DROP TABLE "promo"."redemption_throttle";

-- 4. The hold and the station on promo.voucher. The CHECK first, by name; the
--    foreign keys and the indexes on these columns (voucher_redeemed_station_idx,
--    voucher_held_sale_unique, voucher_held_station_idx, voucher_held_by_idx)
--    are dropped with the columns.
ALTER TABLE "promo"."voucher" DROP CONSTRAINT "voucher_hold_check";
ALTER TABLE "promo"."voucher"
  DROP COLUMN "redeemed_station_id",
  DROP COLUMN "held_sale_id",
  DROP COLUMN "held_station_id",
  DROP COLUMN "held_by_account_id",
  DROP COLUMN "held_at";
