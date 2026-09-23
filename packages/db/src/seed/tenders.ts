/**
 * THE TENDERS A PARK TAKES MONEY IN — as reference data (SCRUM-206, S2-10a).
 *
 * The three rows are here, once, and both writers below read them: the demo
 * seed, which upserts them for its own tenant, and `platformSync`, which
 * converges them for any park that has none.
 *
 * WHY THE SYNC HAS A HALF OF THIS AT ALL. The till's method grid used to be
 * three built-in buttons; since Slice E it is hydrated from
 * `GET /payment-methods`, so the grid is exactly what `pos.payment_method`
 * says and an empty table is a till with no way to take money. Until this
 * file, the only writer was the full demo seed — and a staging deploy runs
 * migrations plus `platform:sync`, not the seed. On 2026-09-23 that left the
 * table empty behind a sale of ฿1,040 that could not be tendered until the
 * three were typed back in through the back office. Anything a screen cannot
 * work without is converged by the sync; it is not left to a fixture file.
 *
 * THE RULE, AND WHAT IT DELIBERATELY WILL NOT DO. A park with ZERO rows —
 * live or archived — gets the three defaults. A park with ANY row is not
 * touched at all: no label pushed back, no missing default added, nothing
 * re-enabled. A park that renamed Cash, unticked PromptPay or archived a
 * tender has said what its list is, and a sync that argued with it would put
 * a button back on a till nobody asked for. That is the same shape as the
 * system-role convergence beside it — the platform owns the starting point,
 * the park owns what it did next.
 *
 * `code` is the token the money row carries (`pos.payment_attempt.method_code`)
 * and `kind` is what the platform does about it (`pos.payment_attempt.method`):
 * the prototype's rule, ported — behaviour keys off the kind and never off the
 * token (`lib/payments.ts:41,56,65`). All three kinds here are ledger-backed,
 * which is what `services/payment-methods.ts` requires of a tender anyone can
 * create.
 */
import { eq, isNull, notExists, sql } from 'drizzle-orm';
import { newId } from '@oto/shared';
import type { Db } from '../index';
import * as s from '../schema/index';

/**
 * The park's three tenders, in the order the till shows them — the prototype's
 * `seedPaymentMethods` (`catalogStore.ts:786-790`), which is also the order the
 * park has taken money in since before this platform existed.
 *
 * Their position in this array IS their `sort_order`, so reordering the array
 * reorders the method grid on a park that has not set its own order.
 */
export const DEFAULT_TENDERS = [
  { code: 'cash', label: 'Cash', kind: 'cash' },
  { code: 'card', label: 'Card', kind: 'card' },
  { code: 'promptpay', label: 'PromptPay', kind: 'qr' },
] as const;

/** The rows `DEFAULT_TENDERS` becomes for one operator, in list order. */
const defaultRows = (operatorId: string) =>
  DEFAULT_TENDERS.map((tender, sortOrder) => ({
    id: newId(),
    operatorId,
    ...tender,
    enabled: true,
    sortOrder,
  }));

/**
 * The demo tenant's copy: upserted, because the seed treats its catalogue as
 * reference data a corrected label should reach.
 *
 * `enabled` is NOT pushed back — a park that unticked PromptPay on the
 * Payments panel meant it. Only the demo seed calls this; the deploy-time
 * convergence is `syncDefaultTenders`, which leaves an existing list alone
 * entirely.
 */
export async function upsertDefaultTenders(db: Db, operatorId: string): Promise<void> {
  for (const row of defaultRows(operatorId)) {
    await db
      .insert(s.paymentMethod)
      .values(row)
      .onConflictDoUpdate({
        // The unique index is partial (`archived_at is null`), so the
        // predicate has to be named for Postgres to infer it.
        target: [s.paymentMethod.operatorId, s.paymentMethod.code],
        targetWhere: isNull(s.paymentMethod.archivedAt),
        set: { label: row.label, kind: row.kind, sortOrder: row.sortOrder },
      });
  }
}

/**
 * Give every park that has no tender list at all the three defaults.
 *
 * `notExists` counts archived rows too: a park that archived its way down to
 * nothing has still made a decision, and three buttons reappearing at the next
 * deploy would undo it. There is no conflict clause on the insert for the same
 * reason the guard is enough — a park reached here has no row to conflict with,
 * so a unique violation would be a genuine surprise and should fail the deploy
 * loudly rather than be swallowed.
 *
 * Archived operators are included: converging one costs three rows, and the
 * alternative is a park that trades again one day and finds a till that cannot
 * take money.
 *
 * @returns the ids of the operators that were given a list.
 */
export async function syncDefaultTenders(db: Db): Promise<string[]> {
  const parks = await db
    .select({ id: s.operator.id })
    .from(s.operator)
    .where(
      notExists(
        db
          .select({ one: sql<number>`1` })
          .from(s.paymentMethod)
          .where(eq(s.paymentMethod.operatorId, s.operator.id)),
      ),
    );

  for (const park of parks) {
    await db.insert(s.paymentMethod).values(defaultRows(park.id));
  }
  return parks.map((park) => park.id);
}
