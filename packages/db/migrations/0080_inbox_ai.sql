-- SCRUM-590 (Inbox AI, Phase 2, round A1) — the customer assistant's schema.
--
-- Plan: docs/progress/plans/inbox-ai-build/PLAN.md, "What Phase 2 changes in
-- the rails" R1, and §A, §C.1, §D, §E. Expand-only: three new tables, three
-- new nullable or defaulted columns, and four CHECK swaps that only WIDEN a
-- list. No row is written here; platform-sync lays the `handover_general`
-- template rows, and nothing sets a channel account's `ai_mode` — every
-- existing account takes the column default `off`.
--
--   inbox.ai_turn     one turn of the assistant on a thread: ids, enums,
--                     counts and single words only (a CHECK holds each word
--                     to one word), never a prompt, a response or a line;
--                     one `pending` turn per thread (`ai_turn_pending_unique`,
--                     the debounce); a lease (`lease_until`, `attempts`) as
--                     the send path's
--   inbox.kb_entry    the knowledge base marketing approves, per language
--   inbox.ai_example  the curated examples; approved only de-identified and
--                     with both source links nulled (`ai_example_approved_check`)
--   channel_account.ai_mode                        off | shadow | live, default off
--   conversation.ai_paused_at, ai_paused_by_account_id   the per-thread pause
--   event.kind        + ai_handover, ai_silent, ai_withdrawn
--   message.provider_status  + withdrawn
--   template.key (and channel_account.out_of_hours_template_key)  + handover_general
--
-- The tenant fence holds: ai_turn reaches its thread and its trigger message
-- by composite keys (operator_id, x_id). The example and KB source links are
-- soft by design (plan §C.1, §E).
--
-- TO REVERSE (drops every turn, knowledge-base entry and example recorded
-- since; the CHECK restores fail while a row uses a widened value — move or
-- delete those rows first):
--   DROP TABLE "inbox"."ai_turn", "inbox"."kb_entry", "inbox"."ai_example";
--   ALTER TABLE "inbox"."channel_account" DROP COLUMN "ai_mode";
--   ALTER TABLE "inbox"."conversation" DROP COLUMN "ai_paused_at", DROP COLUMN "ai_paused_by_account_id";
--   then re-add event_kind_check, message_provider_status_check,
--   template_key_check and channel_account_out_of_hours_key_check with the
--   lists of 0079_inbox_send / 0078_inbox_schema.
CREATE TABLE "inbox"."ai_example" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"intent" text NOT NULL,
	"language" text NOT NULL,
	"customer_text" text NOT NULL,
	"good_reply" text,
	"verdict" text NOT NULL,
	"source_message_id" uuid,
	"source_conversation_id" uuid,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_by_account_id" uuid NOT NULL,
	"approved_by_account_id" uuid,
	"approved_at" timestamp with time zone,
	"deidentified_confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_example_tenant_key" UNIQUE("operator_id","id"),
	CONSTRAINT "ai_example_intent_check" CHECK ("inbox"."ai_example"."intent" ~ '^[a-z][a-z0-9_]{0,47}$'),
	CONSTRAINT "ai_example_language_check" CHECK ("inbox"."ai_example"."language" in ('th','en','ru')),
	CONSTRAINT "ai_example_verdict_check" CHECK ("inbox"."ai_example"."verdict" in ('should_answer','should_handover','should_stay_silent')),
	CONSTRAINT "ai_example_status_check" CHECK ("inbox"."ai_example"."status" in ('proposed','approved','rejected')),
	CONSTRAINT "ai_example_length_check" CHECK (char_length("inbox"."ai_example"."customer_text") between 1 and 500
          and ("inbox"."ai_example"."good_reply" is null or char_length("inbox"."ai_example"."good_reply") between 1 and 800)),
	CONSTRAINT "ai_example_reply_check" CHECK ("inbox"."ai_example"."verdict" <> 'should_answer' or "inbox"."ai_example"."good_reply" is not null),
	CONSTRAINT "ai_example_approved_check" CHECK ("inbox"."ai_example"."status" <> 'approved' or (
            "inbox"."ai_example"."deidentified_confirmed"
            and "inbox"."ai_example"."approved_by_account_id" is not null
            and "inbox"."ai_example"."approved_at" is not null
            and "inbox"."ai_example"."source_message_id" is null
            and "inbox"."ai_example"."source_conversation_id" is null))
);
--> statement-breakpoint
CREATE TABLE "inbox"."ai_turn" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_message_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"intent" text,
	"action" text,
	"certainty" text,
	"language" text,
	"reason" text,
	"model" text,
	"persona_version" text,
	"kb_version" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"latency_ms" integer,
	"message_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_turn_tenant_key" UNIQUE("operator_id","id"),
	CONSTRAINT "ai_turn_state_check" CHECK ("inbox"."ai_turn"."state" in ('pending','deciding','answered','handed_over','silent','cancelled','superseded','shadowed')),
	CONSTRAINT "ai_turn_action_check" CHECK ("inbox"."ai_turn"."action" is null or "inbox"."ai_turn"."action" in ('answer','handover','silent')),
	CONSTRAINT "ai_turn_certainty_check" CHECK ("inbox"."ai_turn"."certainty" is null or "inbox"."ai_turn"."certainty" in ('sure','unsure')),
	CONSTRAINT "ai_turn_language_check" CHECK ("inbox"."ai_turn"."language" is null or "inbox"."ai_turn"."language" in ('th','en','ru','other')),
	CONSTRAINT "ai_turn_reason_check" CHECK ("inbox"."ai_turn"."reason" is null or "inbox"."ai_turn"."reason" ~ '^[A-Z][A-Z0-9_]{0,47}$'),
	CONSTRAINT "ai_turn_intent_check" CHECK ("inbox"."ai_turn"."intent" is null or "inbox"."ai_turn"."intent" ~ '^[a-z][a-z0-9_]{0,47}$'),
	CONSTRAINT "ai_turn_version_words_check" CHECK (("inbox"."ai_turn"."model" is null or "inbox"."ai_turn"."model" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$')
          and ("inbox"."ai_turn"."persona_version" is null or "inbox"."ai_turn"."persona_version" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$')
          and ("inbox"."ai_turn"."kb_version" is null or "inbox"."ai_turn"."kb_version" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$')),
	CONSTRAINT "ai_turn_counts_check" CHECK ("inbox"."ai_turn"."attempts" >= 0
          and ("inbox"."ai_turn"."input_tokens" is null or "inbox"."ai_turn"."input_tokens" >= 0)
          and ("inbox"."ai_turn"."output_tokens" is null or "inbox"."ai_turn"."output_tokens" >= 0)
          and ("inbox"."ai_turn"."cache_read_tokens" is null or "inbox"."ai_turn"."cache_read_tokens" >= 0)
          and ("inbox"."ai_turn"."latency_ms" is null or "inbox"."ai_turn"."latency_ms" >= 0)),
	CONSTRAINT "ai_turn_lease_check" CHECK ("inbox"."ai_turn"."state" <> 'deciding' or "inbox"."ai_turn"."lease_until" is not null)
);
--> statement-breakpoint
CREATE TABLE "inbox"."kb_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid,
	"topic" text NOT NULL,
	"key" text NOT NULL,
	"language" text NOT NULL,
	"question" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"source_example_id" uuid,
	"updated_by_account_id" uuid,
	"approved_by_account_id" uuid,
	"approved_at" timestamp with time zone,
	"needs_translation" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_entry_tenant_key" UNIQUE("operator_id","id"),
	CONSTRAINT "kb_entry_topic_check" CHECK ("inbox"."kb_entry"."topic" in ('about_oto','hours_note','address_note','directions','parking','age_rules','socks','prices_note','faq')),
	CONSTRAINT "kb_entry_language_check" CHECK ("inbox"."kb_entry"."language" in ('th','en','ru')),
	CONSTRAINT "kb_entry_status_check" CHECK ("inbox"."kb_entry"."status" in ('draft','approved','archived')),
	CONSTRAINT "kb_entry_key_check" CHECK (char_length("inbox"."kb_entry"."key") <= 80 and "inbox"."kb_entry"."key" ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'),
	CONSTRAINT "kb_entry_length_check" CHECK (char_length("inbox"."kb_entry"."question") between 1 and 200 and char_length("inbox"."kb_entry"."body") between 1 and 1200),
	CONSTRAINT "kb_entry_approved_check" CHECK ("inbox"."kb_entry"."status" <> 'approved' or ("inbox"."kb_entry"."approved_by_account_id" is not null and "inbox"."kb_entry"."approved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" DROP CONSTRAINT "channel_account_out_of_hours_key_check";--> statement-breakpoint
ALTER TABLE "inbox"."event" DROP CONSTRAINT "event_kind_check";--> statement-breakpoint
ALTER TABLE "inbox"."message" DROP CONSTRAINT "message_provider_status_check";--> statement-breakpoint
ALTER TABLE "inbox"."template" DROP CONSTRAINT "template_key_check";--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" ADD COLUMN "ai_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD COLUMN "ai_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD COLUMN "ai_paused_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "inbox"."ai_example" ADD CONSTRAINT "ai_example_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."ai_example" ADD CONSTRAINT "ai_example_proposed_by_account_id_account_id_fk" FOREIGN KEY ("proposed_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."ai_example" ADD CONSTRAINT "ai_example_approved_by_account_id_account_id_fk" FOREIGN KEY ("approved_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."ai_turn" ADD CONSTRAINT "ai_turn_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."ai_turn" ADD CONSTRAINT "ai_turn_conversation_fk" FOREIGN KEY ("operator_id","conversation_id") REFERENCES "inbox"."conversation"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."ai_turn" ADD CONSTRAINT "ai_turn_trigger_message_fk" FOREIGN KEY ("operator_id","trigger_message_id") REFERENCES "inbox"."message"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."kb_entry" ADD CONSTRAINT "kb_entry_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."kb_entry" ADD CONSTRAINT "kb_entry_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."kb_entry" ADD CONSTRAINT "kb_entry_updated_by_account_id_account_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."kb_entry" ADD CONSTRAINT "kb_entry_approved_by_account_id_account_id_fk" FOREIGN KEY ("approved_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_example_lookup_idx" ON "inbox"."ai_example" USING btree ("operator_id","status","intent","language");--> statement-breakpoint
CREATE INDEX "ai_example_source_conversation_idx" ON "inbox"."ai_example" USING btree ("source_conversation_id");--> statement-breakpoint
CREATE INDEX "ai_example_source_message_idx" ON "inbox"."ai_example" USING btree ("source_message_id");--> statement-breakpoint
CREATE INDEX "ai_example_proposed_by_idx" ON "inbox"."ai_example" USING btree ("proposed_by_account_id");--> statement-breakpoint
CREATE INDEX "ai_example_approved_by_idx" ON "inbox"."ai_example" USING btree ("approved_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_turn_pending_unique" ON "inbox"."ai_turn" USING btree ("conversation_id") WHERE state = 'pending';--> statement-breakpoint
CREATE INDEX "ai_turn_due_idx" ON "inbox"."ai_turn" USING btree ("state","due_at");--> statement-breakpoint
CREATE INDEX "ai_turn_operator_created_idx" ON "inbox"."ai_turn" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_turn_conversation_fk_idx" ON "inbox"."ai_turn" USING btree ("operator_id","conversation_id");--> statement-breakpoint
CREATE INDEX "ai_turn_trigger_message_idx" ON "inbox"."ai_turn" USING btree ("operator_id","trigger_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_entry_key_unique" ON "inbox"."kb_entry" USING btree ("operator_id","key","language",coalesce("branch_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status <> 'archived';--> statement-breakpoint
CREATE INDEX "kb_entry_lookup_idx" ON "inbox"."kb_entry" USING btree ("operator_id","status","topic");--> statement-breakpoint
CREATE INDEX "kb_entry_branch_idx" ON "inbox"."kb_entry" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "kb_entry_source_example_idx" ON "inbox"."kb_entry" USING btree ("source_example_id");--> statement-breakpoint
CREATE INDEX "kb_entry_updated_by_idx" ON "inbox"."kb_entry" USING btree ("updated_by_account_id");--> statement-breakpoint
CREATE INDEX "kb_entry_approved_by_idx" ON "inbox"."kb_entry" USING btree ("approved_by_account_id");--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD CONSTRAINT "conversation_ai_paused_by_account_id_account_id_fk" FOREIGN KEY ("ai_paused_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_ai_paused_by_idx" ON "inbox"."conversation" USING btree ("ai_paused_by_account_id");--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" ADD CONSTRAINT "channel_account_ai_mode_check" CHECK ("inbox"."channel_account"."ai_mode" in ('off','shadow','live'));--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" ADD CONSTRAINT "channel_account_out_of_hours_key_check" CHECK ("inbox"."channel_account"."out_of_hours_template_key" is null or "inbox"."channel_account"."out_of_hours_template_key" in ('welcome','handover_birthday','handover_events','handover_complaint_online','handover_complaint_onsite','handover_lost_found','handover_marketing','out_of_hours','handover_general'));--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD CONSTRAINT "conversation_ai_paused_check" CHECK ("inbox"."conversation"."ai_paused_by_account_id" is null or "inbox"."conversation"."ai_paused_at" is not null);--> statement-breakpoint
ALTER TABLE "inbox"."event" ADD CONSTRAINT "event_kind_check" CHECK ("inbox"."event"."kind" in ('received','ai_replied','classified','routed','assigned','released','diverted','moved_team','branch_set','handled','reopened','date_booked','beo_saved','translated','pos_update','sla_breached','notice_mirrored','send_failed','ai_handover','ai_silent','ai_withdrawn'));--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD CONSTRAINT "message_provider_status_check" CHECK ("inbox"."message"."provider_status" is null or "inbox"."message"."provider_status" in ('queued','sent','delivered','read','failed','withdrawn'));--> statement-breakpoint
ALTER TABLE "inbox"."template" ADD CONSTRAINT "template_key_check" CHECK ("inbox"."template"."key" in ('welcome','handover_birthday','handover_events','handover_complaint_online','handover_complaint_onsite','handover_lost_found','handover_marketing','out_of_hours','handover_general'));