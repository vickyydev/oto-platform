-- S2-20 K1 (SCRUM-217) — the self-service kiosk's redemption core. The plan is
-- docs/progress/plans/events-kiosk/PLAN.md §5, §8 and the K1 row of §9.
-- PROVISIONAL NUMBER: renumbered in landing order (lanes H and I take 0066 and
-- 0067 the same week).
--
-- 1. `pos.kiosk_session` — one row per session at a kiosk: the station, its
--    paired credential and box, the press (`action_id`, unique per station, so
--    a replayed press finds the first one's row and issues nothing again), the
--    booking and the redemption's sale, the bands that printed, and the outcome
--    with its reason. A `failed` or `abandoned` session names no sale and no
--    band (`kiosk_session_no_sale_check`): a redemption at the kiosk is issued,
--    printed and only then committed, so a printer fault leaves nothing behind.
--
-- 2. A SALE A PAIRED DEVICE RANG UP. `pos.sale.created_by_account_id` loses its
--    NOT NULL and `device_credential_id` is added beside it; `sale_actor_check`
--    keeps the old rule in a wider form — a person or a device, never neither.
--    Expand-only: every sale already written names its account, and the code
--    deployed before this one never writes a null there.
--
CREATE TABLE "pos"."kiosk_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"device_credential_id" uuid NOT NULL,
	"box_id" uuid,
	"action_id" text,
	"booking_id" uuid,
	"sale_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"reason" text,
	"band_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiosk_session_outcome_check" CHECK ("pos"."kiosk_session"."outcome" is null or "pos"."kiosk_session"."outcome" in ('issued','handed_off','failed','abandoned')),
	CONSTRAINT "kiosk_session_ended_check" CHECK (("pos"."kiosk_session"."outcome" is null) = ("pos"."kiosk_session"."ended_at" is null)),
	CONSTRAINT "kiosk_session_reason_check" CHECK ("pos"."kiosk_session"."outcome" is null or "pos"."kiosk_session"."outcome" not in ('failed','abandoned') or "pos"."kiosk_session"."reason" is not null),
	CONSTRAINT "kiosk_session_issued_check" CHECK ("pos"."kiosk_session"."outcome" is distinct from 'issued' or "pos"."kiosk_session"."sale_id" is not null),
	CONSTRAINT "kiosk_session_no_sale_check" CHECK ("pos"."kiosk_session"."outcome" is null or "pos"."kiosk_session"."outcome" not in ('failed','abandoned') or ("pos"."kiosk_session"."sale_id" is null and "pos"."kiosk_session"."band_ids" = '[]'::jsonb))
);
--> statement-breakpoint
ALTER TABLE "pos"."sale" ALTER COLUMN "created_by_account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD COLUMN "device_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."kiosk_session" ADD CONSTRAINT "kiosk_session_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "core"."operator"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."kiosk_session" ADD CONSTRAINT "kiosk_session_branch_id_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "core"."branch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."kiosk_session" ADD CONSTRAINT "kiosk_session_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "core"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."kiosk_session" ADD CONSTRAINT "kiosk_session_device_credential_id_device_credential_id_fk" FOREIGN KEY ("device_credential_id") REFERENCES "core"."device_credential"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."kiosk_session" ADD CONSTRAINT "kiosk_session_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "core"."box"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."kiosk_session" ADD CONSTRAINT "kiosk_session_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "pos"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos"."kiosk_session" ADD CONSTRAINT "kiosk_session_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "pos"."sale"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kiosk_session_operator_idx" ON "pos"."kiosk_session" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "kiosk_session_branch_idx" ON "pos"."kiosk_session" USING btree ("branch_id","started_at");--> statement-breakpoint
CREATE INDEX "kiosk_session_station_idx" ON "pos"."kiosk_session" USING btree ("station_id","started_at");--> statement-breakpoint
CREATE INDEX "kiosk_session_credential_idx" ON "pos"."kiosk_session" USING btree ("device_credential_id");--> statement-breakpoint
CREATE INDEX "kiosk_session_box_idx" ON "pos"."kiosk_session" USING btree ("box_id");--> statement-breakpoint
CREATE INDEX "kiosk_session_booking_idx" ON "pos"."kiosk_session" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "kiosk_session_sale_idx" ON "pos"."kiosk_session" USING btree ("sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kiosk_session_action_unique" ON "pos"."kiosk_session" USING btree ("station_id","action_id") WHERE action_id is not null;--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_device_credential_id_device_credential_id_fk" FOREIGN KEY ("device_credential_id") REFERENCES "core"."device_credential"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_device_credential_idx" ON "pos"."sale" USING btree ("device_credential_id");--> statement-breakpoint
ALTER TABLE "pos"."sale" ADD CONSTRAINT "sale_actor_check" CHECK ("pos"."sale"."created_by_account_id" is not null or "pos"."sale"."device_credential_id" is not null);