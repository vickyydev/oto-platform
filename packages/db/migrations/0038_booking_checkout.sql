-- S2-12 (SCRUM-209), arrival round 1 — the booking is paid for real.
--
-- Plan docs/progress/plans/arrival/PLAN.md section 2.1. Until this migration the
-- booking site wrote `status = 'paid'` with no payment at all; from here a
-- booking is written `pending`, is paid only when the gateway's backend
-- notification and a Payment Inquiry agree (or the inquiry poller finds it),
-- and carries a QR the park signed.
--
-- Columns: channel; package and head counts; the one gateway attempt it is
-- paid through; paid_at; expires_at (the hold the pending sweeper ends);
-- business_date (= the visit date; the money sits on the attempt's own day,
-- OD-A10); the server's pricing snapshot; the QR's key fingerprint and
-- signature.
--
-- EXISTING ROWS are staging demo data written by the prototype's simulated
-- flow: they are kept as they are (paid, or redeemed), given paid_at = the
-- instant they were written, no attempt, and a pricing snapshot that SAYS they
-- were never paid through a gateway. Check that production holds no platform
-- booking rows before this runs.
--
-- Forward only. Nothing is dropped and nothing is renamed.

ALTER TABLE "pos"."booking" ADD COLUMN "channel" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD COLUMN "package_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD COLUMN "kids_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD COLUMN "adults_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD COLUMN "payment_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD COLUMN "business_date" date;--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD COLUMN "pricing_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD COLUMN "qr_key_id" text;--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD COLUMN "qr_signature" text;--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD CONSTRAINT "booking_package_id_ticket_package_id_fk" FOREIGN KEY ("package_id") REFERENCES "pos"."ticket_package"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD CONSTRAINT "booking_payment_attempt_id_payment_attempt_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "pos"."payment_attempt"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_package_idx" ON "pos"."booking" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "booking_payment_attempt_idx" ON "pos"."booking" USING btree ("payment_attempt_id");--> statement-breakpoint
CREATE INDEX "booking_status_expires_idx" ON "pos"."booking" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "booking_business_date_idx" ON "pos"."booking" USING btree ("business_date");--> statement-breakpoint
-- The visit date is the booking's business date.
UPDATE "pos"."booking" SET "business_date" = "booking_date" WHERE "business_date" IS NULL;--> statement-breakpoint
-- Head counts, summed off the priced lines the booking site stored.
UPDATE "pos"."booking" b SET
  "kids_count" = coalesce((
    SELECT sum(CASE WHEN (l->>'kids') ~ '^[0-9]+$' THEN (l->>'kids')::integer ELSE 0 END)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b."payload"->'lines') = 'array' THEN b."payload"->'lines' ELSE '[]'::jsonb END) l
  ), 0),
  "adults_count" = coalesce((
    SELECT sum(CASE WHEN (l->>'adults') ~ '^[0-9]+$' THEN (l->>'adults')::integer ELSE 0 END)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b."payload"->'lines') = 'array' THEN b."payload"->'lines' ELSE '[]'::jsonb END) l
  ), 0);--> statement-breakpoint
-- The package, where every line names the same one and it still exists.
UPDATE "pos"."booking" b SET "package_id" = p."id"
FROM "pos"."ticket_package" p
WHERE b."package_id" IS NULL
  AND jsonb_typeof(b."payload"->'lines') = 'array'
  AND (SELECT count(DISTINCT l->>'packageId') FROM jsonb_array_elements(b."payload"->'lines') l) = 1
  AND p."id"::text = (SELECT min(l->>'packageId') FROM jsonb_array_elements(b."payload"->'lines') l);--> statement-breakpoint
-- Paid by the prototype's simulated flow, with no payment behind it: said so.
UPDATE "pos"."booking" SET
  "paid_at" = coalesce("paid_at", "created_at"),
  "pricing_snapshot" = coalesce("pricing_snapshot", jsonb_build_object(
    'legacy', true,
    'paidBy', 'simulated_booking_flow',
    'note', 'Written as paid by the booking site before S2-12; no payment attempt exists for it.',
    'rateMode', "payload"->>'rateMode',
    'tier', "payload"->>'tier',
    'lines', coalesce("payload"->'lines', '[]'::jsonb),
    'totalSatang', "total_satang"
  ))
WHERE "status" IN ('paid', 'redeemed');--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD CONSTRAINT "booking_status_check" CHECK ("pos"."booking"."status" in ('pending','paid','redeemed','expired','cancelled'));--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD CONSTRAINT "booking_channel_check" CHECK ("pos"."booking"."channel" in ('web','counter','import'));--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD CONSTRAINT "booking_counts_check" CHECK ("pos"."booking"."kids_count" >= 0 and "pos"."booking"."adults_count" >= 0);--> statement-breakpoint
ALTER TABLE "pos"."booking" ADD CONSTRAINT "booking_qr_check" CHECK (("pos"."booking"."qr_signature" is null) = ("pos"."booking"."qr_key_id" is null));
