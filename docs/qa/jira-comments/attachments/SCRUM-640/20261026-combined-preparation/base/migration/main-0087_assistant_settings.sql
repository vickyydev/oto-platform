CREATE TABLE "core"."setting" (
	"operator_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setting_operator_id_key_pk" PRIMARY KEY("operator_id","key"),
	CONSTRAINT "setting_revision_positive_check" CHECK ("core"."setting"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "core"."setting" ADD CONSTRAINT "setting_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."setting" ADD CONSTRAINT "setting_updated_by_account_id_fk" FOREIGN KEY ("updated_by") REFERENCES "core"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "setting_updated_by_idx" ON "core"."setting" USING btree ("updated_by");
