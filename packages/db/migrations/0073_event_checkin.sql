-- S2-20 E3 (SCRUM-217) — check-in, check-out and reprint at events. The plan is
-- docs/progress/plans/events-kiosk/PLAN.md §8 ("This ticket": pos.event_checkin
-- and the band change) and the E3 row of §9. PROVISIONAL NUMBER: built on 0070;
-- the lander renumbers it and regenerates the snapshot at landing.
--
-- 1. `pos.event_checkin` — one child's day at an event, as the POS keeps it:
--    the MIRROR of a check-in the OTO App stays master of (Q1). Its id is the
--    check-in id the till or the box minted and the directory call carries, so
--    a retry is a replay in the app; `sync_state` says whether the app has it
--    yet (the E2 write-back and Failures/Retry pattern). One check-in per child
--    per day: `event_checkin_attendee_day_unique` (H4), among the check-ins the
--    app has not taken back — `undone_at` is set on one the app undid (its own
--    "Undo check-in") when the child is next checked in, so the till can check
--    them in again. The child's name, the allergy and diet lines, the parent
--    and the event's title and times are what the bands printed, frozen.
--
-- 2. `pos.band` gains event bands: `sale_id` becomes nullable, an
--    `event_checkin_id` column names the check-in that issued an event band,
--    and `band_owner_check` requires exactly one of the two. Every band that
--    exists has a sale and no check-in, so the check holds on every row.
--
-- Expand-only: one new table, one column added, one NOT NULL relaxed.
--
CREATE TABLE "pos"."event_checkin" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"otoapp_event_id" uuid NOT NULL,
	"attendee_id" uuid NOT NULL,
	"link_id" uuid,
	"event_type" text NOT NULL,
	"attendance_date" date NOT NULL,
	"child_name" text NOT NULL,
	"parent_name" text,
	"parent_attending" boolean DEFAULT false NOT NULL,
	"allergy" text,
	"dietary" text,
	"event_title" text NOT NULL,
	"start_time" text,
	"end_time" text,
	"checked_in_at" timestamp with time zone NOT NULL,
	"checked_in_by_account_id" uuid,
	"checked_in_by_name" text,
	"checked_out_at" timestamp with time zone,
	"checked_out_by_account_id" uuid,
	"checked_out_by_name" text,
	"undone_at" timestamp with time zone,
	"kid_band_id" uuid,
	"parent_band_id" uuid,
	"station_id" uuid,
	"box_id" uuid,
	"origin" text DEFAULT 'till' NOT NULL,
	"source_event_id" uuid,
	"box_seq" bigint,
	"otoapp_checkin_id" uuid,
	"sync_state" text DEFAULT 'pending' NOT NULL,
	"sync_attempts" integer DEFAULT 0 NOT NULL,
	"sync_error" text,
	"last_sync_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"writeback" jsonb,
	"action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_checkin_type_check" CHECK ("pos"."event_checkin"."event_type" in ('party','camp','event')),
	CONSTRAINT "event_checkin_origin_check" CHECK ("pos"."event_checkin"."origin" in ('till','box','otoapp')),
	CONSTRAINT "event_checkin_sync_check" CHECK ("pos"."event_checkin"."sync_state" in ('synced','pending','failed')),
	CONSTRAINT "event_checkin_out_after_in_check" CHECK ("pos"."event_checkin"."checked_out_at" is null or "pos"."event_checkin"."checked_out_at" >= "pos"."event_checkin"."checked_in_at"),
	CONSTRAINT "event_checkin_synced_check" CHECK ("pos"."event_checkin"."sync_state" <> 'synced' or "pos"."event_checkin"."synced_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "pos"."band" ALTER COLUMN "sale_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."band" ADD COLUMN "event_checkin_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."event_checkin" ADD CONSTRAINT "event_checkin_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_checkin" ADD CONSTRAINT "event_checkin_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_checkin" ADD CONSTRAINT "event_checkin_link_id_event_attendee_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "pos"."event_attendee_link"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_checkin" ADD CONSTRAINT "event_checkin_checked_in_by_account_id_account_id_fk" FOREIGN KEY ("checked_in_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_checkin" ADD CONSTRAINT "event_checkin_checked_out_by_account_id_account_id_fk" FOREIGN KEY ("checked_out_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_checkin" ADD CONSTRAINT "event_checkin_kid_band_id_band_id_fk" FOREIGN KEY ("kid_band_id") REFERENCES "pos"."band"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_checkin" ADD CONSTRAINT "event_checkin_parent_band_id_band_id_fk" FOREIGN KEY ("parent_band_id") REFERENCES "pos"."band"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_checkin" ADD CONSTRAINT "event_checkin_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_checkin" ADD CONSTRAINT "event_checkin_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_checkin_attendee_day_unique" ON "pos"."event_checkin" USING btree ("otoapp_event_id","attendee_id","attendance_date") WHERE undone_at is null;--> statement-breakpoint
CREATE INDEX "event_checkin_operator_idx" ON "pos"."event_checkin" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "event_checkin_branch_day_idx" ON "pos"."event_checkin" USING btree ("branch_id","attendance_date");--> statement-breakpoint
CREATE INDEX "event_checkin_link_idx" ON "pos"."event_checkin" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "event_checkin_kid_band_idx" ON "pos"."event_checkin" USING btree ("kid_band_id");--> statement-breakpoint
CREATE INDEX "event_checkin_parent_band_idx" ON "pos"."event_checkin" USING btree ("parent_band_id");--> statement-breakpoint
CREATE INDEX "event_checkin_in_by_idx" ON "pos"."event_checkin" USING btree ("checked_in_by_account_id");--> statement-breakpoint
CREATE INDEX "event_checkin_out_by_idx" ON "pos"."event_checkin" USING btree ("checked_out_by_account_id");--> statement-breakpoint
CREATE INDEX "event_checkin_station_idx" ON "pos"."event_checkin" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "event_checkin_box_idx" ON "pos"."event_checkin" USING btree ("box_id");--> statement-breakpoint
CREATE INDEX "event_checkin_source_event_idx" ON "pos"."event_checkin" USING btree ("source_event_id");--> statement-breakpoint
CREATE INDEX "event_checkin_unsynced_idx" ON "pos"."event_checkin" USING btree ("sync_state","created_at") WHERE sync_state <> 'synced';--> statement-breakpoint
ALTER TABLE "pos"."band" ADD CONSTRAINT "band_event_checkin_id_event_checkin_id_fk" FOREIGN KEY ("event_checkin_id") REFERENCES "pos"."event_checkin"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "band_event_checkin_idx" ON "pos"."band" USING btree ("event_checkin_id");--> statement-breakpoint
ALTER TABLE "pos"."band" ADD CONSTRAINT "band_owner_check" CHECK (("pos"."band"."sale_id" is null) <> ("pos"."band"."event_checkin_id" is null));