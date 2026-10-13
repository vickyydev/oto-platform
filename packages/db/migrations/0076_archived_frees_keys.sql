-- SCRUM-273 — an archived record no longer holds its business key.
--
-- Three Sprint 1 unique indexes were unconditional, so an archived row kept
-- its key for ever: archive a mistyped member and that phone could never be
-- registered again in the operator; archive a tier or a ticket package and its
-- code or name was gone. Newer tables already ignore archived rows
-- (station_name_unique, booth_layout_name_unique); these three now match:
--
--   crm.member         member_phone_unique         (operator_id, phone)
--   crm.tier           tier_code_unique            (operator_id, code)
--   pos.ticket_package ticket_package_name_unique  (branch_id, name)
--
-- Each is dropped and recreated with WHERE archived_at IS NULL. Every row that
-- satisfied the full index satisfies the partial one, so the CREATE cannot
-- fail on existing data. drizzle-kit runs the migration in one transaction,
-- so no moment exists with neither index in place.
--
-- Any ON CONFLICT on these keys must now name the same predicate to infer the
-- index; the seed's upserts were changed with this migration.
--
-- TO REVERSE (only while no two rows share a key, archived ones included —
-- once an archived key has been reused, the full index cannot be rebuilt):
--   DROP INDEX "crm"."member_phone_unique";
--   CREATE UNIQUE INDEX "member_phone_unique" ON "crm"."member" USING btree ("operator_id","phone");
--   DROP INDEX "crm"."tier_code_unique";
--   CREATE UNIQUE INDEX "tier_code_unique" ON "crm"."tier" USING btree ("operator_id","code");
--   DROP INDEX "pos"."ticket_package_name_unique";
--   CREATE UNIQUE INDEX "ticket_package_name_unique" ON "pos"."ticket_package" USING btree ("branch_id","name");
DROP INDEX "crm"."member_phone_unique";--> statement-breakpoint
DROP INDEX "crm"."tier_code_unique";--> statement-breakpoint
DROP INDEX "pos"."ticket_package_name_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "member_phone_unique" ON "crm"."member" USING btree ("operator_id","phone") WHERE archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "tier_code_unique" ON "crm"."tier" USING btree ("operator_id","code") WHERE archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_package_name_unique" ON "pos"."ticket_package" USING btree ("branch_id","name") WHERE archived_at is null;
