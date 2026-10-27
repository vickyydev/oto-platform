-- SCRUM-644 (planner ruling Q25): alert recipients, fingerprint mutes, muted
-- and unsupported delivery records, and the audit app/category labels.
-- Expand-only. PROVISIONAL NUMBER 0090: renumbered by the coordinator at landing.
-- target_app / reason / origin belong to SCRUM-643's own migration (0089 on its
-- branch); they are repeated here with IF NOT EXISTS only so this branch can be
-- tested alone, and the three statements are dropped when 643 lands first.
CREATE TABLE "core"."alert_mute" (
	"id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"operator_id" uuid,
	"reason" text NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"muted_until" timestamp with time zone NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_mute_fingerprint_check" CHECK (length("core"."alert_mute"."fingerprint") between 4 and 200),
	CONSTRAINT "alert_mute_reason_check" CHECK (length(btrim("core"."alert_mute"."reason")) between 1 and 500),
	CONSTRAINT "alert_mute_window_check" CHECK ("core"."alert_mute"."muted_until" > "core"."alert_mute"."starts_at" and "core"."alert_mute"."muted_until" <= "core"."alert_mute"."starts_at" + interval '24 hours'),
	CONSTRAINT "alert_mute_lifted_check" CHECK (("core"."alert_mute"."lifted_at" is null) = ("core"."alert_mute"."lifted_by_account_id" is null))
);
--> statement-breakpoint
CREATE TABLE "core"."alert_recipient" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid,
	"branch_id" uuid,
	"category" text NOT NULL,
	"channel" text NOT NULL,
	"address_ref" text,
	"label" text,
	"created_by_account_id" uuid NOT NULL,
	"updated_by_account_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_recipient_channel_check" CHECK ("core"."alert_recipient"."channel" in ('console','email','webhook')),
	CONSTRAINT "alert_recipient_category_check" CHECK ("core"."alert_recipient"."category" ~ '^(\*|[a-z][a-z0-9_]*(\.[a-z0-9_]+)*)$' and length("core"."alert_recipient"."category") <= 80),
	CONSTRAINT "alert_recipient_address_shape_check" CHECK (("core"."alert_recipient"."channel" = 'console' and "core"."alert_recipient"."address_ref" is null) or ("core"."alert_recipient"."channel" <> 'console' and "core"."alert_recipient"."address_ref" is not null)),
	CONSTRAINT "alert_recipient_address_ref_check" CHECK ("core"."alert_recipient"."address_ref" is null or (position('@' in "core"."alert_recipient"."address_ref") = 0 and position('://' in "core"."alert_recipient"."address_ref") = 0 and "core"."alert_recipient"."address_ref" ~ '^ALERT_[A-Z0-9_]{2,58}$')),
	CONSTRAINT "alert_recipient_branch_operator_check" CHECK ("core"."alert_recipient"."branch_id" is null or "core"."alert_recipient"."operator_id" is not null),
	CONSTRAINT "alert_recipient_label_check" CHECK ("core"."alert_recipient"."label" is null or length("core"."alert_recipient"."label") <= 120)
);
--> statement-breakpoint
ALTER TABLE "core"."alert_delivery" DROP CONSTRAINT "alert_delivery_status_check";--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD COLUMN "source_app" text;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD COLUMN IF NOT EXISTS "target_app" text;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD COLUMN IF NOT EXISTS "reason" text;--> statement-breakpoint
ALTER TABLE "core"."audit_log" ADD COLUMN IF NOT EXISTS "origin" text;--> statement-breakpoint
ALTER TABLE "core"."alert_delivery" ADD COLUMN "mute_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."alert_mute" ADD CONSTRAINT "alert_mute_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."alert_mute" ADD CONSTRAINT "alert_mute_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "core"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."alert_mute" ADD CONSTRAINT "alert_mute_lifted_by_account_id_account_id_fk" FOREIGN KEY ("lifted_by_account_id") REFERENCES "core"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."alert_recipient" ADD CONSTRAINT "alert_recipient_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."alert_recipient" ADD CONSTRAINT "alert_recipient_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."alert_recipient" ADD CONSTRAINT "alert_recipient_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "core"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."alert_recipient" ADD CONSTRAINT "alert_recipient_updated_by_account_id_account_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "core"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_mute_fingerprint_idx" ON "core"."alert_mute" USING btree ("fingerprint","muted_until");--> statement-breakpoint
CREATE INDEX "alert_mute_operator_idx" ON "core"."alert_mute" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "alert_mute_created_by_idx" ON "core"."alert_mute" USING btree ("created_by_account_id");--> statement-breakpoint
CREATE INDEX "alert_mute_lifted_by_idx" ON "core"."alert_mute" USING btree ("lifted_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_recipient_route_unique" ON "core"."alert_recipient" USING btree (coalesce("operator_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("branch_id", '00000000-0000-0000-0000-000000000000'::uuid),"category","channel",coalesce("address_ref", '')) WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "alert_recipient_operator_idx" ON "core"."alert_recipient" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "alert_recipient_branch_idx" ON "core"."alert_recipient" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "alert_recipient_category_idx" ON "core"."alert_recipient" USING btree ("category");--> statement-breakpoint
CREATE INDEX "alert_recipient_created_by_idx" ON "core"."alert_recipient" USING btree ("created_by_account_id");--> statement-breakpoint
CREATE INDEX "alert_recipient_updated_by_idx" ON "core"."alert_recipient" USING btree ("updated_by_account_id");--> statement-breakpoint
ALTER TABLE "core"."alert_delivery" ADD CONSTRAINT "alert_delivery_mute_id_alert_mute_id_fk" FOREIGN KEY ("mute_id") REFERENCES "core"."alert_mute"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_source_app_idx" ON "core"."audit_log" USING btree ("source_app","created_at");--> statement-breakpoint
CREATE INDEX "audit_target_app_idx" ON "core"."audit_log" USING btree ("target_app","created_at");--> statement-breakpoint
CREATE INDEX "audit_category_idx" ON "core"."audit_log" USING btree ("category","created_at");--> statement-breakpoint
CREATE INDEX "alert_delivery_mute_idx" ON "core"."alert_delivery" USING btree ("mute_id");--> statement-breakpoint
ALTER TABLE "core"."alert_delivery" ADD CONSTRAINT "alert_delivery_mute_check" CHECK (("core"."alert_delivery"."status" = 'muted') = ("core"."alert_delivery"."mute_id" is not null));--> statement-breakpoint
ALTER TABLE "core"."alert_delivery" ADD CONSTRAINT "alert_delivery_status_check" CHECK ("core"."alert_delivery"."status" in ('sent','failed','muted','unsupported'));