ALTER TABLE "fix_comments" ADD COLUMN "media" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "fix_reports" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "fix_reports" ADD COLUMN "archived_by_user_id" varchar;--> statement-breakpoint
ALTER TABLE "fix_reports" ADD CONSTRAINT "fix_reports_archived_by_user_id_users_id_fk" FOREIGN KEY ("archived_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_fix_comments_media" ON "fix_comments" USING gin ("media");