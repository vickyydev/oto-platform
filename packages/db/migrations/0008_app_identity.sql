-- S2-17a — the schema the OTO App's own tables land in, and the record of
-- which of its users is which platform account.
--
-- The CREATE SCHEMA below is hand-added; everything after it is generated.
-- `otoapp` is deliberately outside `schemaFilter`, so Drizzle never creates,
-- diffs or drops it — but the app's own migrator runs with `search_path` set
-- to it and would fail on the first statement if the schema were not already
-- there. Creating it here puts it in the platform's migration order, ahead of
-- any deploy step that runs the app's migrator.
--
-- Expand only: a new schema and a new table, nothing renamed or removed, so
-- the release before this one runs unchanged against it.

CREATE SCHEMA IF NOT EXISTS "otoapp";--> statement-breakpoint
CREATE TABLE "core"."app_identity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"app" text NOT NULL,
	"account_id" uuid NOT NULL,
	"external_user_id" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_identity_app_check" CHECK ("core"."app_identity"."app" in ('pos','console','oto_app','radar','booth','inbox'))
);
--> statement-breakpoint
ALTER TABLE "core"."app_identity" ADD CONSTRAINT "app_identity_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."app_identity" ADD CONSTRAINT "app_identity_created_by_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_identity_account_unique" ON "core"."app_identity" USING btree ("app","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_identity_external_unique" ON "core"."app_identity" USING btree ("app","external_user_id");--> statement-breakpoint
CREATE INDEX "app_identity_account_idx" ON "core"."app_identity" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "app_identity_created_by_idx" ON "core"."app_identity" USING btree ("created_by");