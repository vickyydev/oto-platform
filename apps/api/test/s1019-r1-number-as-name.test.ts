import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, member, printJob, station, ticketPackage } from '@oto/db';
import { nameIsPhoneNumber, newId, phoneAsName } from '@oto/shared';
import { buildPrintDocument } from '../src/services/sale-printing';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-1019, R1 — A NUMBER GIVEN WITH NO NAME, through the real routes (the
 * owner's answer of 19 November 2026, docs/progress/plans/dropoff-beo-20261119/
 * ANSWERS.md §8): the customer is made with the number itself as the name
 * until a name is given.
 *
 * - The till's create carries the number, as the till shows one, as the
 *   name: no new field, no new rule on the platform; the same number is one
 *   member, as before.
 * - A name given later replaces it as any name edit does, audited.
 * - The receipt and an adult's band print no number in the name's place.
 *
 * Demo data only: every number and name below is a ZZ TEST fixture.
 */

const STORAGE_ENV = {
  MINIO_ENDPOINT: 'localhost',
  MINIO_PORT: '9000',
  MINIO_USE_SSL: 'false',
  MINIO_ACCESS_KEY: 'oto',
  MINIO_SECRET_KEY: 'otosecret123',
  MINIO_BUCKET: 'oto-files-test',
};

let ctx: TestContext;
let cookie: string;
let operatorId: string;
let stationId: string;
let twoHoursId: string;

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, hkt!.id), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const pkgs = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, hkt!.id));
  twoHoursId = pkgs.find((p) => p.name === '2 Hours Play')!.id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function create(phone: string, nickname: string): Promise<{ id: string; nickname: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/members',
    headers: { cookie, 'idempotency-key': newId() },
    payload: { id: newId(), phone, nickname },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().member;
}

/** One adult on 2 Hours Play for the member, paid in cash: its receipt and the adult's band, as the printer is sent them. */
async function paperOf(memberId: string): Promise<{ receipt: { memberNickname?: string }; band: { holderName?: string } }> {
  const saleId = newId();
  const rung = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: { id: saleId, stationId, memberId, lines: [{ id: newId(), packageId: twoHoursId, kids: 0, adults: 1 }] },
  });
  expect(rung.statusCode, rung.body).toBe(200);
  const owed = rung.json().sale.totals.grossSatang as number;
  const paid = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie },
    payload: { method: 'cash', kind: 'cash', tenderedSatang: owed, actionId: newId() },
  });
  expect(paid.statusCode, paid.body).toBe(200);
  const jobs = paid.json().printing.jobs as { id: string; kind: string; subjectType?: string }[];
  const docOf = async (job: { id: string } | undefined) => {
    expect(job).toBeTruthy();
    const [row] = await ctx.db.select().from(printJob).where(eq(printJob.id, job!.id));
    return (await buildPrintDocument(ctx.db, { boxId: row!.boxId, operatorId }, job!.id)).job.data as Record<string, unknown>;
  };
  return {
    receipt: await docOf(jobs.find((j) => j.kind === 'receipt')),
    band: await docOf(jobs.find((j) => j.subjectType === 'band')),
  };
}

describe('SCRUM-1019 R1 — a number given with no name is the name until one is given', () => {
  it('is created by the number as the till shows one, once, and found by it', async () => {
    const name = phoneAsName('0619191101')!;
    expect(name).toBe('+66 61 919 1101');
    const created = await create('0619191101', name);
    expect(created.nickname).toBe(name);
    expect(nameIsPhoneNumber(created.nickname)).toBe(true);
    const found = await ctx.app.inject({ method: 'GET', url: '/members/lookup?phone=061-919-1101', headers: { cookie } });
    expect(found.json().member.id).toBe(created.id);
    // The same number from another counter a moment later is that member, as before.
    const twice = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      headers: { cookie, 'idempotency-key': newId() },
      payload: { id: newId(), phone: '+66 61 919 1101', nickname: '+66 61 919 1101' },
    });
    expect(twice.statusCode, twice.body).toBe(409);
    expect(twice.json().error).toMatchObject({ code: 'MEMBER_PHONE_EXISTS', details: { memberId: created.id } });
    expect(await ctx.db.select().from(member).where(eq(member.phone, '+66619191101'))).toHaveLength(1);
  });

  it('a name given later replaces it as any name edit does, audited with both', async () => {
    const created = await create('0619191102', phoneAsName('0619191102')!);
    const named = await ctx.app.inject({
      method: 'PATCH',
      url: `/members/${created.id}`,
      headers: { cookie, 'idempotency-key': newId() },
      payload: { nickname: 'ZZ TEST R1 Mali' },
    });
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json().member.nickname).toBe('ZZ TEST R1 Mali');
    const logged = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'member'), eq(auditLog.entityId, created.id), eq(auditLog.action, 'member.update')));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.before).toMatchObject({ nickname: '+66 61 919 1102' });
    expect(logged[0]!.after).toMatchObject({ nickname: 'ZZ TEST R1 Mali' });
  });

  it('the receipt and the adult’s band print no number in the name’s place', async () => {
    const held = await create('0619191103', phoneAsName('0619191103')!);
    const paper = await paperOf(held.id);
    expect(paper.receipt.memberNickname).toBeUndefined();
    expect(paper.band.holderName).toBeUndefined();
    expect(JSON.stringify(paper)).not.toContain('919 1103');
  });

  it('a member with a name prints it, as before', async () => {
    const named = await create('0619191104', 'ZZ TEST R1 Ploy');
    const paper = await paperOf(named.id);
    expect(paper.receipt.memberNickname).toBe('ZZ TEST R1 Ploy');
    expect(paper.band.holderName).toBe('ZZ TEST R1 Ploy');
  });
});
