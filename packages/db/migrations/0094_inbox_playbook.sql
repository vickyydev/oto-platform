-- SCRUM-220 (Unified Inbox, the playbook build: Tom's "Oto Inbox Bot
-- Playbook" is the assistant's first rule) - the shared contract the
-- playbook lanes build on. Expand-only: CHECK swaps that only WIDEN a list,
-- one new NULLABLE column with its own shape CHECK, and no row is written
-- here (platform-sync lays the GM team and the closing lines).
--
--   conversation.category, routing_rule.category,
--   channel_account.default_category                     + gm
--       the general manager's queue: complaints, influencers, jobs,
--       photography, refunds.
--   team.key                                              + gm
--       the one operator-wide GM team that owns it.
--   template.key (and channel_account.out_of_hours_template_key)
--                       + closing_birthday, closing_gm, closing_branch
--       the playbook's destination-keyed closing lines.
--   channel_account.silence_policy (jsonb, null = no policy)
--       {"silentIntents": [...]}: the intents on which the assistant stays
--       silent to the customer on that number and leaves the thread to the
--       team (a branch's drop-off and nanny desk). Null on every row here.
--
-- TO REVERSE (the CHECK restores fail while a row uses a widened value -
-- move every gm conversation, routing rule and channel account to another
-- category, delete the gm team's rules and the gm team, archive or delete
-- the closing_* templates first): drop channel_account_silence_policy_check
-- and the silence_policy column, and re-add the six swapped CHECKs with the
-- lists of 0083_inbox_test_night (template and out-of-hours keys) and
-- 0078_inbox_schema (categories and team keys).
ALTER TABLE "inbox"."channel_account" DROP CONSTRAINT "channel_account_default_category_check";--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" DROP CONSTRAINT "channel_account_out_of_hours_key_check";--> statement-breakpoint
ALTER TABLE "inbox"."conversation" DROP CONSTRAINT "conversation_category_check";--> statement-breakpoint
ALTER TABLE "inbox"."routing_rule" DROP CONSTRAINT "routing_rule_category_check";--> statement-breakpoint
ALTER TABLE "inbox"."team" DROP CONSTRAINT "team_key_check";--> statement-breakpoint
ALTER TABLE "inbox"."template" DROP CONSTRAINT "template_key_check";--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" ADD COLUMN "silence_policy" jsonb;--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" ADD CONSTRAINT "channel_account_silence_policy_check" CHECK ("inbox"."channel_account"."silence_policy" is null or (jsonb_typeof("inbox"."channel_account"."silence_policy") = 'object' and coalesce(jsonb_typeof("inbox"."channel_account"."silence_policy" -> 'silentIntents'), '') = 'array'));--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" ADD CONSTRAINT "channel_account_default_category_check" CHECK ("inbox"."channel_account"."default_category" in ('birthdays','general','marketing','gm'));--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" ADD CONSTRAINT "channel_account_out_of_hours_key_check" CHECK ("inbox"."channel_account"."out_of_hours_template_key" is null or "inbox"."channel_account"."out_of_hours_template_key" in ('welcome','handover_birthday','handover_events','handover_complaint_online','handover_complaint_onsite','handover_lost_found','handover_marketing','out_of_hours','handover_general','follow_up','closing_birthday','closing_gm','closing_branch'));--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD CONSTRAINT "conversation_category_check" CHECK ("inbox"."conversation"."category" in ('birthdays','general','marketing','gm'));--> statement-breakpoint
ALTER TABLE "inbox"."routing_rule" ADD CONSTRAINT "routing_rule_category_check" CHECK ("inbox"."routing_rule"."category" in ('birthdays','general','marketing','gm'));--> statement-breakpoint
ALTER TABLE "inbox"."team" ADD CONSTRAINT "team_key_check" CHECK ("inbox"."team"."key" in ('birthdays','reception','marketing','gm'));--> statement-breakpoint
ALTER TABLE "inbox"."template" ADD CONSTRAINT "template_key_check" CHECK ("inbox"."template"."key" in ('welcome','handover_birthday','handover_events','handover_complaint_online','handover_complaint_onsite','handover_lost_found','handover_marketing','out_of_hours','handover_general','follow_up','closing_birthday','closing_gm','closing_branch'));