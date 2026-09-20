ALTER TABLE "users" ADD COLUMN "platform_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_platform_user_id_unique" UNIQUE("platform_user_id");