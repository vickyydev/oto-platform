-- SCRUM-433 — a sale's voucher line names the voucher by the last four
-- characters of its code, on the sales rung up before that rule too.
--
-- Since 2246aef the api labels a voucher's discount line "<type name> (voucher
-- …XXXX)" (`voucherLineLabel`, apps/api/src/services/vouchers.ts). A sale rung
-- up before it keeps the label it was written with, "<type name> (voucher
-- <whole code>)", and History shows the label, so those sales still showed a
-- code whole — and on a voided sale the voucher is free again. This rewrites
-- those labels once, into the form the api writes now. Only `label` changes:
-- the row's `code` keeps the whole code, which the ledger needs.
--
-- WHICH ROWS: a promo row whose label ends with " (voucher ", the row's own
-- code, and ")". That is the old form and nothing else. A park code's row
-- carries its definition's label, a manual row has no code, and a label in the
-- new form ends with "…" and four characters, never with the whole code — so a
-- second run matches nothing and changes nothing. The api answers a label left
-- in the old form the same way (`maskedVoucherLineLabel`), by the same test.
--
-- THE FREEZE. pos.sale_child_freeze refuses an UPDATE of any row of a sale that
-- is finalised, voided or refunded, and the rows to rewrite belong to exactly
-- those. Its trigger on this table is disabled for the one statement and
-- enabled again straight after. The migrator runs a migration inside one
-- transaction, so no other session ever sees the table without its trigger,
-- and the ALTER's lock holds every other writer of pos.sale_discount until the
-- transaction commits.
--
-- TO REVERSE: the code column still holds the whole code, so the old labels
-- can be written back from it, under the same guard:
--   ALTER TABLE "pos"."sale_discount" DISABLE TRIGGER "sale_discount_freeze";
--   UPDATE "pos"."sale_discount"
--      SET "label" = left("label", length("label") - length(' (voucher …' || right("code", 4) || ')'))
--                    || ' (voucher ' || "code" || ')'
--    WHERE "kind" = 'promo' AND "code" IS NOT NULL AND "label" IS NOT NULL
--      AND right("label", length(' (voucher …' || right("code", 4) || ')')) = ' (voucher …' || right("code", 4) || ')';
--   ALTER TABLE "pos"."sale_discount" ENABLE TRIGGER "sale_discount_freeze";
-- That writes the whole code back on every voucher line, the ones the api has
-- labelled since 2246aef included, which is what going back to the old rule is.
--
-- No column, constraint or index moves. Safe on a live database.
ALTER TABLE "pos"."sale_discount" DISABLE TRIGGER "sale_discount_freeze";--> statement-breakpoint
UPDATE "pos"."sale_discount"
   SET "label" = left("label", length("label") - length(' (voucher ' || "code" || ')'))
                 || ' (voucher …' || right("code", 4) || ')'
 WHERE "kind" = 'promo'
   AND "code" IS NOT NULL
   AND "label" IS NOT NULL
   AND right("label", length(' (voucher ' || "code" || ')')) = ' (voucher ' || "code" || ')';--> statement-breakpoint
ALTER TABLE "pos"."sale_discount" ENABLE TRIGGER "sale_discount_freeze";
