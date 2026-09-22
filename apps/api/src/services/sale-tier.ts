import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { auditLog, tier } from '@oto/db';
import { newId } from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import { isEvidenceExpired } from './members';
import type { Exec, Tx } from './tx';

/**
 * SCRUM-307 — the tier claim: how a walk-in whose document reception has just
 * checked gets priced at the rate that document supports, WITHOUT the tier
 * coming from the request body.
 *
 * WHAT WAS BROKEN. `sale.ts` resolves the tier from the MEMBER and prices a
 * cart with no member at the operator's default. That is right for the case it
 * was written for and wrong for the commonest discounted sale at the counter:
 * staff check a passport or a residence certificate BEFORE the visitor has
 * given a phone number and a name, so at quote time there is no member to read
 * a tier from. The platform priced tourist, the till priced expat, and the
 * commit refused the difference as `SALE_LINE_PRICE_MISMATCH` — no Expat or
 * Thai sale could complete at all.
 *
 * WHAT IS NOT THE FIX: believing `cart.tier`. The tier picks the price and is
 * the one field a visitor would most like to choose, so a body-supplied tier
 * is a price list anybody can pick from (`sale.ts`, rule 2). It stays ignored.
 *
 * WHAT THIS IS. Reception's document check becomes a record on this side of
 * the wire before it can price anything:
 *
 *   1. The till posts `/sales/tier-claims` with the action id of the tap that
 *      confirmed the document, the tier it supports, the document type and its
 *      expiry. The route is guarded on `pos:member:update` — the same
 *      permission that records a verification against a member — and the
 *      VERIFIER, the BRANCH and the OPERATOR are stamped from the session.
 *      Nothing about who checked it comes from the caller.
 *   2. The cart names that ACTION ID. It never names a tier. The lookup below
 *      matches on the action id AND the account that made the claim AND the
 *      branch the cart is for, so a claim belonging to another session, made
 *      under another action, or made at another branch resolves to nothing and
 *      the cart is priced at the default tier.
 *   3. A member named on the cart still wins. A verified tier on a member
 *      record is the stronger fact — a document somebody checked and filed —
 *      and the claim only exists because there is no such record yet.
 *
 * WHERE THE CLAIM IS STORED, and why it is not its own table. `core.audit_log`
 * holds it: `packages/db` belongs to another ticket in flight, and a claim is
 * in any case an append-only fact of the shape the audit log already
 * records — who checked what, at which branch, at what time, under which
 * action id (an indexed column). `sale_tier_claim` rows are therefore read
 * back here as well as written.
 *
 * TWO THINGS THIS DOES NOT DO, so that no comment above is read as more than
 * it says. A claim is NOT single-use: nothing marks it spent when a sale
 * prices from it, because recording which sale spent which claim needs a
 * `tier_claim_id` column on `pos.sale` that this ticket could not add. The
 * window below is the whole of the bound. And the sale row records the tier it
 * was priced at (`customer_tier`) but not the claim id, for the same reason —
 * the two are tied together only through the audit trail today.
 */

/** `core.audit_log.entity_type` for a claim row. */
export const TIER_CLAIM_ENTITY = 'sale_tier_claim';
const CLAIM_CREATE_ACTION = 'sale_tier_claim.create';

/**
 * HOW LONG A CLAIM CAN PRICE A CART.
 *
 * It covers one visitor at the counter: check the document, build the cart,
 * take the money. Thirty minutes is long enough for a party order rung up line
 * by line and short enough that a claim left behind by a visitor who walked
 * away cannot price the next person's cart later in the shift. Since nothing
 * marks a claim spent (see above), this is the only thing that ends it.
 */
export const TIER_CLAIM_WINDOW_MS = 30 * 60 * 1000;

export interface TierClaimActor {
  accountId: string;
  operatorId: string;
  /** The branch the claim belongs to — the session's, resolved by the route. */
  branchId: string;
  requestId?: string;
}

export interface TierClaimInput {
  /**
   * `x-oto-action-id` of the tap that confirmed the document. It is the key
   * the cart names, so one tap produces one claim however many times the
   * request is retried.
   */
  actionId: string;
  toTier: string;
  /** `Passport`, `Residence certificate`, `School card` — a kind, never a number. */
  evidenceType: string;
  /** The document's expiry, `YYYY-MM-DD`. */
  evidenceExpiresAt: string;
}

/** A claim as the till and the tests read it back. */
export interface TierClaimView {
  id: string;
  actionId: string;
  branchId: string;
  toTier: string;
  evidenceType: string;
  evidenceExpiresAt: string;
  /** The account the session authenticated — never a name the caller sent. */
  verifiedByAccountId: string;
  createdAt: string;
  /** When this claim stops pricing anything. */
  expiresAt: string;
}

/** What a claim row's `after` holds. Nothing here identifies the document. */
interface ClaimPayload {
  toTier: string;
  evidenceType: string;
  evidenceExpiresAt: string;
  expiresAt: string;
}

/** The cart fields that decide WHO a cart is priced for. */
export interface TierBearingCart {
  memberId?: string | null;
  /**
   * The action id of the claim this cart is priced under, carried by the cart
   * body. A POINTER, not a price: what it names is a row written on this side
   * under a permission check, and a pointer to somebody else's claim resolves
   * to nothing.
   */
  tierClaimActionId?: string | null;
}

/** The answer when a claim prices the cart. `null` means: ask the member. */
export interface ClaimedTier {
  code: string;
  source: 'claim';
  /** The claim that priced this cart. */
  claimId: string;
}

/** The date a `YYYY-MM-DD` document expiry means, or null if it is not one. */
function parseExpiry(value: string): Date | null {
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Record that staff checked a document, so a cart can be priced at the tier it
 * supports before the visitor has a member record.
 *
 * Runs inside the route's transaction: the claim and the audit row ARE the same
 * row, so there is no window in which one exists without the other.
 */
export async function recordTierClaim(
  tx: Tx,
  actor: TierClaimActor,
  input: TierClaimInput,
  now: Date = new Date(),
): Promise<TierClaimView> {
  // Tiers are data. A claim to a tier this operator does not sell is refused
  // here rather than surfacing later as a package that "has no price".
  const [tierRow] = await tx
    .select()
    .from(tier)
    .where(
      and(
        eq(tier.operatorId, actor.operatorId),
        eq(tier.code, input.toTier),
        isNull(tier.archivedAt),
      ),
    )
    .limit(1);
  if (!tierRow) throw errors.badRequest(`Unknown tier "${input.toTier}"`);

  const evidenceExpiresAt = parseExpiry(input.evidenceExpiresAt);
  if (!evidenceExpiresAt) throw errors.badRequest('That document expiry is not a date');
  if (isEvidenceExpired(evidenceExpiresAt)) {
    throw errors.badRequest(
      'The document has already expired — it cannot price a discounted rate',
    );
  }

  // The same tap arriving twice is the same claim. A DIFFERENT claim under the
  // same action id is not a retry — it is two decisions wearing one id — and
  // is refused rather than silently answered with the first one.
  const existing = await findClaim(tx, actor, actor.branchId, input.actionId, now);
  if (existing) {
    if (
      existing.toTier !== input.toTier ||
      existing.evidenceType !== input.evidenceType ||
      existing.evidenceExpiresAt !== input.evidenceExpiresAt
    ) {
      throw errors.conflict(
        'TIER_CLAIM_ACTION_REUSED',
        'This action already recorded a different document check',
        { claimId: existing.id, toTier: existing.toTier },
      );
    }
    return existing;
  }

  const id = newId();
  const expiresAt = new Date(now.getTime() + TIER_CLAIM_WINDOW_MS);
  const payload: ClaimPayload = {
    toTier: input.toTier,
    evidenceType: input.evidenceType,
    evidenceExpiresAt: input.evidenceExpiresAt,
    expiresAt: expiresAt.toISOString(),
  };
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: CLAIM_CREATE_ACTION,
    entityType: TIER_CLAIM_ENTITY,
    entityId: id,
    after: payload,
    actionId: input.actionId,
    requestId: actor.requestId ?? null,
  });

  return {
    id,
    actionId: input.actionId,
    branchId: actor.branchId,
    toTier: input.toTier,
    evidenceType: input.evidenceType,
    evidenceExpiresAt: input.evidenceExpiresAt,
    verifiedByAccountId: actor.accountId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * The live claim for one action, made by this account at this branch.
 *
 * Every part of that sentence is a predicate: the action id alone would let a
 * till price from a claim another session made, and the branch alone would let
 * a claim follow an account to a till it has no business pricing for. A row
 * outside the window is not returned at all, so an expired claim cannot be
 * told apart here from one that never existed — which is what a caller holding
 * somebody else's action id should see.
 */
async function findClaim(
  db: Exec,
  actor: { accountId: string; operatorId: string },
  branchId: string,
  actionId: string,
  now: Date,
): Promise<TierClaimView | null> {
  const cutoff = new Date(now.getTime() - TIER_CLAIM_WINDOW_MS);
  const [row] = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, TIER_CLAIM_ENTITY),
        eq(auditLog.action, CLAIM_CREATE_ACTION),
        eq(auditLog.actionId, actionId),
        eq(auditLog.actorAccountId, actor.accountId),
        eq(auditLog.branchId, branchId),
        // The tenant, named rather than inferred from the account: every
        // predicate this platform lost a row through was one somebody was sure
        // the others already implied (SCRUM-280, SCRUM-289).
        eq(auditLog.operatorId, actor.operatorId),
        gte(auditLog.createdAt, cutoff),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (!row) return null;

  const payload = row.after as ClaimPayload | null;
  if (!payload?.toTier) return null;
  return {
    id: row.entityId,
    actionId,
    branchId,
    toTier: payload.toTier,
    evidenceType: payload.evidenceType,
    evidenceExpiresAt: payload.evidenceExpiresAt,
    verifiedByAccountId: actor.accountId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: payload.expiresAt,
  };
}

/**
 * THE CLAIM THAT PRICES THIS CART, or `null` when none does — in which case
 * the tier comes from the member, or from the operator's default, exactly as
 * it did before this ticket (`resolveTier` in `sale.ts`).
 *
 * Called at the one point where both the quote and the commit resolve a tier,
 * so the two cannot answer differently: a quote and a commit disagreeing about
 * who the visitor was IS the defect this closes.
 *
 * A MEMBER ON THE CART ENDS IT HERE. Not because a claim would be wrong, but
 * because a member's tier is the stronger record — the verification behind it
 * was filed against a person — and a claim exists only for the moments before
 * there is such a person. It is also how the till behaves: verifying a tier
 * for somebody it has already identified writes a real verification against
 * that member (`POST /members/:id/tier-verification`) and never comes here.
 */
export async function resolveTierClaim(
  db: Exec,
  actor: { accountId: string; operatorId: string },
  branchId: string,
  cart: TierBearingCart,
  now: Date = new Date(),
): Promise<ClaimedTier | null> {
  if (cart.memberId || !cart.tierClaimActionId) return null;

  const claim = await findClaim(db, actor, branchId, cart.tierClaimActionId, now);
  if (!claim) return null;
  // A document that expired between the check and the sale stops pricing it.
  // The claim is still a true record of what was checked; it has just run out
  // of what it was evidence of.
  if (isEvidenceExpired(parseExpiry(claim.evidenceExpiresAt))) return null;
  // The claim named a tier this operator sold when it was made. If that tier
  // has since been withdrawn, pricing falls back rather than charging against
  // a rate that is no longer in the catalogue.
  const [tierRow] = await db
    .select({ code: tier.code })
    .from(tier)
    .where(
      and(
        eq(tier.operatorId, actor.operatorId),
        eq(tier.code, claim.toTier),
        isNull(tier.archivedAt),
      ),
    )
    .limit(1);
  if (!tierRow) return null;

  return { code: claim.toTier, source: 'claim', claimId: claim.id };
}
