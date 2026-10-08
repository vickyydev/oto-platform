-- Tenant ownership for the document modules, the expand half (S2-17b round 6;
-- plan section 7, hazards H10 and H16, questions Q31 and Q47). Generated, then
-- the "public" schema qualifier stripped and the backfill and the census
-- written in between. EXPAND ONLY: four new nullable columns, their foreign
-- keys, four indexes and, where the census allows it, one unique index;
-- nothing renamed, retyped or dropped, so the release before this one runs
-- unchanged against it.
--
--   templates.tenant_id          the park group a contract or letter template belongs to
--   policy_documents.tenant_id   the park group a policy (Rules & Regulations) belongs to
--   asset_catalog.tenant_id      the park group a catalogue item belongs to
--   leave_policies.tenant_id     the park group a days-off accrual policy belongs to (Q31)
--
-- NOT NULL WAITS, as 0006's did. The previous release writes these tables
-- without a park group during the hand-over; until round 7's contraction runs
-- this backfill again and sets NOT NULL, the app reads such a row as its
-- branch's park group's (policies and leave policies) or else the default park
-- group's — where every one of them was read before.
--
-- THE BACKFILL (H10: no row left null, no row given another park group's
-- tenant). 0006's order — branch, employee, contract, the strict actor, the
-- default park group — taken step by step as far as each table's rows reach.
-- Where a step reaches several rows (a template's assignments, an item's
-- assigned assets), it places the row only when they all name ONE park group;
-- a row they split between park groups goes on to the next step.
--
--   templates         its branches (template_assignments); else the employees
--                     of the contracts and letters made from it (it has no
--                     branch or employee of its own, so its contracts are both
--                     the employee and the contract step); else the user who
--                     made it, where the app's strict placement places them
--                     (0006's rule, managedUserTenant); else the default
--   policy_documents  its branch; else the employees of the contracts that
--                     acknowledged it; else the user who made it (strict);
--                     else the default (a company-wide policy no contract
--                     names, made by nobody the rule places, was the one set)
--   asset_catalog     the branches of the assets assigned from it; else those
--                     assets' employees; else the default (it records no maker)
--   leave_policies    its branch; else the default — the census's
--                     branch-then-default (plan section 7, Q31): a company-wide
--                     policy has no branch, employee or maker to follow, and
--                     before this it was every park group's
--
-- The default park group follows the app's own rule, exactly as 0006 takes it:
-- the tenant with slug 'default'; else, where the database holds exactly one
-- park group, that one. Only where neither answers and a row is still left for
-- it is one made ('OTO Default'). An empty database gets none.
--
-- THE OFFBOARDING CENSUS (H16). One offboarding per employee: the route has
-- refused a second one since the lift, and this adds the database's backstop
-- — a unique index on employee_offboarding.employee_id — ONLY where no employee
-- already has two. The app has no "closed" state for an offboarding (every row
-- stays the employee's offboarding; the route reads the latest), so every row
-- is open and the index has no predicate to take (Q47). Where the census finds
-- duplicates the index is NOT made and the migration says so and carries on:
-- the read-back (`npm run tenant:readback`) and `npm run offboarding:census`
-- name the employees, and the index waits for a person to settle them (Q48).
-- The table is locked against writes for the census and the index, so no row
-- can land between the count and the index.
--
-- Grants are not made here (0004's reason). The platform reads none of these
-- tables.
ALTER TABLE "asset_catalog" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "leave_policies" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "policy_documents" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "asset_catalog" ADD CONSTRAINT "asset_catalog_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_policies" ADD CONSTRAINT "leave_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_documents" ADD CONSTRAINT "policy_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

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

CREATE INDEX "idx_asset_catalog_tenant" ON "asset_catalog" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_leave_policies_tenant" ON "leave_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_policy_documents_tenant" ON "policy_documents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_templates_tenant" ON "templates" USING btree ("tenant_id");--> statement-breakpoint

-- The offboarding census (H16): one offboarding per employee, made a unique
-- index only where no employee already has two. Otherwise the index waits (Q48).
LOCK TABLE "employee_offboarding" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
DECLARE
  employees_with_two bigint;
  surplus_rows bigint;
BEGIN
  SELECT count(*), coalesce(sum(n - 1), 0) INTO employees_with_two, surplus_rows
    FROM (SELECT count(*) AS n FROM "employee_offboarding" GROUP BY "employee_id" HAVING count(*) > 1) AS d;
  IF employees_with_two = 0 THEN
    CREATE UNIQUE INDEX "employee_offboarding_employee_unique" ON "employee_offboarding" USING btree ("employee_id");
  ELSE
    RAISE NOTICE 'offboarding census (0008): % employees have more than one offboarding (% rows more than one each), so employee_offboarding_employee_unique is not made. Run npm run offboarding:census in the OTO App to see them; the index waits until they are settled (plan Q48).',
      employees_with_two, surplus_rows;
  END IF;
END $$;
