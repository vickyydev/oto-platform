-- SCRUM-220 (Unified Inbox, the test night before the park's admins test on
-- staging) — two words widen two lists. Expand-only: three CHECK swaps that
-- only WIDEN a list, no new table or column, and no row is written here.
--
-- Plan: docs/progress/plans/inbox-build/PLAN.md, "Test night" R2 and R5.
--
--   template.key (and channel_account.out_of_hours_template_key)  + follow_up
--       the one template that is not a holding line: outside WhatsApp's
--       24-hour window only a template may be sent, and until now every
--       template asked the customer to hold for somebody. Platform-sync lays
--       its three rows (en, th, ru) at every operator that lacks them, and
--       on the same run gives every TH and RU row that still carries the
--       English source its translation (`packages/db/src/seed/inbox.ts`).
--   event.kind  + ai_paused, ai_resumed
--       a person stood the assistant down on a thread, or let it back; the
--       timeline shows a pill for each, as it does for every other action.
--
-- TO REVERSE (the CHECK restores fail while a row uses a widened value —
-- archive the follow_up templates and delete the ai_paused/ai_resumed events
-- first): re-add event_kind_check, template_key_check and
-- channel_account_out_of_hours_key_check with the lists of 0080_inbox_ai.
ALTER TABLE "inbox"."channel_account" DROP CONSTRAINT "channel_account_out_of_hours_key_check";--> statement-breakpoint
ALTER TABLE "inbox"."event" DROP CONSTRAINT "event_kind_check";--> statement-breakpoint
ALTER TABLE "inbox"."template" DROP CONSTRAINT "template_key_check";--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" ADD CONSTRAINT "channel_account_out_of_hours_key_check" CHECK ("inbox"."channel_account"."out_of_hours_template_key" is null or "inbox"."channel_account"."out_of_hours_template_key" in ('welcome','handover_birthday','handover_events','handover_complaint_online','handover_complaint_onsite','handover_lost_found','handover_marketing','out_of_hours','handover_general','follow_up'));--> statement-breakpoint
ALTER TABLE "inbox"."event" ADD CONSTRAINT "event_kind_check" CHECK ("inbox"."event"."kind" in ('received','ai_replied','classified','routed','assigned','released','diverted','moved_team','branch_set','handled','reopened','date_booked','beo_saved','translated','pos_update','sla_breached','notice_mirrored','send_failed','ai_handover','ai_silent','ai_withdrawn','ai_paused','ai_resumed'));--> statement-breakpoint
ALTER TABLE "inbox"."template" ADD CONSTRAINT "template_key_check" CHECK ("inbox"."template"."key" in ('welcome','handover_birthday','handover_events','handover_complaint_online','handover_complaint_onsite','handover_lost_found','handover_marketing','out_of_hours','handover_general','follow_up'));