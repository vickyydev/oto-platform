import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { band, bandEvent, branch, station, syncEvent, ticketPackage, type Db } from '@oto/db';
import { newId } from '@oto/shared';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  boxBySlot,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { countAt } from '../src/services/occupancy';

/**
 * S2-12 round 4 — FINAL GATE reproductions (kept as tests).
 *
 * (1) Within one box and one journal epoch, `box_seq` wins every time, even
 *     when clock trust flips twice across three passages and the effective
 *     times (or the band_event id tie-break) point the other way.
 * (2) Across two boxes on two lanes with skewed clocks, the effective time
 *     (received_at for an untrusted/skewed box) orders the passages.
 *
 * Ledger rows are written directly so the misorder is exact. Dates are in
 * 2032 so nothing here meets another file's.
 */

let ctx: TestContext;
let db: Db;
let centralId: string;
let operatorId: string;
let receptionCookie: string;
let boxA: string;
let boxB: string;
let laneA: string;
let laneB: string;
// A high, file-private epoch so the ledger's (box, epoch, seq) key never meets another file's.
const EPOCH = 7000 + Math.floor(Math.random() * 1000);
let seqA = 0;
let seqB = 0;

const bkk = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+07:00`);

async function sell(kids: number, adults: number): Promise<{ adults: string[]; kids: string[] }> {
  const [till] = await db.select().from(station).where(eq(station.codePrefix, 'T1'));
  const [pkg] = await db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, till!.branchId), eq(ticketPackage.name, '2 Hours Play')));
  const saleId = newId();
  const rung = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: receptionCookie },
    payload: { id: saleId, stationId: till!.id, lines: [{ id: newId(), packageId: pkg!.id, kids, adults }] },
  });
  expect(rung.statusCode, rung.body).toBe(200);
  const paid = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie: receptionCookie },
    payload: {},
  });
  expect(paid.statusCode, paid.body).toBe(200);
  const bands = await db.select().from(band).where(eq(band.saleId, saleId));
  return {
    adults: bands.filter((b) => b.kind === 'adult').map((b) => b.id),
    kids: bands.filter((b) => b.kind === 'kid').map((b) => b.id),
  };
}

interface Passage {
  bandId: string;
  kind: 'entry' | 'exit';
  lane: 'A' | 'B';
  /** The box's own stamp (band_event.created_at, sync_event.occurred_at). */
  stamp: Date;
  receivedAt: Date;
  trust: 'trusted' | 'untrusted' | 'skewed';
  /** Force the band_event id (to attack the id tie-break). */
  id?: string;
}

async function landed(p: Passage): Promise<void> {
  const eventId = newId();
  const boxId = p.lane === 'A' ? boxA : boxB;
  const seq = p.lane === 'A' ? ++seqA : ++seqB;
  await db.insert(syncEvent).values({
    eventId,
    boxId,
    journalEpoch: EPOCH,
    boxSeq: seq,
    type: 'band.gate_event',
    occurredAt: p.stamp,
    receivedAt: p.receivedAt,
    clockTrust: p.trust,
    businessDate: '2032-05-04',
    operatorId,
    branchId: centralId,
    stationId: p.lane === 'A' ? laneA : laneB,
    actorKind: 'box',
    payload: {},
    payloadHash: 'a'.repeat(64),
    sig: 'test',
  } as typeof syncEvent.$inferInsert);
  await db.insert(bandEvent).values({
    id: p.id ?? newId(),
    bandId: p.bandId,
    kind: p.kind,
    stationId: p.lane === 'A' ? laneA : laneB,
    boxId,
    detail: { direction: p.kind, side: 'left', sourceEventId: eventId },
    createdAt: p.stamp,
  });
}

const DAY = '2032-05-04';
const count = async (hhmm: string) => {
  const c = await countAt(db, centralId, bkk(DAY, '05:00'), bkk(DAY, hhmm));
  return { adults: c.adults, kids: c.kids };
};

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  centralId = await branchIdByCode(db, CENTRAL_BRANCH_CODE);
  const [row] = await db.select({ operatorId: branch.operatorId }).from(branch).where(eq(branch.id, centralId));
  operatorId = row!.operatorId;
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  boxA = (await boxBySlot(db, 'virtual-2')).id;
  boxB = (await boxBySlot(db, 'virtual-3')).id;
  laneA = newId();
  laneB = newId();
  await db.insert(station).values([
    { id: laneA, operatorId, branchId: centralId, boxId: boxA, name: 'Final lane A', kind: 'gate' },
    { id: laneB, operatorId, branchId: centralId, boxId: boxB, name: 'Final lane B', kind: 'gate' },
  ]);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('final (1) — box_seq wins inside one box, trust flipping twice', () => {
  it('trusted entry, untrusted exit, trusted re-entry: the family is IN (effective time alone says out)', async () => {
    const base = await count('13:00');
    const s = await sell(1, 1);
    const a = s.adults[0]!;
    // seq n: entry, trusted, 10:00.
    await landed({ bandId: a, kind: 'entry', lane: 'A', stamp: bkk(DAY, '10:00'), receivedAt: bkk(DAY, '10:00'), trust: 'trusted' });
    // seq n+1: exit, untrusted (stamp 3 h behind), only reaches the cloud at 12:00.
    await landed({ bandId: a, kind: 'exit', lane: 'A', stamp: bkk(DAY, '07:30'), receivedAt: bkk(DAY, '12:00'), trust: 'untrusted' });
    // seq n+2: re-entry, trusted again, 11:00, delivered in the same 12:00 batch.
    await landed({ bandId: a, kind: 'entry', lane: 'A', stamp: bkk(DAY, '11:00'), receivedAt: bkk(DAY, '12:00'), trust: 'trusted' });
    const after = await count('13:00');
    expect(after.adults - base.adults, 'the re-entered adult is inside').toBe(1);
    expect(after.kids - base.kids, 'their child is inside').toBe(1);
  });

  it('untrusted entry, trusted exit, untrusted exit-again with a smaller band_event id: the family is OUT', async () => {
    const base = await count('13:00');
    const s = await sell(1, 1);
    const a = s.adults[0]!;
    // Mint the last passage's id FIRST, so on an effective-time tie the id tie-break picks the wrong one.
    const smallId = newId();
    await new Promise((r) => setTimeout(r, 5));
    await landed({ bandId: a, kind: 'entry', lane: 'A', stamp: bkk(DAY, '06:00'), receivedAt: bkk(DAY, '12:00'), trust: 'untrusted' });
    await landed({ bandId: a, kind: 'entry', lane: 'A', stamp: bkk(DAY, '11:40'), receivedAt: bkk(DAY, '12:00'), trust: 'trusted' });
    await landed({ bandId: a, kind: 'exit', lane: 'A', stamp: bkk(DAY, '06:10'), receivedAt: bkk(DAY, '12:00'), trust: 'untrusted', id: smallId });
    const after = await count('13:00');
    expect(after.adults - base.adults, 'the adult whose last lane passage is an exit is out').toBe(0);
    expect(after.kids - base.kids, 'and their child with them').toBe(0);
  });
});

describe('final (2) — two boxes, two lanes, skewed clocks order by effective time', () => {
  it('trusted entry at lane A, exit at lane B whose clock is 2 h behind (received later): OUT', async () => {
    const base = await count('11:00');
    const s = await sell(1, 1);
    const a = s.adults[0]!;
    await landed({ bandId: a, kind: 'entry', lane: 'A', stamp: bkk(DAY, '10:00'), receivedAt: bkk(DAY, '10:00'), trust: 'trusted' });
    await landed({ bandId: a, kind: 'exit', lane: 'B', stamp: bkk(DAY, '08:30'), receivedAt: bkk(DAY, '10:30'), trust: 'skewed' });
    expect((await count('10:15')).adults - base.adults, 'inside before the exit reached the cloud').toBe(1);
    const after = await count('11:00');
    expect(after.adults - base.adults).toBe(0);
    expect(after.kids - base.kids).toBe(0);
  });

  it('entry at lane B whose clock runs 3 h ahead, then trusted exit at lane A: OUT (raw stamps say in)', async () => {
    const base = await count('11:00');
    const s = await sell(1, 1);
    const a = s.adults[0]!;
    await landed({ bandId: a, kind: 'entry', lane: 'B', stamp: bkk(DAY, '13:05'), receivedAt: bkk(DAY, '10:05'), trust: 'skewed' });
    await landed({ bandId: a, kind: 'exit', lane: 'A', stamp: bkk(DAY, '10:20'), receivedAt: bkk(DAY, '10:21'), trust: 'trusted' });
    const after = await count('11:00');
    expect(after.adults - base.adults).toBe(0);
    expect(after.kids - base.kids).toBe(0);
  });

  it('exit at lane A trusted, re-entry at lane B untrusted (stamp behind) later: IN', async () => {
    const base = await count('12:00');
    const s = await sell(1, 1);
    const a = s.adults[0]!;
    await landed({ bandId: a, kind: 'entry', lane: 'A', stamp: bkk(DAY, '10:00'), receivedAt: bkk(DAY, '10:00'), trust: 'trusted' });
    await landed({ bandId: a, kind: 'exit', lane: 'A', stamp: bkk(DAY, '10:30'), receivedAt: bkk(DAY, '10:30'), trust: 'trusted' });
    await landed({ bandId: a, kind: 'entry', lane: 'B', stamp: bkk(DAY, '06:00'), receivedAt: bkk(DAY, '11:00'), trust: 'untrusted' });
    const after = await count('12:00');
    expect(after.adults - base.adults).toBe(1);
    expect(after.kids - base.kids).toBe(1);
  });
});
