import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, memberTierVerification, saleTierClaim, station, ticketPackage } from '@oto/db';
import { TIER_PROOF_NOTE_PROBLEMS, newId } from '@oto/shared';
import { TIER_CLAIM_ENTITY } from '../src/services/sale-tier';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-697 — "Other" on the till's verify-tier step, through the real routes.
 *
 * Staff pick Other and describe what they checked. The description is
 * required (two words at least), never a document number, needs no expiry,
 * and is saved as the verification's note and as the sale claim's note. The
 * audit rows carry the kind only.
 */

let ctx: TestContext;
let cookie: string;
let branchId: string;
let stationId: string;
let twoHoursId: string;
let memberId: string;

const DESCRIPTION = 'Thai driving licence';

function verify(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: `/members/${memberId}/tier-verification`,
    headers: { cookie, 'idempotency-key': newId() },
    payload: { toTier: 'thai', evidenceType: 'Other', ...payload },
  });
}

function claim(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/sales/tier-claims',
    headers: { cookie },
    payload: { branchId, toTier: 'thai', evidenceType: 'Other', ...payload },
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;

  const created = await ctx.app.inject({
    method: 'POST',
    url: '/members',
    headers: { cookie },
    payload: { phone: '0636970697', nickname: 'Other Proof' },
  });
  expect(created.statusCode, created.body).toBeLessThan(300);
  memberId = created.json().member.id as string;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-697 — verify a member on an Other document', () => {
  it('refuses Other with a one-word description, and with none', async () => {
    for (const note of ['Licence', undefined]) {
      const res = await verify(note === undefined ? {} : { note });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toMatchObject({
        code: 'TIER_PROOF_NOTE',
        message: TIER_PROOF_NOTE_PROBLEMS.missing,
      });
    }
    const rows = await ctx.db
      .select()
      .from(memberTierVerification)
      .where(eq(memberTierVerification.memberId, memberId));
    expect(rows).toHaveLength(0);
  });

  it('refuses a description that carries a document number', async () => {
    const res = await verify({ note: 'licence 1234567890123' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'TIER_PROOF_NOTE',
      message: 'Describe the document, never its number.',
    });
  });

  it('records Other with its description and no expiry, and reads it back on the member', async () => {
    const res = await verify({ note: `  ${DESCRIPTION} ` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().member.tierCode).toBe('thai');
    expect(res.json().member.tierVerification).toMatchObject({
      tier: 'thai',
      proofType: 'Other',
      note: DESCRIPTION,
      expiresAt: null,
      reverifyDue: false,
    });

    const [row] = await ctx.db
      .select()
      .from(memberTierVerification)
      .where(eq(memberTierVerification.memberId, memberId))
      .orderBy(desc(memberTierVerification.createdAt))
      .limit(1);
    expect(row).toMatchObject({ evidenceType: 'Other', note: DESCRIPTION, evidenceExpiresAt: null });

    // The audit row names the kind; the free text stays out of the log.
    const [logged] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'member.tier_verify'), eq(auditLog.entityId, row!.id)));
    expect(logged!.after).toMatchObject({ evidenceType: 'Other' });
    expect(JSON.stringify(logged!.after)).not.toContain('licence');

    const lookup = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0636970697',
      headers: { cookie },
    });
    expect(lookup.json().member.tierVerification).toMatchObject({ proofType: 'Other', note: DESCRIPTION });
  });

  it('leaves the note null for the three kinds', async () => {
    const res = await verify({ evidenceType: 'Passport' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().member.tierVerification).toMatchObject({ proofType: 'Passport', note: null });
  });
});

describe('SCRUM-697 — a walk-in claim on an Other document', () => {
  it('refuses Other with a one-word description', async () => {
    const res = await claim({ actionId: newId(), note: 'Licence' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('TIER_PROOF_NOTE');
  });

  it('records the description on the claim, keeps it out of the audit, and the sale read carries it', async () => {
    const actionId = newId();
    const res = await claim({ actionId, note: DESCRIPTION });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().claim).toMatchObject({
      toTier: 'thai',
      evidenceType: 'Other',
      evidenceExpiresAt: null,
      note: DESCRIPTION,
    });

    // The same tap is the same claim; a different description under it is not.
    const again = await claim({ actionId, note: DESCRIPTION });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().claim.id).toBe(res.json().claim.id);
    const changed = await claim({ actionId, note: 'Thai work permit' });
    expect(changed.statusCode, changed.body).toBe(409);
    expect(changed.json().error.code).toBe('TIER_CLAIM_ACTION_REUSED');

    const [row] = await ctx.db.select().from(saleTierClaim).where(eq(saleTierClaim.actionId, actionId));
    expect(row).toMatchObject({ evidenceType: 'Other', note: DESCRIPTION });
    const [logged] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, TIER_CLAIM_ENTITY), eq(auditLog.entityId, row!.id)));
    expect(Object.keys(logged!.after as object)).not.toContain('note');
    expect(JSON.stringify(logged!.after)).not.toContain('licence');

    const saleId = newId();
    const committed = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: {
        id: saleId,
        stationId,
        branchId,
        tierClaimActionId: actionId,
        lines: [{ id: newId(), packageId: twoHoursId, kids: 2, adults: 1 }],
      },
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const read = await ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie } });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().sale.tierClaim).toMatchObject({ documentKind: 'Other', documentNote: DESCRIPTION });
  });
});
