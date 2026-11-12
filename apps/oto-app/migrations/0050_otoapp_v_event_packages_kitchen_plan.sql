-- THE WHOLE KITCHEN PLAN REACHES THE TILL (SCRUM-906, Lane B; the owner's
-- decisions of 12 November 2026): every food line of the BEO's kitchen
-- plan, coded or hand-typed, the staff's latest set-menu choice, the cake as
-- the BEO's cake choice says, and the bar's lines with their own till codes,
-- for a party with or without a package.
--
-- WHAT CHANGES, AND WHAT DOES NOT. `otoapp_v.event_packages` keeps its
-- thirteen columns, in the same order, of the same types, each expression
-- exactly as 0048 wrote it, so a platform release that reads them reads what
-- it read before (its slips, its settlement, its change detection: nothing
-- it composes moves). Two things are added:
--
--   1. ONE NEW COLUMN, `kitchen_plan` (jsonb), at the end (CREATE OR REPLACE
--      may add a column only there; it keeps the view and its grants):
--
--        { "version": 1,
--          "lines":     [ every food line, in the BEO's order ],
--          "bar_lines": [ every bar line ],
--          "cake":      { mode, qty, time, notes } | null,
--          "bar_service_time": "HH:MM" | null }
--
--      Each food line: { line_id, source, product_code, name, qty,
--      choice_group, chosen_option, note, unit_price_satang } and, where
--      0048 marks a line, `audience` and `adults_note` exactly as 0048 marks
--      them. `source` is the BEO's own badge: "set_menu" (SET) or "extra"
--      (EXTRA, or a line from before the badge). `unit_price_satang` is the
--      price entered on the BEO line, in satang, null when none was entered
--      (the BEO keeps baht). `line_id` is the BEO line's own id, null for a
--      set-menu template line no BEO line answers.
--
--      The set menu (template attached and switched on), one entry per
--      template item, in the template's order:
--        - an item the BEO's set-menu lines answer — by the line's groupId,
--          or, for a line saved before groupId, as the BEO's set-menu block
--          matches it (beo-event-editor.tsx, SetMenuChoiceGroups: a fixed
--          item by its name with no note, a choice by the note "(<group>)")
--          — is those lines as staff last left them: a choice's dish, count
--          and note are the BEO line's, so the latest change wins, whoever
--          made it (the parent link's submit, an AI fill's approval and a
--          staff edit all write these same lines; the parent's submission
--          table is no longer read here). A fixed item takes its first line,
--          as the BEO's block shows it; a choice takes every line of its
--          group, with no count when there are several (the menu does not
--          say how the portions split, as 0042 reads it);
--        - an item no BEO line answers is the template's own line, as 0048
--          gives it: an open choice names its group with no option.
--      Then every line of the kids' list the set menu did not take, coded
--      or not, and then the adults' list as 0048 reads it (with "Different
--      for adults" on, every adults' line that is not the same dish as a
--      kids' line; with it off, the adults' lines of a BEO saved before the
--      switch). The set menu's own lines are read from the list the BEO's
--      block reads them from: the kids' list when it holds one, else the
--      adults'. The codes: a line's own productCode, else the template's
--      code for that option or item.
--
--      The bar: every named line of the bar plan, with its own till code
--      (null until a line has one), its note, its badge and its price. The
--      cake: the kitchen plan's cake mode ("INTERNAL" our cake, "EXTERNAL"
--      the family's own), its quantity, its time and its notes; null for
--      "NONE". `bar_service_time`: the bar plan's own.
--
--   2. A ROW FOR A PARTY WITH A KITCHEN OR BAR PLAN AND NO PACKAGE (the
--      owner's decision 8: the plan is shown on the till and its slips
--      print; settling still needs a package). The package snapshot is now
--      a LEFT JOIN; such a row's `package` is the same object with every
--      field null and no included lines, `add_ons` is empty, and `kitchen`
--      gives the slip time 11:00, as for a package that names none. A
--      platform release that reads `package.name` finds none and treats the
--      row as it treated no row. A party with no package, no kitchen plan
--      and no bar plan still has no row.
--
-- Names are folded and counts read as 0048 reads them. No data is written.
-- Expand-only. packages/db declares the thirteen columns it reads and
-- nothing else, so it is unchanged.
--
-- TO REVERSE: CREATE OR REPLACE cannot drop a column, so drop the view and
-- create it again from 0048: `DROP VIEW otoapp_v.event_packages;` then
-- 0048's statement with `CREATE OR REPLACE VIEW` read as `CREATE VIEW`, then
-- grant SELECT on it to the platform's api role again (dropping the view
-- drops its grants; the post-import step names the role). Nothing else
-- depends on the view.
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
      -- the kids' list holds one, and carries the adults' note when their
      -- list holds the kids' dish of that name with another note.
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
          WHEN an.note IS NOT NULL THEN jsonb_build_object('adults_note', an.note)
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
      -- The adults' note on the kids' dish of this line's name: the first
      -- adults' line that is the same dish as a kids' line of that name (the
      -- same count and till code) with another note; "" for a cleared note.
      LEFT JOIN LATERAL (
        SELECT btrim(COALESCE(aa.item ->> 'notes', '')) AS note
        FROM jsonb_array_elements(ad.kids) AS kk(item)
        JOIN jsonb_array_elements(ad.adults) AS aa(item)
          ON jsonb_typeof(aa.item) = 'object'
          AND lower(regexp_replace(btrim(COALESCE(aa.item ->> 'itemName', '')), '\s+', ' ', 'g'))
            = lower(regexp_replace(btrim(COALESCE(kk.item ->> 'itemName', '')), '\s+', ' ', 'g'))
          AND (CASE WHEN aa.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (aa.item ->> 'quantity')::integer ELSE 1 END)
            = (CASE WHEN kk.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (kk.item ->> 'quantity')::integer ELSE 1 END)
          AND btrim(COALESCE(aa.item ->> 'productCode', '')) = btrim(COALESCE(kk.item ->> 'productCode', ''))
          AND btrim(COALESCE(aa.item ->> 'notes', '')) <> btrim(COALESCE(kk.item ->> 'notes', ''))
        WHERE ad.differ
          AND jsonb_typeof(kk.item) = 'object'
          AND lower(regexp_replace(btrim(COALESCE(kk.item ->> 'itemName', '')), '\s+', ' ', 'g'))
            = lower(regexp_replace(btrim(COALESCE(o.opt, it.item ->> 'label', '')), '\s+', ' ', 'g'))
        LIMIT 1
      ) an ON true
      WHERE it.item ->> 'type' IN ('always_included', 'choice_group')
      UNION ALL
      -- SCRUM-828: the kids' list's lines the BEO gave a till product code;
      -- SCRUM-829 marks one "kids" when the adults' own list has no line of
      -- its name, carries the adults' note when their list holds the same
      -- dish with another note, and emits a line with no code too when the
      -- adults' list holds one of its name in another count or code.
      SELECT
        1 AS part,
        kl.ord,
        1::bigint AS sub,
        jsonb_build_object(
          'product_code', NULLIF(btrim(kl.item ->> 'productCode'), ''),
          'name', kl.item ->> 'itemName',
          'qty', CASE WHEN kl.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (kl.item ->> 'quantity')::integer ELSE 1 END,
          'choice_group', NULL::text,
          'chosen_option', NULL::text,
          'note', NULLIF(btrim(kl.item ->> 'notes'), '')
        ) || CASE
          WHEN an.note IS NOT NULL THEN jsonb_build_object('adults_note', an.note)
          WHEN ad.differ AND NOT ka.named THEN jsonb_build_object('audience', 'kids')
          ELSE '{}'::jsonb
        END AS item
      FROM jsonb_array_elements(ad.kids) WITH ORDINALITY AS kl(item, ord)
      -- Whether the adults' list names this dish, and whether it holds it as the same dish.
      CROSS JOIN LATERAL (
        SELECT
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(ad.adults) AS aa(item)
            WHERE jsonb_typeof(aa.item) = 'object'
              AND lower(regexp_replace(btrim(COALESCE(aa.item ->> 'itemName', '')), '\s+', ' ', 'g'))
                = lower(regexp_replace(btrim(COALESCE(kl.item ->> 'itemName', '')), '\s+', ' ', 'g'))
          ) AS named,
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(ad.adults) AS aa(item)
            WHERE jsonb_typeof(aa.item) = 'object'
              AND lower(regexp_replace(btrim(COALESCE(aa.item ->> 'itemName', '')), '\s+', ' ', 'g'))
                = lower(regexp_replace(btrim(COALESCE(kl.item ->> 'itemName', '')), '\s+', ' ', 'g'))
              AND (CASE WHEN aa.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (aa.item ->> 'quantity')::integer ELSE 1 END)
                = (CASE WHEN kl.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (kl.item ->> 'quantity')::integer ELSE 1 END)
              AND btrim(COALESCE(aa.item ->> 'productCode', '')) = btrim(COALESCE(kl.item ->> 'productCode', ''))
          ) AS same_dish
      ) ka
      LEFT JOIN LATERAL (
        SELECT btrim(COALESCE(aa.item ->> 'notes', '')) AS note
        FROM jsonb_array_elements(ad.adults) AS aa(item)
        WHERE ad.differ
          AND jsonb_typeof(aa.item) = 'object'
          AND lower(regexp_replace(btrim(COALESCE(aa.item ->> 'itemName', '')), '\s+', ' ', 'g'))
            = lower(regexp_replace(btrim(COALESCE(kl.item ->> 'itemName', '')), '\s+', ' ', 'g'))
          AND (CASE WHEN aa.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (aa.item ->> 'quantity')::integer ELSE 1 END)
            = (CASE WHEN kl.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (kl.item ->> 'quantity')::integer ELSE 1 END)
          AND btrim(COALESCE(aa.item ->> 'productCode', '')) = btrim(COALESCE(kl.item ->> 'productCode', ''))
          AND btrim(COALESCE(aa.item ->> 'notes', '')) <> btrim(COALESCE(kl.item ->> 'notes', ''))
        LIMIT 1
      ) an ON true
      WHERE jsonb_typeof(kl.item) = 'object'
        AND (
          (jsonb_typeof(kl.item -> 'productCode') = 'string' AND btrim(kl.item ->> 'productCode') <> '')
          OR (
            ad.differ AND btrim(COALESCE(kl.item ->> 'itemName', '')) <> '' AND ka.named AND NOT ka.same_dish
            -- A dish the set menu's template names is the set menu's own line above, never a second one.
            AND NOT EXISTS (
              SELECT 1
              FROM jsonb_array_elements(CASE WHEN jsonb_typeof(m.items) = 'array' THEN m.items ELSE '[]'::jsonb END) AS ti(item)
              WHERE ti.item ->> 'type' IN ('always_included', 'choice_group')
                AND (
                  lower(regexp_replace(btrim(COALESCE(ti.item ->> 'label', '')), '\s+', ' ', 'g'))
                    = lower(regexp_replace(btrim(COALESCE(kl.item ->> 'itemName', '')), '\s+', ' ', 'g'))
                  OR EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(ti.item -> 'options') = 'array' THEN ti.item -> 'options' ELSE '[]'::jsonb END) AS op(opt)
                    WHERE lower(regexp_replace(btrim(op.opt), '\s+', ' ', 'g'))
                      = lower(regexp_replace(btrim(COALESCE(kl.item ->> 'itemName', '')), '\s+', ' ', 'g'))
                  )
                )
            )
          )
        )
      UNION ALL
      -- The adults' list. With the switch off (0047): its coded lines, as the
      -- kids'. With it on (SCRUM-829): every line of the adults' own list that
      -- is not the same dish as a kids' line, marked "adults".
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
  ,
  -- SCRUM-906: the whole kitchen plan, as the header says.
  jsonb_build_object(
    'version', 1,
    'lines', COALESCE((
      SELECT jsonb_agg(
        line.item || CASE
          -- The set menu's own lines: marked as 0048 marks them, by the dish's name.
          WHEN line.part = 0 THEN CASE
            WHEN an0.note IS NOT NULL THEN jsonb_build_object('adults_note', an0.note)
            WHEN ad.differ
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(ad.kids) AS kk(item)
                WHERE jsonb_typeof(kk.item) = 'object'
                  AND lower(regexp_replace(btrim(COALESCE(kk.item ->> 'itemName', '')), '\s+', ' ', 'g'))
                    = lower(regexp_replace(btrim(COALESCE(line.dish, '')), '\s+', ' ', 'g'))
              )
              AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(ad.adults) AS aa(item)
                WHERE jsonb_typeof(aa.item) = 'object'
                  AND lower(regexp_replace(btrim(COALESCE(aa.item ->> 'itemName', '')), '\s+', ' ', 'g'))
                    = lower(regexp_replace(btrim(COALESCE(line.dish, '')), '\s+', ' ', 'g'))
              )
            THEN jsonb_build_object('audience', 'kids')
            ELSE '{}'::jsonb
          END
          -- The kids' list: marked as 0048 marks a kids' line.
          WHEN line.part = 1 THEN CASE
            WHEN an1.note IS NOT NULL THEN jsonb_build_object('adults_note', an1.note)
            WHEN ad.differ AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(ad.adults) AS aa(item)
              WHERE jsonb_typeof(aa.item) = 'object'
                AND lower(regexp_replace(btrim(COALESCE(aa.item ->> 'itemName', '')), '\s+', ' ', 'g'))
                  = lower(regexp_replace(btrim(COALESCE(line.dish, '')), '\s+', ' ', 'g'))
            ) THEN jsonb_build_object('audience', 'kids')
            ELSE '{}'::jsonb
          END
          -- The adults' own list.
          WHEN ad.differ THEN jsonb_build_object('audience', 'adults')
          ELSE '{}'::jsonb
        END
        ORDER BY line.part, line.ord, line.sub
      )
      FROM (
        -- (0a) A set-menu item the BEO's own lines answer: those lines.
        SELECT
          0 AS part,
          it.ord,
          ml.n AS sub,
          CASE WHEN it.item ->> 'type' = 'choice_group' THEN ml.item ->> 'itemName'
               ELSE COALESCE(NULLIF(btrim(ml.item ->> 'itemName'), ''), it.item ->> 'label') END AS dish,
          NULL::jsonb AS kl,
          jsonb_build_object(
            'line_id', NULLIF(btrim(COALESCE(ml.item ->> 'id', '')), ''),
            'source', 'set_menu',
            'product_code', COALESCE(
              NULLIF(btrim(ml.item ->> 'productCode'), ''),
              CASE WHEN it.item ->> 'type' = 'choice_group' AND jsonb_typeof(it.item -> 'optionProductCodes') = 'object'
                THEN NULLIF(btrim(it.item -> 'optionProductCodes' ->> (ml.item ->> 'itemName')), '') END,
              NULLIF(btrim(it.item ->> 'productCode'), '')
            ),
            'name', CASE WHEN it.item ->> 'type' = 'choice_group' THEN it.item ->> 'label'
                         ELSE COALESCE(NULLIF(btrim(ml.item ->> 'itemName'), ''), it.item ->> 'label') END,
            'qty', CASE
              WHEN it.item ->> 'type' = 'choice_group' AND ml.cnt > 1 THEN NULL
              WHEN ml.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (ml.item ->> 'quantity')::integer
              WHEN it.item ->> 'qty' ~ '^[1-9][0-9]{0,5}$' THEN (it.item ->> 'qty')::integer
            END,
            'choice_group', CASE WHEN it.item ->> 'type' = 'choice_group' THEN it.item ->> 'label' END,
            'chosen_option', CASE WHEN it.item ->> 'type' = 'choice_group' THEN ml.item ->> 'itemName' END,
            -- The note "(<group>)" is the line's mark of its group, not a note: the template's note stands.
            'note', CASE
              WHEN btrim(COALESCE(ml.item ->> 'notes', '')) IN ('', '(' || COALESCE(it.item ->> 'label', '') || ')')
                THEN NULLIF(btrim(it.item ->> 'note'), '')
              ELSE btrim(ml.item ->> 'notes')
            END,
            'unit_price_satang', CASE
              WHEN jsonb_typeof(ml.item -> 'price') = 'number' AND (ml.item ->> 'price')::numeric > 0
                THEN round((ml.item ->> 'price')::numeric * 100)::bigint
            END
          ) AS item
        FROM jsonb_array_elements(
          CASE WHEN m.id IS NOT NULL AND jsonb_typeof(m.items) = 'array' THEN m.items ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS it(item, ord)
        CROSS JOIN LATERAL (
          SELECT l.item, l.n, count(*) OVER () AS cnt
          FROM jsonb_array_elements(CASE WHEN sm.bucket = 'kids' THEN ad.kids ELSE ad.adults END) WITH ORDINALITY AS l(item, n)
          WHERE jsonb_typeof(l.item) = 'object'
            AND l.item ->> 'source' = 'set_menu'
            AND (
              NULLIF(btrim(COALESCE(l.item ->> 'groupId', '')), '') = it.item ->> 'id'
              OR (
                NULLIF(btrim(COALESCE(l.item ->> 'groupId', '')), '') IS NULL
                AND (
                  (it.item ->> 'type' = 'always_included' AND l.item ->> 'itemName' = it.item ->> 'label'
                    AND btrim(COALESCE(l.item ->> 'notes', '')) = '')
                  OR (it.item ->> 'type' = 'choice_group'
                    AND btrim(COALESCE(l.item ->> 'notes', '')) = '(' || COALESCE(it.item ->> 'label', '') || ')')
                )
              )
            )
            -- A fixed item takes the first line that answers it, as the BEO's block shows it.
            AND (
              it.item ->> 'type' = 'choice_group'
              OR NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(CASE WHEN sm.bucket = 'kids' THEN ad.kids ELSE ad.adults END) WITH ORDINALITY AS l2(item, n)
                WHERE l2.n < l.n
                  AND jsonb_typeof(l2.item) = 'object'
                  AND l2.item ->> 'source' = 'set_menu'
                  AND (
                    NULLIF(btrim(COALESCE(l2.item ->> 'groupId', '')), '') = it.item ->> 'id'
                    OR (
                      NULLIF(btrim(COALESCE(l2.item ->> 'groupId', '')), '') IS NULL
                      AND l2.item ->> 'itemName' = it.item ->> 'label'
                      AND btrim(COALESCE(l2.item ->> 'notes', '')) = ''
                    )
                  )
              )
            )
        ) ml
        WHERE it.item ->> 'type' IN ('always_included', 'choice_group')
        UNION ALL
        -- (0b) A set-menu item no BEO line answers: the template's own line, as 0048 gives it.
        SELECT
          0 AS part,
          it.ord,
          1::bigint AS sub,
          it.item ->> 'label' AS dish,
          NULL::jsonb AS kl,
          jsonb_build_object(
            'line_id', NULL::text,
            'source', 'set_menu',
            'product_code', NULLIF(btrim(it.item ->> 'productCode'), ''),
            'name', it.item ->> 'label',
            'qty', CASE WHEN it.item ->> 'qty' ~ '^[1-9][0-9]{0,5}$' THEN (it.item ->> 'qty')::integer END,
            'choice_group', CASE WHEN it.item ->> 'type' = 'choice_group' THEN it.item ->> 'label' END,
            'chosen_option', NULL::text,
            'note', NULLIF(btrim(it.item ->> 'note'), ''),
            'unit_price_satang', NULL::bigint
          ) AS item
        FROM jsonb_array_elements(
          CASE WHEN m.id IS NOT NULL AND jsonb_typeof(m.items) = 'array' THEN m.items ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS it(item, ord)
        WHERE it.item ->> 'type' IN ('always_included', 'choice_group')
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(CASE WHEN sm.bucket = 'kids' THEN ad.kids ELSE ad.adults END) AS l(item)
            WHERE jsonb_typeof(l.item) = 'object'
              AND l.item ->> 'source' = 'set_menu'
              AND (
                NULLIF(btrim(COALESCE(l.item ->> 'groupId', '')), '') = it.item ->> 'id'
                OR (
                  NULLIF(btrim(COALESCE(l.item ->> 'groupId', '')), '') IS NULL
                  AND (
                    (it.item ->> 'type' = 'always_included' AND l.item ->> 'itemName' = it.item ->> 'label'
                      AND btrim(COALESCE(l.item ->> 'notes', '')) = '')
                    OR (it.item ->> 'type' = 'choice_group'
                      AND btrim(COALESCE(l.item ->> 'notes', '')) = '(' || COALESCE(it.item ->> 'label', '') || ')')
                  )
                )
              )
          )
        UNION ALL
        -- (1) The kids' list, every named line the set menu did not take; (2) the adults', as 0048 reads it.
        SELECT
          CASE WHEN li.list = 'kids' THEN 1 ELSE 2 END AS part,
          li.ord,
          1::bigint AS sub,
          li.item ->> 'itemName' AS dish,
          li.item AS kl,
          jsonb_build_object(
            'line_id', NULLIF(btrim(COALESCE(li.item ->> 'id', '')), ''),
            'source', CASE WHEN li.item ->> 'source' = 'set_menu' THEN 'set_menu' ELSE 'extra' END,
            'product_code', NULLIF(btrim(li.item ->> 'productCode'), ''),
            'name', li.item ->> 'itemName',
            'qty', CASE WHEN li.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (li.item ->> 'quantity')::integer ELSE 1 END,
            'choice_group', NULL::text,
            'chosen_option', NULL::text,
            'note', NULLIF(btrim(li.item ->> 'notes'), ''),
            'unit_price_satang', CASE
              WHEN jsonb_typeof(li.item -> 'price') = 'number' AND (li.item ->> 'price')::numeric > 0
                THEN round((li.item ->> 'price')::numeric * 100)::bigint
            END
          ) AS item
        FROM (
          SELECT 'kids' AS list, k.item, k.ord FROM jsonb_array_elements(ad.kids) WITH ORDINALITY AS k(item, ord)
          UNION ALL
          SELECT 'adults', a.item, a.ord FROM jsonb_array_elements(ad.adults) WITH ORDINALITY AS a(item, ord)
        ) li
        WHERE jsonb_typeof(li.item) = 'object'
          AND btrim(COALESCE(li.item ->> 'itemName', '')) <> ''
          -- The adults' list: with the switch on, a line that is not the same dish as a kids' line (0048).
          AND (
            li.list = 'kids'
            OR NOT ad.differ
            OR NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(ad.kids) AS kk(item)
              WHERE jsonb_typeof(kk.item) = 'object'
                AND lower(regexp_replace(btrim(COALESCE(kk.item ->> 'itemName', '')), '\s+', ' ', 'g'))
                  = lower(regexp_replace(btrim(COALESCE(li.item ->> 'itemName', '')), '\s+', ' ', 'g'))
                AND (CASE WHEN kk.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (kk.item ->> 'quantity')::integer ELSE 1 END)
                  = (CASE WHEN li.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (li.item ->> 'quantity')::integer ELSE 1 END)
                AND btrim(COALESCE(kk.item ->> 'productCode', '')) = btrim(COALESCE(li.item ->> 'productCode', ''))
            )
          )
          -- A line the set menu took above is not a second line.
          AND NOT (
            m.id IS NOT NULL
            AND jsonb_typeof(m.items) = 'array'
            AND li.list = sm.bucket
            AND li.item ->> 'source' = 'set_menu'
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(m.items) AS ti(item)
              WHERE ti.item ->> 'type' IN ('always_included', 'choice_group')
                AND (
                  NULLIF(btrim(COALESCE(li.item ->> 'groupId', '')), '') = ti.item ->> 'id'
                  OR (
                    NULLIF(btrim(COALESCE(li.item ->> 'groupId', '')), '') IS NULL
                    AND (
                      (ti.item ->> 'type' = 'always_included' AND li.item ->> 'itemName' = ti.item ->> 'label'
                        AND btrim(COALESCE(li.item ->> 'notes', '')) = '')
                      OR (ti.item ->> 'type' = 'choice_group'
                        AND btrim(COALESCE(li.item ->> 'notes', '')) = '(' || COALESCE(ti.item ->> 'label', '') || ')')
                    )
                  )
                )
                -- A fixed item's second line is not the item's: it stays a line of its own.
                AND (
                  ti.item ->> 'type' = 'choice_group'
                  OR NOT EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(CASE WHEN sm.bucket = 'kids' THEN ad.kids ELSE ad.adults END) WITH ORDINALITY AS l2(item, n)
                    WHERE l2.n < li.ord
                      AND jsonb_typeof(l2.item) = 'object'
                      AND l2.item ->> 'source' = 'set_menu'
                      AND (
                        NULLIF(btrim(COALESCE(l2.item ->> 'groupId', '')), '') = ti.item ->> 'id'
                        OR (
                          NULLIF(btrim(COALESCE(l2.item ->> 'groupId', '')), '') IS NULL
                          AND l2.item ->> 'itemName' = ti.item ->> 'label'
                          AND btrim(COALESCE(l2.item ->> 'notes', '')) = ''
                        )
                      )
                  )
                )
            )
          )
      ) line
      -- 0048's adults' note on a set-menu dish: the first adults' line that is the same dish
      -- as a kids' line of the dish's name, with another note.
      LEFT JOIN LATERAL (
        SELECT btrim(COALESCE(aa.item ->> 'notes', '')) AS note
        FROM jsonb_array_elements(ad.kids) AS kk(item)
        JOIN jsonb_array_elements(ad.adults) AS aa(item)
          ON jsonb_typeof(aa.item) = 'object'
          AND lower(regexp_replace(btrim(COALESCE(aa.item ->> 'itemName', '')), '\s+', ' ', 'g'))
            = lower(regexp_replace(btrim(COALESCE(kk.item ->> 'itemName', '')), '\s+', ' ', 'g'))
          AND (CASE WHEN aa.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (aa.item ->> 'quantity')::integer ELSE 1 END)
            = (CASE WHEN kk.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (kk.item ->> 'quantity')::integer ELSE 1 END)
          AND btrim(COALESCE(aa.item ->> 'productCode', '')) = btrim(COALESCE(kk.item ->> 'productCode', ''))
          AND btrim(COALESCE(aa.item ->> 'notes', '')) <> btrim(COALESCE(kk.item ->> 'notes', ''))
        WHERE line.part = 0
          AND ad.differ
          AND jsonb_typeof(kk.item) = 'object'
          AND lower(regexp_replace(btrim(COALESCE(kk.item ->> 'itemName', '')), '\s+', ' ', 'g'))
            = lower(regexp_replace(btrim(COALESCE(line.dish, '')), '\s+', ' ', 'g'))
        LIMIT 1
      ) an0 ON true
      -- 0048's adults' note on a kids' line: the first adults' line that is the same dish, with another note.
      LEFT JOIN LATERAL (
        SELECT btrim(COALESCE(aa.item ->> 'notes', '')) AS note
        FROM jsonb_array_elements(ad.adults) AS aa(item)
        WHERE line.part = 1
          AND ad.differ
          AND jsonb_typeof(aa.item) = 'object'
          AND lower(regexp_replace(btrim(COALESCE(aa.item ->> 'itemName', '')), '\s+', ' ', 'g'))
            = lower(regexp_replace(btrim(COALESCE(line.kl ->> 'itemName', '')), '\s+', ' ', 'g'))
          AND (CASE WHEN aa.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (aa.item ->> 'quantity')::integer ELSE 1 END)
            = (CASE WHEN line.kl ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (line.kl ->> 'quantity')::integer ELSE 1 END)
          AND btrim(COALESCE(aa.item ->> 'productCode', '')) = btrim(COALESCE(line.kl ->> 'productCode', ''))
          AND btrim(COALESCE(aa.item ->> 'notes', '')) <> btrim(COALESCE(line.kl ->> 'notes', ''))
        LIMIT 1
      ) an1 ON true
    ), '[]'::jsonb),
    'bar_lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'line_id', NULLIF(btrim(COALESCE(b.item ->> 'id', '')), ''),
        'source', CASE WHEN b.item ->> 'source' = 'set_menu' THEN 'set_menu' ELSE 'extra' END,
        'product_code', NULLIF(btrim(b.item ->> 'productCode'), ''),
        'name', b.item ->> 'itemName',
        'qty', CASE WHEN b.item ->> 'quantity' ~ '^[1-9][0-9]{0,5}$' THEN (b.item ->> 'quantity')::integer ELSE 1 END,
        'note', NULLIF(btrim(b.item ->> 'notes'), ''),
        'unit_price_satang', CASE
          WHEN jsonb_typeof(b.item -> 'price') = 'number' AND (b.item ->> 'price')::numeric > 0
            THEN round((b.item ->> 'price')::numeric * 100)::bigint
        END
      ) ORDER BY b.ord)
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(bp.items) = 'array' THEN bp.items ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS b(item, ord)
      WHERE jsonb_typeof(b.item) = 'object' AND NULLIF(btrim(b.item ->> 'itemName'), '') IS NOT NULL
    ), '[]'::jsonb),
    'cake', CASE
      WHEN kp.cake_mode::text IN ('INTERNAL', 'EXTERNAL') THEN jsonb_build_object(
        'mode', kp.cake_mode::text,
        'qty', kp.cake_quantity,
        'time', NULLIF(btrim(kp.cake_time), ''),
        'notes', NULLIF(btrim(kp.cake_notes), '')
      )
    END,
    'bar_service_time', NULLIF(btrim(bp.service_time), '')
  ) AS kitchen_plan
FROM core_events e
JOIN otoapp_v.events ev ON ev.id = e.id AND ev.tenant_id = e.tenant_id AND ev.type = 'party'
-- SCRUM-906: a party with a kitchen or bar plan and no package has a row too (the WHERE below).
LEFT JOIN beo_package_snapshots s ON s.event_id = e.id
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
-- SCRUM-906: the list the BEO's set-menu block reads the set menu's lines from: the kids' when it holds one.
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(ad.kids) AS k(item)
      WHERE jsonb_typeof(k.item) = 'object' AND k.item ->> 'source' = 'set_menu'
    ) THEN 'kids'
    ELSE 'adults'
  END AS bucket
) sm
LEFT JOIN beo_set_menu_templates m
  ON kp.set_menu_enabled AND m.id = kp.set_menu_template_id AND m.tenant_id = e.tenant_id
LEFT JOIN beo_set_menu_selections sel
  ON sel.event_id = e.id AND sel.template_id = m.id AND sel.is_submitted
LEFT JOIN beo_bar_plans bp ON bp.event_id = e.id
LEFT JOIN beo_event_billing bl ON bl.event_id = e.id
WHERE s.id IS NOT NULL OR kp.id IS NOT NULL OR bp.id IS NOT NULL;
