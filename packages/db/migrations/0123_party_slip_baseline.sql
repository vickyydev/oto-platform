-- SCRUM-906 (the whole kitchen plan reaches the till; a release is not a
-- change) - expand-only: one new table. Nothing existing is rewritten or
-- dropped, and a release that does not know it never reads it.
--
--   pos.party_slip_baseline                 new table
--       one row per party, day and station: the slip composer (and the shape
--       the OTO App published the plan in) the station's slip is read under,
--       which slip it was last given, and - when a look took the plan as
--       composed now without printing it - what the station is taken to
--       hold. Written beside every party slip and every VOID/UPDATED slip
--       this release puts on paper, and by the first look at a party whose
--       slips printed before it, so a release that makes more of a plan
--       reach the kitchen never sends a party a correction it never had.
--       Empty until a party's slips print.
--
-- TO REVERSE (nothing else depends on the table): DROP TABLE
-- pos.party_slip_baseline. A release before SCRUM-906 never reads it.
CREATE TABLE "pos"."party_slip_baseline" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"party_date" date NOT NULL,
	"station" text NOT NULL,
	"composer" text NOT NULL,
	"source" text NOT NULL,
	"rebased" boolean DEFAULT false NOT NULL,
	"fingerprint" text NOT NULL,
	"held" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_slip_baseline_station_check" CHECK ("pos"."party_slip_baseline"."station" in ('kitchen','bar'))
);
--> statement-breakpoint
ALTER TABLE "pos"."party_slip_baseline" ADD CONSTRAINT "party_slip_baseline_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_slip_baseline" ADD CONSTRAINT "party_slip_baseline_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "party_slip_baseline_station_unique" ON "pos"."party_slip_baseline" USING btree ("event_id","party_date","station");--> statement-breakpoint
CREATE INDEX "party_slip_baseline_operator_idx" ON "pos"."party_slip_baseline" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "party_slip_baseline_branch_idx" ON "pos"."party_slip_baseline" USING btree ("branch_id");