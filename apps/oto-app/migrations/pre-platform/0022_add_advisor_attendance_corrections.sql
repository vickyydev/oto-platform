ALTER TABLE "advisor_attendance_sessions"
  ADD COLUMN IF NOT EXISTS "voided_at" timestamp,
  ADD COLUMN IF NOT EXISTS "voided_by" varchar REFERENCES "users"("id");

-- Replace the old partial index while it still protects against duplicate open
-- sessions. Avoid CONCURRENTLY because Drizzle applies migrations in a
-- transaction. Dropping the temporary name first also recovers safely from an
-- interrupted attempt that left an invalid concurrent index behind.
DROP INDEX IF EXISTS "advisor_attendance_one_active_open_session";
CREATE UNIQUE INDEX "advisor_attendance_one_active_open_session"
  ON "advisor_attendance_sessions" ("person_id")
  WHERE "check_out_at" IS NULL AND "voided_at" IS NULL;
DROP INDEX IF EXISTS "advisor_attendance_one_open_session";
ALTER INDEX "advisor_attendance_one_active_open_session"
  RENAME TO "advisor_attendance_one_open_session";

CREATE TABLE IF NOT EXISTS "advisor_attendance_corrections" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "session_id" varchar NOT NULL REFERENCES "advisor_attendance_sessions"("id") ON DELETE cascade,
  "branch_id" varchar NOT NULL REFERENCES "branches"("id"),
  "action" text NOT NULL,
  "reason" text NOT NULL,
  "before_values" jsonb NOT NULL,
  "after_values" jsonb NOT NULL,
  "changed_by" varchar NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_advisor_attendance_correction_session"
  ON "advisor_attendance_corrections" ("session_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_advisor_attendance_correction_tenant"
  ON "advisor_attendance_corrections" ("tenant_id");
