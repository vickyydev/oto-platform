-- S2-21 (SCRUM-218), staff benefits round 1 — the plan is
-- docs/progress/plans/benefits/PLAN.md §7 and §8 round 1. Forward-only.
--
-- 1. WHERE A PERSON'S RECORD IS KEPT. `core.employee` gains `source`
--    (`platform`, or `otoapp` for a row the OTO App staff-directory copy
--    writes, S2-17b) and `external_id`, the OTO App's id for that person,
--    unique per operator among live rows. Every existing row is `platform`.
--
-- 2. THE ROLE TEMPLATES. `promo.benefit_role_template`: one row per VERSION
--    of the Owner, Manager and Staff templates, each in force on the trading
--    days `[effective_from, effective_to)`. A change closes the row in force
--    on its date and opens a new one; no other column of a row is ever
--    updated, so the table is the history.
--
-- 3. EACH PERSON'S BENEFIT. `promo.benefit_profile`: one row per version of
--    which template a person takes (null = no benefit) and their override,
--    which while set is their whole profile. Versioned the same way.
--
-- At most one open-ended row per template and per person is held here; the
-- full no-overlap rule is held by the service under an advisory lock.
-- Nothing is written into the new tables: the seed gives the demo tenant its
-- templates and profiles, and a park with none sees empty templates.
--
CREATE TABLE "promo"."benefit_profile" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"benefit_role" text,
	"override" jsonb,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "benefit_profile_role_check" CHECK ("promo"."benefit_profile"."benefit_role" is null or "promo"."benefit_profile"."benefit_role" in ('owner','manager','staff')),
	CONSTRAINT "benefit_profile_range_check" CHECK ("promo"."benefit_profile"."effective_to" is null or "promo"."benefit_profile"."effective_to" >= "promo"."benefit_profile"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "promo"."benefit_role_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"profile" jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benefit_role_template_role_check" CHECK ("promo"."benefit_role_template"."role" in ('owner','manager','staff')),
	CONSTRAINT "benefit_role_template_range_check" CHECK ("promo"."benefit_role_template"."effective_to" is null or "promo"."benefit_role_template"."effective_to" >= "promo"."benefit_role_template"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "core"."employee" ADD COLUMN "source" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."employee" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "promo"."benefit_profile" ADD CONSTRAINT "benefit_profile_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_profile" ADD CONSTRAINT "benefit_profile_employee_id_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "core"."employee"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_profile" ADD CONSTRAINT "benefit_profile_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_role_template" ADD CONSTRAINT "benefit_role_template_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_role_template" ADD CONSTRAINT "benefit_role_template_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "benefit_profile_operator_idx" ON "promo"."benefit_profile" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "benefit_profile_employee_idx" ON "promo"."benefit_profile" USING btree ("employee_id","effective_from");--> statement-breakpoint
CREATE INDEX "benefit_profile_created_by_idx" ON "promo"."benefit_profile" USING btree ("created_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "benefit_profile_open_unique" ON "promo"."benefit_profile" USING btree ("employee_id") WHERE effective_to is null and archived_at is null;--> statement-breakpoint
CREATE INDEX "benefit_role_template_operator_idx" ON "promo"."benefit_role_template" USING btree ("operator_id","role","effective_from");--> statement-breakpoint
CREATE INDEX "benefit_role_template_created_by_idx" ON "promo"."benefit_role_template" USING btree ("created_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "benefit_role_template_open_unique" ON "promo"."benefit_role_template" USING btree ("operator_id","role") WHERE effective_to is null;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_external_id_unique" ON "core"."employee" USING btree ("operator_id","external_id") WHERE external_id is not null and archived_at is null;--> statement-breakpoint
ALTER TABLE "core"."employee" ADD CONSTRAINT "employee_source_check" CHECK ("core"."employee"."source" in ('platform','otoapp'));