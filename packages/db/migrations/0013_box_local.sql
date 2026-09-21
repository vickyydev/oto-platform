-- S2-07a — the five tables a box keeps for ITSELF.
--
-- `SqlBoxStore` in `@oto/box-agent` has been reading and writing these since
-- the store slice landed; what it has not had is anywhere to read and write
-- them on Postgres. A Raspberry Pi creates its own at boot from the SQLite half
-- of the same DDL, so nothing showed there. Staging's virtual box runs inside
-- the api and its store IS this `edge` schema, and there every booth counter,
-- staff session and throttle read threw `BoxStoreFeatureMissingError` while the
-- durable print queue fell back to memory — a queue that loses a voucher
-- somebody is waiting for the moment the process restarts.
--
-- The release now deployed probes `information_schema` at boot for exactly
-- these five names and has been finding none of them. After this migration it
-- finds all five, turns its durable print queue on, and stops throwing on the
-- booth's runtime reads. That is the whole of the change in behaviour, and no
-- deploy is needed for it to take effect.
--
-- **The shape is transcribed, not designed.** `EDGE_BOX_LOCAL_TABLES_SQL` in
-- `packages/box-agent/src/store-sql.ts` is the Postgres DDL the store's own
-- queries were written against, and the SQLite tables next door in
-- `store-sqlite.ts` are the same columns in SQLite's types. Every column, index
-- and check below is that DDL; none of it was changed to write this. It is
-- expressed in Drizzle (`packages/db/src/schema/edge.ts`) rather than executed
-- from that string because tables the api created at boot would be a shape
-- `scripts/verify-schema.ts` cannot check and `pnpm db:generate` would offer to
-- drop.
--
-- **Create only.** Five new tables in `edge`. Nothing is renamed, retyped or
-- dropped, and every index here builds over a table this migration has just
-- created, so none of them can refuse to build on a live database.
--
-- Two spellings differ from that string, and neither is a change of shape: the
-- primary keys and foreign keys carry Drizzle's generated names rather than
-- Postgres's defaults (`box_counter_box_id_scope_counter_key_business_date_pk`,
-- not `box_counter_pkey`). Nothing in the store reads either name; its upserts
-- name their conflict target by column list, which is what makes that safe.
--
-- `box_print_job` is the one table here that holds anything about a guest. It
-- stores the renderer's INPUT, which carries a member's name and, on a kids'
-- band, an allergy line — and it has to, because the point of the table is that
-- a voucher waiting on paper still prints after the power has been off.
-- `edge.print_job` beside it deliberately stores nothing rendered. What limits
-- the exposure here is lifetime rather than redaction: the store DELETEs the
-- row once the paper is out of the machine instead of keeping it as `printed`.
--
-- No `created_at` on any of the five, matching the SQLite tables they mirror.
-- `box_print_job` carries `queued_at` and `box_throttle` carries
-- `first_failure_at`; the other three are last-writer rows whose whole content
-- is their current value. A column nothing writes and nothing reads, differing
-- from the Pi's table, would buy only the convention.

CREATE TABLE "edge"."box_counter" (
	"box_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"counter_key" text NOT NULL,
	"business_date" date NOT NULL,
	"counter_value" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_counter_box_id_scope_counter_key_business_date_pk" PRIMARY KEY("box_id","scope","counter_key","business_date")
);
--> statement-breakpoint
CREATE TABLE "edge"."box_print_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"box_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"role" text,
	"station_id" uuid,
	"device_id" uuid,
	"copies" smallint DEFAULT 1 NOT NULL,
	"job" jsonb NOT NULL,
	"finish" jsonb,
	"template_id" uuid,
	"template_version" integer,
	"action_id" text,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_print_job_state_check" CHECK ("edge"."box_print_job"."state" in ('queued','sending','interrupted')),
	CONSTRAINT "box_print_job_copies_check" CHECK ("edge"."box_print_job"."copies" > 0),
	CONSTRAINT "box_print_job_attempts_check" CHECK ("edge"."box_print_job"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "edge"."box_runtime" (
	"box_id" uuid NOT NULL,
	"runtime_key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_runtime_box_id_runtime_key_pk" PRIMARY KEY("box_id","runtime_key")
);
--> statement-breakpoint
CREATE TABLE "edge"."box_staff_session" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"box_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"credential_kind" text DEFAULT 'pin' NOT NULL,
	"staff_code" text,
	"signed_in_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edge"."box_throttle" (
	"box_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"subject" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"first_failure_at" timestamp with time zone NOT NULL,
	"last_failure_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_throttle_box_id_scope_subject_pk" PRIMARY KEY("box_id","scope","subject"),
	CONSTRAINT "box_throttle_failures_check" CHECK ("edge"."box_throttle"."failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "edge"."box_counter" ADD CONSTRAINT "box_counter_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_print_job" ADD CONSTRAINT "box_print_job_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_print_job" ADD CONSTRAINT "box_print_job_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_print_job" ADD CONSTRAINT "box_print_job_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "core"."device"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_runtime" ADD CONSTRAINT "box_runtime_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_staff_session" ADD CONSTRAINT "box_staff_session_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_staff_session" ADD CONSTRAINT "box_staff_session_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_staff_session" ADD CONSTRAINT "box_staff_session_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_throttle" ADD CONSTRAINT "box_throttle_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "box_print_job_pending_idx" ON "edge"."box_print_job" USING btree ("box_id","queued_at");--> statement-breakpoint
CREATE INDEX "box_print_job_station_idx" ON "edge"."box_print_job" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "box_print_job_device_idx" ON "edge"."box_print_job" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "box_staff_session_box_idx" ON "edge"."box_staff_session" USING btree ("box_id");--> statement-breakpoint
CREATE INDEX "box_staff_session_account_idx" ON "edge"."box_staff_session" USING btree ("account_id");