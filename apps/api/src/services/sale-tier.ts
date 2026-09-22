import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { saleTierClaim, tier } from '@oto/db';
import { newId } from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import { isEvidenceExpired } from './members';
import type { Exec, Tx } from './tx';

/**
 * SCRUM-307 / SCRUM-311 — the tier claim: how a walk-in whose document
 * reception has just checked gets priced at the rate that document supports,
 * WITHOUT the tier coming from the request body.
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
 * WHERE THE CLAIM IS STORED. `pos.sale_tier_claim`, its own table since
 * SCRUM-311. It began in `core.audit_log` because the schema package belonged
 * to another ticket in flight, and the two things that cost are what this
 * ticket is: a claim can now be SPENT, and the sale it priced names it
 * (`pos.sale.tier_claim_id`). The audit row is still written beside the claim,
 * in the same transaction — the log is the trail, the table is the record.
 *
 * THE TWO THINGS THAT END A CLAIM, and a claim ends one way or the other:
 *
 *   SPENT   `commitSale` stamps `spent_by_sale_id` on it with a conditional
 *           update in the transaction that writes the sale, so one document
 *           check prices one sale and a second cart naming it is refused
 *           (`TIER_CLAIM_SPENT`). Two carts racing for one claim cannot both
 *           win it: the second update matches no row.
 *   OLD     the window below. Nothing is deleted when either happens — the row
 *           stays as the record of what was checked and, once spent, of which
 *           sale it paid for.
 */

/** `core.audit_log.entity_type` for the row written beside a claim. */
export const TIER_CLAIM_ENTITY = 'sale_tier_claim';
const CLAIM_CREATE_ACTION = 'sale_tier_claim.create';

/**
 * HOW LONG A CLAIM CAN PRICE A CART.
 *
 * It covers one visitor at the counter: check the document, build the cart,
 * take the money. Thirty minutes is long enough for a party order rung up line
 * by line and short enough that a claim left behind by a visitor who walked
 * away cannot price the next person's cart later in the shift. It is the
 * second of the two bounds — being spent is the first.
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
  /** When this claim stops pricing anything, if nothing spends it first. */
  expiresAt: string;
  /** The sale that spent it, once one has. */
  spentBySaleId: string | null;
}

/** What the audit row's `after` holds. Nothing here identifies the document. */
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

/** The answer when a claim prices the cart. */
export interface ClaimedTier {
  code: string;
  source: 'claim';
  /** The claim that priced this cart, stamped onto the sale when it commits. */
  claimId: string;
}

/**
 * Why a claim the cart NAMED priced nothing, when the till should be told.
 *
 * Only one case produces it, and only because the till cannot work it out for
 * itself: the claim exists, belongs to this session, is inside its window —
 * and has already paid for a sale. Everything else a claim can fail on
 * (another session's, another branch's, expired, withdrawn tier) is answered
 * with silence and the default tier, which is what a caller holding an action
 * id that is not theirs should see.
 */
export interface TierClaimRefusal {
  code: 'TIER_CLAIM_SPENT';
  message: string;
  details: { claimId: string; saleId: string };
}

/** What the resolver answers: a tier, or nothing and possibly a reason. */
export interface TierClaimResolution {
  claim: ClaimedTier | null;
  refusal: TierClaimRefusal | null;
}

/** The date a `YYYY-MM-DD` document expiry means, or null if it is not one. */
function parseExpiry(value: string): Date | null {
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** A claim row as the rest of this file reads it. */
function viewOf(row: typeof saleTierClaim.$inferSelect): TierClaimView {
  return {
    id: row.id,
    actionId: row.actionId,
    branchId: row.branchId,
    toTier: row.toTier,
    evidenceType: row.evidenceType,
    evidenceExpiresAt: row.evidenceExpiresAt,
    verifiedByAccountId: row.accountId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: new Date(row.createdAt.getTime() + TIER_CLAIM_WINDOW_MS).toISOString(),
    spentBySaleId: row.spentBySaleId,
  };
}

/**
 * Record that staff checked a document, so a cart can be priced at the tier it
 * supports before the visitor has a member record.
 *
 * Runs inside the route's transaction: the claim row and the audit row commit
 * together, so there is no window in which one exists without the other.
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

  /**
   * The same tap arriving twice is the same claim. A DIFFERENT claim under the
   * same action id is not a retry — it is two decisions wearing one id — and
   * is refused rather than silently answered with the first one.
   *
   * Looked up on the table's own key, `(operator_id, action_id)`, and NOT
   * through the resolver's predicate: an action id that another account used,
   * or one whose claim has aged out of the window, still occupies that key, so
   * a lookup narrower than the constraint would decide to insert a row the
   * database is about to refuse.
   */
  const existing = await claimByAction(tx, actor.operatorId, input.actionId);
  if (existing) return sameTapOrRefuse(existing, actor, input);

  const id = newId();
  const expiresAt = new Date(now.getTime() + TIER_CLAIM_WINDOW_MS);
  const [written] = await tx
    .insert(saleTierClaim)
    .values({
      id,
      operatorId: actor.operatorId,
      branchId: actor.branchId,
      accountId: actor.accountId,
      actionId: input.actionId,
      toTier: input.toTier,
      evidenceType: input.evidenceType,
      evidenceExpiresAt: input.evidenceExpiresAt,
      createdAt: now,
    })
    // Two requests for one tap, arriving together: the loser of the unique
    // index has nothing to add, and the claim it wanted is the one the winner
    // wrote. Read back below rather than refused.
    .onConflictDoNothing()
    .returning();
  if (!written) {
    const raced = await claimByAction(tx, actor.operatorId, input.actionId);
    if (!raced) {
      throw errors.conflict(
        'TIER_CLAIM_UNAVAILABLE',
        'That document check could not be recorded — try it again',
      );
    }
    return sameTapOrRefuse(raced, actor, input);
  }

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

  return viewOf(written);
}

/**
 * The claim already on this action id, when it is the SAME tap — otherwise a
 * refusal.
 *
 * Same tap means every part of it: the same verifier, the same branch and the
 * same decision. A retry through a dropped connection matches all of them and
 * is answered with the claim that exists; anything else is two document checks
 * wearing one id, and answering that with the first one would price a cart
 * from a check nobody made.
 */
function sameTapOrRefuse(
  existing: TierClaimView,
  actor: TierClaimActor,
  input: TierClaimInput,
): TierClaimView {
  if (
    existing.verifiedByAccountId !== actor.accountId ||
    existing.branchId !== actor.branchId ||
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

/** One operator's claim for one action id, whoever made it and however old. */
async function claimByAction(
  db: Exec,
  operatorId: string,
  actionId: string,
): Promise<TierClaimView | null> {
  const [row] = await db
    .select()
    .from(saleTierClaim)
    .where(
      and(eq(saleTierClaim.operatorId, operatorId), eq(saleTierClaim.actionId, actionId)),
    )
    .limit(1);
  return row ? viewOf(row) : null;
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
    .from(saleTierClaim)
    .where(
      and(
        eq(saleTierClaim.actionId, actionId),
        eq(saleTierClaim.accountId, actor.accountId),
        eq(saleTierClaim.branchId, branchId),
        // The tenant, named rather than inferred from the account: every
        // predicate this platform lost a row through was one somebody was sure
        // the others already implied (SCRUM-280, SCRUM-289).
        eq(saleTierClaim.operatorId, actor.operatorId),
        gte(saleTierClaim.createdAt, cutoff),
      ),
    )
    .orderBy(desc(saleTierClaim.createdAt))
    .limit(1);
  return row ? viewOf(row) : null;
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
 * NOTHING HERE THROWS. A spent claim comes back as a `refusal` beside the
 * empty answer, and what happens to it is the caller's decision: the quote
 * prices the cart at the default tier and shows the reason, the commit turns
 * it into a 409. That split is deliberate — pricing a cart is not the act that
 * needs refusing, taking money for it is.
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
): Promise<TierClaimResolution> {
  const nothing: TierClaimResolution = { claim: null, refusal: null };
  if (cart.memberId || !cart.tierClaimActionId) return nothing;

  const claim = await findClaim(db, actor, branchId, cart.tierClaimActionId, now);
  if (!claim) return nothing;
  /**
   * ONE DOCUMENT CHECK, ONE SALE. A claim that has already priced a sale
   * prices nothing else: without this, the passport checked for the family at
   * 14:30 would still be sitting in the window at 14:50 and the till — which
   * keeps the action id of the last check it made — could ring the next
   * visitor up at the expat rate on a document that was never theirs.
   *
   * Told apart from every other failure above, because this one is the
   * session's own claim and staff can do something about it.
   */
  if (claim.spentBySaleId) {
    return {
      claim: null,
      refusal: {
        code: 'TIER_CLAIM_SPENT',
        message:
          'That document check has already been used on a sale — check the document again to ' +
          'price this one',
        details: { claimId: claim.id, saleId: claim.spentBySaleId },
      },
    };
  }
  // A document that expired between the check and the sale stops pricing it.
  // The claim is still a true record of what was checked; it has just run out
  // of what it was evidence of.
  if (isEvidenceExpired(parseExpiry(claim.evidenceExpiresAt))) return nothing;
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
  if (!tierRow) return nothing;

  return { claim: { code: claim.toTier, source: 'claim', claimId: claim.id }, refusal: null };
}

/**
 * Spend the claim on the sale it priced — the write that makes it single-use.
 *
 * CONDITIONAL, AND THAT IS THE WHOLE MECHANISM: `where spent_by_sale_id is
 * null` means the second of two carts racing for one claim updates no row and
 * is refused, inside its own transaction, before its sale can commit. Checking
 * first and writing after would leave exactly the gap the park would find on a
 * Saturday — two sales at the expat rate off one passport.
 *
 * Called from `commitSale` with the transaction that is writing the sale, so a
 * sale that fails afterwards takes the spend back with it.
 */
export async function spendTierClaim(
  tx: Tx,
  claimId: string,
  saleId: string,
  now: Date,
): Promise<void> {
  const spent = await tx
    .update(saleTierClaim)
    .set({ spentBySaleId: saleId, spentAt: now })
    .where(and(eq(saleTierClaim.id, claimId), isNull(saleTierClaim.spentBySaleId)))
    .returning({ id: saleTierClaim.id });
  if (spent.length === 0) {
    throw errors.conflict(
      'TIER_CLAIM_SPENT',
      'That document check has already been used on a sale — check the document again to ' +
        'price this one',
      { claimId },
    );
  }
}
