CREATE TABLE "core"."setting_registry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"app_owner" text NOT NULL,
	"owning_page_url" text,
	"editable_here" boolean DEFAULT false NOT NULL,
	"required_permission" text NOT NULL,
	"last_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setting_registry_metadata_nonblank_check" CHECK (
    length(btrim("core"."setting_registry"."key")) > 0 and length(btrim("core"."setting_registry"."label")) > 0
    and length(btrim("core"."setting_registry"."app_owner")) > 0 and length(btrim("core"."setting_registry"."required_permission")) > 0
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "setting_registry_key_unique" ON "core"."setting_registry" USING btree ("key");