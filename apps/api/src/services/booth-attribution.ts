import { sql } from 'drizzle-orm';

/**
 * Who a booth spin is attributed to (SCRUM-694) — read in ONE place.
 *
 * Nobody signs in at the booth any more. The voucher's Staff row is today's
 * roster from Console → Booths → Today's staff, merged into one label
 * ("Tom and Jerry"), and the box sends that label with the spin as
 * `staffLabel` on the `booth.spin_recorded` fact. Nobody rostered sends null,
 * and the slip prints "unattributed". `booth.spin.staff_account_id` stays
 * null for every spin from such a box; a box older than SCRUM-694 with a
 * session still open may still name the signed-in account, and that is
 * still an attribution.
 *
 * **No column holds the label** (no migration this round). It is read from:
 *
 *  1. the spin's own ledger event — `edge.sync_event`, joined on
 *     `booth.spin.source_event_id` — whose payload is kept intact, as the box
 *     sent it, for 365 days (`SYNC_EVENT_RETENTION_DAYS`); and
 *  2. once that row has been swept, the `spin.record` audit row the handler
 *     writes in the same transaction, whose `after.staffLabel` is a copy.
 *     Audit rows are never swept, and they are read only when the ledger row
 *     has gone.
 *
 * Every reader that asks "was this spin attributed?" uses `SPIN_UNATTRIBUTED`
 * and nothing else. A reader that went back to `staff_account_id is null` —
 * or to `promo.voucher.issued_by_account_id is null` — would count every spin
 * of a SCRUM-694 box as unattributed.
 *
 * The fragments are written for a `booth.spin` aliased `s`; `SPIN_LABEL_JOINS`
 * adds the aliases `spin_ev` and `spin_au`, which nothing else in the ledger,
 * ops or analytics queries uses. When grouping by the label, group by the
 * expression itself or select from a subquery that names it.
 */

/** The longest label read back; the box sends the names the slip printed. */
export const SPIN_STAFF_LABEL_MAX = 500;

/** The two lookups the label is read through. Goes after `booth.spin s`. */
export const SPIN_LABEL_JOINS = sql`
  left join edge.sync_event spin_ev on spin_ev.event_id = s.source_event_id
  left join lateral (
    select a.after ->> 'staffLabel' as label
      from core.audit_log a
     where spin_ev.event_id is null
       and a.entity_type = 'spin'
       and a.entity_id = s.id::text
       and a.action = 'spin.record'
     order by a.created_at
     limit 1
  ) spin_au on true`;

/** The Staff-row text the slip printed: trimmed, cut to 500, and "" as null. */
export const SPIN_STAFF_LABEL = sql`nullif(btrim(left(coalesce(spin_ev.payload ->> 'staffLabel', spin_au.label), ${sql.raw(
  String(SPIN_STAFF_LABEL_MAX),
)})), '')`;

/** No account (an older box's sign-in) and no label (nobody on today's roster). */
export const SPIN_UNATTRIBUTED = sql`(s.staff_account_id is null and ${SPIN_STAFF_LABEL} is null)`;

/**
 * The same rule as `SPIN_STAFF_LABEL`, applied to a value in hand — the spin
 * fact's payload, which is where the push raises `booth.unattributed` from.
 */
export function normaliseStaffLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const label = raw.slice(0, SPIN_STAFF_LABEL_MAX).trim();
  return label === '' ? null : label;
}
