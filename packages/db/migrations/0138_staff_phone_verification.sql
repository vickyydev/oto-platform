ALTER TABLE "core"."verification_code" DROP CONSTRAINT "verification_code_purpose_check";--> statement-breakpoint
ALTER TABLE "core"."verification_code" ADD COLUMN "destination_digest" text;--> statement-breakpoint
ALTER TABLE "core"."verification_code" ADD CONSTRAINT "verification_code_purpose_check" CHECK ("core"."verification_code"."purpose" in ('setup','password_reset','verify_phone'));