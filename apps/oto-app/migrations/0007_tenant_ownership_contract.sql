-- Tenant ownership, the contract half (S2-17b round 4b; plan section 7, hazards
-- H10 and H11). Generated, then the backfill and the gate written in front of
-- it. Applied one release after 0006, once the release that writes every row's
-- park group (round 4a) is live everywhere: that release passes on both shapes
-- of these tables, the one before this migration and the one after it.
--
--   1. The three tables are locked against writes (reads go on) for the length
--      of the migration, so no row can arrive between the backfill and the
--      NOT NULL below. A write already in flight is waited for, then placed.
--   2. 0006's backfill runs again, statement for statement, over whatever the
--      previous release wrote with no park group during the hand-over. It
--      places only rows still null: a row already placed is never moved.
--   3. The gate: if any row of the three still has no park group, the
--      migration stops here, loudly, and changes nothing. Nothing in the
--      backfill can leave one, so the gate stands for whatever no one foresaw.
--   4. tenant_id becomes NOT NULL on settings, activity_log and attention_items.
--   5. The baseline's settings_key_unique (one row per key across every park
--      group) is dropped. The (tenant_id, key) unique 0006 added carries
--      uniqueness alone, so every park group can save its own row for a key.
--      It goes LAST: while the backfill runs it still guarantees that a
--      hand-over row placed in the default park group cannot meet a second row
--      for its key there.
--
-- Read-back before and after: `npm run tenant:readback` in the app
-- (script/tenant-ownership-readback.mjs). Grants are not made here (0004's
-- reason). The platform reads none of these tables.
LOCK TABLE "settings", "activity_log", "attention_items" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

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

-- The gate: nothing is made NOT NULL while a row is still without its park group.
DO $$
DECLARE
  unplaced_settings bigint;
  unplaced_activity bigint;
  unplaced_attention bigint;
BEGIN
  SELECT count(*) INTO unplaced_settings FROM "settings" WHERE "tenant_id" IS NULL;
  SELECT count(*) INTO unplaced_activity FROM "activity_log" WHERE "tenant_id" IS NULL;
  SELECT count(*) INTO unplaced_attention FROM "attention_items" WHERE "tenant_id" IS NULL;
  IF unplaced_settings + unplaced_activity + unplaced_attention > 0 THEN
    RAISE EXCEPTION 'tenant ownership (0007): % settings, % activity_log and % attention_items rows still have no park group after the backfill ran again, so tenant_id is not made NOT NULL and nothing was changed. Run npm run tenant:readback in the OTO App to see them, give each its park group, then deploy again.',
      unplaced_settings, unplaced_activity, unplaced_attention;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "activity_log" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attention_items" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" DROP CONSTRAINT "settings_key_unique";
