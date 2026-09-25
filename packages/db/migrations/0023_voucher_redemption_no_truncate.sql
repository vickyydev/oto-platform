-- SCRUM-411 (booth audit L11) — the redemption ledger's append-only rule,
-- completed.
--
-- 0021 refuses an UPDATE or a DELETE on promo.voucher_redemption row by row,
-- and a row trigger never fires for TRUNCATE: one statement, run as the api's
-- own role, emptied the ledger the audit calls the evidence of who gave away
-- what. The same function is attached again at statement level for TRUNCATE
-- — TG_OP names what was refused — and it fires whether the table is named
-- directly or reached through TRUNCATE ... CASCADE from promo.voucher, so the
-- vouchers cannot be emptied around it either.
--
-- What no trigger can do: the table's owner may still drop or disable it. The
-- other half of the rule is operational — run the api as a role that does not
-- own the table — and is not a migration.
--
-- Adds one trigger; no column, row or constraint moves. Safe on a live database.
CREATE OR REPLACE TRIGGER "voucher_redemption_no_truncate" BEFORE TRUNCATE ON "promo"."voucher_redemption"
  FOR EACH STATEMENT EXECUTE FUNCTION "promo"."voucher_redemption_append_only"();
