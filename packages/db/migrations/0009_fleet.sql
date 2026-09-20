-- S2-04 — the fleet: boxes, the stations that sit on them, the devices those
-- boxes report, the credentials non-people hold, and the two `edge` tables that
-- make a box visible from the cloud.
--
-- Expand only. Nothing is renamed, retyped or dropped, so the release now
-- deployed runs unchanged against this database and a rollback onto it is
-- uneventful. `core.station` gains eight columns, all nullable or with a
-- default; `core.branch` gains two; `core.station.device_key_hash` stays where
-- it is even though `core.device_credential` supersedes it, and a later
-- migration drops it once nothing deployed reads it.
--
-- Two of the new indexes are unique over data that already exists:
-- `station_name_unique` (branch, name) and `box_slot_unique` (branch, slot).
-- Both are partial on `archived_at is null`, so archiving frees the name; the
-- station one will refuse to build if a branch already holds two live stations
-- with the same name, which is a duplicate worth failing the deploy over.

CREATE TABLE "core"."box" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slot" text NOT NULL,
	"hostname" text,
	"role" text DEFAULT 'counter' NOT NULL,
	"secret_hash" text,
	"claim_code_hash" text,
	"claim_code_expires_at" timestamp with time zone,
	"registered_at" timestamp with time zone,
	"agent_version" text,
	"current_epoch" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'unclaimed' NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"last_status" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "box_role_check" CHECK ("core"."box"."role" in ('counter','gate','booth','kiosk','standby','virtual')),
	CONSTRAINT "box_status_check" CHECK ("core"."box"."status" in ('unclaimed','online','offline','disabled')),
	CONSTRAINT "box_epoch_check" CHECK ("core"."box"."current_epoch" > 0)
);
--> statement-breakpoint
CREATE TABLE "core"."device" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"box_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"transport" text NOT NULL,
	"address" text,
	"model" text,
	"protocol" text,
	"serial_number" text,
	"terminal_id" text,
	"merchant_id" text,
	"reachability" text DEFAULT 'unknown' NOT NULL,
	"paper_status" text DEFAULT 'unknown' NOT NULL,
	"last_error" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "device_kind_check" CHECK ("core"."device"."kind" in ('receipt_printer','band_printer','kitchen_printer','bar_printer','scanner','terminal','gate','gate_reader','cash_drawer')),
	CONSTRAINT "device_transport_check" CHECK ("core"."device"."transport" in ('lan','usb','serial','bluetooth','simulated')),
	CONSTRAINT "device_reachability_check" CHECK ("core"."device"."reachability" in ('unknown','reachable','unreachable')),
	CONSTRAINT "device_paper_check" CHECK ("core"."device"."paper_status" in ('unknown','ok','low','out'))
);
--> statement-breakpoint
CREATE TABLE "core"."device_credential" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"station_id" uuid,
	"box_id" uuid,
	"label" text,
	"pairing_code_hash" text,
	"pairing_code_expires_at" timestamp with time zone,
	"secret_hash" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rotated_from" uuid,
	"paired_by_account_id" uuid,
	"paired_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_credential_kind_check" CHECK ("core"."device_credential"."kind" in ('display','kiosk','booth','box')),
	CONSTRAINT "device_credential_target_check" CHECK (("core"."device_credential"."kind" = 'box' and "core"."device_credential"."box_id" is not null and "core"."device_credential"."station_id" is null)
          or ("core"."device_credential"."kind" <> 'box' and "core"."device_credential"."station_id" is not null and "core"."device_credential"."box_id" is null))
);
--> statement-breakpoint
CREATE TABLE "core"."signing_key" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid,
	"purpose" text NOT NULL,
	"kid" text NOT NULL,
	"algorithm" text DEFAULT 'ed25519' NOT NULL,
	"public_key" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"not_before" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signing_key_purpose_check" CHECK ("core"."signing_key"."purpose" in ('staff_token','booking_qr','benefit_qr'))
);
--> statement-breakpoint
CREATE TABLE "core"."station_device" (
	"id" uuid PRIMARY KEY NOT NULL,
	"station_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_device_role_check" CHECK ("core"."station_device"."role" in ('receipt','kids_band','adult_band','kitchen','bar','scanner','card_terminal','qr_terminal','gate','cash_drawer'))
);
--> statement-breakpoint
CREATE TABLE "core"."station_staff" (
	"id" uuid PRIMARY KEY NOT NULL,
	"station_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"added_by" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edge"."box_command" (
	"id" uuid PRIMARY KEY NOT NULL,
	"box_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb,
	"state" text DEFAULT 'queued' NOT NULL,
	"requested_by_account_id" uuid,
	"action_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"result" jsonb,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_command_kind_check" CHECK ("edge"."box_command"."kind" in ('test_print','config_apply','clear_cache','collect_logs','restart','go_offline','go_online','reset_store')),
	CONSTRAINT "box_command_state_check" CHECK ("edge"."box_command"."state" in ('queued','running','succeeded','failed','expired','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "edge"."box_heartbeat" (
	"id" uuid PRIMARY KEY NOT NULL,
	"box_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reported_at" timestamp with time zone,
	"clock_offset_ms" integer,
	"agent_version" text,
	"uptime_s" integer,
	"temp_c" real,
	"outbox_depth" integer,
	"payload" jsonb
);
--> statement-breakpoint
ALTER TABLE "core"."branch" ADD COLUMN "opening_hours" jsonb;--> statement-breakpoint
ALTER TABLE "core"."branch" ADD COLUMN "business_day_start" time DEFAULT '05:00' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."station" ADD COLUMN "box_id" uuid;--> statement-breakpoint
ALTER TABLE "core"."station" ADD COLUMN "code_prefix" text;--> statement-breakpoint
ALTER TABLE "core"."station" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."station" ADD COLUMN "config_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."station" ADD COLUMN "payment_routing" jsonb;--> statement-breakpoint
ALTER TABLE "core"."station" ADD COLUMN "offline_wallet_cap_satang" integer;--> statement-breakpoint
ALTER TABLE "core"."station" ADD COLUMN "access_scope" text DEFAULT 'all_staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "core"."station" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "core"."box" ADD CONSTRAINT "box_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."box" ADD CONSTRAINT "box_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."device" ADD CONSTRAINT "device_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."device" ADD CONSTRAINT "device_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."device" ADD CONSTRAINT "device_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."device_credential" ADD CONSTRAINT "device_credential_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."device_credential" ADD CONSTRAINT "device_credential_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."device_credential" ADD CONSTRAINT "device_credential_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."device_credential" ADD CONSTRAINT "device_credential_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."device_credential" ADD CONSTRAINT "device_credential_paired_by_account_id_account_id_fk" FOREIGN KEY ("paired_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."device_credential" ADD CONSTRAINT "device_credential_rotated_from_fk" FOREIGN KEY ("rotated_from") REFERENCES "core"."device_credential"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."signing_key" ADD CONSTRAINT "signing_key_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."station_device" ADD CONSTRAINT "station_device_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."station_device" ADD CONSTRAINT "station_device_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "core"."device"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."station_staff" ADD CONSTRAINT "station_staff_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."station_staff" ADD CONSTRAINT "station_staff_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."station_staff" ADD CONSTRAINT "station_staff_added_by_account_id_fk" FOREIGN KEY ("added_by") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_command" ADD CONSTRAINT "box_command_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_command" ADD CONSTRAINT "box_command_requested_by_account_id_account_id_fk" FOREIGN KEY ("requested_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge"."box_heartbeat" ADD CONSTRAINT "box_heartbeat_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "box_operator_idx" ON "core"."box" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "box_branch_idx" ON "core"."box" USING btree ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "box_slot_unique" ON "core"."box" USING btree ("branch_id","slot") WHERE archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "box_claim_code_unique" ON "core"."box" USING btree ("claim_code_hash") WHERE claim_code_hash is not null;--> statement-breakpoint
CREATE INDEX "box_heartbeat_age_idx" ON "core"."box" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "device_box_kind_idx" ON "core"."device" USING btree ("box_id","kind");--> statement-breakpoint
CREATE INDEX "device_branch_idx" ON "core"."device" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "device_operator_idx" ON "core"."device" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_address_unique" ON "core"."device" USING btree ("box_id","address") WHERE address is not null and archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "device_credential_secret_unique" ON "core"."device_credential" USING btree ("secret_hash") WHERE secret_hash is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "device_credential_pairing_unique" ON "core"."device_credential" USING btree ("pairing_code_hash") WHERE pairing_code_hash is not null;--> statement-breakpoint
CREATE INDEX "device_credential_station_idx" ON "core"."device_credential" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "device_credential_box_idx" ON "core"."device_credential" USING btree ("box_id");--> statement-breakpoint
CREATE INDEX "device_credential_operator_idx" ON "core"."device_credential" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "device_credential_branch_idx" ON "core"."device_credential" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "device_credential_rotated_from_idx" ON "core"."device_credential" USING btree ("rotated_from");--> statement-breakpoint
CREATE INDEX "device_credential_paired_by_idx" ON "core"."device_credential" USING btree ("paired_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signing_key_kid_unique" ON "core"."signing_key" USING btree ("purpose","kid");--> statement-breakpoint
CREATE INDEX "signing_key_purpose_active_idx" ON "core"."signing_key" USING btree ("purpose","active");--> statement-breakpoint
CREATE INDEX "signing_key_operator_idx" ON "core"."signing_key" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "station_device_role_unique" ON "core"."station_device" USING btree ("station_id","role");--> statement-breakpoint
CREATE INDEX "station_device_device_idx" ON "core"."station_device" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "station_staff_unique" ON "core"."station_staff" USING btree ("station_id","account_id");--> statement-breakpoint
CREATE INDEX "station_staff_account_idx" ON "core"."station_staff" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "station_staff_added_by_idx" ON "core"."station_staff" USING btree ("added_by");--> statement-breakpoint
CREATE INDEX "box_command_poll_idx" ON "edge"."box_command" USING btree ("box_id","created_at") WHERE state = 'queued';--> statement-breakpoint
CREATE INDEX "box_command_history_idx" ON "edge"."box_command" USING btree ("box_id","created_at");--> statement-breakpoint
CREATE INDEX "box_command_expires_idx" ON "edge"."box_command" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "box_command_action_idx" ON "edge"."box_command" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "box_command_requested_by_idx" ON "edge"."box_command" USING btree ("requested_by_account_id");--> statement-breakpoint
CREATE INDEX "box_heartbeat_box_received_idx" ON "edge"."box_heartbeat" USING btree ("box_id","received_at");--> statement-breakpoint
CREATE INDEX "box_heartbeat_received_idx" ON "edge"."box_heartbeat" USING btree ("received_at");--> statement-breakpoint
ALTER TABLE "core"."station" ADD CONSTRAINT "station_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "station_box_idx" ON "core"."station" USING btree ("box_id");--> statement-breakpoint
CREATE INDEX "station_branch_live_idx" ON "core"."station" USING btree ("branch_id") WHERE archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "station_name_unique" ON "core"."station" USING btree ("branch_id","name") WHERE archived_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "station_code_prefix_unique" ON "core"."station" USING btree ("branch_id","code_prefix") WHERE code_prefix is not null and archived_at is null;--> statement-breakpoint
ALTER TABLE "core"."station" ADD CONSTRAINT "station_access_scope_check" CHECK ("core"."station"."access_scope" in ('all_staff','selected_staff'));--> statement-breakpoint
ALTER TABLE "core"."station" ADD CONSTRAINT "station_wallet_cap_check" CHECK ("core"."station"."offline_wallet_cap_satang" is null or "core"."station"."offline_wallet_cap_satang" >= 0);