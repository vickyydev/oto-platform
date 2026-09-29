-- UNDO of 0022_booth_staff_session_and_voucher_wording — run by hand, never
-- by the migrator (README.md beside this file says why it lives here).
--
-- 0022 (SCRUM-400, S2-07d) added the park's own wording for a voucher slip —
-- promo.voucher_definition: title_en, title_th, instruction_en,
-- instruction_th — and how long a sign-in at a booth lasts —
-- booth.booth_settings.staff_session_minutes, with its CHECK. All nullable,
-- nothing rewritten; going back is dropping them.
--
-- Nothing since stands on them: 0028's spin_duration_seconds is a column of
-- its own on booth_settings, and no view reads either table (no CREATE VIEW
-- in migrations/ up to 0034).
--
-- NOT REVERSIBLE — read before running:
--  * THE WORDS THE PARK TYPED and every booth's session length go with the
--    columns. Copy them out first if they are to be typed back later:
--      CREATE TABLE "public"."voucher_wording_before_undo_0022" AS
--        SELECT "id", "title_en", "title_th", "instruction_en", "instruction_th"
--          FROM "promo"."voucher_definition"
--         WHERE "title_en" IS NOT NULL OR "title_th" IS NOT NULL
--            OR "instruction_en" IS NOT NULL OR "instruction_th" IS NOT NULL;
--      CREATE TABLE "public"."booth_session_before_undo_0022" AS
--        SELECT "station_id", "staff_session_minutes"
--          FROM "booth"."booth_settings"
--         WHERE "staff_session_minutes" IS NOT NULL;
--  * WHAT A BOOTH ALREADY HOLDS. The wording and the session length reach a
--    box inside its published bundle, and a published version is frozen
--    (packages/db/src/schema/booth.ts, "A published wheel, frozen"): a box
--    keeps printing the words and keeping the session length it was last
--    published with until the booth is published again, and a release from
--    before 0022 ignores those fields in the bundle. Publish each booth again
--    after the undo if the boxes are to forget them.
--
-- RUN AS THE TABLES' OWNER (the migration role), as one transaction:
--   psql "$DATABASE_URL" -1 -f packages/db/migrations/undo/0022_booth_staff_session_and_voucher_wording.sql
--
-- AFTERWARDS: the row for 0022 stays in drizzle.__drizzle_migrations, and the
-- migrator re-applies nothing below its high-water mark — the way forward is
-- a new forward migration, not a re-run of 0022 (README.md).

-- The session length: the CHECK by name, then the column.
ALTER TABLE "booth"."booth_settings" DROP CONSTRAINT "booth_settings_staff_session_minutes_check";
ALTER TABLE "booth"."booth_settings" DROP COLUMN "staff_session_minutes";

-- The wording.
ALTER TABLE "promo"."voucher_definition"
  DROP COLUMN "title_en",
  DROP COLUMN "title_th",
  DROP COLUMN "instruction_en",
  DROP COLUMN "instruction_th";
