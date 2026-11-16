ALTER TABLE "core"."account" ADD CONSTRAINT "account_tenant_key" UNIQUE("operator_id","id");
--> statement-breakpoint
CREATE TABLE "inbox"."account_access" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"allowed_categories" text[],
	"restrict_channels" boolean DEFAULT false NOT NULL,
	"version" integer NOT NULL,
	"updated_by_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_access_tenant_account_key" UNIQUE("operator_id","account_id"),
	CONSTRAINT "account_access_categories_check" CHECK ("inbox"."account_access"."allowed_categories" is null or "inbox"."account_access"."allowed_categories" <@ array['birthdays','general','marketing','gm']::text[]),
	CONSTRAINT "account_access_version_check" CHECK ("inbox"."account_access"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "inbox"."account_channel_access" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_channel_access_key" UNIQUE("operator_id","account_id","channel_account_id")
);
--> statement-breakpoint
ALTER TABLE "inbox"."account_access" ADD CONSTRAINT "account_access_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."account_access" ADD CONSTRAINT "account_access_updated_by_account_id_account_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "core"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."account_access" ADD CONSTRAINT "account_access_account_fk" FOREIGN KEY ("operator_id","account_id") REFERENCES "core"."account"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."account_channel_access" ADD CONSTRAINT "account_channel_access_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."account_channel_access" ADD CONSTRAINT "account_channel_access_policy_fk" FOREIGN KEY ("operator_id","account_id") REFERENCES "inbox"."account_access"("operator_id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox"."account_channel_access" ADD CONSTRAINT "account_channel_access_channel_fk" FOREIGN KEY ("operator_id","channel_account_id") REFERENCES "inbox"."channel_account"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
--> statement-breakpoint
CREATE INDEX "account_access_updated_by_idx" ON "inbox"."account_access" USING btree ("updated_by_account_id");
--> statement-breakpoint
CREATE INDEX "account_channel_access_channel_idx" ON "inbox"."account_channel_access" USING btree ("operator_id","channel_account_id");
