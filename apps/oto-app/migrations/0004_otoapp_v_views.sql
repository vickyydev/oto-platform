-- The POS seam: four read-only views in schema `otoapp_v` over this app's
-- events, camps and their children (events-kiosk PLAN s8, round 0).
--
-- The POS never reads this app's tables (conflict C10). It reads these views,
-- and writes back only through the directory API, so this app stays the
-- master of every event, registration and check-in (PLAN Q1). A grep test in
-- apps/api holds the POS to that.
--
-- WHY HERE, in this app's migrator rather than the platform's: the platform
-- migrator runs first on every database (it creates schema `otoapp`, and this
-- migrator refuses to start without it), so on an empty database — CI, every
-- test database — a platform migration would meet none of the tables below.
-- The views depend on this app's tables and on the columns 0003 adds, so they
-- are created after them, by the migrator that owns them, and Postgres then
-- refuses any later migration here that would drop or retype a column the POS
-- reads.
--
-- Everything is written to survive one bad row rather than fail the whole
-- read: dates stay the `yyyy-MM-dd` text the app stores, the platform branch
-- id is cast only when it is shaped like a uuid, and a jsonb list is unpacked
-- only when it is an array.
--
-- Grants are not made here. The role names differ between deployments; the
-- post-import step gives the platform's api role USAGE on `otoapp_v` and
-- SELECT on these views, never on the tables (SPRINT_2_PLAN, S2-17b
-- cutover). A view runs with its owner's rights, so that is all it needs.
--
-- The schema is created only when it is missing, so a deployment whose app
-- role may not create schemas can have an administrator create it once
-- (`CREATE SCHEMA otoapp_v AUTHORIZATION <app role>`) and this then skips it.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'otoapp_v') THEN
    CREATE SCHEMA otoapp_v;
  END IF;
END
$$;
--> statement-breakpoint

-- One row per event, at a branch the platform knows.
--
-- `type` is the POS's three kinds (PLAN Q10's default): the types that carry
-- a BEO bill — birthday, private_event, school_group — are a party; camp is a
-- camp; other, studio_event and workshop are events.
--
-- `branch_id` is the PLATFORM branch, read through the SCRUM-268 seam
-- (`branches.core_branch_id`). An event at an app branch that is not mapped
-- (Head Office, or a park the platform has not been told about) has no row
-- here, so a POS read filtered by its own branch can never see it.
--
-- Money is satang, as the platform counts it: the app keeps whole baht.
-- Timestamps are the app's naive UTC, given their zone.
CREATE VIEW otoapp_v.events AS
SELECT
  e.id,
  e.tenant_id,
  e.branch_id AS otoapp_branch_id,
  CASE
    WHEN b.core_branch_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN b.core_branch_id::uuid
  END AS branch_id,
  CASE e.event_type
    WHEN 'camp' THEN 'camp'
    WHEN 'birthday' THEN 'party'
    WHEN 'private_event' THEN 'party'
    WHEN 'school_group' THEN 'party'
    ELSE 'event'
  END AS type,
  e.event_type::text AS app_event_type,
  e.title,
  e.status,
  e.is_archived AS archived,
  e.event_date AS start_date,
  -- A camp runs to its last day, and a camp with none is open-ended (the
  -- app's own reading in /api/core/camp-checkins/today). Anything else is
  -- one day.
  CASE WHEN e.event_type = 'camp' THEN e.camp_end_date ELSE e.event_date END AS end_date,
  CASE
    WHEN e.event_type = 'camp' AND jsonb_typeof(e.camp_cancelled_days) = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(e.camp_cancelled_days))
    ELSE '{}'::text[]
  END AS cancelled_days,
  e.start_time,
  e.end_time,
  e.location_text AS location,
  e.num_children AS expected_kids,
  e.num_adults AS expected_adults,
  e.entry_price_weekday_thb::bigint * 100 AS entry_price_weekday_satang,
  e.entry_price_weekend_thb::bigint * 100 AS entry_price_weekend_satang,
  e.child_name,
  e.kid_turning_age,
  e.booking_name,
  e.parent_name,
  e.whatsapp_phone_e164 AS parent_phone,
  e.activities,
  e.decoration,
  e.total_value::bigint * 100 AS total_value_satang,
  e.prepayment_amount::bigint * 100 AS deposit_satang,
  e.prepayment_date AS deposit_date,
  e.created_at AT TIME ZONE 'UTC' AS created_at,
  e.updated_at AT TIME ZONE 'UTC' AS updated_at
FROM core_events e
JOIN branches b ON b.id = e.branch_id AND b.tenant_id = e.tenant_id
WHERE b.core_branch_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--> statement-breakpoint

-- One row per child registered on an event: a camp's `camp_registrations`
-- and a one-off event's or a party's `event_attendees` (0003).
--
-- `attendance_days` and `attends_all_days` keep the app's own camp rule: a
-- registration with an empty list attends every day of the camp
-- (/api/core/camp-checkins/today). A list that is not a list at all is read as
-- attending no day — the app's own query would fail on it — rather than every
-- day. A one-off event or a party is one day, so its attendees attend all of
-- it.
--
-- "Manager Added" and "MANAGER_ADDED" are the app's placeholders for a parent
-- and a phone nobody gave (its manager-add path); they come through as null,
-- since neither is a name or a number.
--
-- `source` is known only for `event_attendees`; a camp registration does not
-- record where it came from.
CREATE VIEW otoapp_v.event_attendees AS
SELECT
  r.id,
  r.event_id,
  r.tenant_id,
  ev.branch_id,
  ev.type AS event_type,
  'camp_registration'::text AS record_kind,
  r.id AS child_id,
  r.child_full_name AS child_name,
  NULLIF(r.parent_guardian_name, 'Manager Added') AS parent_name,
  NULLIF(r.emergency_contact_number, 'MANAGER_ADDED') AS parent_phone,
  r.parent_attending,
  CASE
    WHEN jsonb_typeof(r.attendance_days) = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(r.attendance_days))
    ELSE '{}'::text[]
  END AS attendance_days,
  CASE
    WHEN r.attendance_days IS NULL THEN true
    WHEN jsonb_typeof(r.attendance_days) = 'array' THEN jsonb_array_length(r.attendance_days) = 0
    ELSE false
  END AS attends_all_days,
  r.special_notes AS notes,
  r.is_one_time,
  r.added_by_manager,
  NULL::text AS source,
  r.created_at AT TIME ZONE 'UTC' AS created_at,
  r.updated_at AT TIME ZONE 'UTC' AS updated_at
FROM camp_registrations r
JOIN otoapp_v.events ev ON ev.id = r.event_id AND ev.tenant_id = r.tenant_id
UNION ALL
SELECT
  a.id,
  a.event_id,
  a.tenant_id,
  ev.branch_id,
  ev.type AS event_type,
  'event_attendee'::text AS record_kind,
  a.id AS child_id,
  a.child_full_name AS child_name,
  a.parent_name,
  a.parent_phone,
  a.parent_attending,
  '{}'::text[] AS attendance_days,
  true AS attends_all_days,
  a.notes,
  false AS is_one_time,
  false AS added_by_manager,
  a.source,
  a.created_at,
  a.updated_at
FROM event_attendees a
JOIN otoapp_v.events ev ON ev.id = a.event_id AND ev.tenant_id = a.tenant_id;
--> statement-breakpoint

-- One row per attendee per day: a camp's `camp_attendance` and a one-off
-- event's `event_attendee_checkins` (0003), with the app's three states
-- (waiting, checked_in, checked_out). The app stays the master of this state
-- (PLAN Q1): the POS mirrors it and writes back through the directory API.
--
-- `checkin_ref` is the id a directory caller minted for the check-in; a camp
-- check-in made in the app itself has none.
CREATE VIEW otoapp_v.event_attendance AS
SELECT
  c.id,
  c.checkin_ref,
  c.camp_registration_id AS attendee_id,
  r.event_id,
  c.tenant_id,
  ev.branch_id,
  'camp_registration'::text AS record_kind,
  to_char(c.attendance_date, 'YYYY-MM-DD') AS attendance_date,
  c.status::text AS status,
  c.checked_in_at AT TIME ZONE 'UTC' AS checked_in_at,
  c.checked_in_by,
  c.checked_out_at AT TIME ZONE 'UTC' AS checked_out_at,
  c.checked_out_by,
  c.updated_at AT TIME ZONE 'UTC' AS updated_at
FROM camp_attendance c
JOIN camp_registrations r ON r.id = c.camp_registration_id AND r.tenant_id = c.tenant_id
JOIN otoapp_v.events ev ON ev.id = r.event_id AND ev.tenant_id = r.tenant_id
UNION ALL
SELECT
  k.id,
  k.checkin_ref,
  k.attendee_id,
  a.event_id,
  k.tenant_id,
  ev.branch_id,
  'event_attendee'::text AS record_kind,
  to_char(k.attendance_date, 'YYYY-MM-DD') AS attendance_date,
  k.status::text AS status,
  k.checked_in_at,
  k.checked_in_by,
  k.checked_out_at,
  k.checked_out_by,
  k.updated_at
FROM event_attendee_checkins k
JOIN event_attendees a ON a.id = k.attendee_id AND a.tenant_id = k.tenant_id
JOIN otoapp_v.events ev ON ev.id = a.event_id AND ev.tenant_id = a.tenant_id;
--> statement-breakpoint

-- The children behind those registrations, as the app knows them: the
-- identity and safety facts the POS needs to link an attendee to a platform
-- child (`crm.child`) and to print the allergy and diet lines on a band.
--
-- The app keeps no child record of its own — a child exists only as a
-- registration on an event — so this is one row per registration, keyed by
-- its id (`event_attendees.child_id`). Linking the same child across two camps
-- is the platform's match to make, not this view's.
--
-- `1900-01-01` is the app's placeholder for a date of birth nobody gave (its
-- one-time add), and comes through as null.
CREATE VIEW otoapp_v.children AS
SELECT
  r.id,
  r.tenant_id,
  ev.branch_id,
  'camp_registration'::text AS record_kind,
  r.event_id,
  r.child_full_name AS child_name,
  NULLIF(r.date_of_birth, '1900-01-01') AS date_of_birth,
  NULL::integer AS age_years,
  r.primary_language AS language,
  r.allergies,
  r.allergies_notes AS allergy_notes,
  r.food_restrictions,
  NULLIF(r.parent_guardian_name, 'Manager Added') AS guardian_name,
  NULLIF(r.emergency_contact_number, 'MANAGER_ADDED') AS guardian_phone,
  r.created_at AT TIME ZONE 'UTC' AS created_at,
  r.updated_at AT TIME ZONE 'UTC' AS updated_at
FROM camp_registrations r
JOIN otoapp_v.events ev ON ev.id = r.event_id AND ev.tenant_id = r.tenant_id
UNION ALL
SELECT
  a.id,
  a.tenant_id,
  ev.branch_id,
  'event_attendee'::text AS record_kind,
  a.event_id,
  a.child_full_name AS child_name,
  a.date_of_birth,
  a.age_years,
  a.primary_language AS language,
  a.allergies,
  NULL::text AS allergy_notes,
  a.food_restrictions,
  a.parent_name AS guardian_name,
  a.parent_phone AS guardian_phone,
  a.created_at,
  a.updated_at
FROM event_attendees a
JOIN otoapp_v.events ev ON ev.id = a.event_id AND ev.tenant_id = a.tenant_id;
