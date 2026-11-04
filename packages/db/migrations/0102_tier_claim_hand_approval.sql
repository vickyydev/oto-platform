ALTER TABLE "pos"."sale_tier_claim" ADD COLUMN "approval_reason" text;--> statement-breakpoint
ALTER TABLE "pos"."sale_tier_claim" ADD COLUMN "approval_reason_text" text;--> statement-breakpoint
ALTER TABLE "pos"."sale_tier_claim" ADD COLUMN "approval_note" text;--> statement-breakpoint
CREATE INDEX "sale_tier_claim_approval_idx" ON "pos"."sale_tier_claim" USING btree ("operator_id","account_id","created_at") WHERE approval_reason is not null;--> statement-breakpoint
ALTER TABLE "pos"."sale_tier_claim" ADD CONSTRAINT "sale_tier_claim_approval_check" CHECK ("pos"."sale_tier_claim"."approval_reason" is not null or ("pos"."sale_tier_claim"."approval_reason_text" is null and "pos"."sale_tier_claim"."approval_note" is null));