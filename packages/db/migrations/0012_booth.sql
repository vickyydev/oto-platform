-- S2-07a — the Lucky Wheel booth: what an administrator publishes, what the
-- box runs, what a child won, and the piece of paper it turned into.
--
-- Nine new tables — six in `booth`, two in `promo`, two in `core` — one CHECK
-- widened, and one backfill. **Expand only.** Nothing is renamed, retyped or
-- dropped, so the release now deployed runs unchanged against this database
-- and a rollback onto it is uneventful.
--
-- The one statement worth reading twice is the `sync_change_scope_check` pair
-- at the top and bottom. It is a DROP and an ADD rather than an ALTER because
-- Postgres has no ALTER for a check's expression, and it is SAFE because the
-- new list is a superset of the old one: every scope the currently deployed
-- release writes still passes, and the two statements are inside the one
-- transaction this migration runs in, so no concurrent insert ever sees the
-- table unconstrained. Widening a CHECK in a single statement is exactly what
-- S2-01b replaced the pg enums for.
--
-- Every index here builds over a table this migration has just created, so
-- none of them can refuse to build on a live database.
--
-- Three placements are decisions rather than conveniences, and the reasoning
-- is on the tables themselves:
--
--   `booth.booth_settings` holds what an administrator has set for one booth,
--   keyed by the station's own id. The natural home would be `core.station`,
--   beside `capabilities` and `payment_routing`; what rules it out is
--   `layout_id`, which would put a foreign key from `core` into `booth` and
--   invert the schema layering `helpers.ts` sets out.
--
--   `promo.voucher` carries `cost_satang` and `expires_at` copied from its
--   definition at issue rather than read back through it. A voucher printed
--   in October under a definition re-costed in November is still worth what
--   the paper says.
--
--   `booth.voucher_print` records a print that `edge.print_job` also records,
--   because the two are swept on different clocks: print jobs go after 90
--   days, and "how many copies of this code exist, and who asked for the
--   second" has to be answerable for as long as the voucher is. Its
--   `print_job_id` therefore carries no foreign key — a pointer has to be
--   able to outlive what it points at.
--
-- `booth.booth_prize.weight_bp` is an integer in basis points, because "the
-- weights must add up to 100" has to hold for every list somebody types. The
-- launch weights are 23.5 / 27.5 / 17.5 / 14.5 / 14.5 / 2.5 per cent — halves,
-- which are exact in binary floating point, so a float column would pass today
-- and go wrong the first time a slice is split three ways or nudged by a
-- tenth. As 2350 / 2750 / 1750 / 1450 / 1450 / 250 they add to exactly 10000
-- whatever anybody types. A cross-row sum cannot be a CHECK, so what the
-- database enforces is the per-row range; the sum is checked in integer
-- arithmetic where a version is published (S2-07b).
--
-- `booth.booth_settings.daily_spin_cap` ships nullable and **nothing reads
-- it**. Whether one child spinning two hundred times is a problem to cap or
-- the point of a marketing booth has not been decided; a nullable column costs
-- nothing now and saves a migration on a table full of live booths later.
--
-- The backfill at the end fills `core.box_sync_key` from the current
-- `core.box.sync_public_key`. See the note above that statement: without it,
-- the first box to restart after the verifier starts reading the keyring
-- would have every queued event quarantined.

CREATE TABLE "core"."box_sync_key" (
	"id" uuid PRIMARY KEY NOT NULL,
	"box_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"algorithm" text DEFAULT 'ed25519' NOT NULL,
	"fingerprint" text NOT NULL,
	"registered_epoch" integer DEFAULT 1 NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"retired_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "box_sync_key_epoch_check" CHECK ("core"."box_sync_key"."registered_epoch" > 0),
	CONSTRAINT "box_sync_key_fingerprint_check" CHECK ("core"."box_sync_key"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "box_sync_key_retired_check" CHECK ("core"."box_sync_key"."retired_at" is null or "core"."box_sync_key"."retired_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "core"."credential" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"secret_hash" text NOT NULL,
	"label" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_account_id" uuid,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_kind_check" CHECK ("core"."credential"."kind" in ('password','pin','badge')),
	CONSTRAINT "credential_revocation_check" CHECK (("core"."credential"."active" and "core"."credential"."revoked_at" is null) or (not "core"."credential"."active" and "core"."credential"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "promo"."voucher" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"voucher_definition_id" uuid NOT NULL,
	"code" text NOT NULL,
	"source" text DEFAULT 'booth' NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"cost_satang" integer DEFAULT 0 NOT NULL,
	"issued_by_account_id" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"member_id" uuid,
	"print_count" integer DEFAULT 0 NOT NULL,
	"redeemed_at" timestamp with time zone,
	"redeemed_by_account_id" uuid,
	"redeemed_branch_id" uuid,
	"sale_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_source_check" CHECK ("promo"."voucher"."source" in ('booth','legacy','manual')),
	CONSTRAINT "voucher_status_check" CHECK ("promo"."voucher"."status" in ('issued','redeemed','expired','void')),
	CONSTRAINT "voucher_code_shape_check" CHECK ("promo"."voucher"."code" ~ '^[0-9A-Z-]{4,32}$'),
	CONSTRAINT "voucher_cost_check" CHECK ("promo"."voucher"."cost_satang" >= 0),
	CONSTRAINT "voucher_print_count_check" CHECK ("promo"."voucher"."print_count" >= 0),
	CONSTRAINT "voucher_expiry_check" CHECK ("promo"."voucher"."expires_at" is null or "promo"."voucher"."expires_at" > "promo"."voucher"."issued_at"),
	CONSTRAINT "voucher_redeemed_check" CHECK ("promo"."voucher"."status" <> 'redeemed' or "promo"."voucher"."redeemed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "promo"."voucher_definition" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name_en" text NOT NULL,
	"name_th" text,
	"kind" text NOT NULL,
	"value_type" text DEFAULT 'none' NOT NULL,
	"value_satang" integer,
	"value_bp" integer,
	"product_id" uuid,
	"ticket_package_id" uuid,
	"expiry_days" integer,
	"offline_policy" text DEFAULT 'allow' NOT NULL,
	"single_use" boolean DEFAULT true NOT NULL,
	"cost_satang" integer DEFAULT 0 NOT NULL,
	"terms_en" text,
	"terms_th" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "voucher_definition_kind_check" CHECK ("promo"."voucher_definition"."kind" in ('discount','free_item','free_ticket','wallet_credit','manual')),
	CONSTRAINT "voucher_definition_value_type_check" CHECK ("promo"."voucher_definition"."value_type" in ('amount','percent','item','none')),
	CONSTRAINT "voucher_definition_offline_policy_check" CHECK ("promo"."voucher_definition"."offline_policy" in ('allow','refuse')),
	CONSTRAINT "voucher_definition_value_satang_check" CHECK ("promo"."voucher_definition"."value_satang" is null or "promo"."voucher_definition"."value_satang" >= 0),
	CONSTRAINT "voucher_definition_value_bp_check" CHECK ("promo"."voucher_definition"."value_bp" is null or ("promo"."voucher_definition"."value_bp" >= 0 and "promo"."voucher_definition"."value_bp" <= 10000)),
	CONSTRAINT "voucher_definition_expiry_days_check" CHECK ("promo"."voucher_definition"."expiry_days" is null or "promo"."voucher_definition"."expiry_days" > 0),
	CONSTRAINT "voucher_definition_cost_check" CHECK ("promo"."voucher_definition"."cost_satang" >= 0)
);
--> statement-breakpoint
CREATE TABLE "booth"."booth_config_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"layout_id" uuid NOT NULL,
	"bundle" jsonb NOT NULL,
	"bundle_hash" text NOT NULL,
	"published_by_account_id" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booth_config_version_number_check" CHECK ("booth"."booth_config_version"."version" > 0),
	CONSTRAINT "booth_config_version_hash_check" CHECK ("booth"."booth_config_version"."bundle_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "booth"."booth_layout" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"design" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"asset_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "booth_layout_version_check" CHECK ("booth"."booth_layout"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "booth"."booth_prize" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"voucher_definition_id" uuid,
	"name_en" text NOT NULL,
	"name_th" text,
	"wheel_label" text,
	"weight_bp" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"expiry_days" integer,
	"daily_cap" integer,
	"cost_satang" integer DEFAULT 0 NOT NULL,
	"stock_item_id" uuid,
	"slice_color" text,
	"text_color" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "booth_prize_weight_check" CHECK ("booth"."booth_prize"."weight_bp" >= 0 and "booth"."booth_prize"."weight_bp" <= 10000),
	CONSTRAINT "booth_prize_daily_cap_check" CHECK ("booth"."booth_prize"."daily_cap" is null or "booth"."booth_prize"."daily_cap" > 0),
	CONSTRAINT "booth_prize_expiry_days_check" CHECK ("booth"."booth_prize"."expiry_days" is null or "booth"."booth_prize"."expiry_days" > 0),
	CONSTRAINT "booth_prize_cost_check" CHECK ("booth"."booth_prize"."cost_satang" >= 0),
	CONSTRAINT "booth_prize_sort_check" CHECK ("booth"."booth_prize"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "booth"."booth_settings" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"layout_id" uuid,
	"daily_spin_cap" integer,
	"button_key" text DEFAULT 'Space' NOT NULL,
	"eligibility" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booth_settings_eligibility_check" CHECK ("booth"."booth_settings"."eligibility" in ('none','band','phone')),
	CONSTRAINT "booth_settings_daily_spin_cap_check" CHECK ("booth"."booth_settings"."daily_spin_cap" is null or "booth"."booth_settings"."daily_spin_cap" > 0),
	CONSTRAINT "booth_settings_button_key_check" CHECK ("booth"."booth_settings"."button_key" <> 'Enter')
);
--> statement-breakpoint
CREATE TABLE "booth"."booth_staff_assignment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"station_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"added_by" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booth"."spin" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"box_id" uuid NOT NULL,
	"booth_config_version_id" uuid NOT NULL,
	"outcome" text DEFAULT 'prize' NOT NULL,
	"prize_id" uuid,
	"voucher_id" uuid,
	"staff_account_id" uuid,
	"clock_suspect" boolean DEFAULT false NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"business_date" date NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action_id" text,
	"source_event_id" uuid,
	CONSTRAINT "spin_outcome_check" CHECK ("booth"."spin"."outcome" in ('prize','no_prize')),
	CONSTRAINT "spin_prize_check" CHECK ("booth"."spin"."outcome" <> 'prize' or "booth"."spin"."prize_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "booth"."voucher_print" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"box_id" uuid NOT NULL,
	"station_id" uuid,
	"voucher_id" uuid NOT NULL,
	"print_job_id" uuid,
	"reason" text DEFAULT 'initial' NOT NULL,
	"requested_by_account_id" uuid,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action_id" text,
	CONSTRAINT "voucher_print_reason_check" CHECK ("booth"."voucher_print"."reason" in ('initial','reprint'))
);
--> statement-breakpoint
ALTER TABLE "edge"."sync_change" DROP CONSTRAINT "sync_change_scope_check";--> statement-breakpoint
ALTER TABLE "core"."box_sync_key" ADD CONSTRAINT "box_sync_key_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."credential" ADD CONSTRAINT "credential_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."credential" ADD CONSTRAINT "credential_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."credential" ADD CONSTRAINT "credential_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_voucher_definition_id_voucher_definition_id_fk" FOREIGN KEY ("voucher_definition_id") REFERENCES "promo"."voucher_definition"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_issued_by_account_id_account_id_fk" FOREIGN KEY ("issued_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "crm"."member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_redeemed_by_account_id_account_id_fk" FOREIGN KEY ("redeemed_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_redeemed_branch_id_branch_id_fk" FOREIGN KEY ("redeemed_branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD CONSTRAINT "voucher_definition_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD CONSTRAINT "voucher_definition_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "pos"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_definition" ADD CONSTRAINT "voucher_definition_ticket_package_id_ticket_package_id_fk" FOREIGN KEY ("ticket_package_id") REFERENCES "pos"."ticket_package"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_config_version" ADD CONSTRAINT "booth_config_version_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_config_version" ADD CONSTRAINT "booth_config_version_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_config_version" ADD CONSTRAINT "booth_config_version_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_config_version" ADD CONSTRAINT "booth_config_version_layout_id_booth_layout_id_fk" FOREIGN KEY ("layout_id") REFERENCES "booth"."booth_layout"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_config_version" ADD CONSTRAINT "booth_config_version_published_by_account_id_account_id_fk" FOREIGN KEY ("published_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_layout" ADD CONSTRAINT "booth_layout_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_prize" ADD CONSTRAINT "booth_prize_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_prize" ADD CONSTRAINT "booth_prize_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_prize" ADD CONSTRAINT "booth_prize_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_prize" ADD CONSTRAINT "booth_prize_voucher_definition_id_voucher_definition_id_fk" FOREIGN KEY ("voucher_definition_id") REFERENCES "promo"."voucher_definition"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_prize" ADD CONSTRAINT "booth_prize_stock_item_id_stock_item_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "pos"."stock_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD CONSTRAINT "booth_settings_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD CONSTRAINT "booth_settings_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD CONSTRAINT "booth_settings_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_settings" ADD CONSTRAINT "booth_settings_layout_id_booth_layout_id_fk" FOREIGN KEY ("layout_id") REFERENCES "booth"."booth_layout"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_staff_assignment" ADD CONSTRAINT "booth_staff_assignment_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_staff_assignment" ADD CONSTRAINT "booth_staff_assignment_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."booth_staff_assignment" ADD CONSTRAINT "booth_staff_assignment_added_by_account_id_fk" FOREIGN KEY ("added_by") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."spin" ADD CONSTRAINT "spin_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."spin" ADD CONSTRAINT "spin_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."spin" ADD CONSTRAINT "spin_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."spin" ADD CONSTRAINT "spin_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."spin" ADD CONSTRAINT "spin_booth_config_version_id_booth_config_version_id_fk" FOREIGN KEY ("booth_config_version_id") REFERENCES "booth"."booth_config_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."spin" ADD CONSTRAINT "spin_prize_id_booth_prize_id_fk" FOREIGN KEY ("prize_id") REFERENCES "booth"."booth_prize"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."spin" ADD CONSTRAINT "spin_voucher_id_voucher_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "promo"."voucher"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."spin" ADD CONSTRAINT "spin_staff_account_id_account_id_fk" FOREIGN KEY ("staff_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."voucher_print" ADD CONSTRAINT "voucher_print_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."voucher_print" ADD CONSTRAINT "voucher_print_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."voucher_print" ADD CONSTRAINT "voucher_print_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."voucher_print" ADD CONSTRAINT "voucher_print_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."voucher_print" ADD CONSTRAINT "voucher_print_voucher_id_voucher_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "promo"."voucher"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booth"."voucher_print" ADD CONSTRAINT "voucher_print_requested_by_account_id_account_id_fk" FOREIGN KEY ("requested_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "box_sync_key_live_idx" ON "core"."box_sync_key" USING btree ("box_id") WHERE retired_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "box_sync_key_fingerprint_unique" ON "core"."box_sync_key" USING btree ("box_id","fingerprint");--> statement-breakpoint
CREATE INDEX "box_sync_key_registered_idx" ON "core"."box_sync_key" USING btree ("box_id","registered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_active_kind_unique" ON "core"."credential" USING btree ("account_id","kind") WHERE active;--> statement-breakpoint
CREATE INDEX "credential_account_idx" ON "core"."credential" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "credential_operator_idx" ON "core"."credential" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "credential_created_by_idx" ON "core"."credential" USING btree ("created_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_code_unique" ON "promo"."voucher" USING btree ("operator_id","code");--> statement-breakpoint
CREATE INDEX "voucher_definition_idx" ON "promo"."voucher" USING btree ("voucher_definition_id");--> statement-breakpoint
CREATE INDEX "voucher_branch_issued_idx" ON "promo"."voucher" USING btree ("branch_id","issued_at");--> statement-breakpoint
CREATE INDEX "voucher_operator_status_idx" ON "promo"."voucher" USING btree ("operator_id","status");--> statement-breakpoint
CREATE INDEX "voucher_issued_by_idx" ON "promo"."voucher" USING btree ("issued_by_account_id");--> statement-breakpoint
CREATE INDEX "voucher_member_idx" ON "promo"."voucher" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "voucher_redeemed_by_idx" ON "promo"."voucher" USING btree ("redeemed_by_account_id");--> statement-breakpoint
CREATE INDEX "voucher_redeemed_branch_idx" ON "promo"."voucher" USING btree ("redeemed_branch_id");--> statement-breakpoint
CREATE INDEX "voucher_sale_idx" ON "promo"."voucher" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "voucher_expiring_idx" ON "promo"."voucher" USING btree ("expires_at") WHERE expires_at is not null and status = 'issued';--> statement-breakpoint
CREATE INDEX "voucher_definition_operator_idx" ON "promo"."voucher_definition" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_definition_code_unique" ON "promo"."voucher_definition" USING btree ("operator_id","code");--> statement-breakpoint
CREATE INDEX "voucher_definition_product_idx" ON "promo"."voucher_definition" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "voucher_definition_package_idx" ON "promo"."voucher_definition" USING btree ("ticket_package_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booth_config_version_unique" ON "booth"."booth_config_version" USING btree ("station_id","version");--> statement-breakpoint
CREATE INDEX "booth_config_version_published_idx" ON "booth"."booth_config_version" USING btree ("station_id","published_at");--> statement-breakpoint
CREATE INDEX "booth_config_version_operator_idx" ON "booth"."booth_config_version" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "booth_config_version_branch_idx" ON "booth"."booth_config_version" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "booth_config_version_layout_idx" ON "booth"."booth_config_version" USING btree ("layout_id");--> statement-breakpoint
CREATE INDEX "booth_config_version_published_by_idx" ON "booth"."booth_config_version" USING btree ("published_by_account_id");--> statement-breakpoint
CREATE INDEX "booth_layout_operator_idx" ON "booth"."booth_layout" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booth_layout_name_unique" ON "booth"."booth_layout" USING btree ("operator_id","name") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "booth_prize_station_idx" ON "booth"."booth_prize" USING btree ("station_id") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "booth_prize_operator_idx" ON "booth"."booth_prize" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "booth_prize_branch_idx" ON "booth"."booth_prize" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "booth_prize_definition_idx" ON "booth"."booth_prize" USING btree ("voucher_definition_id");--> statement-breakpoint
CREATE INDEX "booth_prize_stock_item_idx" ON "booth"."booth_prize" USING btree ("stock_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booth_prize_name_unique" ON "booth"."booth_prize" USING btree ("station_id","name_en") WHERE archived_at is null;--> statement-breakpoint
CREATE INDEX "booth_settings_operator_idx" ON "booth"."booth_settings" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "booth_settings_branch_idx" ON "booth"."booth_settings" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "booth_settings_layout_idx" ON "booth"."booth_settings" USING btree ("layout_id");--> statement-breakpoint
CREATE UNIQUE INDEX "booth_staff_assignment_unique" ON "booth"."booth_staff_assignment" USING btree ("station_id","account_id");--> statement-breakpoint
CREATE INDEX "booth_staff_assignment_account_idx" ON "booth"."booth_staff_assignment" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "booth_staff_assignment_added_by_idx" ON "booth"."booth_staff_assignment" USING btree ("added_by");--> statement-breakpoint
CREATE INDEX "spin_station_date_idx" ON "booth"."spin" USING btree ("station_id","business_date");--> statement-breakpoint
CREATE INDEX "spin_prize_date_idx" ON "booth"."spin" USING btree ("prize_id","business_date") WHERE simulated = false;--> statement-breakpoint
CREATE INDEX "spin_box_occurred_idx" ON "booth"."spin" USING btree ("box_id","occurred_at");--> statement-breakpoint
CREATE INDEX "spin_branch_date_idx" ON "booth"."spin" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "spin_operator_idx" ON "booth"."spin" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "spin_staff_idx" ON "booth"."spin" USING btree ("staff_account_id");--> statement-breakpoint
CREATE INDEX "spin_config_version_idx" ON "booth"."spin" USING btree ("booth_config_version_id");--> statement-breakpoint
CREATE INDEX "spin_action_idx" ON "booth"."spin" USING btree ("action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spin_voucher_unique" ON "booth"."spin" USING btree ("voucher_id") WHERE voucher_id is not null;--> statement-breakpoint
CREATE INDEX "voucher_print_voucher_idx" ON "booth"."voucher_print" USING btree ("voucher_id","queued_at");--> statement-breakpoint
CREATE INDEX "voucher_print_box_idx" ON "booth"."voucher_print" USING btree ("box_id","queued_at");--> statement-breakpoint
CREATE INDEX "voucher_print_branch_idx" ON "booth"."voucher_print" USING btree ("branch_id","queued_at");--> statement-breakpoint
CREATE INDEX "voucher_print_operator_idx" ON "booth"."voucher_print" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "voucher_print_station_idx" ON "booth"."voucher_print" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "voucher_print_job_idx" ON "booth"."voucher_print" USING btree ("print_job_id");--> statement-breakpoint
CREATE INDEX "voucher_print_requested_by_idx" ON "booth"."voucher_print" USING btree ("requested_by_account_id");--> statement-breakpoint
CREATE INDEX "voucher_print_action_idx" ON "booth"."voucher_print" USING btree ("action_id");--> statement-breakpoint
ALTER TABLE "edge"."sync_change" ADD CONSTRAINT "sync_change_scope_check" CHECK ("edge"."sync_change"."scope" in ('catalogue','members','staff','deny_list','bookings','bands','station_config','receipt_series','booth'));--> statement-breakpoint
-- Seed the keyring from the key each box is currently registered with.
--
-- A box signs every event as it queues it, and the signature is verified once,
-- at push, against the box's public key. Until now there was one such key per
-- box, in `core.box.sync_public_key`. A box that queues three vouchers, goes
-- offline, is restarted and comes back has three events signed by whatever key
-- it held BEFORE the restart — and the cloud virtual box mints a fresh keypair
-- on every boot, because it has nowhere private to keep one. Reading only the
-- current key, those three events fail verification and land in quarantine:
-- `synced_count=0` on the box's return, with three printed vouchers in
-- visitors' hands.
--
-- So every key already on record becomes the first row of that box's ring
-- here. Without this, the first restart after the verifier starts reading the
-- ring would be the outage, not a later one.
--
-- `gen_random_uuid()` rather than the platform's UUIDv7: this runs in SQL,
-- where the application's generator is not available, and it is a handful of
-- rows written once. `ON CONFLICT DO NOTHING` so re-running the migration
-- against a database that already has the ring changes nothing.
INSERT INTO "core"."box_sync_key" ("id", "box_id", "public_key", "algorithm", "fingerprint", "registered_epoch", "registered_at")
SELECT
	gen_random_uuid(),
	b."id",
	b."sync_public_key",
	coalesce(b."sync_key_algorithm", 'ed25519'),
	encode(sha256(convert_to(b."sync_public_key", 'UTF8')), 'hex'),
	b."current_epoch",
	coalesce(b."sync_key_registered_at", now())
FROM "core"."box" b
WHERE b."sync_public_key" IS NOT NULL
ON CONFLICT ("box_id", "fingerprint") DO NOTHING;