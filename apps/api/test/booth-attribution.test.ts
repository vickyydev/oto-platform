import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { account, box, boothConfigVersion, spin, station } from '@oto/db';
import { newId, type SyncPushResponse } from '@oto/shared';
import { boxCredential, generateSyncKeyPair, sealEnvelope } from '@oto/box-agent';
import { RECEPTION, createTestContext, teardownAll, type TestContext } from './helpers';
import { issueClaimCode } from '../src/services/box';
import {
  SPIN_LABEL_JOINS,
  SPIN_STAFF_LABEL,
  SPIN_UNATTRIBUTED,
  normaliseStaffLabel,
} from '../src/services/booth-attribution';
import { boothBusinessDate } from '../src/services/booth-duty';
import { boothReportCsv, boothReportOf, rollupBoothBranchDay } from '../src/services/analytics-booth';

/**
 * SCRUM-694 — who a booth spin is attributed to, read in one place.
 *
 * Nobody signs in at the booth: the box sends the Staff-row label its slip
 * printed (today's roster, "Tom and Jerry") on the spin fact, and no column
 * holds it. These spins go through the real `POST /box/v1/sync/push`, sealed
 * with the box's own key, so the label is read back from the ledger exactly
 * as a box wrote it — and from the `spin.record` audit row once the ledger
 * row has been swept. Older boxes' payloads (a signed-in account, or nothing)
 * keep their old meaning.
 */

let ctx: TestContext;
let operatorId: string;
let branchId: string;
let boxId: string;
let credential: string;
let privateKeyPem: string;
let boothA: string;
let boothB: string;
const versions = new Map<string, string>();
let receptionId: string;
let today: string;
let seq = 0;

beforeAll(async () => {
  ctx = await createTestContext();
  const [seeded] = await ctx.db.select().from(station).where(eq(station.name, 'Booth 1')).limit(1);
  operatorId = seeded!.operatorId;
  branchId = seeded!.branchId;
  const [seededVersion] = await ctx.db
    .select()
    .from(boothConfigVersion)
    .where(eq(boothConfigVersion.stationId, seeded!.id))
    .limit(1);
  const [reception] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone)).limit(1);
  receptionId = reception!.id;

  // A box of its own, registered with a signing key, carrying two booths.
  const id = newId();
  await ctx.db.insert(box).values({
    id,
    operatorId,
    branchId,
    name: 'Attribution box',
    slot: 'attribution-1',
    role: 'booth',
    status: 'unclaimed',
  });
  const { code } = await issueClaimCode(ctx.db, id);
  const keys = generateSyncKeyPair();
  const registered = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/register',
    payload: {
      claimCode: code,
      agentVersion: '0.1.0',
      hostname: 'attribution-1',
      syncPublicKey: keys.publicKeyPem,
      syncKeyAlgorithm: 'ed25519',
    },
  });
  expect(registered.statusCode, registered.body).toBe(200);
  const body = registered.json() as { boxId: string; secret: string };
  boxId = body.boxId;
  credential = boxCredential(body.boxId, body.secret);
  privateKeyPem = keys.privateKeyPem;

  for (const [name, prefix] of [
    ['Attribution Booth A', 'AA'],
    ['Attribution Booth B', 'AB'],
  ] as const) {
    const stationId = newId();
    await ctx.db.insert(station).values({ id: stationId, operatorId, branchId, boxId, name, kind: 'booth', codePrefix: prefix });
    const versionId = newId();
    await ctx.db.insert(boothConfigVersion).values({
      ...seededVersion!,
      id: versionId,
      stationId,
      version: 1,
      publishedAt: new Date(),
    });
    versions.set(stationId, versionId);
    if (prefix === 'AA') boothA = stationId;
    else boothB = stationId;
  }
  today = await boothBusinessDate(ctx.db, branchId);
}, 120_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** One press as a box files it: sealed, pushed, applied. Answers the spin id. */
async function pushSpin(stationId: string, payload: Record<string, unknown>): Promise<string> {
  const spinId = newId();
  seq += 1;
  const envelope = sealEnvelope(
    {
      eventId: newId(),
      journalEpoch: 1,
      boxSeq: seq,
      type: 'booth.spin_recorded',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      clockTrust: 'trusted',
      stationId,
      actorKind: 'device',
      actorAccountId: null,
      actorCredentialId: null,
      actionId: `attribution-${seq}`,
      payload: {
        spinId,
        boothConfigVersionId: versions.get(stationId)!,
        outcome: 'no_prize',
        prizeId: null,
        voucherId: null,
        clockSuspect: false,
        simulated: false,
        ...payload,
      },
    },
    boxId,
    privateKeyPem,
  );
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/sync/push',
    headers: { authorization: `Bearer ${credential}` },
    payload: { events: [envelope] },
  });
  expect(res.statusCode, res.body).toBe(200);
  const answer = res.json() as SyncPushResponse;
  expect(answer.results[0]?.result, JSON.stringify(answer.results[0])).toBe('applied');
  return spinId;
}

async function attributionOf(spinId: string): Promise<{ label: string | null; unattributed: boolean }> {
  const { rows } = await ctx.db.execute<{ label: string | null; unattributed: boolean }>(sql`
    select ${SPIN_STAFF_LABEL} as label, ${SPIN_UNATTRIBUTED} as unattributed
      from booth.spin s ${SPIN_LABEL_JOINS}
     where s.id = ${spinId}::uuid`);
  return rows[0]!;
}

describe('a spin’s attribution is the label its slip printed', () => {
  it('a roster label reads back, and the spin is attributed', async () => {
    const id = await pushSpin(boothA, { staffLabel: 'Tom and Jerry', dutyAccountIds: [] });
    expect(await attributionOf(id)).toEqual({ label: 'Tom and Jerry', unattributed: false });
    const [row] = await ctx.db.select({ staffAccountId: spin.staffAccountId }).from(spin).where(eq(spin.id, id));
    expect(row?.staffAccountId, 'nobody signs in: the column stays null').toBeNull();
  });

  it('nobody on today’s roster is unattributed', async () => {
    const id = await pushSpin(boothA, { staffLabel: null, dutyAccountIds: [] });
    expect(await attributionOf(id)).toEqual({ label: null, unattributed: true });
  });

  it('a payload from before SCRUM-694 keeps its meaning: a signed-in account is attributed, neither is not', async () => {
    const signedIn = await pushSpin(boothA, { staffAccountId: receptionId });
    expect(await attributionOf(signedIn)).toEqual({ label: null, unattributed: false });
    const nobody = await pushSpin(boothA, {});
    expect(await attributionOf(nobody)).toEqual({ label: null, unattributed: true });
  });

  it('once the ledger row is swept, the label is read from the spin.record audit row', async () => {
    const id = await pushSpin(boothA, { staffLabel: 'Nok', dutyAccountIds: [] });
    const [row] = await ctx.db.select({ sourceEventId: spin.sourceEventId }).from(spin).where(eq(spin.id, id));
    // What the 365-day retention sweep does to the ledger.
    await ctx.db.execute(sql`delete from edge.sync_event where event_id = ${row!.sourceEventId}::uuid`);
    expect(await attributionOf(id)).toEqual({ label: 'Nok', unattributed: false });
  });

  it('a label longer than any slip is cut to 500 characters, never refused', async () => {
    const id = await pushSpin(boothA, { staffLabel: 'x'.repeat(900), dutyAccountIds: [] });
    const read = await attributionOf(id);
    expect(read.label).toHaveLength(500);
    expect(read.unattributed).toBe(false);
  });

  it('normaliseStaffLabel is the same rule in hand', () => {
    expect(normaliseStaffLabel('  Tom and Jerry ')).toBe('Tom and Jerry');
    expect(normaliseStaffLabel('   ')).toBeNull();
    expect(normaliseStaffLabel(null)).toBeNull();
    expect(normaliseStaffLabel(42)).toBeNull();
    expect(normaliseStaffLabel('y'.repeat(900))).toHaveLength(500);
  });
});

describe('the booth report’s By staff reads the slip label (D7)', () => {
  it('two spins labelled Tom and Jerry and one with none: two staff rows, the same in the CSV, and booth totals of 3', async () => {
    await pushSpin(boothB, { staffLabel: 'Tom and Jerry', dutyAccountIds: [] });
    await pushSpin(boothB, { staffLabel: 'Tom and Jerry', dutyAccountIds: [] });
    await pushSpin(boothB, { staffLabel: null, dutyAccountIds: [] });
    await rollupBoothBranchDay(ctx.db, { id: branchId, operatorId }, today, new Date());

    const scope = { branches: [{ branchId, name: 'Branch' }], omitted: [], from: today, to: today };
    const report = await boothReportOf(ctx.db, scope);
    const staff = report.staff
      .filter((s) => s.boothId === boothB)
      .map((s) => ({ accountId: s.accountId, label: s.label, name: s.name, spins: s.spins }))
      .sort((a, b) => b.spins - a.spins);
    expect(staff).toEqual([
      { accountId: null, label: 'Tom and Jerry', name: 'Tom and Jerry', spins: 2 },
      { accountId: null, label: null, name: 'Unattributed', spins: 1 },
    ]);
    expect(report.booths.find((b) => b.boothId === boothB)?.spins).toBe(3);

    const { csv } = await boothReportCsv(ctx.db, scope);
    const lines = csv.split('\r\n').filter((l) => l.includes('Attribution Booth B'));
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes('"Tom and Jerry"') && l.includes('"2"'))).toBe(true);
    expect(lines.some((l) => l.includes('"Unattributed"') && l.includes('"1"'))).toBe(true);
  });

  it('the Console’s count of unattributed spins uses the same rule', async () => {
    const { rows } = await ctx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from booth.spin s ${SPIN_LABEL_JOINS}
       where s.station_id = ${boothB}::uuid and ${SPIN_UNATTRIBUTED}`);
    expect(rows[0]?.n).toBe(1);
    const all = await ctx.db
      .select({ id: spin.id })
      .from(spin)
      .where(and(eq(spin.stationId, boothB), eq(spin.simulated, false)));
    expect(all).toHaveLength(3);
  });
});
