-- ONE DEPOSIT (SCRUM-813): the party's received deposit, read in one order by
-- every view the till reads it from.
--
-- 0004's otoapp_v.events (the till's party page, its bill, and the "before"
-- of a till's edit) and 0042's otoapp_v.event_packages (the settle quote)
-- read the party's deposit from the event's own Prepayment
-- (core_events.prepayment_amount) only, so a deposit entered in the BEO (its
-- billing's deposit paid, or Party Details' "Prepayment received", both in
-- beo_event_billing) never reached the till. From here the app keeps one
-- figure: every writer of a received deposit (the BEO's billing route, the
-- BEO's Save, the AI fill's approval, the event's own Prepayment and a till's
-- party edit) writes the same amount and date to all three places
-- (server/lib/partyDeposit.ts).
--
-- A party saved before that rule may hold different figures in the three
-- places. Nothing here rewrites them (no data is written by this migration).
-- Instead otoapp_v.events reads the three in ONE order, the order the app's
-- own readers use (currentDeposit in server/lib/partyDeposit.ts: the BEO,
-- the Events page), and otoapp_v.event_packages reads otoapp_v.events'
-- figure, so the party page and the settle quote can never disagree:
--
--   1. Party Details' prepayment received (add_ons.partyDetails
--      .prepaymentReceived), a number or a numeric string, rounded (cast only
--      once it reads as a number, so an odd value is skipped, never fatal):
--      what the BEO editor, its PDF, the day-of view and the Events page's
--      card showed, and what staff typed in the BEO before the rule;
--   2. else the BEO billing's deposit paid (deposit_paid, deposit_paid_amount);
--   3. else the event's prepayment, exactly as 0004 read it.
--
-- deposit_date is the day the same place keeps (Party Details' depositDate,
-- the billing's deposit_paid_at while it says paid), else the other BEO
-- place's day, else the event's valid prepayment day; with no BEO figure it
-- is the event's prepayment_date, exactly as 0004 read it.
--
-- All three are WHOLE BAHT, so the one figure is multiplied by 100 into
-- satang, as 0004 converted the prepayment. A deposit that is 0 or unset in
-- the BEO falls through to the next.
--
-- Nothing else changes: each view keeps the same columns, in the same order,
-- of the same types (CREATE OR REPLACE keeps the views, their grants and the
-- views built on otoapp_v.events), every other expression as 0004 and 0042
-- wrote it; packages/db declares both unchanged. beo_event_billing is unique
-- per event, so its join adds no row. Expand-only.
CREATE OR REPLACE VIEW otoapp_v.events AS
SELECT
  e.id,
  e.tenant_id,
  e.branch_id AS otoapp_branch_id,
  CASE
    WHEN b.core_branch_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
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
  (CASE
    WHEN d.details_thb IS NOT NULL THEN d.details_thb
    WHEN d.paid_thb IS NOT NULL THEN d.paid_thb
    ELSE e.prepayment_amount
  END)::bigint * 100 AS deposit_satang,
  CASE
    WHEN d.details_thb IS NOT NULL THEN COALESCE(d.details_day, d.paid_day, d.own_day)
    WHEN d.paid_thb IS NOT NULL THEN COALESCE(d.paid_day, d.details_day, d.own_day)
    ELSE e.prepayment_date
  END AS deposit_date,
  e.created_at AT TIME ZONE 'UTC' AS created_at,
  e.updated_at AT TIME ZONE 'UTC' AS updated_at
FROM core_events e
JOIN branches b ON b.id = e.branch_id AND b.tenant_id = e.tenant_id
LEFT JOIN beo_event_billing bl ON bl.event_id = e.id
CROSS JOIN LATERAL (
  SELECT
    CASE
      WHEN jsonb_typeof(bl.add_ons) = 'object'
       AND (bl.add_ons -> 'partyDetails' ->> 'prepaymentReceived') ~ '^\s*[0-9]{1,9}(\.[0-9]+)?\s*$'
        THEN NULLIF(round((bl.add_ons -> 'partyDetails' ->> 'prepaymentReceived')::numeric)::integer, 0)
    END AS details_thb,
    CASE
      WHEN jsonb_typeof(bl.add_ons) = 'object'
       AND jsonb_typeof(bl.add_ons -> 'partyDetails' -> 'depositDate') = 'string'
       AND substr(btrim(bl.add_ons -> 'partyDetails' ->> 'depositDate'), 1, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        THEN substr(btrim(bl.add_ons -> 'partyDetails' ->> 'depositDate'), 1, 10)
    END AS details_day,
    CASE WHEN bl.deposit_paid AND bl.deposit_paid_amount > 0 THEN bl.deposit_paid_amount END AS paid_thb,
    CASE WHEN bl.deposit_paid THEN bl.deposit_paid_at::date::text END AS paid_day,
    CASE
      WHEN substr(btrim(e.prepayment_date), 1, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        THEN substr(btrim(e.prepayment_date), 1, 10)
    END AS own_day
) d
WHERE b.core_branch_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
--> statement-breakpoint

-- otoapp_v.event_packages, as 0042 made it, its settlement's deposit the one
-- otoapp_v.events reads (the view already joins it as ev).
CREATE OR REPLACE VIEW otoapp_v.event_packages AS
SELECT
  e.id::varchar AS event_id,
  ev.branch_id AS core_branch_id,
  CASE WHEN pg_input_is_valid(e.event_date, 'date') THEN e.event_date::date END AS party_date,
  CASE WHEN pg_input_is_valid(e.start_time, 'time') THEN e.start_time::time END AS start_time,
  CASE WHEN pg_input_is_valid(e.end_time, 'time') THEN e.end_time::time END AS end_time,
  jsonb_build_object(
    'template_id', s.template_id,
    'name', s.package_name,
    'hours', s.hours,
    'kids_included', s.kids_included,
    'adults_included', s.adults_included,
    'socks_included', s.socks_included,
    'price_weekday_satang', COALESCE(s.price_weekday, s.base_price),
    'price_weekend_satang', COALESCE(s.price_weekend, s.price_weekday, s.base_price),
    'extra_child_weekday_satang', s.extra_child_weekday,
    'extra_child_weekend_satang', s.extra_child_weekend,
    'extra_adult_weekday_satang', s.extra_adult_weekday,
    'extra_adult_weekend_satang', s.extra_adult_weekend,
    'included_lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('label', i.label) ORDER BY i.sort_order, i.created_at, i.id)
      FROM beo_package_snapshot_items i
      WHERE i.snapshot_id = s.id AND i.included
    ), '[]'::jsonb)
  ) AS package,
  jsonb_build_object(
    'kids_expected', e.num_children,
    'adults_expected', e.num_adults
  ) AS counts,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'template_id', i.source_template_line_item_id,
      'name', i.label,
      'qty', i.qty,
      'unit_price_satang', i.unit_price,
      'fnb_credit_satang', t.fnb_credit,
      'prints_voucher', COALESCE(t.prints_voucher, false)
    ) ORDER BY i.sort_order, i.created_at, i.id)
    FROM beo_package_snapshot_items i
    LEFT JOIN package_line_item_templates t ON t.id = i.source_template_line_item_id
    WHERE i.snapshot_id = s.id AND NOT i.included AND i.billable AND i.qty > 0
  ), '[]'::jsonb) AS add_ons,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'template_id', es.template_id,
      'name', es.name,
      'category', et.category,
      'duration_minutes', es.duration_minutes,
      'age_range', et.age_range,
      'max_kids', et.max_kids,
      'price_satang', CASE WHEN es.billable THEN es.price ELSE 0 END,
      'extra_children', CASE
        WHEN es.billable AND et.max_kids IS NOT NULL AND e.num_children IS NOT NULL
          THEN GREATEST(e.num_children - et.max_kids, 0)
        ELSE 0
      END,
      'extra_child_price_satang', et.extra_child_price
    ) ORDER BY es.sort_order, es.created_at, es.id)
    FROM beo_entertainment_selections es
    LEFT JOIN entertainment_package_templates et ON et.id = es.template_id AND et.tenant_id = e.tenant_id
    WHERE es.event_id = e.id
  ), '[]'::jsonb) AS entertainment,
  COALESCE((
    SELECT jsonb_agg(line.item ORDER BY line.ord, line.sub)
    FROM (
      SELECT
        it.ord,
        o.sub,
        jsonb_build_object(
          'product_code', COALESCE(
            NULLIF(btrim(it.item -> 'optionProductCodes' ->> o.opt), ''),
            NULLIF(btrim(it.item ->> 'productCode'), '')
          ),
          'name', it.item ->> 'label',
          'qty', CASE
            WHEN cardinality(c.chosen) > 1 THEN NULL
            WHEN it.item ->> 'qty' ~ '^[1-9][0-9]{0,5}$' THEN (it.item ->> 'qty')::integer
          END,
          'choice_group', CASE WHEN it.item ->> 'type' = 'choice_group' THEN it.item ->> 'label' END,
          'chosen_option', o.opt,
          'note', NULLIF(btrim(it.item ->> 'note'), '')
        ) AS item
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(m.items) = 'array' THEN m.items ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS it(item, ord)
      CROSS JOIN LATERAL (
        SELECT COALESCE(array_agg(ch.opt ORDER BY sl.n, ch.n), '{}'::text[]) AS chosen
        FROM jsonb_array_elements(
          CASE
            WHEN it.item ->> 'type' = 'choice_group' AND jsonb_typeof(sel.selections) = 'array'
              THEN sel.selections
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS sl(entry, n)
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE
            WHEN sl.entry ->> 'groupId' = it.item ->> 'id' AND jsonb_typeof(sl.entry -> 'chosenOptions') = 'array'
              THEN sl.entry -> 'chosenOptions'
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY AS ch(opt, n)
      ) c
      CROSS JOIN LATERAL unnest(
        CASE WHEN cardinality(c.chosen) = 0 THEN ARRAY[NULL::text] ELSE c.chosen END
      ) WITH ORDINALITY AS o(opt, sub)
      WHERE it.item ->> 'type' IN ('always_included', 'choice_group')
    ) line
  ), '[]'::jsonb) AS set_menu,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'product_code', NULL::text,
      'name', b.item ->> 'itemName',
      'qty', CASE WHEN b.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (b.item ->> 'quantity')::integer ELSE 1 END
    ) ORDER BY b.ord)
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(bp.items) = 'array' THEN bp.items ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS b(item, ord)
    WHERE NULLIF(btrim(b.item ->> 'itemName'), '') IS NOT NULL
  ), '[]'::jsonb) AS bar_items,
  jsonb_build_object(
    'kids_food_time', CASE WHEN jsonb_typeof(kp.menus) = 'object' THEN NULLIF(btrim(kp.menus ->> 'kidsFoodTime'), '') END,
    'adults_food_time', CASE WHEN jsonb_typeof(kp.menus) = 'object' THEN NULLIF(btrim(kp.menus ->> 'adultsFoodTime'), '') END,
    'ready_offset_minutes', COALESCE(kp.kitchen_ready_offset_minutes, 20),
    'slips_time', to_char(COALESCE(s.slips_time, time '11:00'), 'HH24:MI')
  ) AS kitchen,
  jsonb_build_object(
    -- The party's one deposit, as otoapp_v.events reads it above.
    'deposit_satang', ev.deposit_satang,
    'pos_sale_id', NULLIF(btrim(bl.pos_order_ref), '')
  ) AS settlement
FROM core_events e
JOIN otoapp_v.events ev ON ev.id = e.id AND ev.tenant_id = e.tenant_id AND ev.type = 'party'
JOIN beo_package_snapshots s ON s.event_id = e.id
LEFT JOIN beo_kitchen_plans kp ON kp.event_id = e.id
LEFT JOIN beo_set_menu_templates m
  ON kp.set_menu_enabled AND m.id = kp.set_menu_template_id AND m.tenant_id = e.tenant_id
LEFT JOIN beo_set_menu_selections sel
  ON sel.event_id = e.id AND sel.template_id = m.id AND sel.is_submitted
LEFT JOIN beo_bar_plans bp ON bp.event_id = e.id
LEFT JOIN beo_event_billing bl ON bl.event_id = e.id;
