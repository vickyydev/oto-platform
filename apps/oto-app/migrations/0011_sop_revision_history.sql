CREATE TABLE "sop_article_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"previous_status" "sop_status" NOT NULL,
	"saved_by_id" varchar NOT NULL,
	"saved_by_name" text NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mutation_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sop_articles" ADD COLUMN "edit_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sop_article_revisions" ADD CONSTRAINT "sop_article_revisions_article_id_sop_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "sop_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sop_article_revisions" ADD CONSTRAINT "sop_article_revisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sop_revision_article_version_unique" ON "sop_article_revisions" USING btree ("article_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "sop_revision_article_mutation_unique" ON "sop_article_revisions" USING btree ("article_id","mutation_id");--> statement-breakpoint
CREATE INDEX "sop_revision_tenant_article_idx" ON "sop_article_revisions" USING btree ("tenant_id","article_id");
--> statement-breakpoint
-- Saved content remains immutable. Article deletion still removes its history.
CREATE FUNCTION "refuse_sop_revision_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Saved SOP revisions cannot be edited';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "sop_revision_immutable" BEFORE UPDATE ON "sop_article_revisions"
FOR EACH ROW EXECUTE FUNCTION "refuse_sop_revision_update"();
