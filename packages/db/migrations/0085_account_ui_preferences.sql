-- SCRUM-653 — a person's theme and language, kept on their account so every
-- staff app shows them the same way after sign-in. Expand-only: two columns
-- with defaults (every existing account reads 'system' and 'en') and two
-- CHECKs on the new columns alone; nothing is renamed, dropped or rewritten,
-- and a release that does not know the columns never reads them.
--
-- Plan: docs/progress/plans/suite-ui-preferences/PLAN.md.
--
--   core.account.ui_theme     'system' | 'light' | 'dark'   default 'system'
--   core.account.ui_language  'en' | 'th'                   default 'en'
--
-- TO REVERSE: drop the two constraints, then the two columns. The choices
-- people made are lost with them; nothing else reads them.
ALTER TABLE "core"."account" ADD COLUMN "ui_theme" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."account" ADD COLUMN "ui_language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."account" ADD CONSTRAINT "account_ui_theme_check" CHECK ("core"."account"."ui_theme" in ('system','light','dark'));--> statement-breakpoint
ALTER TABLE "core"."account" ADD CONSTRAINT "account_ui_language_check" CHECK ("core"."account"."ui_language" in ('en','th'));