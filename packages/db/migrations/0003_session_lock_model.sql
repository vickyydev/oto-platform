ALTER TABLE "session" ADD COLUMN "class" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
CREATE INDEX "session_account_live_idx" ON "session" USING btree ("account_id","revoked_at");--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_class_check" CHECK ("class" IN ('staff','display','box','kiosk'));
