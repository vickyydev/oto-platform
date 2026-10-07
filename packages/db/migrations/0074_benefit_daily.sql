-- S2-21 (SCRUM-218), staff benefits round 4 — the benefits' day. The plan is
-- docs/progress/plans/benefits/PLAN.md §5, §7 and §8 round 4. Forward-only.
-- The number is provisional (0074): the lander renumbers and regenerates it
-- behind whatever lands first.
--
-- `analytics.fact_benefit_daily`: per branch, trading day, beneficiary and
-- benefit role, what the staff benefits took off the day's recorded orders,
-- split comp / free items / staff credit / standing discount, each with how
-- many applications used it, and the free-item units. Written by the daily
-- rollup and closed (`provisional` cleared) by job:benefit.period_rollover
-- at each branch's day start. Additive: one new table, nothing else touched,
-- nothing written into it here.
--
CREATE TABLE "analytics"."fact_benefit_daily" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"employee_id" uuid NOT NULL,
	"benefit_role" text NOT NULL,
	"applications" integer DEFAULT 0 NOT NULL,
	"comp_count" integer DEFAULT 0 NOT NULL,
	"comped_satang" bigint DEFAULT 0 NOT NULL,
	"free_items_count" integer DEFAULT 0 NOT NULL,
	"free_item_units" integer DEFAULT 0 NOT NULL,
	"free_items_satang" bigint DEFAULT 0 NOT NULL,
	"credit_count" integer DEFAULT 0 NOT NULL,
	"credit_satang" bigint DEFAULT 0 NOT NULL,
	"discount_count" integer DEFAULT 0 NOT NULL,
	"discount_satang" bigint DEFAULT 0 NOT NULL,
	"total_relief_satang" bigint DEFAULT 0 NOT NULL,
	"applied_satang" bigint DEFAULT 0 NOT NULL,
	"provisional" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_benefit_daily_role_check" CHECK ("analytics"."fact_benefit_daily"."benefit_role" in ('owner','manager','staff')),
	CONSTRAINT "fact_benefit_daily_counts_check" CHECK ("analytics"."fact_benefit_daily"."applications" > 0 and "analytics"."fact_benefit_daily"."comp_count" >= 0 and "analytics"."fact_benefit_daily"."free_items_count" >= 0 and "analytics"."fact_benefit_daily"."free_item_units" >= 0 and "analytics"."fact_benefit_daily"."credit_count" >= 0 and "analytics"."fact_benefit_daily"."discount_count" >= 0
          and "analytics"."fact_benefit_daily"."comp_count" <= "analytics"."fact_benefit_daily"."applications" and "analytics"."fact_benefit_daily"."free_items_count" <= "analytics"."fact_benefit_daily"."applications" and "analytics"."fact_benefit_daily"."credit_count" <= "analytics"."fact_benefit_daily"."applications" and "analytics"."fact_benefit_daily"."discount_count" <= "analytics"."fact_benefit_daily"."applications"),
	CONSTRAINT "fact_benefit_daily_amounts_check" CHECK ("analytics"."fact_benefit_daily"."comped_satang" >= 0 and "analytics"."fact_benefit_daily"."free_items_satang" >= 0 and "analytics"."fact_benefit_daily"."credit_satang" >= 0 and "analytics"."fact_benefit_daily"."discount_satang" >= 0 and "analytics"."fact_benefit_daily"."applied_satang" >= 0
          and "analytics"."fact_benefit_daily"."total_relief_satang" = "analytics"."fact_benefit_daily"."comped_satang" + "analytics"."fact_benefit_daily"."free_items_satang" + "analytics"."fact_benefit_daily"."credit_satang" + "analytics"."fact_benefit_daily"."discount_satang"
          and "analytics"."fact_benefit_daily"."applied_satang" <= "analytics"."fact_benefit_daily"."total_relief_satang")
);
--> statement-breakpoint
ALTER TABLE "analytics"."fact_benefit_daily" ADD CONSTRAINT "fact_benefit_daily_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics"."fact_benefit_daily" ADD CONSTRAINT "fact_benefit_daily_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics"."fact_benefit_daily" ADD CONSTRAINT "fact_benefit_daily_employee_id_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "core"."employee"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fact_benefit_daily_unique" ON "analytics"."fact_benefit_daily" USING btree ("branch_id","business_date","employee_id","benefit_role");--> statement-breakpoint
CREATE INDEX "fact_benefit_daily_operator_date_idx" ON "analytics"."fact_benefit_daily" USING btree ("operator_id","business_date");--> statement-breakpoint
CREATE INDEX "fact_benefit_daily_employee_idx" ON "analytics"."fact_benefit_daily" USING btree ("employee_id","business_date");--> statement-breakpoint
CREATE INDEX "fact_benefit_daily_provisional_idx" ON "analytics"."fact_benefit_daily" USING btree ("branch_id","business_date") WHERE provisional;