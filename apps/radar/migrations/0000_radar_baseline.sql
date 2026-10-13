CREATE TABLE "booth_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"source" text NOT NULL,
	"event_type" text NOT NULL,
	"claim_id" text NOT NULL,
	"prize_name" text,
	"phone" text,
	"code" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "booth_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"device_id" text,
	"clicked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_qrs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"token" text NOT NULL,
	"short_code" text NOT NULL,
	"device_id" text NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"saved_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"redeemed_by" text,
	CONSTRAINT "campaign_qrs_token_unique" UNIQUE("token"),
	CONSTRAINT "campaign_qrs_short_code_unique" UNIQUE("short_code"),
	CONSTRAINT "short_code_len_valid" CHECK (length("campaign_qrs"."short_code") IN (4, 6))
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"promo_code" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"usage_cap" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_birthdays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"full_name" text,
	"branch" text NOT NULL,
	"department" text NOT NULL,
	"birth_month" integer NOT NULL,
	"birth_day" integer NOT NULL,
	"birth_year" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visitor_survey_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch" text NOT NULL,
	"visitor_type" text NOT NULL,
	"discovery_channel" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_clicks" ADD CONSTRAINT "campaign_clicks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_qrs" ADD CONSTRAINT "campaign_qrs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_booth_events_claim" ON "booth_events" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_booth_events_occurred" ON "booth_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_campaign_clicks_campaign" ON "campaign_clicks" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_campaign_qrs_campaign" ON "campaign_qrs" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_campaign_qrs_campaign_device" ON "campaign_qrs" USING btree ("campaign_id","device_id");--> statement-breakpoint
CREATE INDEX "idx_campaign_qrs_token" ON "campaign_qrs" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_staff_birthdays_branch" ON "staff_birthdays" USING btree ("branch");--> statement-breakpoint
CREATE INDEX "idx_staff_birthdays_md" ON "staff_birthdays" USING btree ("birth_month","birth_day");--> statement-breakpoint
CREATE INDEX "idx_visitor_survey_branch_submitted" ON "visitor_survey_responses" USING btree ("branch","submitted_at");