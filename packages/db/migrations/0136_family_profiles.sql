-- SCRUM-1024 (family profiles, plan step F1 / E1) - the family behind a
-- member's children: several parents or guardians for the same children.
-- Plan: docs/progress/plans/dropoff-beo-20261119/FAMILY_PROFILES_PLAN.md,
-- sections 2.2 and 3. Built as 0136 while 0135 was taken by another lane;
-- renumbered at landing if that one has not landed first.
--
-- EXPAND ONLY. Two new tables and two nullable columns; nothing existing is
-- rewritten, dropped, renamed or made NOT NULL, and no row is written here.
--   * crm.family: one family, with the tenant fence (operator_id, id) the
--     guardian rows land on (the inbox pattern). NOT crm.guardian, which is
--     a collector on one drop-off registration.
--   * crm.family_guardian: a member who is a parent or guardian of a family,
--     one live row per family and member (partial unique), who added them,
--     where and when. A composite foreign key holds it to its own
--     operator's family; the member's operator is checked by the service.
--   * crm.child.family_id (the child's family) and
--     crm.child.merged_into_child_id (set later on a duplicate only), both
--     nullable, RESTRICT and indexed. A child saved before this release keeps
--     NULL until the backfill (step F2) gives it a family.
--
-- LOCKS. crm.child is the only existing table touched: two ADD COLUMN with
-- no default (catalogue only), two foreign keys whose check reads columns
-- that are all NULL, and two plain indexes, as every index on a live table
-- here is built (0069 on pos.sale_line); drizzle runs a migration in one
-- transaction, so CONCURRENTLY is not available. The child table is the size
-- of the member register's children, and nothing else is scanned.
--
-- Nothing reads the new tables yet: every reader still uses
-- child.member_id, and the switch crm.family_profiles (FLAG_CATALOGUE) is
-- off. TO REVERSE before any reader uses them: undo/0136_family_profiles.sql.
CREATE TABLE "crm"."family" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"source" text NOT NULL,
	"created_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "family_tenant_key" UNIQUE("operator_id","id"),
	CONSTRAINT "family_source_check" CHECK ("crm"."family"."source" in ('backfill','till','sync','booking','link'))
);
--> statement-breakpoint
CREATE TABLE "crm"."family_guardian" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"source" text NOT NULL,
	"added_by_account_id" uuid,
	"branch_id" uuid,
	"station_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "family_guardian_source_check" CHECK ("crm"."family_guardian"."source" in ('backfill','till','sync','booking','link'))
);
--> statement-breakpoint
ALTER TABLE "crm"."child" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."child" ADD COLUMN "merged_into_child_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."family" ADD CONSTRAINT "family_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."family" ADD CONSTRAINT "family_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."family_guardian" ADD CONSTRAINT "family_guardian_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."family_guardian" ADD CONSTRAINT "family_guardian_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "crm"."member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."family_guardian" ADD CONSTRAINT "family_guardian_added_by_account_id_account_id_fk" FOREIGN KEY ("added_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."family_guardian" ADD CONSTRAINT "family_guardian_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."family_guardian" ADD CONSTRAINT "family_guardian_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."family_guardian" ADD CONSTRAINT "family_guardian_family_fk" FOREIGN KEY ("operator_id","family_id") REFERENCES "crm"."family"("operator_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "family_created_by_idx" ON "crm"."family" USING btree ("created_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "family_guardian_live_unique" ON "crm"."family_guardian" USING btree ("family_id","member_id") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "family_guardian_member_live_idx" ON "crm"."family_guardian" USING btree ("member_id") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "family_guardian_operator_idx" ON "crm"."family_guardian" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "family_guardian_family_idx" ON "crm"."family_guardian" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "family_guardian_member_idx" ON "crm"."family_guardian" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "family_guardian_added_by_idx" ON "crm"."family_guardian" USING btree ("added_by_account_id");--> statement-breakpoint
CREATE INDEX "family_guardian_branch_idx" ON "crm"."family_guardian" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "family_guardian_station_idx" ON "crm"."family_guardian" USING btree ("station_id");--> statement-breakpoint
ALTER TABLE "crm"."child" ADD CONSTRAINT "child_family_id_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "crm"."family"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."child" ADD CONSTRAINT "child_merged_into_child_id_child_id_fk" FOREIGN KEY ("merged_into_child_id") REFERENCES "crm"."child"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "child_family_idx" ON "crm"."child" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "child_merged_into_idx" ON "crm"."child" USING btree ("merged_into_child_id");