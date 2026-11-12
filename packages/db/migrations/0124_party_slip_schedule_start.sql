-- SCRUM-906 (the whole kitchen plan reaches the till; a release does not
-- catch up) - expand-only: one new table. Nothing existing is rewritten or
-- dropped, and a release that does not know it never reads it.
--
--   pos.party_slip_schedule_start           new table
--       one row per park and kind of party: the moment the slip time's job
--       first ticked at the park printing that kind of party. Today one
--       kind, "no_package": a party with a kitchen plan and no package
--       (the owner's decision 8), which no release before SCRUM-906
--       printed, so none has a scheduled run. Without this row the first
--       tick after the release would print at once every such party of the
--       day whose slip time had passed, parties already over among them.
--       The job writes the row itself at its first tick at the park, and
--       does not print a party with no package whose slip time passed
--       before it ("Print party slips now" still does). Empty until the
--       job first runs.
--
-- TO REVERSE (nothing else depends on the table): DROP TABLE
-- pos.party_slip_schedule_start. A release before SCRUM-906 never reads it.
CREATE TABLE "pos"."party_slip_schedule_start" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_slip_schedule_start_kind_check" CHECK ("pos"."party_slip_schedule_start"."kind" in ('no_package'))
);
--> statement-breakpoint
ALTER TABLE "pos"."party_slip_schedule_start" ADD CONSTRAINT "party_slip_schedule_start_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_slip_schedule_start" ADD CONSTRAINT "party_slip_schedule_start_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "party_slip_schedule_start_kind_unique" ON "pos"."party_slip_schedule_start" USING btree ("branch_id","kind");--> statement-breakpoint
CREATE INDEX "party_slip_schedule_start_operator_idx" ON "pos"."party_slip_schedule_start" USING btree ("operator_id");