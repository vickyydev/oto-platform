-- SCRUM-1032: the people on an activity of the BEO's Entertainment & Program
-- (shared/beoActivityPeople.ts). An activity named at most one person by
-- beo_entertainment_items.assignment_target_id; now it also owns targets of its
-- own, in their order, so it names several: a member of staff from the staff
-- list (the new kind EMPLOYEE), a login, a department, or a role with its
-- number ("2 animators"). Expand only: a new value of the target kind, four
-- columns (three nullable, the order with a default), their keys and index,
-- and a check every existing row passes (no number stored). No stored row is
-- changed; no view the till reads names any of it. The new kind is not used in
-- this migration (a value added to a type is usable once its transaction ends).
ALTER TYPE "beo_assignment_target_type" ADD VALUE 'EMPLOYEE';--> statement-breakpoint
ALTER TABLE "beo_assignment_targets" ADD COLUMN "employee_id" varchar;--> statement-breakpoint
ALTER TABLE "beo_assignment_targets" ADD COLUMN "head_count" integer;--> statement-breakpoint
ALTER TABLE "beo_assignment_targets" ADD COLUMN "entertainment_item_id" uuid;--> statement-breakpoint
ALTER TABLE "beo_assignment_targets" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "beo_assignment_targets" ADD CONSTRAINT "beo_assignment_targets_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beo_assignment_targets" ADD CONSTRAINT "beo_assignment_targets_entertainment_item_id_beo_entertainment_items_id_fk" FOREIGN KEY ("entertainment_item_id") REFERENCES "beo_entertainment_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_beo_assignment_targets_entertainment_item" ON "beo_assignment_targets" USING btree ("entertainment_item_id");--> statement-breakpoint
ALTER TABLE "beo_assignment_targets" ADD CONSTRAINT "beo_assignment_targets_head_count_check" CHECK ("beo_assignment_targets"."head_count" IS NULL OR ("beo_assignment_targets"."head_count" >= 1 AND "beo_assignment_targets"."head_count" <= 99));
