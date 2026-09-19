-- S2-01b — named schemas, the sprint's table names, and the constraint
-- corrections that go with them.
--
-- Hand-written, and deliberately so: `drizzle-kit generate` answers a move
-- between schemas with DROP + CREATE, which would throw away the rows. Every
-- statement below preserves data. This is the ONE migration allowed to break
-- the previous release, because it lands before the first deploy; from 0006
-- every migration is expand/contract.
--
-- Verified by `pnpm --filter @oto/db exec tsx scripts/verify-schema.ts`, which
-- introspects a migrated database and compares it with 0005_snapshot.json.

CREATE SCHEMA IF NOT EXISTS "core";--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "crm";--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "pos";--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "promo";--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "booth";--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "analytics";--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "edge";--> statement-breakpoint

-- 1. Move every table out of public. Indexes and constraints follow it.
ALTER TABLE "public"."operator" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."branch" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."department" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."employee" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."account" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."role" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."role_permission" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."role_assignment" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."session" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."verification_code" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."station" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."audit_log" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."idempotency_key" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."file_object" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."auth_throttle" SET SCHEMA "core";--> statement-breakpoint
ALTER TABLE "public"."tier" SET SCHEMA "crm";--> statement-breakpoint
ALTER TABLE "public"."member" SET SCHEMA "crm";--> statement-breakpoint
ALTER TABLE "public"."member_tier_verification" SET SCHEMA "crm";--> statement-breakpoint
ALTER TABLE "public"."child" SET SCHEMA "crm";--> statement-breakpoint
ALTER TABLE "public"."visit" SET SCHEMA "crm";--> statement-breakpoint
ALTER TABLE "public"."visit_child" SET SCHEMA "crm";--> statement-breakpoint
ALTER TABLE "public"."ticket_package" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."branch_holiday" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."branch_tax_config" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."product_category" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."product" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."tax_override" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."booking" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."attendee" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."transaction" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."transaction_line" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."payment" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."wallet" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."wallet_entry" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."wristband" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."item" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."stock_location" SET SCHEMA "pos";--> statement-breakpoint
ALTER TABLE "public"."stock_level" SET SCHEMA "pos";--> statement-breakpoint

-- 2. The sprint's names. Renaming now, while these tables are empty, is the
--    only cheap moment: `transaction` and `payment` are also SQL keywords in
--    everyday conversation, and `item` says nothing at all.
ALTER TABLE "pos"."transaction" RENAME TO "sale";--> statement-breakpoint
ALTER TABLE "pos"."transaction_line" RENAME TO "sale_line";--> statement-breakpoint
ALTER TABLE "pos"."sale_line" RENAME COLUMN "transaction_id" TO "sale_id";--> statement-breakpoint
ALTER TABLE "pos"."payment" RENAME TO "payment_attempt";--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" RENAME COLUMN "transaction_id" TO "sale_id";--> statement-breakpoint
ALTER TABLE "pos"."wristband" RENAME TO "band";--> statement-breakpoint
ALTER TABLE "pos"."item" RENAME TO "stock_item";--> statement-breakpoint
ALTER TABLE "pos"."stock_level" RENAME COLUMN "item_id" TO "stock_item_id";--> statement-breakpoint

-- Constraints and indexes keep their old names through a table rename.
ALTER TABLE "pos"."sale" RENAME CONSTRAINT "transaction_operator_id_operator_id_fk" TO "sale_operator_id_operator_id_fk";--> statement-breakpoint
ALTER TABLE "pos"."sale" RENAME CONSTRAINT "transaction_branch_id_branch_id_fk" TO "sale_branch_id_branch_id_fk";--> statement-breakpoint
ALTER TABLE "pos"."sale" RENAME CONSTRAINT "transaction_member_id_member_id_fk" TO "sale_member_id_member_id_fk";--> statement-breakpoint
ALTER TABLE "pos"."sale" RENAME CONSTRAINT "transaction_created_by_account_id_account_id_fk" TO "sale_created_by_account_id_account_id_fk";--> statement-breakpoint
ALTER TABLE "pos"."payment_attempt" RENAME CONSTRAINT "payment_transaction_id_transaction_id_fk" TO "payment_attempt_sale_id_sale_id_fk";--> statement-breakpoint
ALTER TABLE "pos"."band" RENAME CONSTRAINT "wristband_operator_id_operator_id_fk" TO "band_operator_id_operator_id_fk";--> statement-breakpoint
ALTER TABLE "pos"."band" RENAME CONSTRAINT "wristband_branch_id_branch_id_fk" TO "band_branch_id_branch_id_fk";--> statement-breakpoint
ALTER TABLE "pos"."stock_item" RENAME CONSTRAINT "item_operator_id_operator_id_fk" TO "stock_item_operator_id_operator_id_fk";--> statement-breakpoint
ALTER INDEX "pos"."transaction_branch_idx" RENAME TO "sale_branch_idx";--> statement-breakpoint
ALTER INDEX "pos"."transaction_member_idx" RENAME TO "sale_member_idx";--> statement-breakpoint
ALTER INDEX "pos"."transaction_operator_idx" RENAME TO "sale_operator_idx";--> statement-breakpoint
ALTER INDEX "pos"."transaction_account_idx" RENAME TO "sale_account_idx";--> statement-breakpoint
ALTER INDEX "pos"."transaction_line_tx_idx" RENAME TO "sale_line_sale_idx";--> statement-breakpoint
ALTER INDEX "pos"."payment_tx_idx" RENAME TO "payment_attempt_sale_idx";--> statement-breakpoint
ALTER INDEX "pos"."wristband_branch_idx" RENAME TO "band_branch_idx";--> statement-breakpoint
ALTER INDEX "pos"."wristband_code_idx" RENAME TO "band_code_idx";--> statement-breakpoint
ALTER INDEX "pos"."wristband_operator_idx" RENAME TO "band_operator_idx";--> statement-breakpoint
ALTER INDEX "pos"."item_operator_idx" RENAME TO "stock_item_operator_idx";--> statement-breakpoint

-- 3. Enumerations become text + CHECK. Adding a value to a pg enum takes a
--    DDL lock and cannot happen in a transaction that also reads it; a CHECK
--    is replaced in one statement. The database still enforces the set.
ALTER TABLE "core"."account" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "core"."account" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;--> statement-breakpoint
ALTER TABLE "core"."account" ALTER COLUMN "status" SET DEFAULT 'invited';--> statement-breakpoint
ALTER TABLE "core"."account" ADD CONSTRAINT "account_status_check" CHECK ("status" IN ('invited','active','inactive'));--> statement-breakpoint
ALTER TABLE "core"."role_assignment" ALTER COLUMN "scope_type" SET DATA TYPE text USING "scope_type"::text;--> statement-breakpoint
ALTER TABLE "core"."role_assignment" ADD CONSTRAINT "role_assignment_scope_check" CHECK ("scope_type" IN ('operator','branch','department','record'));--> statement-breakpoint
ALTER TABLE "core"."verification_code" ALTER COLUMN "purpose" SET DATA TYPE text USING "purpose"::text;--> statement-breakpoint
ALTER TABLE "core"."verification_code" ADD CONSTRAINT "verification_code_purpose_check" CHECK ("purpose" IN ('setup','password_reset'));--> statement-breakpoint
ALTER TABLE "crm"."member" ALTER COLUMN "preferred_channel" SET DATA TYPE text USING "preferred_channel"::text;--> statement-breakpoint
ALTER TABLE "crm"."member" ADD CONSTRAINT "member_preferred_channel_check" CHECK ("preferred_channel" IS NULL OR "preferred_channel" IN ('whatsapp','telegram','line','instagram'));--> statement-breakpoint
ALTER TABLE "crm"."member" ALTER COLUMN "created_via" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "crm"."member" ALTER COLUMN "created_via" SET DATA TYPE text USING "created_via"::text;--> statement-breakpoint
ALTER TABLE "crm"."member" ALTER COLUMN "created_via" SET DEFAULT 'pos';--> statement-breakpoint
ALTER TABLE "crm"."member" ADD CONSTRAINT "member_created_via_check" CHECK ("created_via" IN ('pos','booking','import'));--> statement-breakpoint
ALTER TABLE "crm"."visit" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "crm"."visit" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;--> statement-breakpoint
ALTER TABLE "crm"."visit" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "crm"."visit" ADD CONSTRAINT "visit_status_check" CHECK ("status" IN ('draft','active','closed'));--> statement-breakpoint
ALTER TABLE "core"."station" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "core"."station" ALTER COLUMN "kind" SET DATA TYPE text USING "kind"::text;--> statement-breakpoint
ALTER TABLE "core"."station" ALTER COLUMN "kind" SET DEFAULT 'till';--> statement-breakpoint
ALTER TABLE "core"."station" ADD CONSTRAINT "station_kind_check" CHECK ("kind" IN ('till','kiosk','gate','display','booth'));--> statement-breakpoint
DROP TYPE "public"."account_status";--> statement-breakpoint
DROP TYPE "public"."scope_type";--> statement-breakpoint
DROP TYPE "public"."verification_purpose";--> statement-breakpoint
DROP TYPE "public"."contact_channel";--> statement-breakpoint
DROP TYPE "public"."member_created_via";--> statement-breakpoint
DROP TYPE "public"."visit_status";--> statement-breakpoint
DROP TYPE "public"."station_kind";--> statement-breakpoint

-- 4. A station belongs to an operator, not only to a branch: every
--    tenant-owned table carries its operator so a tenancy filter never has to
--    join through the branch to find out whose row this is.
ALTER TABLE "core"."station" ADD COLUMN "operator_id" uuid;--> statement-breakpoint
UPDATE "core"."station" s SET "operator_id" = b."operator_id" FROM "core"."branch" b WHERE b."id" = s."branch_id";--> statement-breakpoint
ALTER TABLE "core"."station" ALTER COLUMN "operator_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."station" ADD CONSTRAINT "station_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id");--> statement-breakpoint
CREATE INDEX "station_operator_idx" ON "core"."station" USING btree ("operator_id");--> statement-breakpoint

-- 5. Roles: a seeded bundle the platform owns is marked, and uniqueness
--    becomes per operator so two operators may each have a "reception".
ALTER TABLE "core"."role" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "core"."role" SET "is_system" = true WHERE "operator_id" IS NULL;--> statement-breakpoint
DROP INDEX "core"."role_name_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "role_name_unique" ON "core"."role" USING btree ("operator_id","name");--> statement-breakpoint
-- operator_id is null on a system role and Postgres treats nulls as distinct,
-- so the index above would allow two system roles of the same name.
CREATE UNIQUE INDEX "role_system_name_unique" ON "core"."role" USING btree ("name") WHERE "operator_id" IS NULL;--> statement-breakpoint

-- 6. Withdrawn, not deleted: a role assignment and a holiday calendar both
--    have to explain the past after they stop applying.
ALTER TABLE "core"."role_assignment" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pos"."branch_holiday" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint

-- 7. No CASCADE on a ledger or on a child's record. Deleting a member must
--    not silently take a child's allergies with it, and a wallet ledger is
--    never deleted out from under itself — these should fail loudly instead.
ALTER TABLE "crm"."child" DROP CONSTRAINT "child_member_id_member_id_fk";--> statement-breakpoint
ALTER TABLE "crm"."child" ADD CONSTRAINT "child_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "crm"."member"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "crm"."member_tier_verification" DROP CONSTRAINT "member_tier_verification_member_id_member_id_fk";--> statement-breakpoint
ALTER TABLE "crm"."member_tier_verification" ADD CONSTRAINT "member_tier_verification_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "crm"."member"("id");--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" DROP CONSTRAINT "wallet_entry_wallet_id_wallet_id_fk";--> statement-breakpoint
ALTER TABLE "pos"."wallet_entry" ADD CONSTRAINT "wallet_entry_wallet_id_wallet_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "pos"."wallet"("id");--> statement-breakpoint
ALTER TABLE "pos"."sale_line" DROP CONSTRAINT "transaction_line_transaction_id_transaction_id_fk";--> statement-breakpoint
ALTER TABLE "pos"."sale_line" ADD CONSTRAINT "sale_line_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id");--> statement-breakpoint
ALTER TABLE "pos"."stock_level" DROP CONSTRAINT "stock_level_item_id_item_id_fk";--> statement-breakpoint
ALTER TABLE "pos"."stock_level" ADD CONSTRAINT "stock_level_stock_item_id_stock_item_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "pos"."stock_item"("id");--> statement-breakpoint
ALTER INDEX "pos"."stock_level_item_idx" RENAME TO "stock_level_item_idx_old";--> statement-breakpoint
DROP INDEX "pos"."stock_level_item_idx_old";--> statement-breakpoint
CREATE INDEX "stock_level_item_idx" ON "pos"."stock_level" USING btree ("stock_item_id");--> statement-breakpoint

-- 8. The denials list reads the audit log by action and date (S2-01a).
CREATE INDEX "audit_action_idx" ON "core"."audit_log" USING btree ("action","created_at");
