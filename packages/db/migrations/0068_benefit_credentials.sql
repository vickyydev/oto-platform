-- S2-21 (SCRUM-218), staff benefits round 2 — the plan is
-- docs/progress/plans/benefits/PLAN.md §4, §7 and §8 round 2. Forward-only.
-- PROVISIONAL NUMBER: 0069, journal index 68; the lander renumbers it.
--
-- THE BENEFIT QR'S RECORD. `promo.benefit_credential`: one row per staff
-- benefit QR the platform signed — whose it is, which `benefit_qr` key signed
-- it (`kid`), the format version, SHA-256 of the printed code (never the
-- code), who issued it and when, its expiry, and who revoked it and when.
-- The QR itself is never stored: it is re-derived from these columns and the
-- api's private key when an administrator asks to print it.
--
-- `benefit_credential_revoked_idx` is the revocation list every box's
-- `benefits` scope carries: the revoked QRs still inside their own lifetime.
-- A revoker without a revocation is refused by a CHECK, as on
-- `core.staff_token`. Nothing is written into the new table.
--
CREATE TABLE "promo"."benefit_credential" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"kid" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"code_hash" text NOT NULL,
	"issued_by_account_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_account_id" uuid,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benefit_credential_expiry_check" CHECK ("promo"."benefit_credential"."expires_at" > "promo"."benefit_credential"."issued_at"),
	CONSTRAINT "benefit_credential_version_check" CHECK ("promo"."benefit_credential"."version" >= 1),
	CONSTRAINT "benefit_credential_revocation_check" CHECK ("promo"."benefit_credential"."revoked_at" is not null or "promo"."benefit_credential"."revoked_by_account_id" is null)
);
--> statement-breakpoint
ALTER TABLE "promo"."benefit_credential" ADD CONSTRAINT "benefit_credential_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_credential" ADD CONSTRAINT "benefit_credential_employee_id_employee_id_fk" FOREIGN KEY ("employee_id") REFERENCES "core"."employee"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_credential" ADD CONSTRAINT "benefit_credential_issued_by_account_id_account_id_fk" FOREIGN KEY ("issued_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."benefit_credential" ADD CONSTRAINT "benefit_credential_revoked_by_account_id_account_id_fk" FOREIGN KEY ("revoked_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "benefit_credential_operator_idx" ON "promo"."benefit_credential" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "benefit_credential_employee_idx" ON "promo"."benefit_credential" USING btree ("employee_id","issued_at");--> statement-breakpoint
CREATE INDEX "benefit_credential_issued_by_idx" ON "promo"."benefit_credential" USING btree ("issued_by_account_id");--> statement-breakpoint
CREATE INDEX "benefit_credential_revoked_by_idx" ON "promo"."benefit_credential" USING btree ("revoked_by_account_id");--> statement-breakpoint
CREATE INDEX "benefit_credential_revoked_idx" ON "promo"."benefit_credential" USING btree ("operator_id","expires_at") WHERE revoked_at is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "benefit_credential_code_hash_unique" ON "promo"."benefit_credential" USING btree ("code_hash");