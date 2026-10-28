-- SCRUM-677 (the inbox assistant's booking closing) - expand-only: two CHECK
-- swaps that only WIDEN a list, and no row is written here (platform-sync
-- lays the line, insert-if-absent, in English with its Thai and Russian
-- rows marked for translation).
--
--   template.key (and channel_account.out_of_hours_template_key)
--       + closing_booking
--       a PLAN's own closing line, not a destination's: after a nanny answer
--       it says why Central Floresta will write - to confirm the booking -
--       where the branch line only said "we'll be back to you shortly".
--
-- TO REVERSE (the CHECK restores fail while a row uses the widened value -
-- archive or delete the closing_booking templates, and clear any
-- out-of-hours key set to it, first): re-add the two swapped CHECKs with the
-- lists of 0094_inbox_playbook.
ALTER TABLE "inbox"."channel_account" DROP CONSTRAINT "channel_account_out_of_hours_key_check";--> statement-breakpoint
ALTER TABLE "inbox"."template" DROP CONSTRAINT "template_key_check";--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" ADD CONSTRAINT "channel_account_out_of_hours_key_check" CHECK ("inbox"."channel_account"."out_of_hours_template_key" is null or "inbox"."channel_account"."out_of_hours_template_key" in ('welcome','handover_birthday','handover_events','handover_complaint_online','handover_complaint_onsite','handover_lost_found','handover_marketing','out_of_hours','handover_general','follow_up','closing_birthday','closing_gm','closing_branch','closing_unclear','closing_booking'));--> statement-breakpoint
ALTER TABLE "inbox"."template" ADD CONSTRAINT "template_key_check" CHECK ("inbox"."template"."key" in ('welcome','handover_birthday','handover_events','handover_complaint_online','handover_complaint_onsite','handover_lost_found','handover_marketing','out_of_hours','handover_general','follow_up','closing_birthday','closing_gm','closing_branch','closing_unclear','closing_booking'));