ALTER TABLE "checklist_runs"
  ADD COLUMN IF NOT EXISTS "completed_by" varchar REFERENCES "users"("id");