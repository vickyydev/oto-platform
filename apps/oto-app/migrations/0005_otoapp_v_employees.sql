-- The employee seam: one read-only view in schema `otoapp_v` over this app's
-- staff list (S2-17b round 2, PLAN section 5; conflict C13).
--
-- This app stays the employee master. The platform copies what it needs into
-- `core.employee` (source `otoapp`) with its job `job:otoapp.employee_sync`,
-- and reads nothing of the HR record but this view: its repository
-- (`apps/api/src/services/otoapp-employees.ts`) is the only platform file
-- besides the events repository that may name `otoapp_v`, and a grep test
-- holds it to that.
--
-- THE COLUMN ALLOW-LIST. Exactly what the platform needs to keep one person
-- one row and to know who they sign in as: the ids, the park group, the
-- branch, the names, the phone and email, where they are in their employment,
-- when this app last changed them, and the platform account the app's own
-- rule ties them to. Nothing about pay, tax, social security, visa, address,
-- date of birth, face or PIN crosses — a test pins the column list.
--
-- `branch_id` is the PLATFORM branch, read through the SCRUM-268 seam exactly
-- as the events views read it (0004): lower-case uuids only, the branch in the
-- employee's own park group, null for an unmapped branch (Head Office) or
-- none.
--
-- `platform_user_id` is the platform account of the user this app's own rule
-- links to the employee (`getUserWithBranchAccess` in `server/storage.ts`),
-- turned round to read from the employee's side:
--
--   1. The user an employee carries in `user_id` — when that user is carried
--      by this employee alone. A login carried by two employees is answered
--      by the app with whichever row its query happens to return first, so it
--      is no link here: one person is never guessed.
--   2. Failing that, a user NO employee carries in `user_id`, whose email
--      matches the employee's ignoring case, across every park group as the
--      app matches it: the only employee on that email; or, of several, the
--      only one on the user's phone (when the user has one), else the only
--      one with the user's full name. Again, a tie the app breaks by row order
--      is no link.
--
--   An employee two users would both reach by step 2 names neither. One that
--   a user reaches by step 1 names that user, whoever else reaches it by
--   email: the explicit link is the person.
--
-- The email step is NOT limited to a park group, because the app's is not.
-- Whether a link counts is the platform's question (the account must belong to
-- the operator the employee's park group is anchored to); the view only says
-- what the app says.
--
-- Grants are not made here, for the reason 0004 gives: the role names differ
-- between deployments, and the post-import step gives the platform's api role
-- SELECT on this view beside the other four — never on the tables.
CREATE VIEW otoapp_v.employees AS
WITH
carried AS (
  SELECT user_id, count(*) AS n
  FROM employees
  WHERE user_id IS NOT NULL
  GROUP BY user_id
),
by_user_id AS (
  SELECT e.id AS employee_id, u.platform_user_id
  FROM employees e
  JOIN users u ON u.id = e.user_id
  JOIN carried c ON c.user_id = e.user_id AND c.n = 1
),
email_candidates AS (
  SELECT
    u.id AS user_id,
    u.platform_user_id,
    e.id AS employee_id,
    NULLIF(u.phone_e164, '') IS NOT NULL AS user_has_phone,
    COALESCE(e.phone_e164 = u.phone_e164, false) AS phone_match,
    COALESCE(e.full_name = u.full_name, false) AS name_match,
    count(*) OVER (PARTITION BY u.id) AS on_email,
    count(*) FILTER (WHERE e.phone_e164 = u.phone_e164) OVER (PARTITION BY u.id) AS on_phone,
    count(*) FILTER (WHERE e.full_name = u.full_name) OVER (PARTITION BY u.id) AS on_name
  FROM users u
  JOIN employees e ON lower(e.email) = lower(u.email)
  WHERE NULLIF(u.email, '') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM employees x WHERE x.user_id = u.id)
),
by_email AS (
  SELECT employee_id, user_id, platform_user_id
  FROM email_candidates
  WHERE on_email = 1
     OR (user_has_phone AND phone_match AND on_phone = 1)
     OR (NOT user_has_phone AND name_match AND on_name = 1)
),
link AS (
  SELECT employee_id, platform_user_id FROM by_user_id
  UNION ALL
  SELECT m.employee_id, m.platform_user_id
  FROM by_email m
  WHERE NOT EXISTS (SELECT 1 FROM by_user_id k WHERE k.employee_id = m.employee_id)
    AND (SELECT count(*) FROM by_email o WHERE o.employee_id = m.employee_id) = 1
)
SELECT
  e.id,
  e.tenant_id,
  e.branch_id AS otoapp_branch_id,
  CASE
    WHEN b.core_branch_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN b.core_branch_id::uuid
  END AS branch_id,
  e.full_name,
  e.nickname,
  e.phone_e164 AS phone,
  e.email,
  e.status,
  e.employment_state,
  e.last_working_day AT TIME ZONE 'UTC' AS last_working_day,
  e.updated_at AT TIME ZONE 'UTC' AS updated_at,
  l.platform_user_id
FROM employees e
LEFT JOIN branches b ON b.id = e.branch_id AND b.tenant_id = e.tenant_id
LEFT JOIN link l ON l.employee_id = e.id;
