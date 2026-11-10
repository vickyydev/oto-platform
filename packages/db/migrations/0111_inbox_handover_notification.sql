-- SCRUM-823 (a Birthdays & Events hand-over tells a person; owner, 10 Nov) -
-- expand-only: one new table, two new nullable columns and two checks that
-- every existing row already satisfies. Nothing existing is rewritten or
-- dropped, and a release that does not know them never reads them.
--
--   inbox.handover_notification             new table
--       one row per notice of an assistant hand-over: the birthday manager on
--       duty through the OTO App and a WhatsApp or Telegram ping, and the one
--       escalation to the GM fifteen minutes later when nobody picked the
--       thread up. Keyed by the turn, the kind, the channel and the park, so
--       a replayed commit or sweep writes nothing twice. No customer text and
--       no full phone number. Empty until the first such hand-over.
--   core.branch.birthday_manager_contact    jsonb, null
--   core.branch.gm_contact                  jsonb, null
--       who the park's notices go to ({ name, appUserId, phone, channel }),
--       named in the Console's branch settings. Null on every branch until
--       then: the hand-over is recorded "nobody to tell" and still escalates.
--       PostgreSQL adds a nullable column without rewriting the table.
CREATE TABLE "inbox"."handover_notification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"branch_id" uuid,
	"destination" text NOT NULL,
	"intent" text,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"target" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handover_notification_kind_check" CHECK ("inbox"."handover_notification"."kind" in ('notice','escalation')),
	CONSTRAINT "handover_notification_channel_check" CHECK ("inbox"."handover_notification"."channel" in ('app','whatsapp','telegram')),
	CONSTRAINT "handover_notification_state_check" CHECK ("inbox"."handover_notification"."state" in ('pending','sent','failed','skipped')),
	CONSTRAINT "handover_notification_destination_check" CHECK ("inbox"."handover_notification"."destination" in ('birthdays','general','marketing','gm')),
	CONSTRAINT "handover_notification_intent_check" CHECK ("inbox"."handover_notification"."intent" is null or "inbox"."handover_notification"."intent" ~ '^[a-z][a-z0-9_]{0,47}$'),
	CONSTRAINT "handover_notification_error_check" CHECK ("inbox"."handover_notification"."error_code" is null or "inbox"."handover_notification"."error_code" ~ '^[A-Z][A-Z0-9_]{0,47}$'),
	CONSTRAINT "handover_notification_target_check" CHECK ("inbox"."handover_notification"."target" is null or char_length("inbox"."handover_notification"."target") <= 80),
	CONSTRAINT "handover_notification_sent_check" CHECK ("inbox"."handover_notification"."state" <> 'sent' or "inbox"."handover_notification"."sent_at" is not null),
	CONSTRAINT "handover_notification_attempts_check" CHECK ("inbox"."handover_notification"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "core"."branch" ADD COLUMN "birthday_manager_contact" jsonb;--> statement-breakpoint
ALTER TABLE "core"."branch" ADD COLUMN "gm_contact" jsonb;--> statement-breakpoint
ALTER TABLE "inbox"."handover_notification" ADD CONSTRAINT "handover_notification_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."handover_notification" ADD CONSTRAINT "handover_notification_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."handover_notification" ADD CONSTRAINT "handover_notification_conversation_fk" FOREIGN KEY ("operator_id","conversation_id") REFERENCES "inbox"."conversation"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."handover_notification" ADD CONSTRAINT "handover_notification_turn_fk" FOREIGN KEY ("operator_id","turn_id") REFERENCES "inbox"."ai_turn"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "handover_notification_once" ON "inbox"."handover_notification" USING btree ("operator_id","turn_id","kind","channel",coalesce("branch_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "handover_notification_conversation_idx" ON "inbox"."handover_notification" USING btree ("operator_id","conversation_id");--> statement-breakpoint
CREATE INDEX "handover_notification_turn_idx" ON "inbox"."handover_notification" USING btree ("operator_id","turn_id");--> statement-breakpoint
CREATE INDEX "handover_notification_branch_idx" ON "inbox"."handover_notification" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "handover_notification_pending_idx" ON "inbox"."handover_notification" USING btree ("created_at") WHERE state = 'pending';--> statement-breakpoint
CREATE INDEX "handover_notification_open_idx" ON "inbox"."handover_notification" USING btree ("created_at") WHERE kind = 'notice' and escalated_at is null and picked_up_at is null;--> statement-breakpoint
ALTER TABLE "core"."branch" ADD CONSTRAINT "branch_birthday_manager_contact_check" CHECK ("core"."branch"."birthday_manager_contact" is null or jsonb_typeof("core"."branch"."birthday_manager_contact") = 'object');--> statement-breakpoint
ALTER TABLE "core"."branch" ADD CONSTRAINT "branch_gm_contact_check" CHECK ("core"."branch"."gm_contact" is null or jsonb_typeof("core"."branch"."gm_contact") = 'object');