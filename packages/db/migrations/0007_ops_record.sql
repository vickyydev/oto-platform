CREATE TABLE "core"."alert" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"category" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"subject" text NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb,
	"operator_id" uuid,
	"branch_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"reopen_count" integer DEFAULT 0 NOT NULL,
	"last_notified_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by_account_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_severity_check" CHECK ("core"."alert"."severity" in ('info','warning','critical')),
	CONSTRAINT "alert_status_check" CHECK ("core"."alert"."status" in ('open','acknowledged','resolved'))
);
--> statement-breakpoint
CREATE TABLE "core"."alert_delivery" (
	"id" uuid PRIMARY KEY NOT NULL,
	"alert_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"event" text NOT NULL,
	"status" text NOT NULL,
	"target" text,
	"error" text,
	"duration_ms" integer,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_delivery_event_check" CHECK ("core"."alert_delivery"."event" in ('opened','reopened','resolved','test')),
	CONSTRAINT "alert_delivery_status_check" CHECK ("core"."alert_delivery"."status" in ('sent','failed'))
);
--> statement-breakpoint
CREATE TABLE "core"."ops_expectation" (
	"name" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'job' NOT NULL,
	"description" text,
	"interval_seconds" integer NOT NULL,
	"grace_seconds" integer DEFAULT 60 NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"muted_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_expectation_interval_check" CHECK ("core"."ops_expectation"."interval_seconds" > 0),
	CONSTRAINT "ops_expectation_grace_check" CHECK ("core"."ops_expectation"."grace_seconds" >= 0),
	CONSTRAINT "ops_expectation_severity_check" CHECK ("core"."ops_expectation"."severity" in ('info','warning','critical'))
);
--> statement-breakpoint
CREATE TABLE "core"."ops_last" (
	"name" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"last_run_id" uuid,
	"last_outcome" text NOT NULL,
	"last_started_at" timestamp with time zone NOT NULL,
	"last_finished_at" timestamp with time zone,
	"last_duration_ms" integer,
	"last_ok_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_last_outcome_check" CHECK ("core"."ops_last"."last_outcome" in ('running','ok','failed','skipped'))
);
--> statement-breakpoint
CREATE TABLE "core"."ops_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" jsonb,
	"error_code" text,
	"error_message" text,
	"fingerprint" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"request_id" text,
	"action_id" text,
	"operator_id" uuid,
	"branch_id" uuid,
	"station_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_run_kind_check" CHECK ("core"."ops_run"."kind" in ('http','process','job','client','adapter','device','sync','webhook','integration','console')),
	CONSTRAINT "ops_run_outcome_check" CHECK ("core"."ops_run"."outcome" in ('ok','failed','skipped'))
);
--> statement-breakpoint
ALTER TABLE "core"."alert" ADD CONSTRAINT "alert_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."alert" ADD CONSTRAINT "alert_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."alert" ADD CONSTRAINT "alert_acknowledged_by_account_id_account_id_fk" FOREIGN KEY ("acknowledged_by_account_id") REFERENCES "core"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."alert_delivery" ADD CONSTRAINT "alert_delivery_alert_id_alert_id_fk" FOREIGN KEY ("alert_id") REFERENCES "core"."alert"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ops_last" ADD CONSTRAINT "ops_last_last_run_id_ops_run_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "core"."ops_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ops_run" ADD CONSTRAINT "ops_run_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ops_run" ADD CONSTRAINT "ops_run_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."ops_run" ADD CONSTRAINT "ops_run_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_open_key_unique" ON "core"."alert" USING btree ("key") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "alert_key_resolved_idx" ON "core"."alert" USING btree ("key","resolved_at");--> statement-breakpoint
CREATE INDEX "alert_status_seen_idx" ON "core"."alert" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "alert_operator_idx" ON "core"."alert" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "alert_branch_idx" ON "core"."alert" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "alert_acknowledged_by_idx" ON "core"."alert" USING btree ("acknowledged_by_account_id");--> statement-breakpoint
CREATE INDEX "alert_delivery_alert_idx" ON "core"."alert_delivery" USING btree ("alert_id","attempted_at");--> statement-breakpoint
CREATE INDEX "alert_delivery_attempted_idx" ON "core"."alert_delivery" USING btree ("attempted_at");--> statement-breakpoint
CREATE INDEX "ops_expectation_enabled_idx" ON "core"."ops_expectation" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "ops_last_kind_idx" ON "core"."ops_last" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "ops_last_outcome_idx" ON "core"."ops_last" USING btree ("last_outcome");--> statement-breakpoint
CREATE INDEX "ops_last_run_idx" ON "core"."ops_last" USING btree ("last_run_id");--> statement-breakpoint
CREATE INDEX "ops_run_started_idx" ON "core"."ops_run" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "ops_run_kind_started_idx" ON "core"."ops_run" USING btree ("kind","started_at");--> statement-breakpoint
CREATE INDEX "ops_run_name_started_idx" ON "core"."ops_run" USING btree ("name","started_at");--> statement-breakpoint
CREATE INDEX "ops_run_outcome_started_idx" ON "core"."ops_run" USING btree ("outcome","started_at");--> statement-breakpoint
CREATE INDEX "ops_run_fingerprint_idx" ON "core"."ops_run" USING btree ("fingerprint","started_at");--> statement-breakpoint
CREATE INDEX "ops_run_request_idx" ON "core"."ops_run" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "ops_run_action_idx" ON "core"."ops_run" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "ops_run_operator_idx" ON "core"."ops_run" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "ops_run_branch_idx" ON "core"."ops_run" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "ops_run_station_idx" ON "core"."ops_run" USING btree ("station_id");