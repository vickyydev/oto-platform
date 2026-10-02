import { sql } from 'drizzle-orm';
import type { Db } from '@oto/db';

/**
 * S2-15a round 1 — OPEN EVERY DRAWER, for a suite that refunds in cash.
 *
 * Since S2-15a a cash refund slice leaves the drawer of the counter the refund
 * is made at, as a `refund_out` on that drawer's open session, and a counter
 * whose drawer is not open refuses it (`CASH_SESSION_NOT_OPEN`). A suite whose
 * subject is something else — stock going back on a shelf, credit going back
 * on a wallet — has its counter's drawer open the way a till's would be at the
 * start of the day: one session per live till that has none, at the branch's
 * standard float, opened by the branch's first active account, with its float
 * movement. `apps/api/test/cash-r1.test.ts` is where the drawer itself is
 * tested, through the routes.
 */
export async function openEveryCashDrawer(db: Db): Promise<void> {
  await db.execute(sql`
    with opened as (
      insert into pos.cash_session (id, operator_id, branch_id, station_id, business_date, status,
                                    opened_by_account_id, opened_at, opening_float_satang)
      select gen_random_uuid(), s.operator_id, s.branch_id, s.id,
             ((now() at time zone b.timezone) - b.business_day_start)::date, 'open',
             (select a.id from core.account a where a.operator_id = s.operator_id and a.status = 'active'
               order by a.created_at, a.id limit 1),
             now() - interval '1 day', b.cash_default_float_satang
        from core.station s
        join core.branch b on b.id = s.branch_id
       where s.archived_at is null
         and s.kind in ('till', 'kiosk')
         and coalesce(s.payment_routing ->> 'cash', '') <> 'none'
         and not exists (select 1 from pos.cash_session c where c.station_id = s.id and c.status = 'open')
         and exists (select 1 from core.account a where a.operator_id = s.operator_id and a.status = 'active')
      returning id, operator_id, branch_id, station_id, business_date, opened_by_account_id, opening_float_satang
    )
    insert into pos.cash_movement (id, operator_id, branch_id, session_id, station_id, kind, amount_satang, reason,
                                   actor_account_id, business_date, action_id)
    select gen_random_uuid(), o.operator_id, o.branch_id, o.id, o.station_id, 'float', o.opening_float_satang,
           'test fixture: drawer open for the day', o.opened_by_account_id, o.business_date, 'cash:open:' || o.id
      from opened o`);
}
