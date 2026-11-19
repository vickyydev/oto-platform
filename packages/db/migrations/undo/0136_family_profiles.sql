-- UNDO of 0136_family_profiles — run by hand, never by the migrator
-- (README.md beside this file says why it lives here).
--
-- 0136 (SCRUM-1024, family profiles, plan step F1) added crm.family,
-- crm.family_guardian, and on crm.child the nullable columns family_id and
-- merged_into_child_id with their foreign keys and indexes. Going back is
-- dropping them, children's columns first, then the guardian rows, then the
-- families.
--
-- WHEN IT IS SAFE: only while nothing reads a family, that is before any
-- reader is switched (plan step F3) and with the switch crm.family_profiles
-- at `off` everywhere (FLAG_CATALOGUE lists it as not supported until then,
-- so no write path can have set it). Afterwards the way back is the switch,
-- set to `off`, which keeps every family for a later `on` (plan section 3,
-- "Undo without losing data").
--
-- NOT REVERSIBLE — read before running:
--  * EVERY FAMILY AND GUARDIAN ROW goes, and every child's family_id. While
--    each family has the one guardian its first child was saved under, the
--    backfill (packages/db/scripts/family-backfill.ts, plan step F2) makes
--    them again from child.member_id after a new forward migration puts the
--    tables back. A family with a SECOND guardian (plan step F4) or a merged
--    child (F5) cannot be rebuilt that way: copy them out first, e.g.
--      CREATE TABLE "public"."family_guardian_before_undo_0136" AS
--        SELECT * FROM "crm"."family_guardian";
--      CREATE TABLE "public"."child_family_before_undo_0136" AS
--        SELECT "id", "family_id", "merged_into_child_id" FROM "crm"."child"
--         WHERE "family_id" IS NOT NULL OR "merged_into_child_id" IS NOT NULL;
--  * Audit rows that name a family (action family.create) stay: the audit
--    log is never rewritten.
--  * The api running when this is run must be a release from before 0136:
--    a later one writes a family for every new child and would fail on the
--    missing table.
--
-- RUN AS THE TABLES' OWNER (the migration role), as one transaction:
--   psql "$DATABASE_URL" -1 -f packages/db/migrations/undo/0136_family_profiles.sql
--
-- AFTERWARDS: the row for 0136 stays in drizzle.__drizzle_migrations, and the
-- migrator re-applies nothing below its high-water mark — the way forward is
-- a new forward migration, not a re-run of 0136 (README.md).

-- The child's two columns: their foreign keys and indexes go with them.
ALTER TABLE "crm"."child"
  DROP COLUMN "merged_into_child_id",
  DROP COLUMN "family_id";

-- The guardian rows, then the families they name.
DROP TABLE "crm"."family_guardian";
DROP TABLE "crm"."family";
