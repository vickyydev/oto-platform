-- SCRUM-794: one OPEN offboarding per profile. Offboard then Onboard Again
-- ends one contract and starts another on the same profile, and the
-- offboarding of the contract that ended stays as its record, marked
-- re-onboarded (0037). The app now refuses a second offboarding only while
-- one is still open; this partial unique index is the database's backstop for
-- that rule.
--
-- Expand-only. Migration 0008's `employee_offboarding_employee_unique` (one
-- offboarding per profile, ever) is left as it is: retiring it is the
-- contract step that lets a profile be offboarded a second time, and it is a
-- release of its own. Until then that index refuses the second offboarding
-- and the app answers 409 in words.
--
-- Made only where no profile has two open offboardings already, as 0008 made
-- its index (the census, plan Q48); otherwise it waits with a notice, so the
-- migration never fails on such a database. Not declared in shared/schema.ts
-- for the same reason as 0008's index.
LOCK TABLE "employee_offboarding" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
DECLARE
  employees_with_two bigint;
BEGIN
  SELECT count(*) INTO employees_with_two
    FROM (SELECT 1 FROM "employee_offboarding" WHERE "reonboarded_at" IS NULL
           GROUP BY "employee_id" HAVING count(*) > 1) AS d;
  IF employees_with_two = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "employee_offboarding_one_open" ON "employee_offboarding" USING btree ("employee_id") WHERE "reonboarded_at" IS NULL;
  ELSE
    RAISE NOTICE 'offboarding census (0038): % employees have more than one open offboarding, so employee_offboarding_one_open is not made. Run npm run offboarding:census in the OTO App to see them (plan Q48).',
      employees_with_two;
  END IF;
END $$;
