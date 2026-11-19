import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, member, memberTierVerification, saleTierClaim } from '@oto/db';
import { TIER_PROOF_EXPIRY_PROBLEMS, newId } from '@oto/shared';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-1019 — the number, the rate and the document, through the real
 * routes (the owner's answers of 19 November 2026,
 * docs/progress/plans/dropoff-beo-20261119/ANSWERS.md §2).
 *
 * - A number the system does not know creates the customer by itself: the
 *   till calls `POST /members` with its own id and the name the family gave.
 *   The same number is one member, however it is typed or pressed again.
 * - The expiry date is required on every document kind, Other included, on a
 *   member's check and on a walk-in's claim. The Thai rate confirmed at the
 *   till has no document and no date, as before. A document recorded before
 *   the rule with no date stays as it was filed: no backfill, no lock-out.
 *
 * Demo data only: every number and name below is a ZZ TEST fixture.
 */

let ctx: TestContext;
let cookie: string;
let branchId: string;

const NEXT_YEAR = `${new Date().getUTCFullYear() + 1}-06-30`;
const KINDS = [
  { evidenceType: 'Passport' },
  { evidenceType: 'Driving licence' },
  { evidenceType: 'School card' },
  { evidenceType: 'Other', note: 'Work permit' },
] as const;

function createMember(payload: Record<string, unknown>, headers: Record<string, string> = { cookie }) {
  return ctx.app.inject({ method: 'POST', url: '/members', headers: { ...headers, 'idempotency-key': newId() }, payload });
}

async function newMember(phone: string, nickname: string): Promise<string> {
  const created = await createMember({ phone, nickname });
  expect(created.statusCode, created.body).toBe(200);
  return created.json().member.id as string;
}

function verify(memberId: string, payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/members/${memberId}/tier-verification`,
    headers: { cookie, 'idempotency-key': newId() },
    payload: { toTier: 'expat', ...payload },
  });
}

function claim(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/sales/tier-claims',
    headers: { cookie, 'idempotency-key': newId() },
    payload: { branchId, toTier: 'expat', actionId: newId(), ...payload },
  });
}

const rowsOf = (memberId: string) =>
  ctx.db.select().from(memberTierVerification).where(eq(memberTierVerification.memberId, memberId));

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-1019 — a number nobody knows makes the customer by itself', () => {
  it('is created once, from the number and the name, under the till’s own id', async () => {
    const id = newId();
    const body = { id, phone: '0619190001', nickname: 'ZZ TEST 1019 Mali', preferredChannel: 'line' };
    const first = await createMember(body);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().member).toMatchObject({ id, phone: '+66619190001', nickname: 'ZZ TEST 1019 Mali', preferredChannel: 'line' });

    // The same press again (a reply lost on the way back): the member that exists.
    const again = await createMember(body);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().member.id).toBe(id);
    const rows = await ctx.db.select().from(member).where(eq(member.phone, '+66619190001'));
    expect(rows).toHaveLength(1);

    // The lookup finds it as the family typed the number, in the local form.
    const found = await ctx.app.inject({ method: 'GET', url: '/members/lookup?phone=061-919-0001', headers: { cookie } });
    expect(found.json().member.id).toBe(id);
  });

  it('the same number typed another way is refused cleanly, naming the member that exists', async () => {
    const first = await newMember('0619190002', 'ZZ TEST 1019 Ben');
    const twice = await createMember({ id: newId(), phone: '+66 61 919 0002', nickname: 'ZZ TEST 1019 Other name' });
    expect(twice.statusCode, twice.body).toBe(409);
    expect(twice.json().error).toMatchObject({ code: 'MEMBER_PHONE_EXISTS', details: { memberId: first } });
    const rows = await ctx.db.select().from(member).where(eq(member.phone, '+66619190002'));
    expect(rows.map((r) => r.nickname)).toEqual(['ZZ TEST 1019 Ben']);
  });

  it('is audited once, with what was created', async () => {
    const id = await newMember('0619190003', 'ZZ TEST 1019 Audited');
    const logged = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'member'), eq(auditLog.entityId, id), eq(auditLog.action, 'member.create')));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.after).toMatchObject({ phone: '+66619190003', nickname: 'ZZ TEST 1019 Audited' });
  });

  it('is guarded: the member-create permission, and nothing without a session', async () => {
    const route = ctx.app.routeRegistry.find((r) => r.method === 'POST' && r.url === '/members');
    expect(route?.config.permission).toBe('pos:member:create');
    const anonymous = await ctx.app.inject({ method: 'POST', url: '/members', payload: { phone: '0619190004', nickname: 'ZZ TEST 1019 Nobody' } });
    expect(anonymous.statusCode).toBe(401);
    expect(await ctx.db.select().from(member).where(eq(member.phone, '+66619190004'))).toHaveLength(0);
  });

  it('another park group’s same number is its own customer, never this one', async () => {
    const ours = await newMember('0619190005', 'ZZ TEST 1019 Ours');
    const other = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    const theirs = await createMember({ phone: '0619190005', nickname: 'ZZ TEST 1019 Theirs' }, { cookie: other });
    expect(theirs.statusCode, theirs.body).toBe(200);
    expect(theirs.json().member.id).not.toBe(ours);
  });

  it('a name is still required: nothing is created with no name', async () => {
    const res = await createMember({ phone: '0619190006', nickname: '' });
    expect(res.statusCode).toBe(400);
    expect(await ctx.db.select().from(member).where(eq(member.phone, '+66619190006'))).toHaveLength(0);
  });
});

describe('SCRUM-1019 — the expiry date is required on every document kind', () => {
  it('a member’s check without the date is refused, for every kind, Other included', async () => {
    for (const [i, kind] of KINDS.entries()) {
      const memberId = await newMember(`06191901${10 + i}`, `ZZ TEST 1019 No date ${i}`);
      const res = await verify(memberId, { ...kind });
      expect(res.statusCode, `${kind.evidenceType}: ${res.body}`).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'TIER_PROOF_EXPIRY', message: TIER_PROOF_EXPIRY_PROBLEMS.missing });
      expect(await rowsOf(memberId)).toHaveLength(0);
      const [m] = await ctx.db.select().from(member).where(eq(member.id, memberId));
      expect(m!.tierCode).toBe('tourist');
    }
  });

  it('a member’s check with the date is recorded, for every kind', async () => {
    for (const [i, kind] of KINDS.entries()) {
      const memberId = await newMember(`06191902${10 + i}`, `ZZ TEST 1019 Dated ${i}`);
      const res = await verify(memberId, { ...kind, evidenceExpiresAt: NEXT_YEAR });
      expect(res.statusCode, `${kind.evidenceType}: ${res.body}`).toBe(200);
      expect(res.json().member.tierVerification).toMatchObject({
        tier: 'expat',
        proofType: kind.evidenceType,
        expiresAt: NEXT_YEAR,
        reverifyDue: false,
      });
    }
  });

  it('a date that is not a day of the calendar is refused', async () => {
    const memberId = await newMember('0619190301', 'ZZ TEST 1019 Bad date');
    const res = await verify(memberId, { evidenceType: 'Passport', evidenceExpiresAt: '2031-02-30' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'TIER_PROOF_EXPIRY', message: TIER_PROOF_EXPIRY_PROBLEMS.notADate });
  });

  it('a walk-in’s claim without the date is refused, for every kind; with it, recorded', async () => {
    for (const kind of KINDS) {
      const actionId = newId();
      const refused = await claim({ ...kind, actionId });
      expect(refused.statusCode, `${kind.evidenceType}: ${refused.body}`).toBe(400);
      expect(refused.json().error).toMatchObject({ code: 'TIER_PROOF_EXPIRY', message: TIER_PROOF_EXPIRY_PROBLEMS.missing });
      expect(await ctx.db.select().from(saleTierClaim).where(eq(saleTierClaim.actionId, actionId))).toHaveLength(0);

      const made = await claim({ ...kind, evidenceExpiresAt: NEXT_YEAR });
      expect(made.statusCode, `${kind.evidenceType}: ${made.body}`).toBe(200);
      expect(made.json().claim).toMatchObject({ evidenceType: kind.evidenceType, evidenceExpiresAt: NEXT_YEAR });
    }
  });

  it('the Thai rate confirmed at the till still carries no document and no date', async () => {
    const memberId = await newMember('0619190401', 'ZZ TEST 1019 Thai');
    const confirmed = await verify(memberId, { toTier: 'thai', evidenceType: 'Approved by hand' });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json().member.tierVerification).toMatchObject({ tier: 'thai', expiresAt: null });

    const other = await newMember('0619190402', 'ZZ TEST 1019 Thai dated');
    const dated = await verify(other, { toTier: 'thai', evidenceType: 'Approved by hand', evidenceExpiresAt: NEXT_YEAR });
    expect(dated.statusCode, dated.body).toBe(400);
    expect(dated.json().error.code).toBe('TIER_APPROVAL');
  });
});

describe('SCRUM-1019 — a document recorded before the rule, with no date', () => {
  it('stays as it was filed and keeps the rate: no backfill, no lock-out', async () => {
    const memberId = await newMember('0619190501', 'ZZ TEST 1019 Earlier');
    await ctx.db.insert(memberTierVerification).values({
      id: newId(),
      memberId,
      fromTier: 'tourist',
      toTier: 'expat',
      evidenceType: 'Passport',
      evidenceExpiresAt: null,
    });
    await ctx.db.update(member).set({ tierCode: 'expat' }).where(eq(member.id, memberId));

    const lookup = await ctx.app.inject({ method: 'GET', url: '/members/lookup?phone=0619190501', headers: { cookie } });
    expect(lookup.statusCode, lookup.body).toBe(200);
    expect(lookup.json().member).toMatchObject({ tierCode: 'expat' });
    expect(lookup.json().member.tierVerification).toMatchObject({
      tier: 'expat',
      proofType: 'Passport',
      expiresAt: null,
      reverifyDue: false,
    });
    const [row] = await rowsOf(memberId);
    expect(row!.evidenceExpiresAt).toBeNull();
  });

  it('a check pressed again under its own id answers as it was made, before the date is read', async () => {
    const memberId = await newMember('0619190502', 'ZZ TEST 1019 Replay');
    const verificationId = newId();
    await ctx.db.insert(memberTierVerification).values({
      id: verificationId,
      memberId,
      fromTier: 'tourist',
      toTier: 'expat',
      evidenceType: 'Passport',
      evidenceExpiresAt: null,
    });
    const replay = await verify(memberId, { verificationId, evidenceType: 'Passport' });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(await rowsOf(memberId)).toHaveLength(1);
  });
});
