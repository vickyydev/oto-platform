CREATE TABLE IF NOT EXISTS "beo_bar_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL UNIQUE REFERENCES "core_events"("id") ON DELETE CASCADE,
  "service_time" text,
  "items" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_beo_bar_plans_event" ON "beo_bar_plans" ("event_id");
