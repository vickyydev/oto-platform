-- SCRUM-696 (the inbox assistant's behaviour rules) - expand-only: one
-- CREATE TABLE with its foreign keys, indexes and CHECKs, and no row is
-- written here.
--
--   inbox.ai_rule
--       an operator's plain instruction for one assistant intent (or 'any'),
--       with an optional ask-first question; draft / approved / archived as
--       kb_entry, approved always naming by whom and when. Only approved
--       rows reach the customer assistant's prompt.
--
-- TO REVERSE: DROP TABLE inbox.ai_rule
CREATE TABLE "inbox"."ai_rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid,
	"intent" text NOT NULL,
	"instruction" text NOT NULL,
	"ask_first" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"taught_from" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"updated_by_account_id" uuid,
	"approved_by_account_id" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_rule_tenant_key" UNIQUE("operator_id","id"),
	CONSTRAINT "ai_rule_intent_check" CHECK ("inbox"."ai_rule"."intent" ~ '^[a-z][a-z0-9_]{0,47}$'),
	CONSTRAINT "ai_rule_status_check" CHECK ("inbox"."ai_rule"."status" in ('draft','approved','archived')),
	CONSTRAINT "ai_rule_source_check" CHECK ("inbox"."ai_rule"."source" in ('teach','manual')),
	CONSTRAINT "ai_rule_length_check" CHECK (char_length("inbox"."ai_rule"."instruction") between 1 and 600
          and ("inbox"."ai_rule"."taught_from" is null or char_length("inbox"."ai_rule"."taught_from") between 1 and 2000)),
	CONSTRAINT "ai_rule_ask_first_check" CHECK ("inbox"."ai_rule"."ask_first" is null or (
            jsonb_typeof("inbox"."ai_rule"."ask_first") = 'object'
            and "inbox"."ai_rule"."ask_first"->>'condition' in ('always','branch_unknown')
            and jsonb_typeof("inbox"."ai_rule"."ask_first"->'question') = 'object'
            and char_length(coalesce("inbox"."ai_rule"."ask_first"->'question'->>'en', '')) between 1 and 200)),
	CONSTRAINT "ai_rule_approved_check" CHECK ("inbox"."ai_rule"."status" <> 'approved' or ("inbox"."ai_rule"."approved_by_account_id" is not null and "inbox"."ai_rule"."approved_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "inbox"."ai_rule" ADD CONSTRAINT "ai_rule_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."ai_rule" ADD CONSTRAINT "ai_rule_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."ai_rule" ADD CONSTRAINT "ai_rule_updated_by_account_id_account_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."ai_rule" ADD CONSTRAINT "ai_rule_approved_by_account_id_account_id_fk" FOREIGN KEY ("approved_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_rule_lookup_idx" ON "inbox"."ai_rule" USING btree ("operator_id","status");--> statement-breakpoint
CREATE INDEX "ai_rule_branch_idx" ON "inbox"."ai_rule" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "ai_rule_updated_by_idx" ON "inbox"."ai_rule" USING btree ("updated_by_account_id");--> statement-breakpoint
CREATE INDEX "ai_rule_approved_by_idx" ON "inbox"."ai_rule" USING btree ("approved_by_account_id");