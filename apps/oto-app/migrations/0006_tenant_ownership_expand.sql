-- Tenant ownership, the expand half (S2-17b round 4a; plan section 7, hazards
-- H10 and H11). Generated, then the "public" schema qualifier stripped and the
-- backfill written in between. EXPAND ONLY: three new nullable columns, their
-- foreign keys, two indexes and one new unique index; nothing renamed, retyped
-- or dropped, so the release before this one runs unchanged against it.
--
--   settings.tenant_id          the park group a setting belongs to
--   activity_log.tenant_id      the park group an Activity Logbook row belongs to
--   attention_items.tenant_id   the park group an Attention item belongs to
--
-- THE TWO UNIQUES ON settings. The baseline's `settings_key_unique` (one row per
-- key, across every park group) STAYS. The new `settings_tenant_id_key_unique`
-- (one row per key per park group) stands beside it, and is also the tenant_id
-- index on settings (it leads with it). Until the contraction — round 4b, one
-- release later, which drops `settings_key_unique` — a key can be held by one
-- park group only, so the app lets only the default park group save settings
-- and every other park group reads the default's values.
--
-- NOT NULL WAITS TOO. The previous release writes these tables without a
-- tenant during the hand-over, and its rows must still be taken. The app reads
-- such a row as it did before this migration (a setting with no tenant as the
-- default park group's, an activity row by its branch). Round 4b runs this
-- backfill again over whatever the hand-over left null, and sets NOT NULL once
-- the read-back (script/tenant-ownership-readback.mjs) shows none.
--
-- THE BACKFILL (H10: no row left null, no row given another park group's
-- tenant). Each row takes its park group from what it is about, in order:
--
--   activity_log     its branch; else its employee; else its contract's
--                    employee; else the user who did it, where the app's
--                    strict placement (managedUserTenant, server/routes.ts)
--                    places that user: every access row names one park group,
--                    every branch those rows name is that park group's, and an
--                    operator admin's operator is that park group's too (a
--                    user it cannot place places nobody); else the default
--                    park group
--   attention_items  its branch; else its employee; else its contract's
--                    employee; else the default park group (an item is raised
--                    by the engine, not by a user)
--   settings         the default park group: before this there was one set of
--                    settings, and it was the default park group's
--
-- The default park group follows the app's own rule for its default tenant
-- (getDefaultTenantId, server/routes.ts): the tenant with slug 'default'
-- (DEFAULT_TENANT_SLUG); else, where the database holds exactly one park group,
-- that one — a one-park-group database stays one park group, and its rows are
-- its own. Only where neither answers (no tenant at all, or several and none
-- slugged 'default') and a row still needs it is one made — 'OTO Default', as
-- the app's own tenant backfill makes it (script/backfillTenant.ts,
-- ensureDefaultTenant). A database with nothing to place gets no new tenant.
--
-- Grants are not made here (0004's reason). The platform reads none of these
-- tables.
ALTER TABLE "activity_log" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "attention_items" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_items" ADD CONSTRAINT "attention_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- activity_log: its branch, its employee, its contract's employee, its actor.
UPDATE "activity_log" AS a SET "tenant_id" = b."tenant_id"
  FROM "branches" AS b
 WHERE a."tenant_id" IS NULL AND b."id" = a."branch_id";--> statement-breakpoint
UPDATE "activity_log" AS a SET "tenant_id" = e."tenant_id"
  FROM "employees" AS e
 WHERE a."tenant_id" IS NULL AND e."id" = a."employee_id";--> statement-breakpoint
UPDATE "activity_log" AS a SET "tenant_id" = e."tenant_id"
  FROM "contract_instances" AS c
  JOIN "employees" AS e ON e."id" = c."employee_id"
 WHERE a."tenant_id" IS NULL AND c."id" = a."contract_instance_id";--> statement-breakpoint
UPDATE "activity_log" AS a SET "tenant_id" = u."tenant_id"
  FROM (
    SELECT x."user_id", min(x."tenant_id"::text)::uuid AS "tenant_id"
      FROM "user_branch_access" AS x
      LEFT JOIN "branches" AS b ON b."id" = x."branch_id"
     GROUP BY x."user_id"
    HAVING count(DISTINCT x."tenant_id") = 1
       AND bool_and(x."branch_id" IS NULL OR b."tenant_id" IS NOT DISTINCT FROM x."tenant_id")
  ) AS u
  LEFT JOIN "users" AS usr ON usr."id" = u."user_id"
 WHERE a."tenant_id" IS NULL AND u."user_id" = a."created_by"
   AND (usr."role" IS DISTINCT FROM 'operator_admin' OR usr."operator_id" IS NULL
        OR EXISTS (SELECT 1 FROM "operators" AS o
                    WHERE o."id" = usr."operator_id" AND o."tenant_id" = u."tenant_id"));--> statement-breakpoint

-- attention_items: its branch, its employee, its contract's employee.
UPDATE "attention_items" AS i SET "tenant_id" = b."tenant_id"
  FROM "branches" AS b
 WHERE i."tenant_id" IS NULL AND b."id" = i."branch_id";--> statement-breakpoint
UPDATE "attention_items" AS i SET "tenant_id" = e."tenant_id"
  FROM "employees" AS e
 WHERE i."tenant_id" IS NULL AND e."id" = i."employee_id";--> statement-breakpoint
UPDATE "attention_items" AS i SET "tenant_id" = e."tenant_id"
  FROM "contract_instances" AS c
  JOIN "employees" AS e ON e."id" = c."employee_id"
 WHERE i."tenant_id" IS NULL AND c."id" = i."contract_instance_id";--> statement-breakpoint

-- The default park group: slug 'default', else the only park group there is;
-- made only where neither answers and a row is still left for it.
INSERT INTO "tenants" ("name", "slug")
SELECT 'OTO Default', 'default'
 WHERE NOT EXISTS (SELECT 1 FROM "tenants" WHERE "slug" = 'default')
   AND (SELECT count(*) FROM "tenants") <> 1
   AND (EXISTS (SELECT 1 FROM "settings" WHERE "tenant_id" IS NULL)
        OR EXISTS (SELECT 1 FROM "activity_log" WHERE "tenant_id" IS NULL)
        OR EXISTS (SELECT 1 FROM "attention_items" WHERE "tenant_id" IS NULL));--> statement-breakpoint

-- Everything left: the default park group's.
UPDATE "activity_log" SET "tenant_id" = coalesce(
    (SELECT "id" FROM "tenants" WHERE "slug" = 'default'),
    (SELECT min("id"::text)::uuid FROM "tenants" HAVING count(*) = 1))
 WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "attention_items" SET "tenant_id" = coalesce(
    (SELECT "id" FROM "tenants" WHERE "slug" = 'default'),
    (SELECT min("id"::text)::uuid FROM "tenants" HAVING count(*) = 1))
 WHERE "tenant_id" IS NULL;--> statement-breakpoint
UPDATE "settings" SET "tenant_id" = coalesce(
    (SELECT "id" FROM "tenants" WHERE "slug" = 'default'),
    (SELECT min("id"::text)::uuid FROM "tenants" HAVING count(*) = 1))
 WHERE "tenant_id" IS NULL;--> statement-breakpoint

CREATE INDEX "idx_activity_log_tenant" ON "activity_log" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_attention_items_tenant" ON "attention_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_tenant_id_key_unique" ON "settings" USING btree ("tenant_id","key");
