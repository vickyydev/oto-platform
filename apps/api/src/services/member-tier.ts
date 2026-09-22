import { and, eq, isNull } from 'drizzle-orm';
import { member, memberTierVerification, tier } from '@oto/db';
import { newId } from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import type { Tx } from './tx';

/**
 * SCRUM-241 — taking a verified tier back off a member.
 *
 * Granting one has existed since Sprint 1: staff check a passport or a
 * residence certificate, `POST /members/:id/tier-verification` files the
 * evidence and moves `member.tier_code` in the same transaction, and every
 * ticket that member buys is priced at the discounted rate from then on. There
 * was no way back. A rate granted on a document that turned out to belong to
 * somebody else, or to a resident who has since left, stood until the document
 * expired — and `evidence_expires_at` is nullable, so a row written without one
 * stood for good. The admin form said so in as many words rather than pretend:
 * "taking the rate back off a member is not built yet (SCRUM-241)".
 *
 * WHAT A REVOKE IS, precisely: another row in the same evidence table, of its
 * own kind. Not a deletion, not an edit of the grant. The grant row stays
 * exactly as it was written and the revocation sits after it, so
 * `GET /members/tier-verifications` reads as what happened in the order it
 * happened — who granted this rate on what document, and who took it away and
 * why. Erasing the grant would destroy the only record that the discount was
 * ever legitimate, which is the half a record check actually needs.
 *
 * WHY A REASON IS REQUIRED. `member_tier_verification.note` is free text and
 * optional on a grant, where the document type and its expiry already say what
 * was checked. A revocation has no document behind it — the whole content of
 * the act is a decision somebody made — so the note IS the record, and a
 * revoke with nothing written in it is a tier change with no account of
 * itself. Three characters is not a sentence; it is the floor under "rt" and
 * an empty box, and the screens ask for a sentence.
 *
 * WHO MAY. `pos:member:tier_downgrade`, which reception does not hold and a
 * branch manager does. That permission was minted for this act and has been
 * carrying its own comment since the vocabulary was written — "a tier only
 * ever goes down with someone accountable for it" — and the direction is why:
 * granting a discount costs the park the difference, and reception checks
 * documents all day, while taking one away is the act a customer argues with
 * at the counter.
 */

/**
 * `member_tier_verification.evidence_type` for a revocation row.
 *
 * The column is `text` with no CHECK constraint (`packages/db/src/schema/
 * members.ts`), so this needs no migration — which is also why it is a
 * constant rather than the string typed at each site: nothing in the database
 * would catch a second spelling of it, so every reader and every writer has to
 * come through here.
 */
export const TIER_REVOKED_EVIDENCE_TYPE = 'revoked';

/**
 * Whether this evidence row is a revocation rather than a grant.
 *
 * Read paths take the LATEST row per member as the member's entitlement. A
 * revocation is the latest row from the moment it is written, and it entitles
 * nothing — it is the record of an entitlement ending. Without this, a revoked
 * member reads back as holding a verification of the baseline tier: a green
 * "verified" badge on the rate that needs no proof at all.
 */
export function isTierRevocation(row: { evidenceType: string } | null | undefined): boolean {
  return row?.evidenceType === TIER_REVOKED_EVIDENCE_TYPE;
}

/** The shortest and longest reason the screens and the route accept. */
export const REVOKE_REASON_MIN = 3;
export const REVOKE_REASON_MAX = 200;

export interface TierRevokeActor {
  /** The session's account — who is accountable for this. Never from the body. */
  accountId: string;
  operatorId: string;
  /** The branch the session is signed in at; the counter this happened at. */
  branchId: string | null;
  requestId?: string | null;
}

export interface TierRevokeResult {
  /** The revocation row written. */
  verificationId: string;
  /** The tier the member held until now. */
  fromTier: string;
  /** The operator's baseline — the rate that needs no document. */
  toTier: string;
}

/**
 * Move a member back to the operator's baseline tier and file the reason.
 *
 * Runs inside the caller's transaction, and does all three parts of the act in
 * it: the evidence row, `member.tier_code`, and the audit entry. A member
 * sitting at a discounted tier with no live verification behind it — or a
 * revocation row beside a member who still prices as an expat — is exactly
 * what one transaction is for.
 *
 * The member is re-read here `FOR UPDATE` rather than trusted from the route's
 * load. Two counters revoking the same member at once would otherwise both
 * read `expat`, both write a revocation row, and file two revocations for one
 * entitlement; the lock makes the second one wait and then find the member
 * already at the baseline, which is the 409 below.
 */
export async function revokeTierVerification(
  tx: Tx,
  actor: TierRevokeActor,
  memberId: string,
  reason: string,
): Promise<TierRevokeResult> {
  const [m] = await tx
    .select()
    .from(member)
    .where(and(eq(member.id, memberId), eq(member.operatorId, actor.operatorId)))
    .for('update')
    .limit(1);
  // The route has already answered 404 for a member outside this operator;
  // this is the same predicate held on the row the write actually touches.
  if (!m) throw errors.notFound('Member not found');

  const [baseline] = await tx
    .select()
    .from(tier)
    .where(
      and(
        eq(tier.operatorId, actor.operatorId),
        eq(tier.isDefault, true),
        isNull(tier.archivedAt),
      ),
    )
    .limit(1);
  /**
   * No fallback to a hard-coded `tourist`, which is what `resolveTier` in
   * `sale.ts` does when an operator has no default tier. That fallback prices
   * one cart and is forgotten; this writes a tier code onto a member and into
   * an evidence row, where a code naming no tier would sit until somebody
   * noticed. An operator with no baseline configured cannot have one restored
   * to them, and saying so is the only honest answer.
   */
  if (!baseline) {
    throw errors.badRequest(
      'This operator has no baseline tier configured, so there is no rate to put this member back on',
    );
  }

  if (m.tierCode === baseline.code) {
    throw errors.conflict(
      'TIER_NOT_VERIFIED',
      `This member is already on the ${baseline.name} rate — there is no verified tier to take back`,
      { tierCode: m.tierCode },
    );
  }

  const id = newId();
  await tx.insert(memberTierVerification).values({
    id,
    memberId: m.id,
    fromTier: m.tierCode,
    toTier: baseline.code,
    evidenceType: TIER_REVOKED_EVIDENCE_TYPE,
    // No document, so no expiry. A revocation does not lapse: what it records
    // has already happened.
    evidenceExpiresAt: null,
    // Stamped from the session on both counts, exactly as a grant is.
    verifiedByAccountId: actor.accountId,
    branchId: actor.branchId,
    note: reason,
  });
  await tx.update(member).set({ tierCode: baseline.code }).where(eq(member.id, m.id));
  await audit.record(tx, {
    actorAccountId: actor.accountId,
    operatorId: actor.operatorId,
    branchId: actor.branchId,
    action: 'member.tier_revoke',
    entityType: 'member_tier_verification',
    entityId: id,
    before: { tierCode: m.tierCode },
    after: { tierCode: baseline.code, memberId: m.id, reason },
    requestId: actor.requestId ?? null,
  });

  return { verificationId: id, fromTier: m.tierCode, toTier: baseline.code };
}
