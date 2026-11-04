import { and, count, desc, eq, gte, isNotNull, isNull, max, sql } from 'drizzle-orm';
import { account, employee, saleTierClaim, tier } from '@oto/db';
import { TIER_APPROVAL_EVIDENCE, newId, tierApprovalProblem } from '@oto/shared';
import { AppError, errors } from '../lib/errors';
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
 * is a price list anybody can pick from (`sale.ts`, rule 2). It can only move
 * a price down to the operator's default tier, which needs no proof.
 *
 * WHAT THIS IS. Reception's document check becomes a record on this side of
 * the wire before it can price anything:
 *
 *   1. The till posts `/sales/tier-claims` with the action id of the tap that
 *      confirmed the document, the tier it supports, the document type and its
 *      expiry when it carries one. The route is guarded on `pos:member:update` — the same
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
 *           win it: the second update matches no row. A void of that sale —
 *           which takes no money — gives the claim back
 *           (`restoreTierClaimOf`), so the corrected order is priced on it.
 *   OLD     the window below. Nothing is deleted when either happens — the row
 *           stays as the record of what was checked and, once spent, of which
 *           sale it paid for.
 */

/** `core.audit_log.entity_type` for the row written beside a claim. */
export const TIER_CLAIM_ENTITY = 'sale_tier_claim';
const CLAIM_CREATE_ACTION = 'sale_tier_claim.create';
const CLAIM_RESTORE_ACTION = 'sale_tier_claim.restore';
/** SCRUM-772 — the Thai rate approved by hand: its own action in the log. */
export const CLAIM_APPROVE_BY_HAND_ACTION = 'sale_tier_claim.approve_by_hand';

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
  /** `Passport`, `Driving licence`, `School card`, `Other` — a kind, never a number (older claims may say `Residence certificate`). */
  evidenceType: string;
  /**
   * The document's expiry, `YYYY-MM-DD`, when it carries one. Optional, as at
   * the design's verify step: a document with no expiry date never expires.
   */
  evidenceExpiresAt?: string | null;
  /**
   * What staff checked when the kind is Other ("Work permit"),
   * trimmed; the route has refused anything holding a document number
   * (SCRUM-697). Never written to the audit row.
   */
  note?: string | null;
}

/** SCRUM-772 — what a hand approval records beside the claim. */
export interface TierApprovalView {
  /** One of `TIER_APPROVAL_REASONS`. */
  reason: string;
  /** What staff typed when the reason is Other; null otherwise. */
  reasonText: string | null;
  /** The optional note; null when none was added. */
  note: string | null;
}

/** A claim as the till and the tests read it back. */
export interface TierClaimView {
  id: string;
  actionId: string;
  branchId: string;
  toTier: string;
  evidenceType: string;
  /** `YYYY-MM-DD`, or null when the document carries no expiry. */
  evidenceExpiresAt: string | null;
  /** What staff typed for an Other document (SCRUM-697); null otherwise. */
  note: string | null;
  /**
   * SCRUM-772 — the rate approved by hand rather than on a document, with the
   * reason staff chose; null for a document check. Who approved it is
   * `verifiedByAccountId`, when is `createdAt`.
   */
  approval: TierApprovalView | null;
  /** The account the session authenticated — never a name the caller sent. */
  verifiedByAccountId: string;
  createdAt: string;
  /** When this claim stops pricing anything, if nothing spends it first. */
  expiresAt: string;
  /** The sale that spent it, once one has. */
  spentBySaleId: string | null;
}

/**
 * What the audit row's `after` holds. Nothing here identifies the document,
 * and the free-text note is left out on purpose (SCRUM-697): the log keeps
 * the kind, the claim row keeps the description.
 */
interface ClaimPayload {
  toTier: string;
  evidenceType: string;
  evidenceExpiresAt: string | null;
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
    note: row.note,
    approval:
      row.approvalReason === null
        ? null
        : {
            reason: row.approvalReason,
            reasonText: row.approvalReasonText,
            note: row.approvalNote,
          },
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

  // No expiry date is a document that never expires; one that is given must
  // be a date that has not passed.
  const expiresOn = input.evidenceExpiresAt ?? null;
  if (expiresOn !== null) {
    const evidenceExpiresAt = parseExpiry(expiresOn);
    if (!evidenceExpiresAt) throw errors.badRequest('That document expiry is not a date');
    if (isEvidenceExpired(evidenceExpiresAt)) {
      throw errors.badRequest(
        'The document has already expired — it cannot price a discounted rate',
      );
    }
  }
  const note = input.note ?? null;
  const claimInput = { ...input, evidenceExpiresAt: expiresOn, note };

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
  if (existing) return sameTapOrRefuse(existing, actor, claimInput);

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
      evidenceExpiresAt: expiresOn,
      note,
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
    return sameTapOrRefuse(raced, actor, claimInput);
  }

  const payload: ClaimPayload = {
    toTier: input.toTier,
    evidenceType: input.evidenceType,
    evidenceExpiresAt: expiresOn,
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
  input: TierClaimInput & { evidenceExpiresAt: string | null; note: string | null },
  approval: TierApprovalView | null = null,
): TierClaimView {
  if (
    existing.verifiedByAccountId !== actor.accountId ||
    existing.branchId !== actor.branchId ||
    existing.toTier !== input.toTier ||
    existing.evidenceType !== input.evidenceType ||
    existing.evidenceExpiresAt !== input.evidenceExpiresAt ||
    existing.note !== input.note ||
    // A document check and a hand approval are two different acts, and two
    // hand approvals for different reasons are two decisions (SCRUM-772).
    existing.approval?.reason !== approval?.reason ||
    existing.approval?.reasonText !== approval?.reasonText ||
    existing.approval?.note !== approval?.note
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

/** SCRUM-772 — a hand approval, as the till sends it. */
export interface TierApprovalInput {
  /** `x-oto-action-id` of the press that approved it: the key the cart names. */
  actionId: string;
  toTier: string;
  /** One of `TIER_APPROVAL_REASONS`. */
  reason: string;
  /** What staff typed when the reason is Other. */
  reasonText?: string | null;
  /** An optional note. */
  note?: string | null;
}

/**
 * SCRUM-772 — THE THAI RATE APPROVED BY HAND, for the special cases a
 * document check does not fit: a Thai child with a foreign parent, a Thai ID
 * seen earlier and not to hand, or another reason staff type.
 *
 * It is a tier claim like a document check — the same table, the same window,
 * spent by one sale — with the reason in place of a document. Nobody else
 * confirms it: the staff member on the till approves alone, so the customer
 * does not wait, and the record is what makes it answerable. The approver is
 * the session's account, the branch is the session's, the time is the row's;
 * the claim names the sale once one spends it, and the audit row is its own
 * action (`sale_tier_claim.approve_by_hand`) carrying the reason and the
 * note, which the rule has already kept free of document numbers.
 *
 * IT NEVER TOUCHES THE MEMBER. No `member_tier_verification` is written, so
 * the member's profile is not marked as a verified tier and the next visit
 * asks again. It prices a member's cart through the claim instead
 * (`resolveTierClaim`).
 */
export async function recordTierApproval(
  tx: Tx,
  actor: TierClaimActor,
  input: TierApprovalInput,
  now: Date = new Date(),
): Promise<TierClaimView> {
  const problem = tierApprovalProblem(input);
  if (problem) throw new AppError(400, 'TIER_APPROVAL', problem);

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

  const approval: TierApprovalView = {
    reason: input.reason,
    reasonText: input.reason === 'other' ? input.reasonText?.trim() || null : null,
    note: input.note?.trim() || null,
  };
  const claimInput = {
    actionId: input.actionId,
    toTier: input.toTier,
    evidenceType: TIER_APPROVAL_EVIDENCE,
    evidenceExpiresAt: null,
    note: null,
  };

  const existing = await claimByAction(tx, actor.operatorId, input.actionId);
  if (existing) return sameTapOrRefuse(existing, actor, claimInput, approval);

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
      evidenceType: TIER_APPROVAL_EVIDENCE,
      evidenceExpiresAt: null,
      note: null,
      approvalReason: approval.reason,
      approvalReasonText: approval.reasonText,
      approvalNote: approval.note,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!written) {
    const raced = await claimByAction(tx, actor.operatorId, input.actionId);
    if (!raced) {
      throw errors.conflict(
        'TIER_CLAIM_UNAVAILABLE',
        'That approval could not be recorded — try it again',
      );
    }
    return sameTapOrRefuse(raced, actor, claimInput, approval);
  }

  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: CLAIM_APPROVE_BY_HAND_ACTION,
    entityType: TIER_CLAIM_ENTITY,
    entityId: id,
    after: {
      toTier: input.toTier,
      evidenceType: TIER_APPROVAL_EVIDENCE,
      approvalReason: approval.reason,
      approvalReasonText: approval.reasonText,
      approvalNote: approval.note,
      expiresAt: expiresAt.toISOString(),
    },
    actionId: input.actionId,
    requestId: actor.requestId ?? null,
  });

  return viewOf(written);
}

/** SCRUM-772 — one staff member's hand approvals, as the Console counts them. */
export interface TierApprovalCount {
  accountId: string;
  /** Nickname, then name, then the phone the account signs in by. */
  name: string | null;
  /** Approvals in the last `TIER_APPROVAL_COUNT_DAYS` days. */
  recent: number;
  /** Every approval this account has made. */
  total: number;
  lastApprovedAt: string;
}

/** The Console's recent window for hand approvals, in days. */
export const TIER_APPROVAL_COUNT_DAYS = 30;

/**
 * SCRUM-772 — how many times each staff member has approved the Thai rate by
 * hand, so the Console can show whether it is used more than the special
 * cases call for. Most recent use first; one operator's rows only.
 */
export async function tierApprovalCounts(
  db: Exec,
  operatorId: string,
  now: Date = new Date(),
): Promise<{ since: string; staff: TierApprovalCount[] }> {
  const since = new Date(now.getTime() - TIER_APPROVAL_COUNT_DAYS * 24 * 60 * 60 * 1000);
  const recent = sql<number>`count(*) filter (where ${saleTierClaim.createdAt} >= ${since})`.mapWith(
    Number,
  );
  const rows = await db
    .select({
      accountId: saleTierClaim.accountId,
      nickname: employee.nickname,
      name: employee.name,
      phone: account.phone,
      recent,
      total: count(),
      lastApprovedAt: max(saleTierClaim.createdAt),
    })
    .from(saleTierClaim)
    .leftJoin(account, eq(saleTierClaim.accountId, account.id))
    .leftJoin(employee, eq(account.employeeId, employee.id))
    .where(and(eq(saleTierClaim.operatorId, operatorId), isNotNull(saleTierClaim.approvalReason)))
    .groupBy(saleTierClaim.accountId, employee.nickname, employee.name, account.phone);
  const staff = rows
    .map((row) => ({
      accountId: row.accountId,
      name: row.nickname ?? row.name ?? row.phone ?? null,
      recent: row.recent,
      total: row.total,
      lastApprovedAt: (row.lastApprovedAt ?? now).toISOString(),
    }))
    .sort(
      (a, b) =>
        b.recent - a.recent || b.total - a.total || a.accountId.localeCompare(b.accountId),
    );
  return { since: since.toISOString(), staff };
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
 * Why a claim that has already priced a sale prices nothing else, in the
 * words of the kind of claim it was. A document check asks for the document
 * again; a rate approved by hand (SCRUM-772) was approved because the
 * document is not to hand, so it asks for a new approval or a document.
 */
function spentClaimMessage(approvedByHand: boolean): string {
  return approvedByHand
    ? 'That approval by hand has already been used on a sale — approve it again, or check a ' +
        'document, to price this one'
    : 'That document check has already been used on a sale — check the document again to ' +
        'price this one';
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
  if (!cart.tierClaimActionId) return nothing;

  const claim = await findClaim(db, actor, branchId, cart.tierClaimActionId, now);
  if (!claim) return nothing;
  /**
   * SCRUM-772 — EXCEPT A RATE APPROVED BY HAND. That approval is for THIS
   * SALE, and it deliberately writes nothing to the member: the profile holds
   * a verified tier only when a document was checked, so the next visit asks
   * again. A member on the cart therefore has no record of what staff just
   * decided, and the approval is what prices it. A document check keeps the
   * rule above: the member's own record wins.
   */
  if (cart.memberId && claim.approval === null) return nothing;
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
        message: spentClaimMessage(claim.approval !== null),
        details: { claimId: claim.id, saleId: claim.spentBySaleId },
      },
    };
  }
  // A document that expired between the check and the sale stops pricing it.
  // The claim is still a true record of what was checked; it has just run out
  // of what it was evidence of.
  if (claim.evidenceExpiresAt !== null && isEvidenceExpired(parseExpiry(claim.evidenceExpiresAt))) {
    return nothing;
  }
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
    // Only on the refusal: which kind of claim it was decides what staff are
    // told to do next.
    const [row] = await tx
      .select({ approvalReason: saleTierClaim.approvalReason })
      .from(saleTierClaim)
      .where(eq(saleTierClaim.id, claimId))
      .limit(1);
    throw errors.conflict(
      'TIER_CLAIM_SPENT',
      spentClaimMessage((row?.approvalReason ?? null) !== null),
      { claimId },
    );
  }
}

/**
 * Give a document check back when the sale it priced is voided (audit L6).
 *
 * A void is only allowed on a sale that took no money (`voidSale`), so the
 * claim it spent has paid for nothing — and the till's own flow voids and
 * re-rings a corrected order under the same check. Without this the corrected
 * sale was refused with TIER_CLAIM_SPENT over a passport nobody had stopped
 * looking at. The window is not extended: a claim given back is still the
 * claim made at 14:30, and it prices nothing after 15:00.
 *
 * Conditional on the claim being spent BY THIS SALE, so a void answered as a
 * replay (the sale was already void) or one arriving after the claim has
 * priced its corrected sale gives nothing back. The voided sale lets go of
 * its `tier_claim_id` in the statement that voids it (`voidSale`), because
 * `sale_tier_claim_unique` lets one sale name a claim and the corrected sale
 * is about to; the void's audit row and the one written here keep the link,
 * and the sale's `customer_tier` still says what it was rung up at.
 *
 * Returns the claim's id, or null when the sale had spent none.
 */
export async function restoreTierClaimOf(
  tx: Tx,
  // SCRUM-774: a null account is the platform itself (the midnight void of a held sale).
  actor: { accountId: string | null; operatorId: string; requestId?: string },
  saleId: string,
  branchId: string,
): Promise<string | null> {
  const [restored] = await tx
    .update(saleTierClaim)
    .set({ spentBySaleId: null, spentAt: null })
    .where(
      and(eq(saleTierClaim.spentBySaleId, saleId), eq(saleTierClaim.operatorId, actor.operatorId)),
    )
    .returning({ id: saleTierClaim.id, actionId: saleTierClaim.actionId });
  if (!restored) return null;
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId,
    action: CLAIM_RESTORE_ACTION,
    entityType: TIER_CLAIM_ENTITY,
    entityId: restored.id,
    before: { spentBySaleId: saleId },
    after: { spentBySaleId: null, reason: 'sale_voided' },
    actionId: restored.actionId,
    requestId: actor.requestId ?? null,
  });
  return restored.id;
}
