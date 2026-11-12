-- SCRUM-908 (the WhatsApp test line on Twilio's sandbox) -
-- 0121_inbox_twilio_test_line, journalled after
-- 0120_registration_contact_confirmed (SCRUM-857). PROVISIONAL NUMBER: the
-- lander renumbers it if another lane lands a 0121 first.
-- expand-only in effect: one provider added to a CHECK (a swap that only
-- WIDENS it), two nullable columns on inbox.conversation with their foreign
-- key, index and CHECK, and the thread key narrowed to the live threads.
-- Nothing is dropped for good or renamed; no row changes; a release that
-- does not know the columns never sets them, and every existing thread is
-- live (archived_at null), so the narrowed key holds exactly what it held.
--
--   channel_account_provider_check   + 'twilio'
--   inbox.conversation.archived_at              timestamptz, null
--   inbox.conversation.archived_by_account_id   uuid, null -> core.account(id)
--       a test line's conversation a person cleared with Start over, and
--       who: both set or both null (conversation_archived_check).
--   conversation_archived_by_idx     the foreign key's index.
--   conversation_thread_unique       one LIVE thread per contact per channel
--       account (WHERE archived_at is null): a cleared thread stands aside,
--       and the number's next message opens a new one.
--
-- TO REVERSE: the full thread key cannot be rebuilt while a cleared thread
-- and a live one share (operator_id, contact_id, channel_account_id), so
-- first re-point each cleared thread to a contact of its own (the erasure's
-- "Erased contact" shape) - they exist only on a test line. Then drop
-- conversation_archived_check, conversation_archived_by_idx, the foreign key
-- conversation_archived_by_account_id_account_id_fk and the two columns;
-- recreate conversation_thread_unique on (operator_id, contact_id,
-- channel_account_id) with no WHERE; archive every 'twilio' channel account
-- and swap channel_account_provider_check back to the list of
-- 0078_inbox_schema once no row says 'twilio'.
ALTER TABLE "inbox"."channel_account" DROP CONSTRAINT "channel_account_provider_check";--> statement-breakpoint
DROP INDEX "inbox"."conversation_thread_unique";--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD COLUMN "archived_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD CONSTRAINT "conversation_archived_by_account_id_account_id_fk" FOREIGN KEY ("archived_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_archived_by_idx" ON "inbox"."conversation" USING btree ("archived_by_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_thread_unique" ON "inbox"."conversation" USING btree ("operator_id","contact_id","channel_account_id") WHERE archived_at is null;--> statement-breakpoint
ALTER TABLE "inbox"."channel_account" ADD CONSTRAINT "channel_account_provider_check" CHECK ("inbox"."channel_account"."provider" in ('meta_cloud','meta_graph','line','respond_io','webform','simulator','console','twilio'));--> statement-breakpoint
ALTER TABLE "inbox"."conversation" ADD CONSTRAINT "conversation_archived_check" CHECK (("inbox"."conversation"."archived_at" is null) = ("inbox"."conversation"."archived_by_account_id" is null));