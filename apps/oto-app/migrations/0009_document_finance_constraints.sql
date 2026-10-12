-- R7a: ownership writers, people expansion and finance keys.
-- Document columns stay nullable while the preceding release still serves.
-- R7b contracts them only after this writer release is live everywhere.
-- Take the same table order as offboarding: its row before the employee.
LOCK TABLE "employee_offboarding" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

-- A person's ownership anchor is additive; existing access rules stay in place.
ALTER TABLE "people" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
LOCK TABLE "people", "access_policies", "employees" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
UPDATE "people" AS p SET "tenant_id" = a."tenant_id"
  FROM (
    SELECT x."person_id", min(x."tenant_id"::text)::uuid AS "tenant_id"
      FROM (SELECT "person_id", "tenant_id" FROM "access_policies"
            UNION ALL SELECT "person_id", "tenant_id" FROM "employees" WHERE "person_id" IS NOT NULL) AS x
     GROUP BY x."person_id"
    HAVING count(DISTINCT x."tenant_id") = 1 AND bool_and(x."tenant_id" IS NOT NULL)
  ) AS a
 WHERE p."tenant_id" IS NULL AND p."id" = a."person_id";--> statement-breakpoint
-- Unplaced or mixed-link people remain unplaced for a recorded decision (Q56).

-- S2-17b round 7 (SCRUM-191): document ownership contraction and finance keys.
-- Applied after release 0008 is live. Its placement statements run again over
-- hand-over rows; already-owned rows stay where they are. Locks are taken at
-- their final strength before reading so an in-flight writer finishes first
-- and no lock upgrade can deadlock a reader that later writes.
-- The gate refuses the whole transaction while any document row is unplaced
-- or finance key is held twice. Counts only: no finance content is printed.
-- P&L report cells retain their existing append/snapshot behaviour (Q55).
LOCK TABLE "asset_catalog", "leave_policies", "policy_documents", "templates",
  "cash_daily", "cash_txns", "xero_tracking_categories", "xero_tracking_options"
  IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint

-- templates: its branches, the employees of its contracts and letters, its maker.
UPDATE "templates" AS t SET "tenant_id" = a."tenant_id"
  FROM (
    SELECT ta."template_id", min(b."tenant_id"::text)::uuid AS "tenant_id"
      FROM "template_assignments" AS ta
      JOIN "branches" AS b ON b."id" = ta."branch_id"
     GROUP BY ta."template_id"
    HAVING count(DISTINCT b."tenant_id") = 1
  ) AS a
 WHERE t."tenant_id" IS NULL AND a."template_id" = t."id";--> statement-breakpoint
UPDATE "templates" AS t SET "tenant_id" = m."tenant_id"
  FROM (
    SELECT u."template_id", min(e."tenant_id"::text)::uuid AS "tenant_id"
      FROM (SELECT c."template_id", c."employee_id" FROM "contract_instances" AS c
            UNION ALL
            SELECT l."template_id", l."employee_id" FROM "employee_letters" AS l
             WHERE l."template_id" IS NOT NULL) AS u
      JOIN "employees" AS e ON e."id" = u."employee_id"
     GROUP BY u."template_id"
    HAVING count(DISTINCT e."tenant_id") = 1
  ) AS m
 WHERE t."tenant_id" IS NULL AND m."template_id" = t."id";--> statement-breakpoint
UPDATE "templates" AS t SET "tenant_id" = u."tenant_id"
  FROM (
    SELECT x."user_id", min(x."tenant_id"::text)::uuid AS "tenant_id"
      FROM "user_branch_access" AS x
      LEFT JOIN "branches" AS b ON b."id" = x."branch_id"
     GROUP BY x."user_id"
    HAVING count(DISTINCT x."tenant_id") = 1
       AND bool_and(x."branch_id" IS NULL OR b."tenant_id" IS NOT DISTINCT FROM x."tenant_id")
  ) AS u
  LEFT JOIN "users" AS usr ON usr."id" = u."user_id"
 WHERE t."tenant_id" IS NULL AND u."user_id" = t."created_by"
   AND (usr."role" IS DISTINCT FROM 'operator_admin' OR usr."operator_id" IS NULL
        OR EXISTS (SELECT 1 FROM "operators" AS o
                    WHERE o."id" = usr."operator_id" AND o."tenant_id" = u."tenant_id"));--> statement-breakpoint

-- policy_documents: its branch, the employees of the contracts that acknowledged it, its maker.
UPDATE "policy_documents" AS p SET "tenant_id" = b."tenant_id"
  FROM "branches" AS b
 WHERE p."tenant_id" IS NULL AND b."id" = p."branch_id";--> statement-breakpoint
UPDATE "policy_documents" AS p SET "tenant_id" = m."tenant_id"
  FROM (
    SELECT c."policy_document_id", min(e."tenant_id"::text)::uuid AS "tenant_id"
      FROM "contract_instances" AS c
      JOIN "employees" AS e ON e."id" = c."employee_id"
     WHERE c."policy_document_id" IS NOT NULL
     GROUP BY c."policy_document_id"
    HAVING count(DISTINCT e."tenant_id") = 1
  ) AS m
 WHERE p."tenant_id" IS NULL AND m."policy_document_id" = p."id";--> statement-breakpoint
UPDATE "policy_documents" AS p SET "tenant_id" = u."tenant_id"
  FROM (
    SELECT x."user_id", min(x."tenant_id"::text)::uuid AS "tenant_id"
      FROM "user_branch_access" AS x
      LEFT JOIN "branches" AS b ON b."id" = x."branch_id"
     GROUP BY x."user_id"
    HAVING count(DISTINCT x."tenant_id") = 1
       AND bool_and(x."branch_id" IS NULL OR b."tenant_id" IS NOT DISTINCT FROM x."tenant_id")
  ) AS u
  LEFT JOIN "users" AS usr ON usr."id" = u."user_id"
 WHERE p."tenant_id" IS NULL AND u."user_id" = p."created_by"
   AND (usr."role" IS DISTINCT FROM 'operator_admin' OR usr."operator_id" IS NULL
        OR EXISTS (SELECT 1 FROM "operators" AS o
                    WHERE o."id" = usr."operator_id" AND o."tenant_id" = u."tenant_id"));--> statement-breakpoint

-- asset_catalog: the branches, then the employees, of the assets assigned from it.
UPDATE "asset_catalog" AS i SET "tenant_id" = a."tenant_id"
  FROM (
    SELECT ea."catalog_asset_id", min(b."tenant_id"::text)::uuid AS "tenant_id"
      FROM "employee_assets" AS ea
      JOIN "branches" AS b ON b."id" = ea."branch_id"
     WHERE ea."catalog_asset_id" IS NOT NULL
     GROUP BY ea."catalog_asset_id"
    HAVING count(DISTINCT b."tenant_id") = 1
  ) AS a
 WHERE i."tenant_id" IS NULL AND a."catalog_asset_id" = i."id";--> statement-breakpoint
UPDATE "asset_catalog" AS i SET "tenant_id" = m."tenant_id"
  FROM (
    SELECT ea."catalog_asset_id", min(e."tenant_id"::text)::uuid AS "tenant_id"
      FROM "employee_assets" AS ea
      JOIN "employees" AS e ON e."id" = ea."employee_id"
     WHERE ea."catalog_asset_id" IS NOT NULL
     GROUP BY ea."catalog_asset_id"
    HAVING count(DISTINCT e."tenant_id") = 1
  ) AS m
 WHERE i."tenant_id" IS NULL AND m."catalog_asset_id" = i."id";--> statement-breakpoint

-- leave_policies: its branch.
UPDATE "leave_policies" AS lp SET "tenant_id" = b."tenant_id"
  FROM "branches" AS b
 WHERE lp."tenant_id" IS NULL AND b."id" = lp."branch_id";--> statement-breakpoint

-- The default park group: slug 'default', else the only park group there is;
-- made only where neither answers and a row is still left for it.
INSERT INTO "tenants" ("name", "slug")
SELECT 'OTO Default', 'default'
 WHERE NOT EXISTS (SELECT 1 FROM "tenants" WHERE "slug" = 'default')
   AND (SELECT count(*) FROM "tenants") <> 1
   AND (EXISTS (SELECT 1 FROM "templates" WHERE "tenant_id" IS NULL)
        OR EXISTS (SELECT 1 FROM "policy_documents" WHERE "tenant_id" IS NULL)
        OR EXISTS (SELECT 1 FROM "asset_catalog" WHERE "tenant_id" IS NULL)
        OR EXISTS (SELECT 1 FROM "leave_policies" WHERE "tenant_id" IS NULL));--> statement-breakpoint

-- Everything left: the default park group's.
UPDATE "templates" SET "tenant_id" = coalesce(
    (SELECT "id" FROM "tenants" WHERE "slug" = 'default'),
    (SELECT min("id"::text)::uuid FROM "tenants" HAVING count(*) = 1))
 WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "policy_documents" SET "tenant_id" = coalesce(
    (SELECT "id" FROM "tenants" WHERE "slug" = 'default'),
    (SELECT min("id"::text)::uuid FROM "tenants" HAVING count(*) = 1))
 WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "asset_catalog" SET "tenant_id" = coalesce(
    (SELECT "id" FROM "tenants" WHERE "slug" = 'default'),
    (SELECT min("id"::text)::uuid FROM "tenants" HAVING count(*) = 1))
 WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "leave_policies" SET "tenant_id" = coalesce(
    (SELECT "id" FROM "tenants" WHERE "slug" = 'default'),
    (SELECT min("id"::text)::uuid FROM "tenants" HAVING count(*) = 1))
 WHERE "tenant_id" IS NULL;--> statement-breakpoint

-- Count every obstacle before refusing. The migrator wraps this in one transaction.
DO $$
DECLARE
  unplaced_templates bigint;
  unplaced_policies bigint;
  unplaced_catalog bigint;
  unplaced_leave bigint;
  duplicate_categories bigint;
  duplicate_options bigint;
  duplicate_txns bigint;
  duplicate_daily bigint;
BEGIN
  SELECT count(*) INTO unplaced_templates FROM "templates" WHERE "tenant_id" IS NULL;
  SELECT count(*) INTO unplaced_policies FROM "policy_documents" WHERE "tenant_id" IS NULL;
  SELECT count(*) INTO unplaced_catalog FROM "asset_catalog" WHERE "tenant_id" IS NULL;
  SELECT count(*) INTO unplaced_leave FROM "leave_policies" WHERE "tenant_id" IS NULL;
  SELECT count(*) INTO duplicate_categories FROM
    (SELECT 1 FROM "xero_tracking_categories" GROUP BY "tenant_id", "tracking_category_id" HAVING count(*) > 1) d;
  SELECT count(*) INTO duplicate_options FROM
    (SELECT 1 FROM "xero_tracking_options" GROUP BY "tenant_id", "tracking_option_id" HAVING count(*) > 1) d;
  SELECT count(*) INTO duplicate_txns FROM
    (SELECT 1 FROM "cash_txns" GROUP BY "tenant_id", "xero_bank_transaction_id" HAVING count(*) > 1) d;
  SELECT count(*) INTO duplicate_daily FROM
    (SELECT 1 FROM "cash_daily" GROUP BY "tenant_id", "date" HAVING count(*) > 1) d;
  IF unplaced_templates + unplaced_policies + unplaced_catalog + unplaced_leave
       + duplicate_categories + duplicate_options + duplicate_txns + duplicate_daily > 0 THEN
    RAISE EXCEPTION 'document/finance gate (0009): unplaced rows templates=%, policy_documents=%, asset_catalog=%, leave_policies=%; duplicate keys xero_tracking_categories=%, xero_tracking_options=%, cash_txns=%, cash_daily=%. Nothing was changed. Run npm run tenant:readback, settle the named groups, then deploy again.',
      unplaced_templates, unplaced_policies, unplaced_catalog, unplaced_leave,
      duplicate_categories, duplicate_options, duplicate_txns, duplicate_daily;
  END IF;
END $$;--> statement-breakpoint

-- A database whose 0008 census deferred this index may now be settled (Q48).
-- The same locked census decides; existing rows are never deleted or merged.
DO $$
DECLARE
  employees_with_two bigint;
  surplus_rows bigint;
BEGIN
  SELECT count(*), coalesce(sum(n - 1), 0) INTO employees_with_two, surplus_rows
    FROM (SELECT count(*) AS n FROM "employee_offboarding" GROUP BY "employee_id" HAVING count(*) > 1) AS d;
  IF employees_with_two = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "employee_offboarding_employee_unique" ON "employee_offboarding" USING btree ("employee_id");
  ELSE
    RAISE NOTICE 'offboarding census (0009): % employees have more than one offboarding (% surplus rows), so employee_offboarding_employee_unique still waits. Run npm run offboarding:census (plan Q48).',
      employees_with_two, surplus_rows;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "cash_daily" ADD CONSTRAINT "cash_daily_tenant_id_date_pk" PRIMARY KEY("tenant_id","date");--> statement-breakpoint
ALTER TABLE "cash_txns" ADD CONSTRAINT "cash_txns_tenant_id_xero_bank_transaction_id_pk" PRIMARY KEY("tenant_id","xero_bank_transaction_id");--> statement-breakpoint
ALTER TABLE "xero_tracking_categories" ADD CONSTRAINT "xero_tracking_categories_tenant_id_tracking_category_id_pk" PRIMARY KEY("tenant_id","tracking_category_id");--> statement-breakpoint
ALTER TABLE "xero_tracking_options" ADD CONSTRAINT "xero_tracking_options_tenant_id_tracking_option_id_pk" PRIMARY KEY("tenant_id","tracking_option_id");