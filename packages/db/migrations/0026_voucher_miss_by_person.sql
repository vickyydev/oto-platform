-- SCRUM-425 (the booth's closing audit, section 3.1 and T25) — a guessing
-- budget for each person as well as each till, and a row for every wrong code.
--
-- The plan for voucher redemption sets "per-station and per-staff not-found
-- budget 5 per minute → 10-minute lock + alert redemption.probing"
-- (docs/progress/SPRINT_2_PLAN.md, S2-10b). promo.redemption_throttle holds the
-- till's half: one row per till, the misses of the last minute, emptied when
-- the till locks. It stays as it is.
--
-- promo.voucher_miss is the person's half, and the record. One row per wrong
-- code tried at a till: the till, its branch, the signed-in account, what the
-- till answered ('invalid' or 'not_found'), the request and the time — and the
-- SHA-256, in hex, of the normalised code, never the code (the rule of 0024;
-- the CHECK refuses anything that is not such a hash). The api counts one
-- account's different hashes inside a minute across every till; the fifth sets
-- account_locked_until on its own row, and that account's look-ups are refused
-- at every till until then.
--
-- A new table rather than an account id beside each miss in
-- redemption_throttle: that row keeps one minute and is emptied by every lock,
-- so it could neither show anybody later who tried what nor keep a person's
-- misses once a till they tried at had locked, and a person's lock would still
-- need a place of its own.
--
-- Nothing is copied in. The misses a till recorded before 0026 name nobody:
-- they still count for that till, and nothing against a person.
--
-- A new, empty table with its keys and indexes; no existing row is touched.
-- Safe to apply on a live database.
CREATE TABLE "promo"."voucher_miss" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"result" text NOT NULL,
	"request_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "voucher_miss_code_hash_check" CHECK ("promo"."voucher_miss"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "voucher_miss_result_check" CHECK ("promo"."voucher_miss"."result" in ('invalid','not_found'))
);
--> statement-breakpoint
ALTER TABLE "promo"."voucher_miss" ADD CONSTRAINT "voucher_miss_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_miss" ADD CONSTRAINT "voucher_miss_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_miss" ADD CONSTRAINT "voucher_miss_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."voucher_miss" ADD CONSTRAINT "voucher_miss_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voucher_miss_account_idx" ON "promo"."voucher_miss" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "voucher_miss_station_idx" ON "promo"."voucher_miss" USING btree ("station_id","occurred_at");--> statement-breakpoint
CREATE INDEX "voucher_miss_branch_idx" ON "promo"."voucher_miss" USING btree ("branch_id","occurred_at");--> statement-breakpoint
CREATE INDEX "voucher_miss_operator_idx" ON "promo"."voucher_miss" USING btree ("operator_id","occurred_at");