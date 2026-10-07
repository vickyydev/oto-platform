-- S2-20 E4 (SCRUM-217) — the party tab. The plan is
-- docs/progress/plans/events-kiosk/PLAN.md §8 ("This ticket") and the E4 row
-- of §9, with Q3's default: charges are a ledger only, and a payment is real
-- money through the tender machine but not a sale of goods. PROVISIONAL
-- NUMBER: built on 0070; the lander renumbers it and regenerates the snapshot
-- at landing.
--
-- 1. `pos.party_charge` — extra tickets or F&B charged to a party's tab
--    (`addPartyExtraCharge`), keyed by the charge id the till minted. A ledger
--    entry, never a sale: no kitchen ticket, no stock, no bands.
--
-- 2. `pos.party_payment` — money taken against a party's balance
--    (`addPartyPayment`), keyed by the payment id the till minted. The money
--    is a `pos.payment_attempt` with no sale (one per payment, unique), so
--    amount, tender, trading day and paid time stay the ledger's;
--    `party_date` is the party's day when it was taken, which End of Day
--    compares with the trading day for the `party_prepay` line.
--
-- 3. `pos.party_edit` — an edit a till made to a party (`updateParty`): the
--    fields it changed, and whether the OTO App has taken it (`sync_state`),
--    written back through the directory API under the edit's own id.
--
-- Expand-only: three new tables, nothing that exists is touched.
--
CREATE TABLE "pos"."party_charge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"otoapp_event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"items" jsonb NOT NULL,
	"total_satang" bigint NOT NULL,
	"account_id" uuid,
	"station_id" uuid,
	"box_id" uuid,
	"action_id" text,
	"charged_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_charge_kind_check" CHECK ("pos"."party_charge"."kind" in ('ticket','fnb')),
	CONSTRAINT "party_charge_total_check" CHECK ("pos"."party_charge"."total_satang" >= 0),
	CONSTRAINT "party_charge_items_check" CHECK (jsonb_typeof("pos"."party_charge"."items") = 'array')
);
--> statement-breakpoint
CREATE TABLE "pos"."party_edit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"otoapp_event_id" uuid NOT NULL,
	"fields" jsonb NOT NULL,
	"sync_state" text DEFAULT 'pending' NOT NULL,
	"sync_attempts" integer DEFAULT 0 NOT NULL,
	"sync_error" text,
	"last_sync_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"account_id" uuid,
	"station_id" uuid,
	"box_id" uuid,
	"action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_edit_sync_check" CHECK ("pos"."party_edit"."sync_state" in ('synced','pending','failed')),
	CONSTRAINT "party_edit_fields_check" CHECK (jsonb_typeof("pos"."party_edit"."fields") = 'object'),
	CONSTRAINT "party_edit_synced_check" CHECK ("pos"."party_edit"."sync_state" <> 'synced' or "pos"."party_edit"."synced_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "pos"."party_payment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"otoapp_event_id" uuid NOT NULL,
	"payment_attempt_id" uuid NOT NULL,
	"party_date" date NOT NULL,
	"account_id" uuid,
	"station_id" uuid,
	"box_id" uuid,
	"action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pos"."party_charge" ADD CONSTRAINT "party_charge_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_charge" ADD CONSTRAINT "party_charge_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_charge" ADD CONSTRAINT "party_charge_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_charge" ADD CONSTRAINT "party_charge_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_charge" ADD CONSTRAINT "party_charge_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_edit" ADD CONSTRAINT "party_edit_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_edit" ADD CONSTRAINT "party_edit_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_edit" ADD CONSTRAINT "party_edit_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_edit" ADD CONSTRAINT "party_edit_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_edit" ADD CONSTRAINT "party_edit_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_payment" ADD CONSTRAINT "party_payment_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_payment" ADD CONSTRAINT "party_payment_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_payment" ADD CONSTRAINT "party_payment_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "pos"."payment_attempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_payment" ADD CONSTRAINT "party_payment_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_payment" ADD CONSTRAINT "party_payment_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_payment" ADD CONSTRAINT "party_payment_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "party_charge_operator_idx" ON "pos"."party_charge" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "party_charge_branch_idx" ON "pos"."party_charge" USING btree ("branch_id","charged_at");--> statement-breakpoint
CREATE INDEX "party_charge_event_idx" ON "pos"."party_charge" USING btree ("otoapp_event_id","charged_at");--> statement-breakpoint
CREATE INDEX "party_charge_account_idx" ON "pos"."party_charge" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "party_charge_station_idx" ON "pos"."party_charge" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "party_charge_box_idx" ON "pos"."party_charge" USING btree ("box_id");--> statement-breakpoint
CREATE INDEX "party_edit_operator_idx" ON "pos"."party_edit" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "party_edit_branch_idx" ON "pos"."party_edit" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "party_edit_event_idx" ON "pos"."party_edit" USING btree ("otoapp_event_id","created_at");--> statement-breakpoint
CREATE INDEX "party_edit_account_idx" ON "pos"."party_edit" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "party_edit_station_idx" ON "pos"."party_edit" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "party_edit_box_idx" ON "pos"."party_edit" USING btree ("box_id");--> statement-breakpoint
CREATE INDEX "party_edit_unsynced_idx" ON "pos"."party_edit" USING btree ("sync_state","created_at") WHERE sync_state <> 'synced';--> statement-breakpoint
CREATE UNIQUE INDEX "party_payment_attempt_unique" ON "pos"."party_payment" USING btree ("payment_attempt_id");--> statement-breakpoint
CREATE INDEX "party_payment_operator_idx" ON "pos"."party_payment" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "party_payment_branch_day_idx" ON "pos"."party_payment" USING btree ("branch_id","party_date");--> statement-breakpoint
CREATE INDEX "party_payment_event_idx" ON "pos"."party_payment" USING btree ("otoapp_event_id");--> statement-breakpoint
CREATE INDEX "party_payment_account_idx" ON "pos"."party_payment" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "party_payment_station_idx" ON "pos"."party_payment" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "party_payment_box_idx" ON "pos"."party_payment" USING btree ("box_id");