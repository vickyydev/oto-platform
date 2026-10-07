-- S2-21 (SCRUM-218), staff benefits round 3 — checkout. The plan is
-- docs/progress/plans/benefits/PLAN.md §4, §7 and §8 round 3. Forward-only.
-- Landed as 0071, after the event attendee link (0070); the snapshot was
-- regenerated at landing so its chain and tables carry 0070's.
--
-- `promo.benefit_usage`: one quota counter per person, item (`free:<id>` or
-- `credit`) and period key (`YYYY-MM-DD` daily, `YYYY-MM` monthly). The claim
-- is one conditional insert-or-update inside the sale's transaction, so two
-- tills taking the last coffee give one success and one row (H1).
--
-- `promo.benefit_application`: one staff benefit applied to one sale — whose
-- QR, which credential, who processed it at which station and box, the comp
-- flag, the four amounts in satang and the counters it moved. At most one
-- live application per till-minted client id (a partial unique index), so a
-- scan claims its quota once however often its order is rung up.
--
-- `pos.sale_discount.benefit_application_id`: the "Staff benefit" row's link
-- to its application. Additive and nullable; no existing check changes.
-- Nothing is written into the new tables.
--
CREATE TABLE "promo"."benefit_application" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"employee_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"benefit_role" text NOT NULL,
	"profile_snapshot" jsonb NOT NULL,
	"engine_version" text NOT NULL,
	"processed_by_account_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"box_id" uuid,
	"origin" text DEFAULT 'cloud' NOT NULL,
	"is_comp" boolean DEFAULT false NOT NULL,
	"comped_satang" bigint DEFAULT 0 NOT NULL,
	"free_items_satang" bigint DEFAULT 0 NOT NULL,
	"credit_satang" bigint DEFAULT 0 NOT NULL,
	"discount_satang" bigint DEFAULT 0 NOT NULL,
	"total_relief_satang" bigint DEFAULT 0 NOT NULL,
	"applied_satang" bigint DEFAULT 0 NOT NULL,
	"usage_deltas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"line_relief" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_account_id" uuid,
	"removed_reason" text,
	"reversed_at" timestamp with time zone,
	"reversed_by_refund_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benefit_application_role_check" CHECK ("promo"."benefit_application"."benefit_role" in ('owner','manager','staff')),
	CONSTRAINT "benefit_application_origin_check" CHECK ("promo"."benefit_application"."origin" in ('cloud','box')),
	CONSTRAINT "benefit_application_amounts_check" CHECK ("promo"."benefit_application"."comped_satang" >= 0 and "promo"."benefit_application"."free_items_satang" >= 0 and "promo"."benefit_application"."credit_satang" >= 0 and "promo"."benefit_application"."discount_satang" >= 0 and "promo"."benefit_application"."applied_satang" >= 0
          and "promo"."benefit_application"."total_relief_satang" = "promo"."benefit_application"."comped_satang" + "promo"."benefit_application"."free_items_satang" + "promo"."benefit_application"."credit_satang" + "promo"."benefit_application"."discount_satang"
          and "promo"."benefit_application"."applied_satang" <= "promo"."benefit_application"."total_relief_satang"),
	CONSTRAINT "benefit_application_removed_check" CHECK (("promo"."benefit_application"."removed_at" is null) = ("promo"."benefit_application"."removed_reason" is null)
          and ("promo"."benefit_application"."removed_reason" is null or "promo"."benefit_application"."removed_reason" in ('removed','voided','moved')))
);
--> statement-breakpoint
CREATE TABLE "promo"."benefit_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"period_kind" text NOT NULL,
	"period_key" text NOT NULL,
	"qty_used" integer DEFAULT 0 NOT NULL,
	"credit_used_satang" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benefit_usage_period_kind_check" CHECK ("promo"."benefit_usage"."period_kind" in ('daily','monthly')),
	CONSTRAINT "benefit_usage_non_negative_check" CHECK ("promo"."benefit_usage"."qty_used" >= 0 and "promo"."benefit_usage"."credit_used_satang" >= 0 and "promo"."benefit_usage"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "pos"."sale_discount" ADD COLUMN "benefit_application_id" uuid;--> statement-breakpoint
ALTER TABLE "promo"."benefit_application" ADD CONSTRAINT "benefit_application_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_application" ADD CONSTRAINT "benefit_application_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_application" ADD CONSTRAINT "benefit_application_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_application" ADD CONSTRAINT "benefit_application_employee_id_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "core"."employee"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_application" ADD CONSTRAINT "benefit_application_credential_id_benefit_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "promo"."benefit_credential"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_application" ADD CONSTRAINT "benefit_application_processed_by_account_id_account_id_fk" FOREIGN KEY ("processed_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_application" ADD CONSTRAINT "benefit_application_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_application" ADD CONSTRAINT "benefit_application_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_application" ADD CONSTRAINT "benefit_application_removed_by_account_id_account_id_fk" FOREIGN KEY ("removed_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_usage" ADD CONSTRAINT "benefit_usage_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_usage" ADD CONSTRAINT "benefit_usage_employee_id_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "core"."employee"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "benefit_application_client_live_unique" ON "promo"."benefit_application" USING btree ("client_id") WHERE removed_at is null;--> statement-breakpoint
CREATE INDEX "benefit_application_client_idx" ON "promo"."benefit_application" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "benefit_application_sale_idx" ON "promo"."benefit_application" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "benefit_application_operator_date_idx" ON "promo"."benefit_application" USING btree ("operator_id","business_date");--> statement-breakpoint
CREATE INDEX "benefit_application_branch_date_idx" ON "promo"."benefit_application" USING btree ("branch_id","business_date");--> statement-breakpoint
CREATE INDEX "benefit_application_employee_idx" ON "promo"."benefit_application" USING btree ("employee_id","occurred_at");--> statement-breakpoint
CREATE INDEX "benefit_application_credential_idx" ON "promo"."benefit_application" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "benefit_application_processed_by_idx" ON "promo"."benefit_application" USING btree ("processed_by_account_id");--> statement-breakpoint
CREATE INDEX "benefit_application_station_idx" ON "promo"."benefit_application" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "benefit_application_box_idx" ON "promo"."benefit_application" USING btree ("box_id");--> statement-breakpoint
CREATE INDEX "benefit_application_removed_by_idx" ON "promo"."benefit_application" USING btree ("removed_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "benefit_usage_unique" ON "promo"."benefit_usage" USING btree ("employee_id","item_key","period_key");--> statement-breakpoint
CREATE INDEX "benefit_usage_operator_idx" ON "promo"."benefit_usage" USING btree ("operator_id","period_key");--> statement-breakpoint
ALTER TABLE "pos"."sale_discount" ADD CONSTRAINT "sale_discount_benefit_application_id_benefit_application_id_fk" FOREIGN KEY ("benefit_application_id") REFERENCES "promo"."benefit_application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_discount_benefit_application_idx" ON "pos"."sale_discount" USING btree ("benefit_application_id");