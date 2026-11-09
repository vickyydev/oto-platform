-- SCRUM-772 (the Thai rate confirmed at the till, with no document) -
-- expand-only: two nullable columns, which PostgreSQL adds without rewriting
-- either table, their foreign keys and an index on each. A release that does
-- not know the columns never reads them.
ALTER TABLE "crm"."member_tier_verification" ADD COLUMN "station_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."sale_tier_claim" ADD COLUMN "station_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."member_tier_verification" ADD CONSTRAINT "member_tier_verification_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."sale_tier_claim" ADD CONSTRAINT "sale_tier_claim_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mtv_station_idx" ON "crm"."member_tier_verification" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "sale_tier_claim_station_idx" ON "pos"."sale_tier_claim" USING btree ("station_id");