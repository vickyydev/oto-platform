-- SCRUM-929 (the till's Theme > Display switch reaches a paired customer
-- display) - expand-only: one nullable column and one CHECK on
-- edge.station_session, the virtual box's station document. No row is written.
--
--   edge.station_session.theme
--       the paired display's look as a till last told it: 'light' or 'dark';
--       null until one does (the display keeps the look it remembers)
--   station_session_theme_check
--       the value is one of the two, or null
--
-- A Pi's own store gains the same column when its box agent starts
-- (addSqliteSessionTheme in packages/box-agent/src/store-sqlite.ts).
--
-- TO REVERSE 0122 (nothing else refers to the column): drop the CHECK, then
-- the column.
ALTER TABLE "edge"."station_session" ADD COLUMN "theme" text;--> statement-breakpoint
ALTER TABLE "edge"."station_session" ADD CONSTRAINT "station_session_theme_check" CHECK ("edge"."station_session"."theme" is null or "edge"."station_session"."theme" in ('light','dark'));