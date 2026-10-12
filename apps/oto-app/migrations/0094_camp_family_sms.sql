CREATE TABLE "camp_family_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"phone_e164" text NOT NULL,
	"provider_id" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"registration_ids" jsonb NOT NULL,
	"grant_hash" text,
	"grant_purpose" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "camp_family_challenges" ADD CONSTRAINT "camp_family_challenges_event_id_core_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "camp_family_event_phone_idx" ON "camp_family_challenges" USING btree ("event_id","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "camp_family_grant_hash_unique" ON "camp_family_challenges" USING btree ("grant_hash");--> statement-breakpoint
CREATE INDEX "camp_family_expiry_idx" ON "camp_family_challenges" USING btree ("expires_at");