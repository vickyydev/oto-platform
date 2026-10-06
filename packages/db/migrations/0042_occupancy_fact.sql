-- S2-12 round 4 (plan docs/progress/plans/arrival/PLAN.md §2.6) — the
-- platform's first fact table: the live occupancy projection, sampled once
-- per quarter-hour per branch by `job:occupancy.facts`.
--
-- A new table only; no existing row is read or rewritten. Undo: drop the table.

CREATE TABLE "analytics"."fact_occupancy_15min" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"adults" integer NOT NULL,
	"kids" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_occupancy_15min_counts_check" CHECK ("analytics"."fact_occupancy_15min"."adults" >= 0 and "analytics"."fact_occupancy_15min"."kids" >= 0)
);
--> statement-breakpoint
ALTER TABLE "analytics"."fact_occupancy_15min" ADD CONSTRAINT "fact_occupancy_15min_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics"."fact_occupancy_15min" ADD CONSTRAINT "fact_occupancy_15min_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fact_occupancy_15min_branch_bucket_unique" ON "analytics"."fact_occupancy_15min" USING btree ("branch_id","bucket_start");--> statement-breakpoint
CREATE INDEX "fact_occupancy_15min_operator_idx" ON "analytics"."fact_occupancy_15min" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "fact_occupancy_15min_branch_date_idx" ON "analytics"."fact_occupancy_15min" USING btree ("branch_id","business_date");
