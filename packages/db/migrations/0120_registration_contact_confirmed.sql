-- SCRUM-857 (the drop-off and nanny form: the family confirms that the number
-- is the one for the chosen channel) - expand-only: two nullable columns and
-- two CHECKs on crm.registration. No row is written here.
--
--   crm.registration.contact_confirmed_at
--       when the family confirmed the number (null on a registration taken
--       without the confirmation: a station's offline path, the booking site,
--       a registration from before this field)
--   crm.registration.contact_confirmed_by
--       who gave the tick: 'family' on their own screen, 'staff' on the till
--       with the family beside them (the customer screen could not show it)
--   registration_contact_confirmed_by_check
--       the value is one of the two, or null
--   registration_contact_confirmed_check
--       both set or both null, and a confirmation names a number that is there
--
-- TO REVERSE 0120 (nothing else refers to the columns): drop the two
-- CHECKs, then the two columns.
ALTER TABLE "crm"."registration" ADD COLUMN "contact_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm"."registration" ADD COLUMN "contact_confirmed_by" text;--> statement-breakpoint
ALTER TABLE "crm"."registration" ADD CONSTRAINT "registration_contact_confirmed_by_check" CHECK ("crm"."registration"."contact_confirmed_by" is null or "crm"."registration"."contact_confirmed_by" in ('family','staff'));--> statement-breakpoint
ALTER TABLE "crm"."registration" ADD CONSTRAINT "registration_contact_confirmed_check" CHECK (("crm"."registration"."contact_confirmed_at" is null) = ("crm"."registration"."contact_confirmed_by" is null) and ("crm"."registration"."contact_confirmed_at" is null or "crm"."registration"."guardian_phone" is not null));