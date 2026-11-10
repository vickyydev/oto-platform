-- SCRUM-824 (a customer's voice note, transcribed and read like typed text) -
-- expand-only: four new columns on inbox.message, one partial index and three
-- checks. Nothing existing is rewritten or dropped, and a release that does not
-- know them never reads them. The words go in inbox.message.transcript, which
-- already exists and stayed empty until now.
--
--   inbox.message.transcript_status            text, null
--       pending | done | failed | too_long | off, on a voice note only; null on
--       every other message and on the voice notes that arrived before this.
--   inbox.message.transcript_language          text, null
--       the language the note was heard in, an ISO 639-1 code (th, ru, en).
--   inbox.message.transcript_attempts          integer, not null, default 0
--   inbox.message.transcript_next_attempt_at   timestamptz, null
--       job:inbox.transcribe's ledger, as the send job's send_attempts and
--       next_attempt_at: how many times the provider was asked, and when the
--       job may ask again. PostgreSQL adds a column with a constant default
--       without rewriting the table.
--   message_transcript_queue_idx               the job's sweep, pending rows only.
ALTER TABLE "inbox"."message" ADD COLUMN "transcript_status" text;--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD COLUMN "transcript_language" text;--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD COLUMN "transcript_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD COLUMN "transcript_next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "message_transcript_queue_idx" ON "inbox"."message" USING btree ("transcript_next_attempt_at") WHERE transcript_status = 'pending';--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD CONSTRAINT "message_transcript_status_check" CHECK ("inbox"."message"."transcript_status" is null or "inbox"."message"."transcript_status" in ('pending','done','failed','too_long','off'));--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD CONSTRAINT "message_transcript_language_check" CHECK ("inbox"."message"."transcript_language" is null or "inbox"."message"."transcript_language" ~ '^[a-z]{2,3}$');--> statement-breakpoint
ALTER TABLE "inbox"."message" ADD CONSTRAINT "message_transcript_attempts_check" CHECK ("inbox"."message"."transcript_attempts" >= 0);
