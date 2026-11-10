-- THE KIDS' MENU IS THE MAIN SELECTION; THE ADULTS MIRROR IT (SCRUM-829):
-- the plan the till reads marks the adults' changes on ONE food list and
-- never charges a copied line twice.
--
-- The BEO's kitchen plan now opens its adults' section from the kids' list.
-- While "Different for adults" is off, the adults' list IS the kids' list and
-- `menus.adults` is saved empty; on, `menus.adults` is the adults' own list,
-- started as a copy of the kids' and changed by staff, and `menus.adultsDiffer`
-- is true (apps/oto-app/shared/kitchenAdults.ts). A BEO saved before this has
-- no `adultsDiffer` key and keeps the reading below exactly as 0047 gave it.
--
-- set_menu, when `menus.adultsDiffer` is true:
--
--   - the set menu's own lines and the kids' coded lines, as 0047 emits them,
--     each with `"audience": "kids"` when the kids' list holds a line of that
--     name and the adults' list holds none (a dish the adults do not get);
--   - then every adults' line, coded or not, that is NOT an unchanged copy of
--     a kids' line (the same name, count, note and till code), with
--     `"audience": "adults"`: a dish the adults get instead or beside, or in
--     another count. An unchanged copy is left out, so a coded item copied for
--     the adults reaches the till ONCE: the settlement charges what this view
--     emits (party-settlement.ts, partyMenuChargesOf), so its figures are what
--     a one-list BEO is charged today, and an adults-only line is charged as a
--     two-list BEO's adults' line is charged today. The kitchen slip
--     (packages/shared/src/party-slips.ts) folds an "adults" line into the
--     kids' line of the same name — "kids N · adults M" beside it — or prints
--     it marked "adults only", and prints a "kids" line marked "kids only".
--
-- When `menus.adultsDiffer` is absent or false: exactly 0047 — the kitchen
-- plan's coded lines, kids before adults, no `audience` key — so no party
-- saved before this changes its plan, its slips or its settlement.
--
-- Names are compared folded (trimmed, lower-cased, one space between words);
-- a count is the line's quantity when it reads as a whole number 1-999999,
-- else 1, as 0047 reads it. `audience` is an extra key on the set_menu
-- entries only where it applies: the view keeps the same columns, in the same
-- order, of the same types (CREATE OR REPLACE keeps it and its grants), every
-- other expression as 0047 wrote it; packages/db declares it unchanged. No
-- data is written. Expand-only.
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
      -- The set menu's own lines, as 0042 and 0045 read them; SCRUM-829 marks
      -- one "kids" when the adults' own list has no line of its name while
      -- the kids' list holds one.
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
        ) || CASE
          WHEN ad.differ
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(ad.kids) AS kk(item)
              WHERE jsonb_typeof(kk.item) = 'object'
                AND lower(regexp_replace(btrim(COALESCE(kk.item ->> 'itemName', '')), '\s+', ' ', 'g'))
                  = lower(regexp_replace(btrim(COALESCE(o.opt, it.item ->> 'label', '')), '\s+', ' ', 'g'))
            )
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(ad.adults) AS aa(item)
              WHERE jsonb_typeof(aa.item) = 'object'
                AND lower(regexp_replace(btrim(COALESCE(aa.item ->> 'itemName', '')), '\s+', ' ', 'g'))
                  = lower(regexp_replace(btrim(COALESCE(o.opt, it.item ->> 'label', '')), '\s+', ' ', 'g'))
            )
          THEN jsonb_build_object('audience', 'kids')
          ELSE '{}'::jsonb
        END AS item
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
      -- SCRUM-828: the kids' list's lines the BEO gave a till product code;
      -- SCRUM-829 marks one "kids" when the adults' own list has no line of its name.
      SELECT
        1 AS part,
        kl.ord,
        1::bigint AS sub,
        jsonb_build_object(
          'product_code', btrim(kl.item ->> 'productCode'),
          'name', kl.item ->> 'itemName',
          'qty', CASE WHEN kl.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (kl.item ->> 'quantity')::integer ELSE 1 END,
          'choice_group', NULL::text,
          'chosen_option', NULL::text,
          'note', NULLIF(btrim(kl.item ->> 'notes'), '')
        ) || CASE
          WHEN ad.differ
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(ad.adults) AS aa(item)
              WHERE jsonb_typeof(aa.item) = 'object'
                AND lower(regexp_replace(btrim(COALESCE(aa.item ->> 'itemName', '')), '\s+', ' ', 'g'))
                  = lower(regexp_replace(btrim(COALESCE(kl.item ->> 'itemName', '')), '\s+', ' ', 'g'))
            )
          THEN jsonb_build_object('audience', 'kids')
          ELSE '{}'::jsonb
        END AS item
      FROM jsonb_array_elements(ad.kids) WITH ORDINALITY AS kl(item, ord)
      WHERE jsonb_typeof(kl.item) = 'object'
        AND jsonb_typeof(kl.item -> 'productCode') = 'string'
        AND btrim(kl.item ->> 'productCode') <> ''
      UNION ALL
      -- The adults' list. Without the switch (0047): its coded lines, as the
      -- kids'. With it (SCRUM-829): every line of the adults' own list that is
      -- not an unchanged copy of a kids' line, marked "adults".
      SELECT
        2 AS part,
        al.ord,
        1::bigint AS sub,
        jsonb_build_object(
          'product_code', NULLIF(btrim(al.item ->> 'productCode'), ''),
          'name', al.item ->> 'itemName',
          'qty', CASE WHEN al.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (al.item ->> 'quantity')::integer ELSE 1 END,
          'choice_group', NULL::text,
          'chosen_option', NULL::text,
          'note', NULLIF(btrim(al.item ->> 'notes'), '')
        ) || CASE WHEN ad.differ THEN jsonb_build_object('audience', 'adults') ELSE '{}'::jsonb END AS item
      FROM jsonb_array_elements(ad.adults) WITH ORDINALITY AS al(item, ord)
      WHERE jsonb_typeof(al.item) = 'object'
        AND CASE
          WHEN ad.differ THEN
            btrim(COALESCE(al.item ->> 'itemName', '')) <> ''
            AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(ad.kids) AS kk(item)
              WHERE jsonb_typeof(kk.item) = 'object'
                AND lower(regexp_replace(btrim(COALESCE(kk.item ->> 'itemName', '')), '\s+', ' ', 'g'))
                  = lower(regexp_replace(btrim(COALESCE(al.item ->> 'itemName', '')), '\s+', ' ', 'g'))
                AND (CASE WHEN kk.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (kk.item ->> 'quantity')::integer ELSE 1 END)
                  = (CASE WHEN al.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (al.item ->> 'quantity')::integer ELSE 1 END)
                AND btrim(COALESCE(kk.item ->> 'notes', '')) = btrim(COALESCE(al.item ->> 'notes', ''))
                AND btrim(COALESCE(kk.item ->> 'productCode', '')) = btrim(COALESCE(al.item ->> 'productCode', ''))
            )
          ELSE
            jsonb_typeof(al.item -> 'productCode') = 'string'
            AND btrim(al.item ->> 'productCode') <> ''
        END
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
-- SCRUM-829: the kitchen plan's two lists and its "Different for adults" switch, read once.
CROSS JOIN LATERAL (
  SELECT
    COALESCE(
      jsonb_typeof(kp.menus) = 'object'
        AND jsonb_typeof(kp.menus -> 'adultsDiffer') = 'boolean'
        AND (kp.menus -> 'adultsDiffer')::text = 'true',
      false
    ) AS differ,
    CASE WHEN jsonb_typeof(kp.menus -> 'kids') = 'array' THEN kp.menus -> 'kids' ELSE '[]'::jsonb END AS kids,
    CASE WHEN jsonb_typeof(kp.menus -> 'adults') = 'array' THEN kp.menus -> 'adults' ELSE '[]'::jsonb END AS adults
) ad
LEFT JOIN beo_set_menu_templates m
  ON kp.set_menu_enabled AND m.id = kp.set_menu_template_id AND m.tenant_id = e.tenant_id
LEFT JOIN beo_set_menu_selections sel
  ON sel.event_id = e.id AND sel.template_id = m.id AND sel.is_submitted
LEFT JOIN beo_bar_plans bp ON bp.event_id = e.id
LEFT JOIN beo_event_billing bl ON bl.event_id = e.id;
