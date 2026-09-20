ALTER TYPE "core_checklist_status" ADD VALUE IF NOT EXISTS 'missed';
--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD COLUMN IF NOT EXISTS "period_start" timestamp;
--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD COLUMN IF NOT EXISTS "period_end" timestamp;
--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD COLUMN IF NOT EXISTS "missed_at" timestamp;
--> statement-breakpoint
ALTER TABLE "checklist_runs" ADD COLUMN IF NOT EXISTS "responsible_staff" jsonb DEFAULT '[]'::jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_checklist_runs_period"
  ON "checklist_runs" ("tenant_id", "template_id", "branch_id", "period_start")
  WHERE "period_start" IS NOT NULL;