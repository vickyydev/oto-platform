-- SCRUM-831 (never ask twice; the owner, 10 November: "the memory is the
-- primary mechanism; the guard is the last net and its firing is counted") -
-- expand-only: one new table. Nothing existing is rewritten or dropped, and a
-- release that does not know it never reads it.
--
--   inbox.conversation_open_question       new table
--       one row per slot a sent assistant reply asked the customer (the
--       child's age, the date, the park...), on the line that asked it; the
--       customer's next message is read as its answer and the row closes,
--       answered (with the short value read: a number, a date, a time, a
--       park - never a name or a sentence, 40 characters at most) or
--       withdrawn (a person took the thread, the line never left, the slot
--       was asked again). At most one open row per slot per thread. Empty
--       until the assistant asks something on a live number.
CREATE TABLE "inbox"."conversation_open_question" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"turn_id" uuid NOT NULL,
	"asked_message_id" uuid NOT NULL,
	"asked_at" timestamp with time zone NOT NULL,
	"answer" text,
	"answered_message_id" uuid,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_open_question_tenant_key" UNIQUE("operator_id","id"),
	CONSTRAINT "conversation_open_question_slot_check" CHECK ("inbox"."conversation_open_question"."slot" in ('date','time','park','kids_count','adults_count','guests_count','child_age','child_name','package','residency','other')),
	CONSTRAINT "conversation_open_question_state_check" CHECK ("inbox"."conversation_open_question"."state" in ('open','answered','withdrawn')),
	CONSTRAINT "conversation_open_question_answer_check" CHECK ("inbox"."conversation_open_question"."answer" is null or char_length("inbox"."conversation_open_question"."answer") between 1 and 40),
	CONSTRAINT "conversation_open_question_closed_check" CHECK (("inbox"."conversation_open_question"."state" = 'open' and "inbox"."conversation_open_question"."closed_at" is null and "inbox"."conversation_open_question"."answer" is null and "inbox"."conversation_open_question"."answered_message_id" is null)
          or ("inbox"."conversation_open_question"."state" = 'answered' and "inbox"."conversation_open_question"."closed_at" is not null and "inbox"."conversation_open_question"."answered_message_id" is not null)
          or ("inbox"."conversation_open_question"."state" = 'withdrawn' and "inbox"."conversation_open_question"."closed_at" is not null and "inbox"."conversation_open_question"."answer" is null and "inbox"."conversation_open_question"."answered_message_id" is null))
);
--> statement-breakpoint
ALTER TABLE "inbox"."conversation_open_question" ADD CONSTRAINT "conversation_open_question_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation_open_question" ADD CONSTRAINT "conversation_open_question_conversation_fk" FOREIGN KEY ("operator_id","conversation_id") REFERENCES "inbox"."conversation"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation_open_question" ADD CONSTRAINT "conversation_open_question_turn_fk" FOREIGN KEY ("operator_id","turn_id") REFERENCES "inbox"."ai_turn"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation_open_question" ADD CONSTRAINT "conversation_open_question_asked_message_fk" FOREIGN KEY ("operator_id","asked_message_id") REFERENCES "inbox"."message"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation_open_question" ADD CONSTRAINT "conversation_open_question_answered_message_fk" FOREIGN KEY ("operator_id","answered_message_id") REFERENCES "inbox"."message"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_open_question_open_unique" ON "inbox"."conversation_open_question" USING btree ("conversation_id","slot") WHERE state = 'open';--> statement-breakpoint
CREATE INDEX "conversation_open_question_conversation_idx" ON "inbox"."conversation_open_question" USING btree ("operator_id","conversation_id","asked_at");--> statement-breakpoint
CREATE INDEX "conversation_open_question_turn_idx" ON "inbox"."conversation_open_question" USING btree ("operator_id","turn_id");--> statement-breakpoint
CREATE INDEX "conversation_open_question_asked_message_idx" ON "inbox"."conversation_open_question" USING btree ("operator_id","asked_message_id");--> statement-breakpoint
CREATE INDEX "conversation_open_question_answered_message_idx" ON "inbox"."conversation_open_question" USING btree ("operator_id","answered_message_id");