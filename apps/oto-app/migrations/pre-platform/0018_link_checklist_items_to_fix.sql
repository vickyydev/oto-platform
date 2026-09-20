ALTER TABLE "checklist_template_items"
  ADD COLUMN IF NOT EXISTS "linked_to_fix" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "fix_reports"
  ADD COLUMN IF NOT EXISTS "source_checklist_run_item_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "fix_reports"
    ADD CONSTRAINT "fix_reports_source_checklist_run_item_id_checklist_run_items_id_fk"
    FOREIGN KEY ("source_checklist_run_item_id")
    REFERENCES "public"."checklist_run_items"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fix_reports_source_checklist_item"
  ON "fix_reports" ("source_checklist_run_item_id");