-- S2-20 E2 (SCRUM-217) — attendee create and pass sale. The plan is
-- docs/progress/plans/events-kiosk/PLAN.md §8 ("This ticket") and the E2 row
-- of §9. PROVISIONAL NUMBER: built on 0067; the lander renumbers it and
-- regenerates the snapshot at landing.
--
-- 1. `pos.event_attendee_link` — one row per child the POS added to an OTO App
--    event: the sale that paid for a pass (and its line), the price charged,
--    the member and saved child it was pre-filled from, the station, box and
--    account, and whether the OTO App has the child yet (`sync_state`). Its id
--    is the attendee id the till minted and the directory call carries, so a
--    retry is a replay in the app. `writeback` holds the directory body as sent:
--    what a retry replays. The unused `pos.attendee` placeholder is untouched.
--
-- 2. `pos.event_drop_in_pricing` — the branch's three walk-up prices (camp
--    day, event day, party guest), each a weekday/weekend satang pair. Only the
--    party guest price is read (Q8's default); all three are shown on the Admin
--    Events panel.
--
-- Expand-only: two new tables, nothing that exists is touched.
--
CREATE TABLE "pos"."event_attendee_link" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"otoapp_event_id" uuid NOT NULL,
	"otoapp_attendee_id" uuid,
	"event_type" text NOT NULL,
	"child_id" uuid,
	"member_id" uuid,
	"sale_id" uuid,
	"sale_line_id" uuid,
	"billing" text NOT NULL,
	"price_snapshot_satang" bigint DEFAULT 0 NOT NULL,
	"parent_attending" boolean DEFAULT false NOT NULL,
	"attendance_days" date[] DEFAULT '{}'::date[] NOT NULL,
	"source" text DEFAULT 'till' NOT NULL,
	"sync_state" text DEFAULT 'pending' NOT NULL,
	"sync_attempts" integer DEFAULT 0 NOT NULL,
	"sync_error" text,
	"last_sync_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"merged" boolean DEFAULT false NOT NULL,
	"writeback" jsonb,
	"account_id" uuid,
	"station_id" uuid,
	"box_id" uuid,
	"action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "event_attendee_link_type_check" CHECK ("pos"."event_attendee_link"."event_type" in ('party','camp','event')),
	CONSTRAINT "event_attendee_link_source_check" CHECK ("pos"."event_attendee_link"."source" in ('till','booking','kiosk','otoapp')),
	CONSTRAINT "event_attendee_link_sync_check" CHECK ("pos"."event_attendee_link"."sync_state" in ('synced','pending','failed')),
	CONSTRAINT "event_attendee_link_billing_check" CHECK ("pos"."event_attendee_link"."billing" in ('sale','party_tab','free')),
	CONSTRAINT "event_attendee_link_price_check" CHECK ("pos"."event_attendee_link"."price_snapshot_satang" >= 0),
	CONSTRAINT "event_attendee_link_sale_check" CHECK (("pos"."event_attendee_link"."billing" = 'sale') = ("pos"."event_attendee_link"."sale_id" is not null)),
	CONSTRAINT "event_attendee_link_synced_check" CHECK ("pos"."event_attendee_link"."sync_state" <> 'synced' or ("pos"."event_attendee_link"."otoapp_attendee_id" is not null and "pos"."event_attendee_link"."synced_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "pos"."event_drop_in_pricing" (
	"branch_id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"camp_day_weekday_satang" bigint DEFAULT 0 NOT NULL,
	"camp_day_weekend_satang" bigint DEFAULT 0 NOT NULL,
	"event_day_weekday_satang" bigint DEFAULT 0 NOT NULL,
	"event_day_weekend_satang" bigint DEFAULT 0 NOT NULL,
	"party_guest_weekday_satang" bigint DEFAULT 0 NOT NULL,
	"party_guest_weekend_satang" bigint DEFAULT 0 NOT NULL,
	"updated_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_drop_in_pricing_non_negative_check" CHECK ("pos"."event_drop_in_pricing"."camp_day_weekday_satang" >= 0 and "pos"."event_drop_in_pricing"."camp_day_weekend_satang" >= 0 and "pos"."event_drop_in_pricing"."event_day_weekday_satang" >= 0 and "pos"."event_drop_in_pricing"."event_day_weekend_satang" >= 0 and "pos"."event_drop_in_pricing"."party_guest_weekday_satang" >= 0 and "pos"."event_drop_in_pricing"."party_guest_weekend_satang" >= 0)
);
--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" ADD CONSTRAINT "event_attendee_link_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" ADD CONSTRAINT "event_attendee_link_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" ADD CONSTRAINT "event_attendee_link_child_id_child_id_fk" FOREIGN KEY ("child_id") REFERENCES "crm"."child"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" ADD CONSTRAINT "event_attendee_link_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "crm"."member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" ADD CONSTRAINT "event_attendee_link_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" ADD CONSTRAINT "event_attendee_link_sale_line_id_sale_line_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "pos"."sale_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" ADD CONSTRAINT "event_attendee_link_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" ADD CONSTRAINT "event_attendee_link_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" ADD CONSTRAINT "event_attendee_link_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_drop_in_pricing" ADD CONSTRAINT "event_drop_in_pricing_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_drop_in_pricing" ADD CONSTRAINT "event_drop_in_pricing_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."event_drop_in_pricing" ADD CONSTRAINT "event_drop_in_pricing_updated_by_account_id_account_id_fk" FOREIGN KEY ("updated_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_attendee_link_operator_idx" ON "pos"."event_attendee_link" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "event_attendee_link_branch_idx" ON "pos"."event_attendee_link" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "event_attendee_link_event_idx" ON "pos"."event_attendee_link" USING btree ("otoapp_event_id","otoapp_attendee_id");--> statement-breakpoint
CREATE INDEX "event_attendee_link_child_idx" ON "pos"."event_attendee_link" USING btree ("child_id");--> statement-breakpoint
CREATE INDEX "event_attendee_link_member_idx" ON "pos"."event_attendee_link" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "event_attendee_link_sale_idx" ON "pos"."event_attendee_link" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "event_attendee_link_sale_line_idx" ON "pos"."event_attendee_link" USING btree ("sale_line_id");--> statement-breakpoint
CREATE INDEX "event_attendee_link_account_idx" ON "pos"."event_attendee_link" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "event_attendee_link_station_idx" ON "pos"."event_attendee_link" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "event_attendee_link_box_idx" ON "pos"."event_attendee_link" USING btree ("box_id");--> statement-breakpoint
CREATE INDEX "event_attendee_link_unsynced_idx" ON "pos"."event_attendee_link" USING btree ("sync_state","created_at") WHERE sync_state <> 'synced';--> statement-breakpoint
CREATE INDEX "event_drop_in_pricing_operator_idx" ON "pos"."event_drop_in_pricing" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "event_drop_in_pricing_updated_by_idx" ON "pos"."event_drop_in_pricing" USING btree ("updated_by_account_id");