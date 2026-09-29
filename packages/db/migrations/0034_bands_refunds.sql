-- S2-11 (SCRUM-208) — signed bands, their events, and refunds.
--
-- `pos.band` has existed since Sprint 1 as a placeholder: an operator, a
-- nullable branch, a bare `code`, a status defaulting to `inactive` and a
-- jsonb. Nothing has ever written a row to it — the demo reset deletes from it
-- and the box's `bands` cache scope reads it, both of an empty table — so it is
-- reshaped IN PLACE rather than dropped and recreated: `pos.sale_line.band_id`
-- already points at it, and that foreign key stays as it is.
--
-- **The guard is deliberately loud.** The reshape adds a NOT NULL `sale_id`
-- and drops `payload`, which is only safe on an empty table. A deployment that
-- somehow holds band rows stops here with a sentence rather than losing them
-- (the same guard 0014 put in front of the sales ledger).
--
-- Two new tables: `pos.band_event`, append-only, and `pos.refund`, numbered
-- from `pos.receipt_series` kind `refund` (a kind 0014 already allowed).
-- Nothing else is altered.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "pos"."band") THEN
    RAISE EXCEPTION 'pos.band is not empty: this migration reshapes the Sprint 1 placeholder and would destroy real bands. Migrate the rows before running it.';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "pos"."band_code_idx";--> statement-breakpoint
ALTER TABLE "pos"."band" DROP COLUMN "payload";--> statement-breakpoint
ALTER TABLE "pos"."band" DROP CONSTRAINT "band_operator_id_operator_id_fk";--> statement-breakpoint
ALTER TABLE "pos"."band" DROP CONSTRAINT "band_branch_id_branch_id_fk";--> statement-breakpoint
ALTER TABLE "pos"."band" ALTER COLUMN "branch_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."band" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "pos"."band" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "pos"."band" ADD COLUMN "sale_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."band" ADD COLUMN "sale_line_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."band" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."band" ADD COLUMN "child_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."band" ADD COLUMN "printed_job_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."band" ADD CONSTRAINT "band_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."band" ADD CONSTRAINT "band_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."band" ADD CONSTRAINT "band_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."band" ADD CONSTRAINT "band_sale_line_id_sale_line_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "pos"."sale_line"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."band" ADD CONSTRAINT "band_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "crm"."member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."band" ADD CONSTRAINT "band_child_id_child_id_fk" FOREIGN KEY ("child_id") REFERENCES "crm"."child"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "band_code_unique" ON "pos"."band" USING btree ("code");--> statement-breakpoint
CREATE INDEX "band_sale_idx" ON "pos"."band" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "band_sale_line_idx" ON "pos"."band" USING btree ("sale_line_id");--> statement-breakpoint
CREATE INDEX "band_member_idx" ON "pos"."band" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "band_child_idx" ON "pos"."band" USING btree ("child_id");--> statement-breakpoint
CREATE INDEX "band_branch_status_idx" ON "pos"."band" USING btree ("branch_id","status");--> statement-breakpoint
ALTER TABLE "pos"."band" ADD CONSTRAINT "band_kind_check" CHECK ("pos"."band"."kind" in ('kid','adult'));--> statement-breakpoint
ALTER TABLE "pos"."band" ADD CONSTRAINT "band_status_check" CHECK ("pos"."band"."status" in ('active','replaced','revoked'));--> statement-breakpoint
ALTER TABLE "pos"."band" ADD CONSTRAINT "band_child_kind_check" CHECK ("pos"."band"."child_id" is null or "pos"."band"."kind" = 'kid');--> statement-breakpoint
CREATE TABLE "pos"."band_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"band_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"station_id" uuid,
	"box_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "band_event_kind_check" CHECK ("pos"."band_event"."kind" in ('minted','reprinted','replaced','revoked','scanned'))
);
--> statement-breakpoint
ALTER TABLE "pos"."band_event" ADD CONSTRAINT "band_event_band_id_band_id_fk" FOREIGN KEY ("band_id") REFERENCES "pos"."band"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."band_event" ADD CONSTRAINT "band_event_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."band_event" ADD CONSTRAINT "band_event_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "band_event_band_idx" ON "pos"."band_event" USING btree ("band_id","created_at");--> statement-breakpoint
CREATE INDEX "band_event_station_idx" ON "pos"."band_event" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "band_event_box_idx" ON "pos"."band_event" USING btree ("box_id");--> statement-breakpoint
CREATE TABLE "pos"."refund" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"number" text NOT NULL,
	"amount_satang" bigint NOT NULL,
	"mode" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"approved_by_account_id" uuid NOT NULL,
	"created_by_account_id" uuid NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tender_allocation" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_amount_check" CHECK ("pos"."refund"."amount_satang" > 0),
	CONSTRAINT "refund_mode_check" CHECK ("pos"."refund"."mode" in ('whole','items','custom')),
	CONSTRAINT "refund_reason_check" CHECK (length(trim("pos"."refund"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "pos"."refund" ADD CONSTRAINT "refund_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."refund" ADD CONSTRAINT "refund_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."refund" ADD CONSTRAINT "refund_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."refund" ADD CONSTRAINT "refund_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."refund" ADD CONSTRAINT "refund_approved_by_account_id_account_id_fk" FOREIGN KEY ("approved_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."refund" ADD CONSTRAINT "refund_created_by_account_id_account_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refund_number_unique" ON "pos"."refund" USING btree ("branch_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "refund_action_unique" ON "pos"."refund" USING btree ("operator_id","action_id") WHERE action_id is not null;--> statement-breakpoint
CREATE INDEX "refund_operator_idx" ON "pos"."refund" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "refund_sale_idx" ON "pos"."refund" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "refund_station_idx" ON "pos"."refund" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "refund_branch_created_idx" ON "pos"."refund" USING btree ("branch_id","created_at");--> statement-breakpoint
CREATE INDEX "refund_approved_by_idx" ON "pos"."refund" USING btree ("approved_by_account_id");--> statement-breakpoint
CREATE INDEX "refund_created_by_idx" ON "pos"."refund" USING btree ("created_by_account_id");
