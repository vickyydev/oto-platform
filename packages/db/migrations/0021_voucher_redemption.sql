CREATE TABLE "promo"."redemption_throttle" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"recent_misses" timestamp with time zone[] DEFAULT '{}'::timestamptz[] NOT NULL,
	"locked_until" timestamp with time zone,
	"lock_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redemption_throttle_lock_count_check" CHECK ("promo"."redemption_throttle"."lock_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "promo"."voucher_redemption" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sale_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"account_id" uuid,
	"reason" text,
	"request_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_redemption_kind_check" CHECK ("promo"."voucher_redemption"."kind" in ('held','applied','consumed','released')),
	CONSTRAINT "voucher_redemption_reason_check" CHECK (("promo"."voucher_redemption"."kind" = 'released') = ("promo"."voucher_redemption"."reason" is not null)
          and ("promo"."voucher_redemption"."reason" is null or "promo"."voucher_redemption"."reason" in ('line_removed','sale_voided','moved','lapsed','sale_closed')))
);
--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD COLUMN "redeemed_station_id" uuid;--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD COLUMN "held_sale_id" uuid;--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD COLUMN "held_station_id" uuid;--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD COLUMN "held_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD COLUMN "held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "promo"."redemption_throttle" ADD CONSTRAINT "redemption_throttle_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."redemption_throttle" ADD CONSTRAINT "redemption_throttle_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."redemption_throttle" ADD CONSTRAINT "redemption_throttle_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_redemption" ADD CONSTRAINT "voucher_redemption_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_redemption" ADD CONSTRAINT "voucher_redemption_voucher_id_voucher_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "promo"."voucher"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_redemption" ADD CONSTRAINT "voucher_redemption_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_redemption" ADD CONSTRAINT "voucher_redemption_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_redemption" ADD CONSTRAINT "voucher_redemption_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "redemption_throttle_operator_idx" ON "promo"."redemption_throttle" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "redemption_throttle_branch_idx" ON "promo"."redemption_throttle" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "voucher_redemption_voucher_idx" ON "promo"."voucher_redemption" USING btree ("voucher_id","occurred_at");--> statement-breakpoint
CREATE INDEX "voucher_redemption_sale_idx" ON "promo"."voucher_redemption" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "voucher_redemption_operator_idx" ON "promo"."voucher_redemption" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "voucher_redemption_branch_idx" ON "promo"."voucher_redemption" USING btree ("branch_id","occurred_at");--> statement-breakpoint
CREATE INDEX "voucher_redemption_station_idx" ON "promo"."voucher_redemption" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "voucher_redemption_account_idx" ON "promo"."voucher_redemption" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_redeemed_station_id_station_id_fk" FOREIGN KEY ("redeemed_station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_held_station_id_station_id_fk" FOREIGN KEY ("held_station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_held_by_account_id_account_id_fk" FOREIGN KEY ("held_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voucher_redeemed_station_idx" ON "promo"."voucher" USING btree ("redeemed_station_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voucher_held_sale_unique" ON "promo"."voucher" USING btree ("held_sale_id") WHERE held_sale_id is not null;--> statement-breakpoint
CREATE INDEX "voucher_held_station_idx" ON "promo"."voucher" USING btree ("held_station_id");--> statement-breakpoint
CREATE INDEX "voucher_held_by_idx" ON "promo"."voucher" USING btree ("held_by_account_id");--> statement-breakpoint
ALTER TABLE "promo"."voucher" ADD CONSTRAINT "voucher_hold_check" CHECK (("promo"."voucher"."held_sale_id" is null and "promo"."voucher"."held_station_id" is null and "promo"."voucher"."held_at" is null and "promo"."voucher"."held_by_account_id" is null)
          or ("promo"."voucher"."held_sale_id" is not null and "promo"."voucher"."held_station_id" is not null and "promo"."voucher"."held_at" is not null and "promo"."voucher"."status" = 'issued'));--> statement-breakpoint
-- S2-10b — the redemption ledger is append-only. A voucher's history is the
-- evidence of who gave away what, and a history that can be edited is not
-- evidence: an UPDATE or a DELETE on this table is refused, from any caller,
-- the api included. `promo.voucher`'s own columns are the mirror that moves.
CREATE OR REPLACE FUNCTION "promo"."voucher_redemption_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'promo.voucher_redemption is append-only: % refused (promo.voucher_redemption_append_only)', TG_OP
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "voucher_redemption_append_only" BEFORE UPDATE OR DELETE ON "promo"."voucher_redemption"
  FOR EACH ROW EXECUTE FUNCTION "promo"."voucher_redemption_append_only"();
--> statement-breakpoint
-- S2-10b — A VOIDED SALE HOLDS NO VOUCHER (owner, 24 Sept: "released if the
-- line is removed or the sale is voided").
--
-- In the database rather than in whichever service voids a sale, because no
-- route voids one yet and several will: the till's cancel, a manager's void,
-- a box's offline replay. Written here, the rule holds for all of them and for
-- a correction made in psql, in the same transaction as the void.
--
-- Only a HELD voucher is let go. One already used up stays used up: whether a
-- void or a refund after payment gives a family its voucher back is the refund
-- ticket's decision (S2-11), not a side effect of a status change.
--
-- The ledger row's id is `gen_random_uuid()` (v4) rather than the platform's
-- v7, as in 0012 and 0018: there is no v7 generator in the database, and this
-- is the one place a redemption row is not minted by the service that owns it.
CREATE OR REPLACE FUNCTION "promo"."release_vouchers_on_void"() RETURNS trigger AS $$
BEGIN
  INSERT INTO "promo"."voucher_redemption"
    ("id", "operator_id", "voucher_id", "kind", "sale_id", "branch_id", "station_id", "account_id", "reason", "occurred_at")
  SELECT gen_random_uuid(), v."operator_id", v."id", 'released', NEW."id", NEW."branch_id", NEW."station_id",
         NEW."voided_by_account_id", 'sale_voided', coalesce(NEW."voided_at", now())
    FROM "promo"."voucher" v
   WHERE v."held_sale_id" = NEW."id" AND v."status" = 'issued';

  UPDATE "promo"."voucher"
     SET "held_sale_id" = NULL, "held_station_id" = NULL, "held_by_account_id" = NULL,
         "held_at" = NULL, "updated_at" = now()
   WHERE "held_sale_id" = NEW."id" AND "status" = 'issued';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "sale_void_releases_vouchers" AFTER UPDATE OF "status" ON "pos"."sale"
  FOR EACH ROW WHEN (NEW."status" = 'voided' AND OLD."status" IS DISTINCT FROM 'voided')
  EXECUTE FUNCTION "promo"."release_vouchers_on_void"();
