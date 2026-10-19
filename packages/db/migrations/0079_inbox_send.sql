ALTER TABLE "inbox"."event" DROP CONSTRAINT "event_kind_check";--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD COLUMN "send_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "message_send_queue_idx" ON "inbox"."message" USING btree ("next_attempt_at") WHERE provider_status = 'queued';--> statement-breakpoint
ALTER TABLE "inbox"."event" ADD CONSTRAINT "event_kind_check" CHECK ("inbox"."event"."kind" in ('received','ai_replied','classified','routed','assigned','released','diverted','moved_team','branch_set','handled','reopened','date_booked','beo_saved','translated','pos_update','sla_breached','notice_mirrored','send_failed'));