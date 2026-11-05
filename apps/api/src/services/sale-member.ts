import { and, eq, isNull } from 'drizzle-orm';
import { member, sale } from '@oto/db';
import { errors } from '../lib/errors';
import { audit } from './audit';
import type { ActorContext } from './sale';
import type { Tx } from './tx';

/**
 * SCRUM-779 — A MEMBER WHO ARRIVES AFTER THE SALE WAS RUNG UP.
 *
 * The ordinary walk-in order at the counter: reception checks a document and
 * prices the order at the Thai or expat rate (a claim, `sale_tier_claim`), the
 * payment screen opens and rings the sale up as a walk-in priced by that claim,
 * and the family's details — typed on the customer display — become a member
 * a moment later, with the verification saved against them (SCRUM-227). The
 * till then had a cart that named a member the sale did not, so the Confirm
 * press rang up a SECOND sale under the member and left the first one unpaid.
 *
 * This is the other half: the open sale TAKES the member. Nothing else about
 * it moves — its lines, its money, the tier it was priced at and the claim
 * that priced it stay exactly as they were rung up, so the figure the family
 * was asked for is the figure they pay, and the ledger still says which
 * document check bought the rate.
 *
 * WHAT IS REFUSED, each with its reason: a sale that is not on the platform (a
 * box-lane sale the link has not carried up yet), one already closed, voided or
 * refunded, one that already belongs to a different member, and a member who
 * is not this operator's or has been archived. The same member again is
 * answered as a replay and writes nothing.
 */

export interface SaleMemberAnswer {
  replay: boolean;
  saleId: string;
  memberId: string;
  status: string;
  customerTier: string;
  tierClaimId: string | null;
}

export async function attachSaleMember(
  tx: Tx,
  actor: ActorContext,
  saleId: string,
  input: { memberId: string },
  now: Date = new Date(),
): Promise<SaleMemberAnswer> {
  const [row] = await tx.select().from(sale).where(eq(sale.id, saleId)).for('update').limit(1);
  if (!row || row.operatorId !== actor.operatorId) {
    throw errors.notFound(
      'This sale is not on the platform yet — a sale rung up on the counter box while the connection was down keeps its walk-in details.',
    );
  }
  // The sale names the branch; the URL does not — checked on the row, as the void and the hold do.
  await actor.assertBranchAllowed?.(row.branchId);

  const answer = (replay: boolean): SaleMemberAnswer => ({
    replay,
    saleId,
    memberId: input.memberId,
    status: row.status,
    customerTier: row.customerTier,
    tierClaimId: row.tierClaimId ?? null,
  });
  if (row.memberId === input.memberId) return answer(true);
  if (row.memberId) {
    throw errors.conflict('SALE_MEMBER_SET', 'This sale already belongs to another member.', {
      memberId: row.memberId,
    });
  }
  if (row.status === 'voided') {
    throw errors.conflict('SALE_VOIDED', 'This sale was voided — there is nothing to add the member to.');
  }
  if (row.status === 'finalised' || row.status === 'refunded') {
    throw errors.conflict('SALE_FINALISED', 'This sale is already closed — its customer can no longer change.');
  }

  const [found] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.id, input.memberId), eq(member.operatorId, actor.operatorId), isNull(member.archivedAt)))
    .limit(1);
  if (!found) throw errors.notFound('Member not found');

  await tx.update(sale).set({ memberId: input.memberId, updatedAt: now }).where(eq(sale.id, saleId));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: row.branchId,
    action: 'sale.member_attach',
    entityType: 'sale',
    entityId: saleId,
    requestId: actor.requestId ?? null,
    before: { memberId: null },
    // What did NOT move is recorded beside what did: the price stays the one rung up.
    after: {
      memberId: input.memberId,
      status: row.status,
      customerTier: row.customerTier,
      tierClaimId: row.tierClaimId ?? null,
      grossSatang: row.grossSatang,
    },
  });
  return answer(false);
}
