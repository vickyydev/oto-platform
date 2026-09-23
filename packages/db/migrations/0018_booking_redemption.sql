-- SCRUM-304 — a redemption gets a table.
--
-- SCRUM-234 wrote the claim into `pos.booking.payload` and said in the service
-- why: the ticket had no migration in it, and the jsonb was the shape the row
-- already had. It also said what that cost, and this withdraws those sentences.
-- Who let a family through the gate on a payment taken elsewhere was two ids
-- inside a blob with no foreign key behind them; "redeemed once" rested
-- entirely on the service taking the row `FOR UPDATE`; and reporting on
-- redemptions meant reading jsonb.
--
-- **Create and backfill. Nothing is dropped, retyped or emptied.** One new
-- table, five foreign keys, five indexes, and a copy of every redemption the
-- payload already holds. The payload blocks are LEFT WHERE THEY ARE: the
-- running release reads them, so removing them here would break it mid-deploy
-- (the expand/contract rule from 0004), and a migration is not a place to
-- delete data. The release this ships with stops writing them and reads the
-- table instead; a later ticket may clean the blobs up once nothing reads them.
--
-- **The backfill is a straight copy and it is deliberately loud.** An id in a
-- blob that names no station or no account stops the migration rather than
-- being quietly dropped — the record of who admitted a family is the one field
-- here not worth losing to make a deploy go through. Staging holds a handful of
-- these rows, all written by our own service in one shape, so the copy is
-- expected to be exact. `ON CONFLICT DO NOTHING` makes it re-runnable.
--
-- `created_at` takes its default rather than the redemption's instant: this row
-- was created by this migration, today, and `redeemed_at` is when it happened.
-- The ids are v4 from `gen_random_uuid()` rather than the application's v7 —
-- there is no v7 generator in the database, and a backfilled row is the one
-- place in this schema where the id was not minted by the code that owns it.

CREATE TABLE "pos"."booking_redemption" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"station_id" uuid,
	"account_id" uuid,
	"redeemed_at" timestamp with time zone NOT NULL,
	"band_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pos"."booking_redemption" ADD CONSTRAINT "booking_redemption_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."booking_redemption" ADD CONSTRAINT "booking_redemption_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."booking_redemption" ADD CONSTRAINT "booking_redemption_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "pos"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."booking_redemption" ADD CONSTRAINT "booking_redemption_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."booking_redemption" ADD CONSTRAINT "booking_redemption_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_redemption_booking_unique" ON "pos"."booking_redemption" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "booking_redemption_operator_idx" ON "pos"."booking_redemption" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "booking_redemption_branch_idx" ON "pos"."booking_redemption" USING btree ("branch_id","redeemed_at");--> statement-breakpoint
CREATE INDEX "booking_redemption_station_idx" ON "pos"."booking_redemption" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "booking_redemption_account_idx" ON "pos"."booking_redemption" USING btree ("account_id");--> statement-breakpoint
-- The backfill. `branchId` in the blob is where it was claimed and falls back
-- to the booking's own branch, which is what the service's reader did with a
-- block that was missing it.
INSERT INTO "pos"."booking_redemption" (
	"id", "operator_id", "branch_id", "booking_id", "station_id", "account_id", "redeemed_at", "band_codes"
)
SELECT
	gen_random_uuid(),
	b."operator_id",
	coalesce(nullif(b."payload" -> 'redemption' ->> 'branchId', '')::uuid, b."branch_id"),
	b."id",
	nullif(b."payload" -> 'redemption' ->> 'stationId', '')::uuid,
	nullif(b."payload" -> 'redemption' ->> 'accountId', '')::uuid,
	(b."payload" -> 'redemption' ->> 'redeemedAt')::timestamptz,
	case
		when jsonb_typeof(b."payload" -> 'redemption' -> 'bandCodes') = 'array'
		then b."payload" -> 'redemption' -> 'bandCodes'
		else '[]'::jsonb
	end
FROM "pos"."booking" b
WHERE jsonb_typeof(b."payload" -> 'redemption') = 'object'
	AND nullif(b."payload" -> 'redemption' ->> 'redeemedAt', '') IS NOT NULL
ON CONFLICT ("booking_id") DO NOTHING;
