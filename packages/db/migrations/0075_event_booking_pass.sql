-- S2-20 E5 (SCRUM-217) — event passes bought online. The plan is
-- docs/progress/plans/events-kiosk/PLAN.md, the E5 row of §9 and consistency
-- #21. Landed as 0075, after the benefits daily fact (0074); the snapshot
-- was regenerated at landing so its chain and tables carry 0074’s.
--
-- `pos.event_attendee_link` learns the pass a family bought on the booking
-- site (mockApi.ts `createBooking` 1085-1115): registered when the booking is
-- paid, written back to the OTO App, checked in when the booking is redeemed.
--
-- 1. `billing` gains `booking`: the pass was paid with the booking's one
--    payment. Its money is filed on the redemption sale, so the link names
--    that sale once the booking is redeemed and none before (the sale check is
--    split: a till's `sale` pass always names its sale, a party walk-up and a
--    free event never do).
-- 2. `booking_id` names the booking that bought it (`event_attendee_link_booking_check`),
--    with its index.
--
-- Expand-only: one nullable column, its index and foreign key, and two checks
-- every existing row already satisfies (no row is `booking`; the split sale
-- check is the old one for the three existing billings).
--
ALTER TABLE "pos"."event_attendee_link" DROP CONSTRAINT "event_attendee_link_billing_check";--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" DROP CONSTRAINT "event_attendee_link_sale_check";--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" ADD COLUMN "booking_id" uuid;--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" ADD CONSTRAINT "event_attendee_link_booking_id_booking_id_fk" FOREIGN KEY ("booking_id") REFERENCES "pos"."booking"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_attendee_link_booking_idx" ON "pos"."event_attendee_link" USING btree ("booking_id");--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" ADD CONSTRAINT "event_attendee_link_booking_check" CHECK ("pos"."event_attendee_link"."billing" <> 'booking' or "pos"."event_attendee_link"."booking_id" is not null);--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" ADD CONSTRAINT "event_attendee_link_billing_check" CHECK ("pos"."event_attendee_link"."billing" in ('sale','party_tab','free','booking'));--> statement-breakpoint
ALTER TABLE "pos"."event_attendee_link" ADD CONSTRAINT "event_attendee_link_sale_check" CHECK (("pos"."event_attendee_link"."billing" <> 'sale' or "pos"."event_attendee_link"."sale_id" is not null) and ("pos"."event_attendee_link"."billing" not in ('party_tab','free') or "pos"."event_attendee_link"."sale_id" is null));