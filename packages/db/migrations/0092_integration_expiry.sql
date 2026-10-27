CREATE TABLE "core"."integration_credential_expiry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"integration_key" text NOT NULL,
	"expires_on" date,
	"set_by_account_id" uuid,
	"set_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_credential_expiry_key_check" CHECK ("core"."integration_credential_expiry"."integration_key" in ('meta_channel_token','pgw_maintenance_key','otoapp_directory_key'))
);
--> statement-breakpoint
ALTER TABLE "core"."integration_credential_expiry" ADD CONSTRAINT "integration_credential_expiry_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."integration_credential_expiry" ADD CONSTRAINT "integration_credential_expiry_set_by_account_id_account_id_fk" FOREIGN KEY ("set_by_account_id") REFERENCES "core"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_credential_expiry_operator_key_unique" ON "core"."integration_credential_expiry" USING btree ("operator_id","integration_key");--> statement-breakpoint
CREATE INDEX "integration_credential_expiry_set_by_idx" ON "core"."integration_credential_expiry" USING btree ("set_by_account_id");