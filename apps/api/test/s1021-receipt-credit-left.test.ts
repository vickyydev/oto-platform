import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branch, printJob, product, station, ticketPackage } from '@oto/db';
import { RECEIPT_CREDIT_LEFT_LABEL, RECEIPT_CREDIT_LEFT_LABEL_TH, formatTHB, newId } from '@oto/shared';
import { buildPrintDocument } from '../src/services/sale-printing';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-1021 — THE CREDIT LEFT ON THE RECEIPT (the owner's answer of 19
 * November 2026: every food and shop receipt paid from a band, in whole or
 * in part, prints the credit left on that band). Pinned through the routes
 * the till calls and the print job the box fetches: the figure is the band's
 * balance right after the sale, named by the band's short code, in English
 * and Thai; a receipt paid without a band prints none.
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
let reception: string;
let operatorId: string;
let stationId: string;
let twoHoursId: string;
let friesId: string;

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, hkt!.id), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const pkgs = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, hkt!.id));
  twoHoursId = pkgs.find((p) => p.name === '2 Hours Play')!.id;
  const [fries] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, 'FB-FRIES'), isNull(product.archivedAt)));
  friesId = fries!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function finalise(saleId: string, payload: Record<string, unknown>) {
  const res = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** An adult on 2 Hours Play: their ticket's credit on a wallet on their band. */
async function adultWithCredit(): Promise<{ qrCode: string; bandShortCode: string; creditSatang: number }> {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, lines: [{ id: newId(), packageId: twoHoursId, kids: 0, adults: 1 }] },
  });
  expect(res.statusCode, res.body).toBe(200);
  const done = await finalise(saleId, {});
  const [grant] = done.grants as { qrCode: string; bandShortCode: string | null; creditSatang: number }[];
  expect(grant!.bandShortCode).toBeTruthy();
  return { qrCode: grant!.qrCode, bandShortCode: grant!.bandShortCode!, creditSatang: grant!.creditSatang };
}

async function friesOrder(quantity: number): Promise<{ saleId: string; owed: number }> {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, channel: 'fnb', pickupCode: '21', items: [{ id: newId(), productId: friesId, quantity }] },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { saleId, owed: res.json().sale.totals.grossSatang as number };
}

async function receiptOf(done: { printing: { jobs: { id: string; kind: string }[] } }) {
  const job = done.printing.jobs.find((j) => j.kind === 'receipt')!;
  const [row] = await ctx.db.select().from(printJob).where(eq(printJob.id, job.id));
  const doc = await buildPrintDocument(ctx.db, { boxId: row!.boxId, operatorId }, job.id);
  return doc.job.data as { creditLeft?: { label: string; amount: string; detail?: string }[] };
}

describe('SCRUM-1021 — a food receipt paid from a band prints the credit left on it', () => {
  it('paid in full from the band: the band’s balance after the sale, its short code, in English and Thai', async () => {
    const adult = await adultWithCredit();
    const { saleId, owed } = await friesOrder(1);
    expect(owed).toBeLessThan(adult.creditSatang);
    const done = await finalise(saleId, { wallet: { key: adult.qrCode, useCredit: true }, actionId: newId() });
    expect(done.finalised).toBe(true);
    const receipt = await receiptOf(done);
    expect(receipt.creditLeft).toEqual([
      { label: RECEIPT_CREDIT_LEFT_LABEL, amount: formatTHB(adult.creditSatang - owed), detail: `เครดิตคงเหลือ · Band ${adult.bandShortCode}` },
    ]);
    expect(RECEIPT_CREDIT_LEFT_LABEL).toBe('Credit left');
    expect(RECEIPT_CREDIT_LEFT_LABEL_TH).toBe('เครดิตคงเหลือ');
  });

  it('paid in part from the band and the rest in cash: the band left at ฿0', async () => {
    const adult = await adultWithCredit();
    const { saleId, owed } = await friesOrder(Math.ceil(adult.creditSatang / 9_000) + 1);
    expect(owed).toBeGreaterThan(adult.creditSatang);
    const first = await finalise(saleId, { wallet: { key: adult.qrCode, useCredit: true }, actionId: newId() });
    expect(first.finalised).toBe(false);
    const done = await finalise(saleId, { method: 'cash', kind: 'cash', tenderedSatang: owed, actionId: newId() });
    expect(done.finalised).toBe(true);
    expect((await receiptOf(done)).creditLeft).toEqual([
      { label: RECEIPT_CREDIT_LEFT_LABEL, amount: '฿0', detail: `${RECEIPT_CREDIT_LEFT_LABEL_TH} · Band ${adult.bandShortCode}` },
    ]);
  });

  it('a food receipt paid without a band prints no credit line', async () => {
    const { saleId, owed } = await friesOrder(1);
    const done = await finalise(saleId, { method: 'cash', kind: 'cash', tenderedSatang: owed, actionId: newId() });
    expect((await receiptOf(done)).creditLeft).toBeUndefined();
  });
});
