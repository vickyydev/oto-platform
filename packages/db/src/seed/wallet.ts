/**
 * S2-14a — every branch's wallet policy (plan docs/progress/plans/wallet/
 * PLAN.md §2.1, OD-W1 = OD-14).
 *
 * Migration 0045 gave every branch that existed when it ran the seeded policy;
 * a database built from empty runs the migrations BEFORE the seed creates its
 * branches, so the seed gives each branch the same row, from the same named
 * constant (`DEFAULT_WALLET_POLICY` in `@oto/shared`): same-day expiry, the
 * ฿300 offline cap, and unused prepaid food refunded — the rule the branch's
 * drop-off pricing already carries, mirrored so the two agree on day one.
 *
 * Keyed per branch (`ON CONFLICT DO NOTHING`), so it is safe to re-run and a
 * policy a manager has changed is never pushed back.
 */
import { DEFAULT_WALLET_POLICY, newId } from '@oto/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../index';
import * as s from '../schema/index';

export async function seedWalletPolicies(db: Db): Promise<void> {
  const branches = await db
    .select({ id: s.branch.id, operatorId: s.branch.operatorId, prepaid: s.dropOffPricing.prepaidFoodUnused })
    .from(s.branch)
    .leftJoin(s.dropOffPricing, eq(s.dropOffPricing.branchId, s.branch.id));
  for (const br of branches) {
    await db
      .insert(s.walletPolicy)
      .values({
        id: newId(),
        operatorId: br.operatorId,
        branchId: br.id,
        expiry: DEFAULT_WALLET_POLICY.expiry,
        expiryDays: DEFAULT_WALLET_POLICY.expiryDays,
        offlineCapSatang: DEFAULT_WALLET_POLICY.offlineCapSatang,
        prepaidUnused: br.prepaid ?? DEFAULT_WALLET_POLICY.prepaidUnused,
      })
      .onConflictDoNothing({ target: s.walletPolicy.branchId });
  }
}
