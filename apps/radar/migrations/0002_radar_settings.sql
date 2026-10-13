CREATE TABLE "branch_settings" (
	"branch" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_notes" (
	"date" text PRIMARY KEY NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pace_forecast_snapshots" (
	"date" text NOT NULL,
	"branch" text NOT NULL,
	"month" text NOT NULL,
	"forecast_revenue" numeric NOT NULL,
	"revenue_to_date" numeric DEFAULT '0' NOT NULL,
	"elapsed_days" integer DEFAULT 0 NOT NULL,
	"target" numeric,
	"model" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "branch_settings_branch_key" ON "branch_settings" USING btree ("branch","key");--> statement-breakpoint
CREATE UNIQUE INDEX "pace_forecast_snapshots_date_branch" ON "pace_forecast_snapshots" USING btree ("date","branch");--> statement-breakpoint
CREATE INDEX "idx_pace_forecast_snapshots_branch_month" ON "pace_forecast_snapshots" USING btree ("branch","month");