-- The OTO App's side of the POS events seam (events-kiosk PLAN s8, round 0).
-- Generated, then the "public" schema qualifier stripped. Expand only:
-- three new tables and four new nullable or defaulted columns; nothing
-- renamed, retyped or dropped, so the release before this one runs unchanged
-- against it.
--
--   core_events.entry_price_weekday_thb, _weekend_thb    the flat walk-up pass price
--   camp_registrations.parent_attending                  a parent band at check-in
--   camp_attendance.checkin_ref                          a directory check-in's own id
--   event_attendees, event_attendee_checkins             per-child rows for one-off
--                                                        events and parties (PLAN Q7),
--                                                        with the same checkin_ref
--   directory_clients                                    a directory caller bound to
--                                                        one tenant
CREATE TABLE "directory_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_clients_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "event_attendee_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"attendee_id" uuid NOT NULL,
	"attendance_date" date NOT NULL,
	"status" "camp_attendance_status" DEFAULT 'waiting' NOT NULL,
	"checked_in_at" timestamp with time zone,
	"checked_in_by" varchar(255),
	"checked_out_at" timestamp with time zone,
	"checked_out_by" varchar(255),
	"checkin_ref" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_event_attendee_checkins_attendee_date" UNIQUE("attendee_id","attendance_date")
);
--> statement-breakpoint
CREATE TABLE "event_attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"booking_id" uuid,
	"child_full_name" text NOT NULL,
	"date_of_birth" text,
	"age_years" integer,
	"primary_language" text,
	"allergies" text,
	"food_restrictions" text,
	"parent_name" text,
	"parent_phone" text,
	"parent_attending" boolean DEFAULT false NOT NULL,
	"notes" text,
	"source" text DEFAULT 'otoapp' NOT NULL,
	"created_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_attendees_source_check" CHECK ("event_attendees"."source" IN ('otoapp', 'pos', 'booking', 'kiosk')),
	CONSTRAINT "event_attendees_age_check" CHECK ("event_attendees"."age_years" IS NULL OR "event_attendees"."age_years" >= 0)
);
--> statement-breakpoint
ALTER TABLE "camp_attendance" ADD COLUMN "checkin_ref" uuid;--> statement-breakpoint
ALTER TABLE "camp_registrations" ADD COLUMN "parent_attending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "core_events" ADD COLUMN "entry_price_weekday_thb" integer;--> statement-breakpoint
ALTER TABLE "core_events" ADD COLUMN "entry_price_weekend_thb" integer;--> statement-breakpoint
ALTER TABLE "directory_clients" ADD CONSTRAINT "directory_clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendee_checkins" ADD CONSTRAINT "event_attendee_checkins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendee_checkins" ADD CONSTRAINT "event_attendee_checkins_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendee_checkins" ADD CONSTRAINT "event_attendee_checkins_attendee_id_event_attendees_id_fk" FOREIGN KEY ("attendee_id") REFERENCES "event_attendees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_booking_id_studio_event_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "studio_event_bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_directory_clients_tenant" ON "directory_clients" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_event_attendee_checkins_event" ON "event_attendee_checkins" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_event_attendee_checkins_tenant_date" ON "event_attendee_checkins" USING btree ("tenant_id","attendance_date");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_event_attendee_checkins_checkin_ref" ON "event_attendee_checkins" USING btree ("checkin_ref") WHERE "event_attendee_checkins"."checkin_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_event_attendees_event" ON "event_attendees" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_event_attendees_tenant" ON "event_attendees" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_event_attendees_booking" ON "event_attendees" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_camp_attendance_checkin_ref" ON "camp_attendance" USING btree ("checkin_ref") WHERE "camp_attendance"."checkin_ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "core_events" ADD CONSTRAINT "core_events_entry_price_check" CHECK (("core_events"."entry_price_weekday_thb" IS NULL OR "core_events"."entry_price_weekday_thb" >= 0) AND ("core_events"."entry_price_weekend_thb" IS NULL OR "core_events"."entry_price_weekend_thb" >= 0));