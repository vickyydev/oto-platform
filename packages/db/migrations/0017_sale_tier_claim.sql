-- SCRUM-311 — the document check gets a table, and a sale says which one
-- priced it.
--
-- SCRUM-307 put the claim in `core.audit_log` and said in the service why: the
-- schema package belonged to another ticket in flight, and a claim is an
-- append-only fact of a shape the log already records. The same comment listed
-- what that cost — a claim was NOT single-use, because marking one spent needs
-- a column somebody can set, and the sale could not name the claim that priced
-- it, because `pos.sale` had nowhere to put the id. So the same passport check
-- could price a second cart minutes later, and "why was this guest charged the
-- expat rate" was answerable only by matching a sale against the log on branch,
-- tier and time. This is those two sentences withdrawn.
--
-- **The audit row stays.** `sale_tier_claim.create` is still written beside the
-- row, in the same transaction, and every assertion about what a claim may
-- carry still reads it. The log is the trail; this table is the record.
--
-- **What makes it single-use** is `spent_by_sale_id`, set by a conditional
-- update — `where spent_by_sale_id is null` — inside the transaction that
-- writes the sale, so two carts racing for one claim cannot both win it. The
-- partial unique on `pos.sale.tier_claim_id` is the net under that, for the
-- write that does not come through the service.
--
-- **Create and add only.** One new table, one nullable column on `pos.sale`,
-- five foreign keys and five indexes. Nothing is renamed, retyped, backfilled
-- or dropped, so nothing here can refuse to build on a live database, and every
-- sale already written keeps a null `tier_claim_id` — which is the true answer
-- for a sale priced from a member's record or the operator's default.

CREATE TABLE "pos"."sale_tier_claim" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"action_id" text NOT NULL,
	"to_tier" text NOT NULL,
	"evidence_type" text NOT NULL,
	"evidence_expires_at" date NOT NULL,
	"spent_by_sale_id" uuid,
	"spent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_tier_claim_spent_check" CHECK (("pos"."sale_tier_claim"."spent_by_sale_id" is null) = ("pos"."sale_tier_claim"."spent_at" is null))
);
--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD COLUMN "tier_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."sale_tier_claim" ADD CONSTRAINT "sale_tier_claim_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_tier_claim" ADD CONSTRAINT "sale_tier_claim_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_tier_claim" ADD CONSTRAINT "sale_tier_claim_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_tier_claim" ADD CONSTRAINT "sale_tier_claim_spent_by_sale_id_sale_id_fk" FOREIGN KEY ("spent_by_sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_tier_claim_action_unique" ON "pos"."sale_tier_claim" USING btree ("operator_id","action_id");--> statement-breakpoint
CREATE INDEX "sale_tier_claim_session_idx" ON "pos"."sale_tier_claim" USING btree ("account_id","branch_id","created_at");--> statement-breakpoint
CREATE INDEX "sale_tier_claim_branch_idx" ON "pos"."sale_tier_claim" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "sale_tier_claim_sale_idx" ON "pos"."sale_tier_claim" USING btree ("spent_by_sale_id");--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_tier_claim_id_sale_tier_claim_id_fk" FOREIGN KEY ("tier_claim_id") REFERENCES "pos"."sale_tier_claim"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_tier_claim_unique" ON "pos"."sale" USING btree ("tier_claim_id") WHERE tier_claim_id is not null;