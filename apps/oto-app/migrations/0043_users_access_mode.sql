-- SCRUM-769: how much of the app a login reaches. 'full' is every login's, as
-- it always was; 'pay_only' is a login whose employment has ended, which the
-- 03:00 batch sets the night after the last working day (unless an Onboard
-- Again employment is planned) in place of switching the login off. It is a
-- switch of its own: is_active, and the platform's lifecycle trigger on it
-- (0031), are untouched, so a login in pay only reports no switch-off.
--
-- Expand-only: a column with a default every existing login takes ('full', so
-- nobody's access changes on deploy) and a check on its two values.
ALTER TABLE "users" ADD COLUMN "access_mode" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_access_mode_check" CHECK ("users"."access_mode" IN ('full', 'pay_only'));