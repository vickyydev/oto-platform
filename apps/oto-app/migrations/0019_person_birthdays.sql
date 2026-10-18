-- Staff birthdays (SCRUM-561, the October Replit port R4; upstream 0023,
-- regenerated here as our 0019 and made re-runnable: a production restore may
-- already carry the pushed columns and constraints).
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "birthday_month" integer;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "birthday_day" integer;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "birthday_year" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "birthday_month" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "birthday_day" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "birthday_year" integer;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "employees" ADD CONSTRAINT "employees_birthday_valid" CHECK (
  (birthday_month IS NULL AND birthday_day IS NULL AND birthday_year IS NULL) OR
  (
    COALESCE(birthday_month BETWEEN 1 AND 12, false)
    AND COALESCE(
      birthday_day BETWEEN 1 AND CASE
        WHEN birthday_month IN (4, 6, 9, 11) THEN 30
        WHEN birthday_month = 2 THEN CASE
          WHEN COALESCE(birthday_year, 2000) % 400 = 0
            OR (
              COALESCE(birthday_year, 2000) % 4 = 0
              AND COALESCE(birthday_year, 2000) % 100 <> 0
            ) THEN 29
          ELSE 28
        END
        ELSE 31
      END,
      false
    )
    AND (birthday_year IS NULL OR birthday_year BETWEEN 1 AND 9999)
  )
);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "users" ADD CONSTRAINT "users_birthday_valid" CHECK (
  (birthday_month IS NULL AND birthday_day IS NULL AND birthday_year IS NULL) OR
  (
    COALESCE(birthday_month BETWEEN 1 AND 12, false)
    AND COALESCE(
      birthday_day BETWEEN 1 AND CASE
        WHEN birthday_month IN (4, 6, 9, 11) THEN 30
        WHEN birthday_month = 2 THEN CASE
          WHEN COALESCE(birthday_year, 2000) % 400 = 0
            OR (
              COALESCE(birthday_year, 2000) % 4 = 0
              AND COALESCE(birthday_year, 2000) % 100 <> 0
            ) THEN 29
          ELSE 28
        END
        ELSE 31
      END,
      false
    )
    AND (birthday_year IS NULL OR birthday_year BETWEEN 1 AND 9999)
  )
);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
