/**
 * SCRUM-804 — THE DEPOSIT TENDER a party's settlement sale records, laid for
 * every operator by `platformSync` and by the demo seed.
 *
 * A party's deposit was paid before the party, in the OTO App. When the till
 * settles the party as one sale (`services/party-settlement.ts` in the api),
 * the deposit is recorded on that sale as a payment so the receipt reads the
 * balance, under this tender: "Deposit (paid in advance)", kind `other`.
 *
 * Switched off (`enabled: false`): only the settlement writes it, so it is
 * never on a till's method grid for an ordinary sale. Insert-if-absent, by its
 * code, counting archived rows too: a park that archived or renamed it has
 * said what it wants, and a sync never undoes it. Laid only for an operator
 * that already has a tender list, so the three defaults (`syncDefaultTenders`,
 * which leaves alone any operator with a row) are never kept from a new park.
 */
import { and, eq, exists, notExists, sql } from 'drizzle-orm';
import { PARTY_DEPOSIT_TENDER, newId } from '@oto/shared';
import type { Db } from '../index';
import * as s from '../schema/index';

/** The sort position it takes: after any list a park is likely to have. */
const DEPOSIT_SORT_ORDER = 90;

/** @returns how many operators were given the tender. */
export async function syncPartyDepositTender(db: Db): Promise<number> {
  const parks = await db
    .select({ id: s.operator.id })
    .from(s.operator)
    .where(
      and(
        exists(
          db
            .select({ one: sql<number>`1` })
            .from(s.paymentMethod)
            .where(eq(s.paymentMethod.operatorId, s.operator.id)),
        ),
        notExists(
          db
            .select({ one: sql<number>`1` })
            .from(s.paymentMethod)
            .where(
              and(
                eq(s.paymentMethod.operatorId, s.operator.id),
                eq(s.paymentMethod.code, PARTY_DEPOSIT_TENDER.code),
              ),
            ),
        ),
      ),
    );
  let laid = 0;
  for (const park of parks) {
    const inserted = await db
      .insert(s.paymentMethod)
      .values({
        id: newId(),
        operatorId: park.id,
        code: PARTY_DEPOSIT_TENDER.code,
        label: PARTY_DEPOSIT_TENDER.label,
        kind: PARTY_DEPOSIT_TENDER.kind,
        enabled: false,
        sortOrder: DEPOSIT_SORT_ORDER,
      })
      .onConflictDoNothing()
      .returning({ id: s.paymentMethod.id });
    laid += inserted.length;
  }
  return laid;
}
