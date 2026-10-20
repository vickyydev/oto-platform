-- SCRUM-590 (the customer assistant, the test night before the park's admins
-- test on staging, 2026-10-21, W5 "shadow mode shows staff nothing") — two
-- words widen two lists. Expand-only: two CHECK swaps that only WIDEN a list,
-- no new table or column, and no row is written here.
--
-- Plan: docs/progress/plans/inbox-ai-build/PLAN.md, "Test night 2026-10-21", W5.
--
--   message.provider_status  + shadow
--       what the assistant WOULD have said on a number in shadow mode: one
--       author_kind 'ai' row for staff to read, never sent (the send claim
--       takes 'queued' rows only, and the row has no next_attempt_at). It is
--       message text, so the erasure and the retention sweep redact it like
--       any line.
--   event.kind  + ai_shadow
--       the pill that names that row (messageId) and the turn (turnId); ids
--       and words only, never the text.
--
-- TO REVERSE (the CHECK restores fail while a row uses a widened value —
-- redact the shadow rows' bodies and delete the ai_shadow events first):
-- re-add message_provider_status_check with the list of 0080_inbox_ai and
-- event_kind_check with the list of 0083_inbox_test_night.
ALTER TABLE "inbox"."event" DROP CONSTRAINT "event_kind_check";--> statement-breakpoint
ALTER TABLE "inbox"."message" DROP CONSTRAINT "message_provider_status_check";--> statement-breakpoint
ALTER TABLE "inbox"."event" ADD CONSTRAINT "event_kind_check" CHECK ("inbox"."event"."kind" in ('received','ai_replied','classified','routed','assigned','released','diverted','moved_team','branch_set','handled','reopened','date_booked','beo_saved','translated','pos_update','sla_breached','notice_mirrored','send_failed','ai_handover','ai_silent','ai_withdrawn','ai_paused','ai_resumed','ai_shadow'));--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD CONSTRAINT "message_provider_status_check" CHECK ("inbox"."message"."provider_status" is null or "inbox"."message"."provider_status" in ('queued','sent','delivered','read','failed','withdrawn','shadow'));
