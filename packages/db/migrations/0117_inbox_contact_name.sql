-- SCRUM-860 (the inbox creates a contact and edits a contact's name) -
-- 0117_inbox_contact_name, journalled after 0116_stay_cancelled (SCRUM-862).
-- expand-only: three nullable columns on inbox.contact, one foreign key with
-- its index, one new CHECK, one CHECK swap that only WIDENS what an erased row
-- must not carry, and ONE backfill of the new column from a column that
-- already exists. Nothing existing is dropped or renamed; a release that does
-- not know the columns never reads them and keeps writing display_name as
-- before.
--
--   inbox.contact.display_name               (unchanged) the name the inbox
--       SHOWS: the channel's profile name as it first arrived, or the name
--       staff set over it. The ingest fills it only while it is null, so a
--       staff-set name is never overwritten by a later message.
--   inbox.contact.profile_name               text, null
--       the channel's own profile name, as last seen - kept so a staff
--       correction loses nothing, and what clearing the staff name restores.
--       Backfilled once from display_name on every live row: until now the
--       shown name WAS the channel's.
--   inbox.contact.name_set_by_account_id     uuid, null -> core.account(id)
--   inbox.contact.name_set_at                timestamptz, null
--       who set the shown name by hand, and when; both set or both null
--       (contact_name_set_check). Null = the shown name is the channel's.
--   contact_name_set_by_idx                  the foreign key's index.
--   contact_erased_check                     widened: an erased contact also
--       carries no profile_name and no staff name (PDPA).
--
-- TO REVERSE: drop contact_name_set_check, contact_name_set_by_idx, the
-- foreign key contact_name_set_by_account_id_account_id_fk and the three
-- columns, then re-add contact_erased_check with the list of
-- 0078_inbox_schema (erased_at is null or (phone is null and member_id is
-- null)). display_name needs no undo: it holds the shown name throughout.
ALTER TABLE "inbox"."contact" DROP CONSTRAINT "contact_erased_check";--> statement-breakpoint
ALTER TABLE "inbox"."contact" ADD COLUMN "profile_name" text;--> statement-breakpoint
ALTER TABLE "inbox"."contact" ADD COLUMN "name_set_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "inbox"."contact" ADD COLUMN "name_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbox"."contact" ADD CONSTRAINT "contact_name_set_by_account_id_account_id_fk" FOREIGN KEY ("name_set_by_account_id") REFERENCES "core"."account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_name_set_by_idx" ON "inbox"."contact" USING btree ("name_set_by_account_id");--> statement-breakpoint
ALTER TABLE "inbox"."contact" ADD CONSTRAINT "contact_name_set_check" CHECK (("inbox"."contact"."name_set_at" is null) = ("inbox"."contact"."name_set_by_account_id" is null));--> statement-breakpoint
UPDATE "inbox"."contact" SET "profile_name" = "display_name" WHERE "profile_name" IS NULL AND "display_name" IS NOT NULL AND "erased_at" IS NULL;--> statement-breakpoint
ALTER TABLE "inbox"."contact" ADD CONSTRAINT "contact_erased_check" CHECK ("inbox"."contact"."erased_at" is null or ("inbox"."contact"."phone" is null and "inbox"."contact"."member_id" is null and "inbox"."contact"."profile_name" is null and "inbox"."contact"."name_set_by_account_id" is null));
