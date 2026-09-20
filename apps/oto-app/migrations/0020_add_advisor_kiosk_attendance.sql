ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "face_enrollment_status" text DEFAULT 'NOT_ENROLLED';
ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "face_id" text;
ALTER TABLE "people" ADD COLUMN IF NOT EXISTS "face_enrolled_at" timestamp;
ALTER TABLE "kiosk_auth_attempts" ADD COLUMN IF NOT EXISTS "person_id" varchar REFERENCES "people"("id");

CREATE TABLE IF NOT EXISTS "advisor_enrollment_sessions" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "person_id" varchar NOT NULL REFERENCES "people"("id") ON DELETE cascade,
  "token_hash" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "used_at" timestamp,
  "created_by" varchar REFERENCES "users"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_advisor_enrollment_token" ON "advisor_enrollment_sessions" ("token_hash");
CREATE INDEX IF NOT EXISTS "idx_advisor_enrollment_person" ON "advisor_enrollment_sessions" ("person_id");

CREATE TABLE IF NOT EXISTS "advisor_attendance_sessions" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "person_id" varchar NOT NULL REFERENCES "people"("id") ON DELETE cascade,
  "branch_id" varchar NOT NULL REFERENCES "branches"("id"),
  "check_in_at" timestamp NOT NULL,
  "check_out_at" timestamp,
  "check_in_date" varchar NOT NULL,
  "is_overnight" boolean DEFAULT false NOT NULL,
  "duration_minutes" integer,
  "auth_method" text NOT NULL,
  "confidence_score" integer,
  "liveness_score" integer,
  "photo_evidence_url" text,
  "kiosk_device_id" varchar REFERENCES "kiosk_devices"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
ALTER TABLE "advisor_attendance_sessions" ADD COLUMN IF NOT EXISTS "duration_minutes" integer;
CREATE INDEX IF NOT EXISTS "idx_advisor_attendance_person_open" ON "advisor_attendance_sessions" ("person_id", "check_out_at");
CREATE INDEX IF NOT EXISTS "idx_advisor_attendance_branch_date" ON "advisor_attendance_sessions" ("branch_id", "check_in_date");
CREATE INDEX IF NOT EXISTS "idx_advisor_attendance_tenant" ON "advisor_attendance_sessions" ("tenant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "advisor_attendance_one_open_session"
  ON "advisor_attendance_sessions" ("person_id")
  WHERE "check_out_at" IS NULL;