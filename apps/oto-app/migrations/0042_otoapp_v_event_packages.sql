-- The birthday package seam (SCRUM-803): one read-only view in schema
-- `otoapp_v` that gives the platform each party's package, as the BEO planned
-- it, so the POS can settle the party as one sale and print its kitchen and bar
-- slips (BIRTHDAY_PLAN.md sections 2-5; the contract is BIRTHDAY_CONTRACT.md).
--
-- Plan in the OTO App, execute in the POS: this app stays the master of the
-- package, the counts, the menu and the timings. The platform reads this view
-- and writes back only the settlement sale's id, through the directory API's
-- party edit (`pos_sale_id`, stored in `beo_event_billing.pos_order_ref`).
--
-- ONE ROW PER PARTY THAT HAS A PACKAGE: a party in `otoapp_v.events` (type
-- `party`, so only at a branch the platform knows) with a package snapshot,
-- the package the BEO applied. Archived and cancelled parties are not left
-- out here; `otoapp_v.events` carries `archived` and `status` for that.
--
-- MONEY IS SATANG and is passed through, never multiplied: the package,
-- line-item and entertainment tables already store satang (the settings
-- screens divide by 100; 16,900 THB is 1690000). The one exception is the
-- deposit, which `core_events` keeps in whole baht and which is read exactly
-- as `otoapp_v.events.deposit_satang` reads it.
--
-- The package's prices are the SNAPSHOT's — what the template said when the
-- package was applied (migration 0041), so a party keeps the prices it was sold
-- at. A day price the package does not set falls back as the app has always
-- priced a package: weekday to the base price, weekend to the weekday price.
-- An extra-child or extra-adult price left unset stays null. A snapshot made
-- before 0041 has no limits; re-applying the package in the BEO fills them.
--
-- Each jsonb column is written to survive one odd row rather than fail the
-- read: a list is unpacked only when it is an array, a quantity read only when
-- it is a whole number, a date or time cast only when it is one.
--
--   package       { template_id, name, hours, kids_included, adults_included,
--                   socks_included (-1 = all children), price_weekday_satang,
--                   price_weekend_satang, extra_child_weekday_satang,
--                   extra_child_weekend_satang, extra_adult_weekday_satang,
--                   extra_adult_weekend_satang, included_lines: [{ label }] }
--   counts        { kids_expected, adults_expected }
--   add_ons       [{ template_id, name, qty, unit_price_satang,
--                   fnb_credit_satang, prints_voucher }] — the snapshot's
--                   add-on lines the BEO keeps billable with a quantity; the
--                   F&B credit is per unit, from the package's line item
--   entertainment [{ template_id, name, category, duration_minutes,
--                   age_range, max_kids, price_satang, extra_children,
--                   extra_child_price_satang }] — the party's selections; one
--                   the BEO marks not billable (included in the package) is
--                   priced 0 with no extra children; extra_children are the
--                   expected kids beyond the line's max_kids
--   set_menu      [{ product_code, name, qty, choice_group, chosen_option,
--                   note }] — the set menu the kitchen plan has switched on,
--                   item by item; a choice group gives one row per option the
--                   parent chose (product code by option), or one row with no
--                   option while the choice is still open; a quantity is the
--                   menu's own, null when it prints none or when the portions
--                   of one group are split over several choices
--   bar_items     [{ product_code, name, qty }] — the bar plan's lines; no
--                   bar line names a till product yet, so product_code is null
--   kitchen       { kids_food_time, adults_food_time, ready_offset_minutes,
--                   slips_time } — HH:MM on the park's clock; slips_time is the
--                   party's own, 11:00 when nothing says otherwise
--   settlement    { deposit_satang, pos_sale_id }
--
-- Grants are not made here, for the reason 0004 gives: the post-import step
-- gives the platform's api role SELECT on the views in `otoapp_v`, never on
-- the tables.
CREATE VIEW otoapp_v.event_packages AS
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
    'deposit_satang', e.prepayment_amount::bigint * 100,
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
