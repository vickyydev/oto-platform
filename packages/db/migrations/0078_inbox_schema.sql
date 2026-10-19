-- SCRUM-578 (S2-19 I1) — the Unified Inbox's schema.
--
-- A new schema `inbox` (now in OWNED_SCHEMAS and drizzle's schemaFilter) and
-- its fifteen tables: channel_account, contact, team, routing_rule, template,
-- conversation, message, participant, assignment, tag, conversation_tag,
-- sla_policy, event, note, webhook_receipt. Plan:
-- docs/progress/plans/inbox-build/PLAN.md §1. Expand-only: nothing that
-- exists changes, and no row is written here — the configuration (teams,
-- routing rules, templates, console channel accounts, the inbox roles) is
-- laid by platform-sync, which owns data, as migrations own structure.
--
-- THE TENANT FENCE. Every inbox → inbox reference is a composite foreign key
-- (operator_id, x_id) → x(operator_id, id), landing on a `<table>_tenant_key`
-- unique constraint, so no row can point into another operator's thread.
--
-- Hand-added after generation: IF NOT EXISTS on the schema, and the event
-- table's append-only trigger at the end.
--
-- TO REVERSE (drops every inbox row recorded since — conversations,
-- messages and their history):
--   DROP SCHEMA "inbox" CASCADE;
CREATE SCHEMA IF NOT EXISTS "inbox";
--> statement-breakpoint
CREATE TABLE "inbox"."assignment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"slot_index" smallint NOT NULL,
	"assignee_kind" text NOT NULL,
	"account_id" uuid,
	"team_id" uuid,
	"assigned_by_kind" text NOT NULL,
	"assigned_by_account_id" uuid,
	"reason" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assignment_slot_check" CHECK ("inbox"."assignment"."slot" in ('primary','support')),
	CONSTRAINT "assignment_slot_index_check" CHECK (("inbox"."assignment"."slot" = 'primary' and "inbox"."assignment"."slot_index" = 0) or ("inbox"."assignment"."slot" = 'support' and "inbox"."assignment"."slot_index" in (1,2))),
	CONSTRAINT "assignment_assignee_kind_check" CHECK ("inbox"."assignment"."assignee_kind" in ('account','team','ai')),
	CONSTRAINT "assignment_assigned_by_kind_check" CHECK ("inbox"."assignment"."assigned_by_kind" in ('account','ai','system')),
	CONSTRAINT "assignment_reason_check" CHECK ("inbox"."assignment"."reason" in ('auto','manual','divert','move','reopen')),
	CONSTRAINT "assignment_assignee_check" CHECK (("inbox"."assignment"."assignee_kind" = 'account' and "inbox"."assignment"."account_id" is not null and "inbox"."assignment"."team_id" is null)
          or ("inbox"."assignment"."assignee_kind" = 'team' and "inbox"."assignment"."team_id" is not null and "inbox"."assignment"."account_id" is null)
          or ("inbox"."assignment"."assignee_kind" = 'ai' and "inbox"."assignment"."account_id" is null and "inbox"."assignment"."team_id" is null)),
	CONSTRAINT "assignment_assigned_by_check" CHECK ("inbox"."assignment"."assigned_by_kind" <> 'account' or "inbox"."assignment"."assigned_by_account_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "inbox"."channel_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid,
	"channel" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"credential_ref" text,
	"opening_hours" jsonb,
	"out_of_hours_template_key" text,
	"default_category" text DEFAULT 'general' NOT NULL,
	"can_reply" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "channel_account_tenant_key" UNIQUE("operator_id","id"),
	CONSTRAINT "channel_account_channel_check" CHECK ("inbox"."channel_account"."channel" in ('whatsapp','instagram','facebook','line','telegram','webform')),
	CONSTRAINT "channel_account_provider_check" CHECK ("inbox"."channel_account"."provider" in ('meta_cloud','meta_graph','line','respond_io','webform','simulator','console')),
	CONSTRAINT "channel_account_status_check" CHECK ("inbox"."channel_account"."status" in ('active','paused','error')),
	CONSTRAINT "channel_account_default_category_check" CHECK ("inbox"."channel_account"."default_category" in ('birthdays','general','marketing')),
	CONSTRAINT "channel_account_out_of_hours_key_check" CHECK ("inbox"."channel_account"."out_of_hours_template_key" is null or "inbox"."channel_account"."out_of_hours_template_key" in ('welcome','handover_birthday','handover_events','handover_complaint_online','handover_complaint_onsite','handover_lost_found','handover_marketing','out_of_hours')),
	CONSTRAINT "channel_account_console_reply_check" CHECK ("inbox"."channel_account"."provider" <> 'console' or not "inbox"."channel_account"."can_reply")
);
--> statement-breakpoint
CREATE TABLE "inbox"."contact" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"external_handle" text NOT NULL,
	"display_name" text,
	"avatar_file_id" uuid,
	"phone" text,
	"member_id" uuid,
	"language" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"opted_out_at" timestamp with time zone,
	"erased_at" timestamp with time zone,
	"erased_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_tenant_key" UNIQUE("operator_id","id"),
	CONSTRAINT "contact_channel_check" CHECK ("inbox"."contact"."channel" in ('whatsapp','instagram','facebook','line','telegram','webform')),
	CONSTRAINT "contact_phone_check" CHECK ("inbox"."contact"."phone" is null or "inbox"."contact"."phone" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "contact_erased_check" CHECK ("inbox"."contact"."erased_at" is null or ("inbox"."contact"."phone" is null and "inbox"."contact"."member_id" is null))
);
--> statement-breakpoint
CREATE TABLE "inbox"."conversation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"team_id" uuid,
	"branch_id" uuid,
	"category" text DEFAULT 'general' NOT NULL,
	"intent" text,
	"language" text,
	"status" text DEFAULT 'active' NOT NULL,
	"handled_at" timestamp with time zone,
	"handled_by_kind" text,
	"handled_by_account_id" uuid,
	"reopened_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"last_customer_message_at" timestamp with time zone,
	"last_staff_message_at" timestamp with time zone,
	"last_routed_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"last_message_preview" text,
	"member_id" uuid,
	"booking_ref" text,
	"event_order_ref" text,
	"ai_summary" text,
	"retain_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_tenant_key" UNIQUE("operator_id","id"),
	CONSTRAINT "conversation_category_check" CHECK ("inbox"."conversation"."category" in ('birthdays','general','marketing')),
	CONSTRAINT "conversation_status_check" CHECK ("inbox"."conversation"."status" in ('active','handled')),
	CONSTRAINT "conversation_handled_by_kind_check" CHECK ("inbox"."conversation"."handled_by_kind" is null or "inbox"."conversation"."handled_by_kind" in ('account','ai')),
	CONSTRAINT "conversation_handled_check" CHECK ("inbox"."conversation"."status" <> 'handled' or "inbox"."conversation"."handled_at" is not null),
	CONSTRAINT "conversation_handled_by_check" CHECK ("inbox"."conversation"."handled_by_kind" is distinct from 'account' or "inbox"."conversation"."handled_by_account_id" is not null),
	CONSTRAINT "conversation_preview_length_check" CHECK ("inbox"."conversation"."last_message_preview" is null or char_length("inbox"."conversation"."last_message_preview") <= 140)
);
--> statement-breakpoint
CREATE TABLE "inbox"."conversation_tag" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox"."event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_account_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_kind_check" CHECK ("inbox"."event"."kind" in ('received','ai_replied','classified','routed','assigned','released','diverted','moved_team','branch_set','handled','reopened','date_booked','beo_saved','translated','pos_update','sla_breached','notice_mirrored')),
	CONSTRAINT "event_actor_kind_check" CHECK ("inbox"."event"."actor_kind" in ('customer','account','ai','system')),
	CONSTRAINT "event_actor_account_check" CHECK ("inbox"."event"."actor_kind" <> 'account' or "inbox"."event"."actor_account_id" is not null),
	CONSTRAINT "event_payload_object_check" CHECK (jsonb_typeof("inbox"."event"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "inbox"."note" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"author_account_id" uuid NOT NULL,
	"body" text,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox"."message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_account_id" uuid,
	"body" text,
	"body_language" text,
	"translated_body" text,
	"translated_to" text,
	"media_file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"audio_file_id" uuid,
	"transcript" text,
	"template_id" uuid,
	"external_message_id" text,
	"provider_status" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"source" text DEFAULT 'channel' NOT NULL,
	"source_id" text,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_tenant_key" UNIQUE("operator_id","id"),
	CONSTRAINT "message_direction_check" CHECK ("inbox"."message"."direction" in ('inbound','outbound')),
	CONSTRAINT "message_author_kind_check" CHECK ("inbox"."message"."author_kind" in ('customer','staff','ai','system')),
	CONSTRAINT "message_provider_status_check" CHECK ("inbox"."message"."provider_status" is null or "inbox"."message"."provider_status" in ('queued','sent','delivered','read','failed')),
	CONSTRAINT "message_source_check" CHECK ("inbox"."message"."source" in ('channel','checkin.contact','booking.confirmation')),
	CONSTRAINT "message_direction_author_check" CHECK (("inbox"."message"."direction" = 'inbound') = ("inbox"."message"."author_kind" = 'customer')),
	CONSTRAINT "message_staff_author_check" CHECK ("inbox"."message"."author_kind" <> 'staff' or "inbox"."message"."author_account_id" is not null),
	CONSTRAINT "message_notice_check" CHECK ("inbox"."message"."source" = 'channel' or ("inbox"."message"."author_kind" = 'system' and "inbox"."message"."source_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "inbox"."participant" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_message_id" uuid,
	"last_read_at" timestamp with time zone,
	"muted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox"."routing_rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"category" text NOT NULL,
	"language" text,
	"branch_id" uuid,
	"primary_kind" text NOT NULL,
	"primary_account_id" uuid,
	"backup_account_id" uuid,
	"auto_add_backup" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "routing_rule_category_check" CHECK ("inbox"."routing_rule"."category" in ('birthdays','general','marketing')),
	CONSTRAINT "routing_rule_primary_kind_check" CHECK ("inbox"."routing_rule"."primary_kind" in ('account','team')),
	CONSTRAINT "routing_rule_primary_account_check" CHECK (("inbox"."routing_rule"."primary_kind" = 'account') = ("inbox"."routing_rule"."primary_account_id" is not null)),
	CONSTRAINT "routing_rule_backup_distinct_check" CHECK ("inbox"."routing_rule"."backup_account_id" is null or "inbox"."routing_rule"."primary_account_id" is null or "inbox"."routing_rule"."backup_account_id" <> "inbox"."routing_rule"."primary_account_id")
);
--> statement-breakpoint
CREATE TABLE "inbox"."sla_policy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"first_response_target_s" integer,
	"follow_up_target_s" integer,
	"business_hours" jsonb,
	"alert_channel" text,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sla_policy_targets_check" CHECK (("inbox"."sla_policy"."first_response_target_s" is null or "inbox"."sla_policy"."first_response_target_s" > 0) and ("inbox"."sla_policy"."follow_up_target_s" is null or "inbox"."sla_policy"."follow_up_target_s" > 0))
);
--> statement-breakpoint
CREATE TABLE "inbox"."tag" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"name" text NOT NULL,
	"colour" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_tenant_key" UNIQUE("operator_id","id")
);
--> statement-breakpoint
CREATE TABLE "inbox"."team" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"key" text NOT NULL,
	"branch_id" uuid,
	"department_id" uuid,
	"name" text NOT NULL,
	"colour" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_tenant_key" UNIQUE("operator_id","id"),
	CONSTRAINT "team_key_check" CHECK ("inbox"."team"."key" in ('birthdays','reception','marketing')),
	CONSTRAINT "team_branch_check" CHECK (("inbox"."team"."key" = 'reception') = ("inbox"."team"."branch_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "inbox"."template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"key" text NOT NULL,
	"language" text NOT NULL,
	"channel" text,
	"branch_id" uuid,
	"body" text NOT NULL,
	"attachment_file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"provider_template_name" text,
	"approval_status" text DEFAULT 'not_required' NOT NULL,
	"needs_translation" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "template_tenant_key" UNIQUE("operator_id","id"),
	CONSTRAINT "template_key_check" CHECK ("inbox"."template"."key" in ('welcome','handover_birthday','handover_events','handover_complaint_online','handover_complaint_onsite','handover_lost_found','handover_marketing','out_of_hours')),
	CONSTRAINT "template_channel_check" CHECK ("inbox"."template"."channel" is null or "inbox"."template"."channel" in ('whatsapp','instagram','facebook','line','telegram','webform')),
	CONSTRAINT "template_approval_status_check" CHECK ("inbox"."template"."approval_status" in ('not_required','pending','approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE "inbox"."webhook_receipt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signature_ok" boolean NOT NULL,
	"payload" jsonb,
	"processed_at" timestamp with time zone,
	"error" text,
	"payload_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_receipt_purged_check" CHECK ("inbox"."webhook_receipt"."payload_purged_at" is null or "inbox"."webhook_receipt"."payload" is null)
);
--> statement-breakpoint
ALTER TABLE "inbox"."assignment" ADD CONSTRAINT "assignment_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."assignment" ADD CONSTRAINT "assignment_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."assignment" ADD CONSTRAINT "assignment_assigned_by_account_id_account_id_fk" FOREIGN KEY ("assigned_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."assignment" ADD CONSTRAINT "assignment_conversation_fk" FOREIGN KEY ("operator_id","conversation_id") REFERENCES "inbox"."conversation"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."assignment" ADD CONSTRAINT "assignment_team_fk" FOREIGN KEY ("operator_id","team_id") REFERENCES "inbox"."team"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" ADD CONSTRAINT "channel_account_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" ADD CONSTRAINT "channel_account_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."contact" ADD CONSTRAINT "contact_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."contact" ADD CONSTRAINT "contact_avatar_file_id_file_object_id_fk" FOREIGN KEY ("avatar_file_id") REFERENCES "core"."file_object"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."contact" ADD CONSTRAINT "contact_erased_by_account_id_account_id_fk" FOREIGN KEY ("erased_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD CONSTRAINT "conversation_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD CONSTRAINT "conversation_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD CONSTRAINT "conversation_handled_by_account_id_account_id_fk" FOREIGN KEY ("handled_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD CONSTRAINT "conversation_contact_fk" FOREIGN KEY ("operator_id","contact_id") REFERENCES "inbox"."contact"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD CONSTRAINT "conversation_channel_account_fk" FOREIGN KEY ("operator_id","channel_account_id") REFERENCES "inbox"."channel_account"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD CONSTRAINT "conversation_team_fk" FOREIGN KEY ("operator_id","team_id") REFERENCES "inbox"."team"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation_tag" ADD CONSTRAINT "conversation_tag_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation_tag" ADD CONSTRAINT "conversation_tag_conversation_fk" FOREIGN KEY ("operator_id","conversation_id") REFERENCES "inbox"."conversation"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."conversation_tag" ADD CONSTRAINT "conversation_tag_tag_fk" FOREIGN KEY ("operator_id","tag_id") REFERENCES "inbox"."tag"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."event" ADD CONSTRAINT "event_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."event" ADD CONSTRAINT "event_actor_account_id_account_id_fk" FOREIGN KEY ("actor_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."event" ADD CONSTRAINT "event_conversation_fk" FOREIGN KEY ("operator_id","conversation_id") REFERENCES "inbox"."conversation"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."note" ADD CONSTRAINT "note_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."note" ADD CONSTRAINT "note_author_account_id_account_id_fk" FOREIGN KEY ("author_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."note" ADD CONSTRAINT "note_conversation_fk" FOREIGN KEY ("operator_id","conversation_id") REFERENCES "inbox"."conversation"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD CONSTRAINT "message_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD CONSTRAINT "message_author_account_id_account_id_fk" FOREIGN KEY ("author_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD CONSTRAINT "message_audio_file_id_file_object_id_fk" FOREIGN KEY ("audio_file_id") REFERENCES "core"."file_object"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD CONSTRAINT "message_conversation_fk" FOREIGN KEY ("operator_id","conversation_id") REFERENCES "inbox"."conversation"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD CONSTRAINT "message_channel_account_fk" FOREIGN KEY ("operator_id","channel_account_id") REFERENCES "inbox"."channel_account"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD CONSTRAINT "message_template_fk" FOREIGN KEY ("operator_id","template_id") REFERENCES "inbox"."template"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."participant" ADD CONSTRAINT "participant_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."participant" ADD CONSTRAINT "participant_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."participant" ADD CONSTRAINT "participant_conversation_fk" FOREIGN KEY ("operator_id","conversation_id") REFERENCES "inbox"."conversation"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."participant" ADD CONSTRAINT "participant_last_read_message_fk" FOREIGN KEY ("operator_id","last_read_message_id") REFERENCES "inbox"."message"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."routing_rule" ADD CONSTRAINT "routing_rule_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."routing_rule" ADD CONSTRAINT "routing_rule_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."routing_rule" ADD CONSTRAINT "routing_rule_primary_account_id_account_id_fk" FOREIGN KEY ("primary_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."routing_rule" ADD CONSTRAINT "routing_rule_backup_account_id_account_id_fk" FOREIGN KEY ("backup_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."routing_rule" ADD CONSTRAINT "routing_rule_team_fk" FOREIGN KEY ("operator_id","team_id") REFERENCES "inbox"."team"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."sla_policy" ADD CONSTRAINT "sla_policy_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."sla_policy" ADD CONSTRAINT "sla_policy_team_fk" FOREIGN KEY ("operator_id","team_id") REFERENCES "inbox"."team"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."tag" ADD CONSTRAINT "tag_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."team" ADD CONSTRAINT "team_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."team" ADD CONSTRAINT "team_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."template" ADD CONSTRAINT "template_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."template" ADD CONSTRAINT "template_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."template" ADD CONSTRAINT "template_updated_by_account_id_account_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."webhook_receipt" ADD CONSTRAINT "webhook_receipt_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."webhook_receipt" ADD CONSTRAINT "webhook_receipt_channel_account_fk" FOREIGN KEY ("operator_id","channel_account_id") REFERENCES "inbox"."channel_account"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_active_slot_unique" ON "inbox"."assignment" USING btree ("conversation_id","slot_index") WHERE released_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_active_account_unique" ON "inbox"."assignment" USING btree ("conversation_id","account_id") WHERE released_at is null and account_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_active_team_unique" ON "inbox"."assignment" USING btree ("conversation_id","team_id") WHERE released_at is null and team_id is not null;--> statement-breakpoint
CREATE INDEX "assignment_conversation_fk_idx" ON "inbox"."assignment" USING btree ("operator_id","conversation_id");--> statement-breakpoint
CREATE INDEX "assignment_team_idx" ON "inbox"."assignment" USING btree ("operator_id","team_id");--> statement-breakpoint
CREATE INDEX "assignment_account_idx" ON "inbox"."assignment" USING btree ("account_id","released_at");--> statement-breakpoint
CREATE INDEX "assignment_assigned_by_idx" ON "inbox"."assignment" USING btree ("assigned_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_account_external_unique" ON "inbox"."channel_account" USING btree ("operator_id","provider","external_id") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "channel_account_operator_idx" ON "inbox"."channel_account" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "channel_account_branch_idx" ON "inbox"."channel_account" USING btree ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_handle_unique" ON "inbox"."contact" USING btree ("operator_id","channel","external_handle");--> statement-breakpoint
CREATE INDEX "contact_phone_idx" ON "inbox"."contact" USING btree ("operator_id","phone");--> statement-breakpoint
CREATE INDEX "contact_member_idx" ON "inbox"."contact" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "contact_avatar_file_idx" ON "inbox"."contact" USING btree ("avatar_file_id");--> statement-breakpoint
CREATE INDEX "contact_erased_by_idx" ON "inbox"."contact" USING btree ("erased_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_thread_unique" ON "inbox"."conversation" USING btree ("operator_id","contact_id","channel_account_id");--> statement-breakpoint
CREATE INDEX "conversation_queue_idx" ON "inbox"."conversation" USING btree ("operator_id","status","team_id");--> statement-breakpoint
CREATE INDEX "conversation_recent_idx" ON "inbox"."conversation" USING btree ("operator_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "conversation_contact_idx" ON "inbox"."conversation" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "conversation_channel_account_idx" ON "inbox"."conversation" USING btree ("operator_id","channel_account_id");--> statement-breakpoint
CREATE INDEX "conversation_team_idx" ON "inbox"."conversation" USING btree ("operator_id","team_id");--> statement-breakpoint
CREATE INDEX "conversation_branch_idx" ON "inbox"."conversation" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "conversation_handled_at_idx" ON "inbox"."conversation" USING btree ("operator_id","handled_at");--> statement-breakpoint
CREATE INDEX "conversation_handled_by_idx" ON "inbox"."conversation" USING btree ("handled_by_account_id");--> statement-breakpoint
CREATE INDEX "conversation_member_idx" ON "inbox"."conversation" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "conversation_retain_until_idx" ON "inbox"."conversation" USING btree ("retain_until");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_tag_unique" ON "inbox"."conversation_tag" USING btree ("conversation_id","tag_id");--> statement-breakpoint
CREATE INDEX "conversation_tag_conversation_fk_idx" ON "inbox"."conversation_tag" USING btree ("operator_id","conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_tag_tag_idx" ON "inbox"."conversation_tag" USING btree ("operator_id","tag_id");--> statement-breakpoint
CREATE INDEX "event_timeline_idx" ON "inbox"."event" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "event_conversation_fk_idx" ON "inbox"."event" USING btree ("operator_id","conversation_id");--> statement-breakpoint
CREATE INDEX "event_actor_account_idx" ON "inbox"."event" USING btree ("actor_account_id");--> statement-breakpoint
CREATE INDEX "note_conversation_fk_idx" ON "inbox"."note" USING btree ("operator_id","conversation_id");--> statement-breakpoint
CREATE INDEX "note_author_account_idx" ON "inbox"."note" USING btree ("author_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_external_unique" ON "inbox"."message" USING btree ("channel_account_id","external_message_id") WHERE external_message_id is not null;--> statement-breakpoint
CREATE INDEX "message_thread_idx" ON "inbox"."message" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "message_conversation_fk_idx" ON "inbox"."message" USING btree ("operator_id","conversation_id");--> statement-breakpoint
CREATE INDEX "message_channel_account_idx" ON "inbox"."message" USING btree ("operator_id","channel_account_id");--> statement-breakpoint
CREATE INDEX "message_template_idx" ON "inbox"."message" USING btree ("operator_id","template_id");--> statement-breakpoint
CREATE INDEX "message_author_account_idx" ON "inbox"."message" USING btree ("author_account_id");--> statement-breakpoint
CREATE INDEX "message_audio_file_idx" ON "inbox"."message" USING btree ("audio_file_id");--> statement-breakpoint
CREATE INDEX "message_source_idx" ON "inbox"."message" USING btree ("operator_id","source","source_id") WHERE source <> 'channel';--> statement-breakpoint
CREATE UNIQUE INDEX "participant_unique" ON "inbox"."participant" USING btree ("conversation_id","account_id");--> statement-breakpoint
CREATE INDEX "participant_conversation_fk_idx" ON "inbox"."participant" USING btree ("operator_id","conversation_id");--> statement-breakpoint
CREATE INDEX "participant_account_idx" ON "inbox"."participant" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "participant_last_read_message_idx" ON "inbox"."participant" USING btree ("operator_id","last_read_message_id");--> statement-breakpoint
CREATE INDEX "routing_rule_team_idx" ON "inbox"."routing_rule" USING btree ("operator_id","team_id");--> statement-breakpoint
CREATE INDEX "routing_rule_lookup_idx" ON "inbox"."routing_rule" USING btree ("operator_id","category","active");--> statement-breakpoint
CREATE INDEX "routing_rule_branch_idx" ON "inbox"."routing_rule" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "routing_rule_primary_account_idx" ON "inbox"."routing_rule" USING btree ("primary_account_id");--> statement-breakpoint
CREATE INDEX "routing_rule_backup_account_idx" ON "inbox"."routing_rule" USING btree ("backup_account_id");--> statement-breakpoint
CREATE INDEX "sla_policy_team_idx" ON "inbox"."sla_policy" USING btree ("operator_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_name_unique" ON "inbox"."tag" USING btree ("operator_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "team_key_unique" ON "inbox"."team" USING btree ("operator_id","key",coalesce("branch_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "team_branch_idx" ON "inbox"."team" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "team_department_idx" ON "inbox"."team" USING btree ("department_id");--> statement-breakpoint
CREATE UNIQUE INDEX "template_key_unique" ON "inbox"."template" USING btree ("operator_id","key","language",coalesce("channel", ''),coalesce("branch_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "template_branch_idx" ON "inbox"."template" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "template_updated_by_idx" ON "inbox"."template" USING btree ("updated_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_receipt_event_unique" ON "inbox"."webhook_receipt" USING btree ("channel_account_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_receipt_channel_account_fk_idx" ON "inbox"."webhook_receipt" USING btree ("operator_id","channel_account_id");--> statement-breakpoint
CREATE INDEX "webhook_receipt_received_idx" ON "inbox"."webhook_receipt" USING btree ("received_at");
--> statement-breakpoint
-- The timeline is evidence: an event row is never edited or removed, from any
-- caller, the api included — with two doors, each opened for one transaction
-- by `set_config(..., true)`:
--   oto.inbox_erasure = on  the PDPA erasure may rewrite `payload` (to null
--                           a body-bearing key) and nothing else on the row;
--   oto.inbox_purge   = on  the retention purge may delete rows whose
--                           conversation's `retain_until` has passed.
CREATE OR REPLACE FUNCTION "inbox"."event_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('oto.inbox_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
  ELSIF current_setting('oto.inbox_erasure', true) = 'on'
    AND NEW.id = OLD.id
    AND NEW.operator_id = OLD.operator_id
    AND NEW.conversation_id = OLD.conversation_id
    AND NEW.kind = OLD.kind
    AND NEW.actor_kind = OLD.actor_kind
    AND NEW.actor_account_id IS NOT DISTINCT FROM OLD.actor_account_id
    AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'inbox.event is append-only: % refused (inbox.event_append_only)', TG_OP
    USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER "event_append_only" BEFORE UPDATE OR DELETE ON "inbox"."event"
FOR EACH ROW EXECUTE FUNCTION "inbox"."event_append_only"();
