import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, member, memberTierVerification } from '@oto/db';
import {
  ADMIN,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  createTestContext,
  operatorIdByName,
  SECOND_OPERATOR_NAME,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-241 — taking a verified tier back off a member.
 *
 * The grant has been testable since Sprint 1 and the way back did not exist:
 * a discounted rate granted on a document stood until that document expired,
 * and `evidence_expires_at` is nullable, so a row written without one stood
 * for good.
 *
 * What these assert, beyond "the member is on the baseline rate again":
 *
 *   - BOTH evidence rows survive. The grant is not edited and not deleted —
 *     the revocation is appended after it — because erasing the grant would
 *     destroy the only record that the discount was ever legitimate.
 *   - The reason is not optional. A revocation has no document behind it, so
 *     the note IS the record of why the rate ended.
 *   - Reception cannot do it. `pos:member:tier_downgrade` is a manager gate,
 *     and reception — which holds `pos:member:update` and records
 *     verifications all day — is the account that proves the two permissions
 *     are not the same permission.
 *   - A second revoke is refused rather than filing a second revocation for
 *     one entitlement.
 */

let ctx: TestContext;
/** Holds `pos:member:update` and NOT `pos:member:tier_downgrade`. */
let reception: string;
/** Platform + operator admin: holds the downgrade gate. */
let admin: string;
let secondAdmin: string;

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  secondAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** A member of the park, verified to `expat` on a passport by reception. */
async function verifiedMember(phone: string, nickname: string): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/members',
    headers: { cookie: reception },
    payload: { phone, nickname },
  });
  expect(created.statusCode).toBe(200);
  const id = created.json().member.id as string;
  const verified = await ctx.app.inject({
    method: 'POST',
    url: `/members/${id}/tier-verification`,
    headers: { cookie: reception },
    payload: { toTier: 'expat', evidenceType: 'Passport', evidenceExpiresAt: '2030-01-01' },
  });
  expect(verified.statusCode).toBe(200);
  expect(verified.json().member.tierCode).toBe('expat');
  return id;
}

/** Every evidence row for one member, oldest first. */
const evidenceRows = (memberId: string) =>
  ctx.db
    .select()
    .from(memberTierVerification)
    .where(eq(memberTierVerification.memberId, memberId))
    .orderBy(asc(memberTierVerification.createdAt));

describe('SCRUM-241 — revoking a verified tier', () => {
  let memberId: string;

  beforeAll(async () => {
    memberId = await verifiedMember('0644440001', 'Revoke Test');
  });

  it('refuses reception, which records verifications but does not take them back', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/members/${memberId}/tier-verification`,
      headers: { cookie: reception },
      payload: { reason: 'Passport turned out to belong to someone else' },
    });
    expect(res.statusCode).toBe(403);
    // Nothing happened: the member still holds the rate and the counter still
    // sees the verification behind it.
    const [row] = await ctx.db.select().from(member).where(eq(member.id, memberId));
    expect(row!.tierCode).toBe('expat');
    expect(await evidenceRows(memberId)).toHaveLength(1);
  });

  it('refuses a reason too short to be an account of anything', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/members/${memberId}/tier-verification`,
      headers: { cookie: admin },
      payload: { reason: 'x' },
    });
    expect(res.statusCode).toBe(400);
    const [row] = await ctx.db.select().from(member).where(eq(member.id, memberId));
    expect(row!.tierCode).toBe('expat');
  });

  it('puts the member back on the baseline rate and keeps both rows, with the reason', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/members/${memberId}/tier-verification`,
      headers: { cookie: admin },
      payload: { reason: 'Residence permit expired and was not renewed' },
    });
    expect(res.statusCode).toBe(200);
    const m = res.json().member;
    expect(m.tierCode).toBe('tourist');
    // The revocation is the latest evidence row, and it entitles nothing: the
    // counter must not read it back as a verification of the baseline tier.
    expect(m.tierVerification).toBeNull();

    const rows = await evidenceRows(memberId);
    expect(rows).toHaveLength(2);
    const [grant, revocation] = rows;
    // The grant is untouched — who gave this rate, on what, and until when.
    expect(grant!.toTier).toBe('expat');
    expect(grant!.evidenceType).toBe('Passport');
    expect(revocation!.fromTier).toBe('expat');
    expect(revocation!.toTier).toBe('tourist');
    expect(revocation!.evidenceType).toBe('revoked');
    expect(revocation!.note).toBe('Residence permit expired and was not renewed');
    // A revocation does not lapse; what it records has already happened.
    expect(revocation!.evidenceExpiresAt).toBeNull();
    // WHO took it away and WHERE come from the session, never from the body.
    expect(revocation!.verifiedByAccountId).toBeTruthy();
    expect(revocation!.branchId).toBeTruthy();
  });

  /**
   * SCRUM-317 — and the register says the same thing as the counter.
   *
   * `GET /members` builds its rows in `services/members.ts`, not through
   * `memberWithChildren`, and it took the newest evidence row as the member's
   * entitlement. After a revoke that row IS the revocation, so the register
   * answered `{tier: 'tourist', proofType: 'revoked'}` — a verification of the
   * rate that needs no document — while `GET /members/:id` answered null for
   * the same member. Both screens reading it masked it; the contract hole was
   * real, and a third reader would have believed the register.
   */
  it('and the register answers the same null, not a verification of the baseline rate', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members?q=Revoke%20Test',
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    const row = res.json().members.find((m: { id: string }) => m.id === memberId);
    expect(row).toBeTruthy();
    expect(row.tierCode).toBe('tourist');
    expect(row.tierVerification).toBeNull();
    // Belt and braces on the wire itself: the word must not reach a client.
    expect(res.body).not.toContain('revoked');
  });

  it('shows both the grant and the revocation in the record-checking list', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members/tier-verifications',
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    const mine = res
      .json()
      .verifications.filter((v: { member: { id: string } }) => v.member.id === memberId);
    expect(mine).toHaveLength(2);
    // Newest first: the revocation, then the grant it ended.
    expect(mine[0].evidenceType).toBe('revoked');
    expect(mine[0].fromTier).toBe('expat');
    expect(mine[0].toTier).toBe('tourist');
    expect(mine[0].note).toBe('Residence permit expired and was not renewed');
    expect(mine[0].verifiedBy).toBeTruthy();
    expect(mine[1].evidenceType).toBe('Passport');
    expect(mine[1].toTier).toBe('expat');
  });

  it('writes an audit row carrying the tier before and after', async () => {
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'member.tier_revoke'));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect((row.before as { tierCode: string }).tierCode).toBe('expat');
    const after = row.after as { tierCode: string; memberId: string; reason: string };
    expect(after.tierCode).toBe('tourist');
    expect(after.memberId).toBe(memberId);
    expect(after.reason).toBe('Residence permit expired and was not renewed');
    expect(row.actorAccountId).toBeTruthy();
    expect(row.operatorId).toBeTruthy();
  });

  it('refuses a second revoke rather than filing two for one entitlement', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/members/${memberId}/tier-verification`,
      headers: { cookie: admin },
      payload: { reason: 'Trying the same thing twice' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TIER_NOT_VERIFIED');
    expect(await evidenceRows(memberId)).toHaveLength(2);
  });
});

describe('SCRUM-241 — tenancy', () => {
  let strangerId: string;

  beforeAll(async () => {
    // The seeded second operator's own member, moved to a discounted tier
    // directly: that operator has no tier rows of its own, and what is being
    // asserted here happens before any tier is looked up.
    const operatorId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
    const [row] = await ctx.db
      .select()
      .from(member)
      .where(eq(member.operatorId, operatorId))
      .limit(1);
    strangerId = row!.id;
    await ctx.db.update(member).set({ tierCode: 'expat' }).where(eq(member.id, strangerId));
  });

  it("does not end another operator's member's tier, and says only 404", async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/members/${strangerId}/tier-verification`,
      headers: { cookie: admin },
      payload: { reason: 'Reaching across the tenancy boundary' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
    const [row] = await ctx.db.select().from(member).where(eq(member.id, strangerId));
    expect(row!.tierCode).toBe('expat');
    expect(await evidenceRows(strangerId)).toHaveLength(0);
  });

  it('refuses its own administrator too, because that operator has no baseline tier to restore', async () => {
    // Not a tenancy refusal — this one owns the row. The operator has no
    // `tier.is_default`, so there is no rate to put the member back on, and
    // guessing `tourist` would write a tier code naming no tier.
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/members/${strangerId}/tier-verification`,
      headers: { cookie: secondAdmin },
      payload: { reason: 'Their own administrator, on their own member' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/baseline tier/i);
    const [row] = await ctx.db.select().from(member).where(eq(member.id, strangerId));
    expect(row!.tierCode).toBe('expat');
  });
});

describe('SCRUM-241 — replaying the revoke', () => {
  it('answers the same thing twice and revokes once', async () => {
    const memberId = await verifiedMember('0644440002', 'Replay Test');
    const headers = { cookie: admin, 'idempotency-key': 'revoke-replay-1' };
    const payload = { reason: 'Moved back to the UK in March' };

    const first = await ctx.app.inject({
      method: 'DELETE',
      url: `/members/${memberId}/tier-verification`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(200);
    const second = await ctx.app.inject({
      method: 'DELETE',
      url: `/members/${memberId}/tier-verification`,
      headers,
      payload,
    });
    // The stored answer, not a 409 from a second attempt at the work: a retry
    // through a dropped connection is the same act, not a new one.
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());

    const rows = await evidenceRows(memberId);
    expect(rows.filter((r) => r.evidenceType === 'revoked')).toHaveLength(1);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, 'member.tier_revoke'), eq(auditLog.entityId, rows[1]!.id)),
      );
    expect(audits).toHaveLength(1);
  });
});
