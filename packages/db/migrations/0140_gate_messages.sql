CREATE TABLE "core"."gate_message_setting" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"languages" text[] NOT NULL,
	"updated_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_message_setting_languages_check" CHECK (cardinality("core"."gate_message_setting"."languages") between 1 and 5 and "core"."gate_message_setting"."languages" <@ array['en','zh','th','ru','fr']::text[])
);
--> statement-breakpoint
CREATE TABLE "core"."gate_message_text" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"lang" text NOT NULL,
	"text" text NOT NULL,
	"updated_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gate_message_text_kind_check" CHECK ("core"."gate_message_text"."kind" in ('case','label')),
	CONSTRAINT "gate_message_text_lang_check" CHECK ("core"."gate_message_text"."lang" in ('en','zh','th','ru','fr')),
	CONSTRAINT "gate_message_text_length_check" CHECK (char_length("core"."gate_message_text"."text") <= 200)
);
--> statement-breakpoint
ALTER TABLE "core"."gate_message_setting" ADD CONSTRAINT "gate_message_setting_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."gate_message_setting" ADD CONSTRAINT "gate_message_setting_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."gate_message_setting" ADD CONSTRAINT "gate_message_setting_updated_by_account_id_account_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "core"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."gate_message_text" ADD CONSTRAINT "gate_message_text_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."gate_message_text" ADD CONSTRAINT "gate_message_text_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."gate_message_text" ADD CONSTRAINT "gate_message_text_updated_by_account_id_account_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "core"."account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gate_message_setting_operator_idx" ON "core"."gate_message_setting" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "gate_message_setting_updated_by_idx" ON "core"."gate_message_setting" USING btree ("updated_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gate_message_setting_branch_unique" ON "core"."gate_message_setting" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "gate_message_text_operator_idx" ON "core"."gate_message_text" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "gate_message_text_updated_by_idx" ON "core"."gate_message_text" USING btree ("updated_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gate_message_text_unique" ON "core"."gate_message_text" USING btree ("branch_id","kind","key","lang");