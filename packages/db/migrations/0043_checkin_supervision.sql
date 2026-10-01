-- S2-13 round 1 (plan docs/progress/plans/checkin/PLAN.md §2.1) — the child
-- check-in and supervision domain, in one migration: the per-branch config
-- (supervision policy, confirmations, drop-off pricing), the nanny roster,
-- the registration and its authorised collectors, one check-in row per child
-- per stay, the staff-accepted sibling waiver and the release. The board and
-- the release flows land in later rounds on these same tables.
--
-- New tables only; no existing row is read or rewritten, except that every
-- existing branch is given the prototype's config (store/catalogStore.ts:
-- 678-712): bands 0-4 nanny / 5-8 drop-off / 9+ none, the sibling waiver at
-- nine, the three confirmations, ฿225 flat drop-off, ฿330 an hour for a nanny,
-- ฿300 an extra hour (display only), unused prepaid food refunded.
--
-- Ids of the seeded config rows are `gen_random_uuid()` (v4) rather than the
-- application's v7, as in 0012/0018/0021: this runs in SQL, and nothing reads
-- order from a config row's id.
--
-- Undo: drop the ten tables (release, supervision_waiver, checkin, guardian,
-- registration, nanny_shift, nanny, drop_off_pricing, confirmation_item,
-- supervision_policy, in that order).

CREATE TABLE "pos"."checkin" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"child_id" uuid,
	"child_name" text NOT NULL,
	"child_age_years" integer NOT NULL,
	"date_of_birth" date,
	"allergies" text,
	"food_restrictions" text,
	"may_order_food" boolean DEFAULT false NOT NULL,
	"food_provision" jsonb,
	"service" text NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"booked_minutes" integer,
	"nanny_id" uuid,
	"checked_in_at" timestamp with time zone,
	"checked_in_by_account_id" uuid,
	"checked_out_at" timestamp with time zone,
	"checked_out_by_account_id" uuid,
	"sale_id" uuid,
	"band_id" uuid,
	"visit_id" uuid,
	"photo_file_id" uuid,
	"offline" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkin_service_check" CHECK ("pos"."checkin"."service" in ('none','drop_off','nanny')),
	CONSTRAINT "checkin_status_check" CHECK ("pos"."checkin"."status" in ('registered','in_park','out')),
	CONSTRAINT "checkin_age_check" CHECK ("pos"."checkin"."child_age_years" >= 0 and "pos"."checkin"."child_age_years" <= 17),
	CONSTRAINT "checkin_booked_minutes_check" CHECK ("pos"."checkin"."booked_minutes" is null or "pos"."checkin"."booked_minutes" > 0),
	CONSTRAINT "checkin_nanny_service_check" CHECK ("pos"."checkin"."nanny_id" is null or "pos"."checkin"."service" = 'nanny'),
	CONSTRAINT "checkin_in_park_check" CHECK ("pos"."checkin"."status" = 'registered' or "pos"."checkin"."checked_in_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "pos"."confirmation_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"code" text NOT NULL,
	"text" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pos"."drop_off_pricing" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"one_time_fee_weekday_satang" integer NOT NULL,
	"one_time_fee_weekend_satang" integer NOT NULL,
	"nanny_hourly_weekday_satang" integer NOT NULL,
	"nanny_hourly_weekend_satang" integer NOT NULL,
	"extra_hour_weekday_satang" integer NOT NULL,
	"extra_hour_weekend_satang" integer NOT NULL,
	"full_day_hours" integer DEFAULT 8 NOT NULL,
	"prepaid_food_unused" text DEFAULT 'refund' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drop_off_pricing_policy_check" CHECK ("pos"."drop_off_pricing"."prepaid_food_unused" in ('refund','forfeit')),
	CONSTRAINT "drop_off_pricing_money_check" CHECK ("pos"."drop_off_pricing"."one_time_fee_weekday_satang" >= 0 and "pos"."drop_off_pricing"."one_time_fee_weekend_satang" >= 0 and "pos"."drop_off_pricing"."nanny_hourly_weekday_satang" >= 0 and "pos"."drop_off_pricing"."nanny_hourly_weekend_satang" >= 0 and "pos"."drop_off_pricing"."extra_hour_weekday_satang" >= 0 and "pos"."drop_off_pricing"."extra_hour_weekend_satang" >= 0 and "pos"."drop_off_pricing"."full_day_hours" > 0)
);
--> statement-breakpoint
CREATE TABLE "crm"."guardian" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"registration_id" uuid NOT NULL,
	"name" text NOT NULL,
	"relationship" text,
	"phone" text,
	"photo_file_id" uuid,
	"source" text DEFAULT 'in_person' NOT NULL,
	"added_by_account_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guardian_source_check" CHECK ("crm"."guardian"."source" in ('in_person','from_chat','on_the_spot')),
	CONSTRAINT "guardian_phone_check" CHECK ("crm"."guardian"."phone" is null or "crm"."guardian"."phone" ~ '^\+[1-9][0-9]{6,14}$')
);
--> statement-breakpoint
CREATE TABLE "pos"."nanny" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"employee_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pos"."nanny_shift" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"nanny_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nanny_shift_span_check" CHECK ("pos"."nanny_shift"."ends_at" > "pos"."nanny_shift"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "crm"."registration" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"member_id" uuid,
	"guardian_name" text NOT NULL,
	"guardian_phone" text,
	"contact_channel" text DEFAULT 'whatsapp' NOT NULL,
	"consent_recorded_at" timestamp with time zone,
	"acknowledged_confirmations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'till' NOT NULL,
	"photo_file_id" uuid,
	"retention_until" timestamp with time zone,
	"station_id" uuid,
	"created_by_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_source_check" CHECK ("crm"."registration"."source" in ('till','board','booking')),
	CONSTRAINT "registration_phone_check" CHECK ("crm"."registration"."guardian_phone" is null or "crm"."registration"."guardian_phone" ~ '^\+[1-9][0-9]{6,14}$')
);
--> statement-breakpoint
CREATE TABLE "pos"."release" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"checkin_id" uuid NOT NULL,
	"guardian_id" uuid,
	"collector_name" text NOT NULL,
	"verified_by_account_id" uuid NOT NULL,
	"pickup_photo_file_id" uuid,
	"offline" boolean DEFAULT false NOT NULL,
	"photo_pending_upload" boolean DEFAULT false NOT NULL,
	"prepaid_policy" text,
	"prepaid_unused_satang" integer DEFAULT 0 NOT NULL,
	"refund_id" uuid,
	"refund_no_sale" boolean DEFAULT false NOT NULL,
	"station_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_policy_check" CHECK ("pos"."release"."prepaid_policy" is null or "pos"."release"."prepaid_policy" in ('refund','forfeit')),
	CONSTRAINT "release_unused_check" CHECK ("pos"."release"."prepaid_unused_satang" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."supervision_policy" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"bands" jsonb NOT NULL,
	"sibling_waiver_enabled" boolean DEFAULT true NOT NULL,
	"waivable_requirement" text DEFAULT 'drop_off' NOT NULL,
	"guardian_min_age" integer DEFAULT 9 NOT NULL,
	"waiver_staff_only" boolean DEFAULT true NOT NULL,
	"nanny_ratio_soft_max" integer DEFAULT 3 NOT NULL,
	"photo_retention_days" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supervision_policy_waivable_check" CHECK ("pos"."supervision_policy"."waivable_requirement" in ('none','drop_off','nanny')),
	CONSTRAINT "supervision_policy_numbers_check" CHECK ("pos"."supervision_policy"."guardian_min_age" >= 0 and "pos"."supervision_policy"."nanny_ratio_soft_max" >= 1 and "pos"."supervision_policy"."photo_retention_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pos"."supervision_waiver" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"registration_id" uuid,
	"checkin_id" uuid,
	"child_id" uuid,
	"child_name" text NOT NULL,
	"child_age_years" integer NOT NULL,
	"waived_requirement" text NOT NULL,
	"sibling_child_id" uuid,
	"sibling_name" text NOT NULL,
	"sibling_age_years" integer NOT NULL,
	"accepted_by_account_id" uuid NOT NULL,
	"station_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supervision_waiver_requirement_check" CHECK ("pos"."supervision_waiver"."waived_requirement" in ('drop_off','nanny'))
);
--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_registration_id_registration_id_fk" FOREIGN KEY ("registration_id") REFERENCES "crm"."registration"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_child_id_child_id_fk" FOREIGN KEY ("child_id") REFERENCES "crm"."child"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_nanny_id_nanny_id_fk" FOREIGN KEY ("nanny_id") REFERENCES "pos"."nanny"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_checked_in_by_account_id_account_id_fk" FOREIGN KEY ("checked_in_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_checked_out_by_account_id_account_id_fk" FOREIGN KEY ("checked_out_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_band_id_band_id_fk" FOREIGN KEY ("band_id") REFERENCES "pos"."band"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_visit_id_visit_id_fk" FOREIGN KEY ("visit_id") REFERENCES "crm"."visit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."checkin" ADD CONSTRAINT "checkin_photo_file_id_file_object_id_fk" FOREIGN KEY ("photo_file_id") REFERENCES "core"."file_object"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."confirmation_item" ADD CONSTRAINT "confirmation_item_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."confirmation_item" ADD CONSTRAINT "confirmation_item_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."drop_off_pricing" ADD CONSTRAINT "drop_off_pricing_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."drop_off_pricing" ADD CONSTRAINT "drop_off_pricing_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."guardian" ADD CONSTRAINT "guardian_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."guardian" ADD CONSTRAINT "guardian_registration_id_registration_id_fk" FOREIGN KEY ("registration_id") REFERENCES "crm"."registration"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."guardian" ADD CONSTRAINT "guardian_photo_file_id_file_object_id_fk" FOREIGN KEY ("photo_file_id") REFERENCES "core"."file_object"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."guardian" ADD CONSTRAINT "guardian_added_by_account_id_account_id_fk" FOREIGN KEY ("added_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."guardian" ADD CONSTRAINT "guardian_revoked_by_account_id_account_id_fk" FOREIGN KEY ("revoked_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."nanny" ADD CONSTRAINT "nanny_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."nanny" ADD CONSTRAINT "nanny_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."nanny" ADD CONSTRAINT "nanny_employee_id_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "core"."employee"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."nanny_shift" ADD CONSTRAINT "nanny_shift_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."nanny_shift" ADD CONSTRAINT "nanny_shift_nanny_id_nanny_id_fk" FOREIGN KEY ("nanny_id") REFERENCES "pos"."nanny"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."nanny_shift" ADD CONSTRAINT "nanny_shift_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."registration" ADD CONSTRAINT "registration_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."registration" ADD CONSTRAINT "registration_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."registration" ADD CONSTRAINT "registration_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "crm"."member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."registration" ADD CONSTRAINT "registration_photo_file_id_file_object_id_fk" FOREIGN KEY ("photo_file_id") REFERENCES "core"."file_object"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."registration" ADD CONSTRAINT "registration_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm"."registration" ADD CONSTRAINT "registration_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."release" ADD CONSTRAINT "release_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."release" ADD CONSTRAINT "release_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."release" ADD CONSTRAINT "release_checkin_id_checkin_id_fk" FOREIGN KEY ("checkin_id") REFERENCES "pos"."checkin"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."release" ADD CONSTRAINT "release_guardian_id_guardian_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "crm"."guardian"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."release" ADD CONSTRAINT "release_verified_by_account_id_account_id_fk" FOREIGN KEY ("verified_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."release" ADD CONSTRAINT "release_pickup_photo_file_id_file_object_id_fk" FOREIGN KEY ("pickup_photo_file_id") REFERENCES "core"."file_object"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."release" ADD CONSTRAINT "release_refund_id_refund_id_fk" FOREIGN KEY ("refund_id") REFERENCES "pos"."refund"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."release" ADD CONSTRAINT "release_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."supervision_policy" ADD CONSTRAINT "supervision_policy_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."supervision_policy" ADD CONSTRAINT "supervision_policy_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."supervision_waiver" ADD CONSTRAINT "supervision_waiver_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."supervision_waiver" ADD CONSTRAINT "supervision_waiver_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."supervision_waiver" ADD CONSTRAINT "supervision_waiver_registration_id_registration_id_fk" FOREIGN KEY ("registration_id") REFERENCES "crm"."registration"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."supervision_waiver" ADD CONSTRAINT "supervision_waiver_checkin_id_checkin_id_fk" FOREIGN KEY ("checkin_id") REFERENCES "pos"."checkin"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."supervision_waiver" ADD CONSTRAINT "supervision_waiver_child_id_child_id_fk" FOREIGN KEY ("child_id") REFERENCES "crm"."child"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."supervision_waiver" ADD CONSTRAINT "supervision_waiver_sibling_child_id_child_id_fk" FOREIGN KEY ("sibling_child_id") REFERENCES "crm"."child"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."supervision_waiver" ADD CONSTRAINT "supervision_waiver_accepted_by_account_id_account_id_fk" FOREIGN KEY ("accepted_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."supervision_waiver" ADD CONSTRAINT "supervision_waiver_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkin_operator_idx" ON "pos"."checkin" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "checkin_branch_status_idx" ON "pos"."checkin" USING btree ("branch_id","status");--> statement-breakpoint
CREATE INDEX "checkin_registration_idx" ON "pos"."checkin" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "checkin_child_idx" ON "pos"."checkin" USING btree ("child_id");--> statement-breakpoint
CREATE INDEX "checkin_nanny_idx" ON "pos"."checkin" USING btree ("nanny_id");--> statement-breakpoint
CREATE INDEX "checkin_sale_idx" ON "pos"."checkin" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "checkin_band_idx" ON "pos"."checkin" USING btree ("band_id");--> statement-breakpoint
CREATE INDEX "checkin_visit_idx" ON "pos"."checkin" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "checkin_photo_idx" ON "pos"."checkin" USING btree ("photo_file_id");--> statement-breakpoint
CREATE INDEX "checkin_checked_in_by_idx" ON "pos"."checkin" USING btree ("checked_in_by_account_id");--> statement-breakpoint
CREATE INDEX "checkin_checked_out_by_idx" ON "pos"."checkin" USING btree ("checked_out_by_account_id");--> statement-breakpoint
CREATE INDEX "checkin_scheduled_idx" ON "pos"."checkin" USING btree ("branch_id","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "confirmation_item_branch_code_unique" ON "pos"."confirmation_item" USING btree ("branch_id","code") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "confirmation_item_operator_idx" ON "pos"."confirmation_item" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drop_off_pricing_branch_unique" ON "pos"."drop_off_pricing" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "drop_off_pricing_operator_idx" ON "pos"."drop_off_pricing" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "guardian_operator_idx" ON "crm"."guardian" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "guardian_registration_idx" ON "crm"."guardian" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "guardian_photo_idx" ON "crm"."guardian" USING btree ("photo_file_id");--> statement-breakpoint
CREATE INDEX "guardian_added_by_idx" ON "crm"."guardian" USING btree ("added_by_account_id");--> statement-breakpoint
CREATE INDEX "guardian_revoked_by_idx" ON "crm"."guardian" USING btree ("revoked_by_account_id");--> statement-breakpoint
CREATE INDEX "nanny_operator_idx" ON "pos"."nanny" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "nanny_branch_idx" ON "pos"."nanny" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "nanny_employee_idx" ON "pos"."nanny" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "nanny_shift_operator_idx" ON "pos"."nanny_shift" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "nanny_shift_nanny_idx" ON "pos"."nanny_shift" USING btree ("nanny_id","starts_at");--> statement-breakpoint
CREATE INDEX "nanny_shift_branch_idx" ON "pos"."nanny_shift" USING btree ("branch_id","starts_at");--> statement-breakpoint
CREATE INDEX "registration_operator_idx" ON "crm"."registration" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "registration_branch_idx" ON "crm"."registration" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "registration_member_idx" ON "crm"."registration" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "registration_phone_idx" ON "crm"."registration" USING btree ("guardian_phone");--> statement-breakpoint
CREATE INDEX "registration_photo_idx" ON "crm"."registration" USING btree ("photo_file_id");--> statement-breakpoint
CREATE INDEX "registration_station_idx" ON "crm"."registration" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "registration_created_by_idx" ON "crm"."registration" USING btree ("created_by_account_id");--> statement-breakpoint
CREATE INDEX "registration_retention_idx" ON "crm"."registration" USING btree ("retention_until");--> statement-breakpoint
CREATE UNIQUE INDEX "release_checkin_unique" ON "pos"."release" USING btree ("checkin_id");--> statement-breakpoint
CREATE INDEX "release_operator_idx" ON "pos"."release" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "release_branch_idx" ON "pos"."release" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "release_guardian_idx" ON "pos"."release" USING btree ("guardian_id");--> statement-breakpoint
CREATE INDEX "release_verified_by_idx" ON "pos"."release" USING btree ("verified_by_account_id");--> statement-breakpoint
CREATE INDEX "release_photo_idx" ON "pos"."release" USING btree ("pickup_photo_file_id");--> statement-breakpoint
CREATE INDEX "release_refund_idx" ON "pos"."release" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "release_station_idx" ON "pos"."release" USING btree ("station_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supervision_policy_branch_unique" ON "pos"."supervision_policy" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "supervision_policy_operator_idx" ON "pos"."supervision_policy" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "supervision_waiver_operator_idx" ON "pos"."supervision_waiver" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "supervision_waiver_branch_idx" ON "pos"."supervision_waiver" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "supervision_waiver_registration_idx" ON "pos"."supervision_waiver" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "supervision_waiver_checkin_idx" ON "pos"."supervision_waiver" USING btree ("checkin_id");--> statement-breakpoint
CREATE INDEX "supervision_waiver_child_idx" ON "pos"."supervision_waiver" USING btree ("child_id");--> statement-breakpoint
CREATE INDEX "supervision_waiver_sibling_idx" ON "pos"."supervision_waiver" USING btree ("sibling_child_id");--> statement-breakpoint
CREATE INDEX "supervision_waiver_accepted_by_idx" ON "pos"."supervision_waiver" USING btree ("accepted_by_account_id");--> statement-breakpoint
CREATE INDEX "supervision_waiver_station_idx" ON "pos"."supervision_waiver" USING btree ("station_id");--> statement-breakpoint
--> statement-breakpoint
INSERT INTO "pos"."supervision_policy" ("id", "operator_id", "branch_id", "bands")
SELECT gen_random_uuid(), b."operator_id", b."id",
  '[{"id":"band-0-4","label":"0–4","minAge":0,"maxAge":4,"requirement":"nanny"},{"id":"band-5-8","label":"5–8","minAge":5,"maxAge":8,"requirement":"drop_off"},{"id":"band-9-up","label":"9+","minAge":9,"maxAge":null,"requirement":"none"}]'::jsonb
FROM "core"."branch" b
ON CONFLICT ("branch_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "pos"."confirmation_item" ("id", "operator_id", "branch_id", "code", "text", "required", "sort_order")
SELECT gen_random_uuid(), b."operator_id", b."id", c."code", c."text", true, c."sort_order"
FROM "core"."branch" b
CROSS JOIN (VALUES
  ('confirm-15min', 'I will remain within 15 minutes of the venue', 0),
  ('confirm-no-refund', 'I understand early pickup does not qualify for refund', 1),
  ('confirm-evac', 'I acknowledge the emergency evacuation point', 2)
) AS c("code", "text", "sort_order")
ON CONFLICT ("branch_id", "code") WHERE archived_at is null DO NOTHING;
--> statement-breakpoint
INSERT INTO "pos"."drop_off_pricing" ("id", "operator_id", "branch_id",
  "one_time_fee_weekday_satang", "one_time_fee_weekend_satang",
  "nanny_hourly_weekday_satang", "nanny_hourly_weekend_satang",
  "extra_hour_weekday_satang", "extra_hour_weekend_satang",
  "full_day_hours", "prepaid_food_unused")
SELECT gen_random_uuid(), b."operator_id", b."id", 22500, 22500, 33000, 33000, 30000, 30000, 8, 'refund'
FROM "core"."branch" b
ON CONFLICT ("branch_id") DO NOTHING;
