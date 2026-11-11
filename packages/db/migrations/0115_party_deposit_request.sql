-- SCRUM-825 (a party's deposit asked from the BEO, paid through the gateway's
-- page and watched by the platform) - expand-only: one new table and three
-- CHECK swaps that only WIDEN a list. No row is written here (platform-sync
-- lays the five party templates, insert-if-absent, in English, Thai and
-- Russian).
--
--   pos.party_deposit_request
--       one row per "Request deposit" press: the party (the OTO App's event,
--       no FK - C10), the family's inbox conversation (soft), the amount in
--       satang, requested -> paid | expired | cancelled, the gateway attempt
--       (its invoice), the hosted page's link and expiry, when it was
--       reminded, handed over, paid or closed, the assistant's three lines,
--       the deposit figure before and after the money, the party edit that
--       carried it to the app (SCRUM-804's path), who pressed and the app's
--       Idempotency-Key the row's id is derived from. One open request per
--       party (party_deposit_request_open_unique); the follow-up job reads
--       the open ones oldest first (party_deposit_request_open_idx).
--   inbox.event.kind
--       + deposit_requested, deposit_reminded, deposit_paid, deposit_expired,
--         deposit_cancelled, deposit_overdue, menu_link_sent, menu_received
--   inbox.template.key (and channel_account.out_of_hours_template_key)
--       + party_deposit_request, party_deposit_reminder,
--         party_deposit_received, party_menu_link, party_menu_received
--
-- TO REVERSE (the CHECK restores fail while a row uses a widened value -
-- archive or delete the five party_* templates, clear any out-of-hours key
-- set to one, and delete the eight new event kinds' rows first): drop
-- pos.party_deposit_request, then re-add the three swapped CHECKs with the
-- lists of 0114_inbox_advice_opener (event_kind_check: 0112_inbox_open_question's).
CREATE TABLE "pos"."party_deposit_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"otoapp_event_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"amount_satang" bigint NOT NULL,
	"currency" text DEFAULT 'THB' NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"payment_attempt_id" uuid NOT NULL,
	"invoice_no" text NOT NULL,
	"payment_link" text,
	"link_expires_at" timestamp with time zone,
	"requested_at" timestamp with time zone NOT NULL,
	"reminded_at" timestamp with time zone,
	"handed_over_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"request_message_id" uuid,
	"reminder_message_id" uuid,
	"paid_message_id" uuid,
	"deposit_before_satang" bigint,
	"deposit_after_satang" bigint,
	"write_back_edit_id" uuid,
	"account_id" uuid,
	"actor_app_user_id" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_deposit_request_state_check" CHECK ("pos"."party_deposit_request"."state" in ('requested','paid','expired','cancelled')),
	CONSTRAINT "party_deposit_request_amount_check" CHECK ("pos"."party_deposit_request"."amount_satang" > 0),
	CONSTRAINT "party_deposit_request_currency_check" CHECK ("pos"."party_deposit_request"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "party_deposit_request_paid_check" CHECK ("pos"."party_deposit_request"."state" <> 'paid' or "pos"."party_deposit_request"."paid_at" is not null),
	CONSTRAINT "party_deposit_request_closed_check" CHECK ("pos"."party_deposit_request"."state" not in ('expired','cancelled') or "pos"."party_deposit_request"."closed_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" DROP CONSTRAINT "channel_account_out_of_hours_key_check";--> statement-breakpoint
ALTER TABLE "inbox"."event" DROP CONSTRAINT "event_kind_check";--> statement-breakpoint
ALTER TABLE "inbox"."template" DROP CONSTRAINT "template_key_check";--> statement-breakpoint
ALTER TABLE "pos"."party_deposit_request" ADD CONSTRAINT "party_deposit_request_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_deposit_request" ADD CONSTRAINT "party_deposit_request_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_deposit_request" ADD CONSTRAINT "party_deposit_request_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "pos"."payment_attempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_deposit_request" ADD CONSTRAINT "party_deposit_request_write_back_edit_id_party_edit_id_fk" FOREIGN KEY ("write_back_edit_id") REFERENCES "pos"."party_edit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."party_deposit_request" ADD CONSTRAINT "party_deposit_request_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "party_deposit_request_attempt_unique" ON "pos"."party_deposit_request" USING btree ("payment_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "party_deposit_request_open_unique" ON "pos"."party_deposit_request" USING btree ("otoapp_event_id") WHERE state = 'requested';--> statement-breakpoint
CREATE INDEX "party_deposit_request_operator_idx" ON "pos"."party_deposit_request" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "party_deposit_request_branch_idx" ON "pos"."party_deposit_request" USING btree ("branch_id","requested_at");--> statement-breakpoint
CREATE INDEX "party_deposit_request_event_idx" ON "pos"."party_deposit_request" USING btree ("otoapp_event_id","requested_at");--> statement-breakpoint
CREATE INDEX "party_deposit_request_conversation_idx" ON "pos"."party_deposit_request" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "party_deposit_request_open_idx" ON "pos"."party_deposit_request" USING btree ("requested_at") WHERE state = 'requested';--> statement-breakpoint
CREATE INDEX "party_deposit_request_write_back_idx" ON "pos"."party_deposit_request" USING btree ("write_back_edit_id");--> statement-breakpoint
CREATE INDEX "party_deposit_request_account_idx" ON "pos"."party_deposit_request" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" ADD CONSTRAINT "channel_account_out_of_hours_key_check" CHECK ("inbox"."channel_account"."out_of_hours_template_key" is null or "inbox"."channel_account"."out_of_hours_template_key" in ('welcome','handover_birthday','handover_events','handover_complaint_online','handover_complaint_onsite','handover_lost_found','handover_marketing','out_of_hours','handover_general','follow_up','closing_birthday','closing_gm','closing_branch','closing_unclear','closing_booking','opener_birthday_advice','opener_birthday_advice_park_known','party_deposit_request','party_deposit_reminder','party_deposit_received','party_menu_link','party_menu_received'));--> statement-breakpoint
ALTER TABLE "inbox"."event" ADD CONSTRAINT "event_kind_check" CHECK ("inbox"."event"."kind" in ('received','ai_replied','classified','routed','assigned','released','diverted','moved_team','branch_set','handled','reopened','date_booked','beo_saved','translated','pos_update','sla_breached','notice_mirrored','send_failed','ai_handover','ai_silent','ai_withdrawn','ai_paused','ai_resumed','ai_shadow','deposit_requested','deposit_reminded','deposit_paid','deposit_expired','deposit_cancelled','deposit_overdue','menu_link_sent','menu_received'));--> statement-breakpoint
ALTER TABLE "inbox"."template" ADD CONSTRAINT "template_key_check" CHECK ("inbox"."template"."key" in ('welcome','handover_birthday','handover_events','handover_complaint_online','handover_complaint_onsite','handover_lost_found','handover_marketing','out_of_hours','handover_general','follow_up','closing_birthday','closing_gm','closing_branch','closing_unclear','closing_booking','opener_birthday_advice','opener_birthday_advice_park_known','party_deposit_request','party_deposit_reminder','party_deposit_received','party_menu_link','party_menu_received'));