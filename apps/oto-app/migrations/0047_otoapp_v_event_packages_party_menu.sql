-- A NEW MENU ITEM FROM THE BEO (SCRUM-828): the kitchen plan's own lines the
-- BEO gave a till product code reach the till's plan and its slips.
--
-- From the BEO's food lines staff add an item the till's catalogue does not
-- have yet (a special cake, a dish one family asked for). The app's server
-- asks the platform to make it a BEO-only till product and writes the code it
-- answers onto that kitchen plan line, as `productCode`, beside its name
-- (server/party-menu-routes.ts). Until now otoapp_v.event_packages' set_menu
-- read the set menu TEMPLATE's items alone, so a line in the kitchen plan
-- itself (beo_kitchen_plans.menus, its kids and adults lists) never reached
-- the till however it was coded.
--
-- set_menu now also carries every kitchen plan line whose productCode is a
-- non-empty string, after the set menu's own lines, kids before adults, each
-- in its list's order:
--
--   product_code   the line's productCode, trimmed
--   name           the line's itemName
--   qty            the line's quantity when it reads as a whole number
--                  1-999999, else 1 (the BEO's own default)
--   choice_group   null: a line of its own, never a group's choice
--   chosen_option  null
--   note           the line's notes, trimmed, null when blank
--
-- A line no till code names is left out, exactly as before: the kitchen
-- plan's other lines (typed names, the set menu's resolved choices, which
-- the template part already gives) do not change the plan or the slips of
-- any party saved before this. The till's plan (party-plan.ts) and its slips
-- (party-slips.ts) then find the product by its code like any catalogue item.
--
-- Nothing else changes: the view keeps the same columns, in the same order,
-- of the same types (CREATE OR REPLACE keeps it and its grants), every other
-- expression as 0045 wrote it; packages/db declares it unchanged. No data is
-- written. Expand-only.
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
    SELECT jsonb_agg(line.item ORDER BY line.part, line.ord, line.sub)
    FROM (
      -- The set menu's own lines, as 0042 and 0045 read them.
      SELECT
        0 AS part,
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
      UNION ALL
      -- SCRUM-828: the kitchen plan's own lines the BEO gave a till product code.
      SELECT
        k.part,
        k.ord,
        1::bigint AS sub,
        jsonb_build_object(
          'product_code', btrim(k.item ->> 'productCode'),
          'name', k.item ->> 'itemName',
          'qty', CASE WHEN k.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (k.item ->> 'quantity')::integer ELSE 1 END,
          'choice_group', NULL::text,
          'chosen_option', NULL::text,
          'note', NULLIF(btrim(k.item ->> 'notes'), '')
        ) AS item
      FROM (
        SELECT 1 AS part, kl.item, kl.ord
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(kp.menus -> 'kids') = 'array' THEN kp.menus -> 'kids' ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS kl(item, ord)
        UNION ALL
        SELECT 2 AS part, al.item, al.ord
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(kp.menus -> 'adults') = 'array' THEN kp.menus -> 'adults' ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS al(item, ord)
      ) k
      WHERE jsonb_typeof(k.item) = 'object'
        AND jsonb_typeof(k.item -> 'productCode') = 'string'
        AND btrim(k.item ->> 'productCode') <> ''
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
    -- The party's one deposit, as otoapp_v.events reads it (0045).
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
