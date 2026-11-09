-- SCRUM-804 (a birthday party settled as one real sale) - expand-only: one new
-- table, nothing existing altered. A release that does not know it never reads
-- it, and every row it holds names a sale that is an ordinary sale.
--
--   pos.party_settlement   which sale settled which OTO App party, what was
--       counted (children, adults, socks handed out), the rate the party's
--       date priced it at, the plan as it was priced (a snapshot), the deposit
--       recorded on the sale and the party edit that writes the sale's id back
--       to the app. One live settlement per party (released_at null); a
--       later one releases it only when its sale was voided or refunded.
CREATE TABLE "pos"."party_settlement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"otoapp_event_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"kids" integer NOT NULL,
	"adults" integer NOT NULL,
	"socks_given" integer NOT NULL,
	"tier" text,
	"rate_mode" text NOT NULL,
	"party_date" date NOT NULL,
	"plan" jsonb NOT NULL,
	"deposit_satang" bigint DEFAULT 0 NOT NULL,
	"deposit_attempt_id" uuid,
	"write_back_edit_id" uuid,
	"settled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"account_id" uuid,
	"station_id" uuid,
	"box_id" uuid,
	"action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_settlement_counts_check" CHECK ("pos"."party_settlement"."kids" >= 0 and "pos"."party_settlement"."adults" >= 0 and "pos"."party_settlement"."socks_given" >= 0),
	CONSTRAINT "party_settlement_deposit_check" CHECK ("pos"."party_settlement"."deposit_satang" >= 0),
	CONSTRAINT "party_settlement_rate_mode_check" CHECK ("pos"."party_settlement"."rate_mode" in ('weekday','weekend')),
	CONSTRAINT "party_settlement_plan_check" CHECK (jsonb_typeof("pos"."party_settlement"."plan") = 'object')
);
--> statement-breakpoint
ALTER TABLE "pos"."party_settlement" ADD CONSTRAINT "party_settlement_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_settlement" ADD CONSTRAINT "party_settlement_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_settlement" ADD CONSTRAINT "party_settlement_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_settlement" ADD CONSTRAINT "party_settlement_deposit_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("deposit_attempt_id") REFERENCES "pos"."payment_attempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_settlement" ADD CONSTRAINT "party_settlement_write_back_edit_id_party_edit_id_fk" FOREIGN KEY ("write_back_edit_id") REFERENCES "pos"."party_edit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_settlement" ADD CONSTRAINT "party_settlement_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_settlement" ADD CONSTRAINT "party_settlement_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_settlement" ADD CONSTRAINT "party_settlement_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "party_settlement_sale_unique" ON "pos"."party_settlement" USING btree ("sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "party_settlement_live_unique" ON "pos"."party_settlement" USING btree ("otoapp_event_id") WHERE released_at is null;--> statement-breakpoint
CREATE INDEX "party_settlement_operator_idx" ON "pos"."party_settlement" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "party_settlement_branch_idx" ON "pos"."party_settlement" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "party_settlement_event_idx" ON "pos"."party_settlement" USING btree ("otoapp_event_id","created_at");--> statement-breakpoint
CREATE INDEX "party_settlement_deposit_attempt_idx" ON "pos"."party_settlement" USING btree ("deposit_attempt_id");--> statement-breakpoint
CREATE INDEX "party_settlement_write_back_idx" ON "pos"."party_settlement" USING btree ("write_back_edit_id");--> statement-breakpoint
CREATE INDEX "party_settlement_account_idx" ON "pos"."party_settlement" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "party_settlement_station_idx" ON "pos"."party_settlement" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "party_settlement_box_idx" ON "pos"."party_settlement" USING btree ("box_id");