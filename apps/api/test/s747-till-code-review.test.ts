import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { branch, paymentAttempt, station, ticketPackage } from '@oto/db';
import { invoiceStationSegment, newId } from '@oto/shared';
import { ADMIN, CENTRAL_BRANCH_CODE, branchIdByCode, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-747 adversarial review. P1: a saved longer code fails when QR is pressed.
 * Keep the existing invoice shape and prove its shared counter, including a
 * deliberate compact-code collision and a legacy station sharing that segment.
 * The segment is not unique; the complete invoice must always be unique.
 */
let ctx: TestContext;
let cookie: string;
let branchId: string;
let boxId: string;
let packageId: string;

beforeAll(async () => {
  ctx = await createTestContext({ env: { PGW_PROVIDER: 'simulator', PGW_INVOICE_PREFIX: 'ZZ747' } });
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  expect((await ctx.db.select().from(branch).where(eq(branch.id, branchId)))[0]).toBeDefined();
  const box = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/boxes`, headers: { cookie },
    payload: { name: 'ZZ TEST SCRUM-747 virtual box', slot: 'zz-test-747', role: 'virtual' } });
  expect(box.statusCode, box.body).toBe(200);
  boxId = box.json().box.id;
  packageId = (await ctx.db.select().from(ticketPackage).where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play'))))[0]!.id;
}, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

async function till(codePrefix: string) {
  const response = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/stations`, headers: { cookie },
    payload: { name: `ZZ TEST SCRUM-747 ${codePrefix}`, kind: 'till', codePrefix, boxId,
      paymentRouting: { card: 'manual', qr: 'gateway' }, capabilities: [], accessScope: 'all_staff', staffAccountIds: [], devices: [] } });
  expect(response.statusCode, response.body).toBe(200);
  const saved = response.json().station;
  expect(saved.codePrefix).toBe(codePrefix);
  return saved.id as string;
}

async function unpaid(stationId: string) {
  const id = newId();
  const response = await ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie },
    payload: { id, stationId, lines: [{ id: newId(), packageId, kids: 1, adults: 1 }] } });
  expect(response.statusCode, response.body).toBe(200);
  return id;
}

const press = (saleId: string, actionId = newId()) => ctx.app.inject({ method: 'POST', url: '/payments/attempts',
  headers: { cookie, 'idempotency-key': `zz-test-${actionId}` }, payload: { saleId, actionId, tender: 'qr', method: 'promptpay', kind: 'qr' } });

describe('saved longer till codes open genuine simulator QR attempts', () => {
  it.each(['ZI7C', 'ZZ747A'])('saves %s and returns a QR, including an exact replay', async code => {
    const stationId = await till(code);
    const saleId = await unpaid(stationId);
    const actionId = newId();
    const first = await press(saleId, actionId);
    expect(first.statusCode, first.body).toBe(200);
    const shown = first.json();
    expect(shown).toMatchObject({ route: 'gateway', attempt: { provider: 'simulator', status: 'sent_to_terminal' } });
    expect(shown.qrPayload).toMatch(/^000201/);
    expect(shown.attempt.invoiceNo).toMatch(/^[A-Z0-9]{20}$/);
    expect(shown.attempt.invoiceNo.slice(5, 8)).toBe(invoiceStationSegment(code));
    expect(shown.expiresAt).not.toBeNull();
    const replay = await press(saleId, actionId);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().attempt.id).toBe(shown.attempt.id);
    expect(replay.json().attempt.invoiceNo).toBe(shown.attempt.invoiceNo);
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(1);
    expect((await ctx.db.select().from(station).where(eq(station.id, stationId)))[0]!.codePrefix).toBe(code);
  });

  it('serialises simultaneous long-code aliases and their legacy short-code alias', async () => {
    const seen = new Map<string, string>();
    let pair: [string, string, string] | undefined;
    for (let i = 0; i < 50_000; i += 1) {
      const code = `Z${i.toString(36).toUpperCase().padStart(5, '0')}`;
      const segment = invoiceStationSegment(code)!;
      expect(segment).toMatch(/^[A-Z0-9]{3}$/);
      if (seen.has(segment)) { pair = [seen.get(segment)!, code, segment]; break; }
      seen.set(segment, code);
    }
    expect(pair).toBeDefined();
    const [left, right, segment] = pair!;
    const stations = [await till(left), await till(right), await till(segment)];
    const sales = await Promise.all(stations.flatMap(id => [unpaid(id), unpaid(id)]));
    const responses = await Promise.all(sales.map(id => press(id)));
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    const invoices = responses.map(response => response.json().attempt.invoiceNo as string);
    expect(new Set(invoices).size).toBe(6);
    expect(new Set(invoices.map(value => value.slice(0, -6))).size).toBe(1);
    expect(invoices.map(value => Number(value.slice(-6))).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    const next = await press(await unpaid(stations[0]!));
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().attempt.invoiceNo).toBe(`${invoices[0]!.slice(0, -6)}000007`);
  });

  it('still refuses unsupported or booking-reserved station codes at save time', async () => {
    for (const codePrefix of ['TOOLONG', 'WEB']) {
      const response = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/stations`, headers: { cookie },
        payload: { name: 'ZZ TEST invalid till', kind: 'till', codePrefix, boxId, paymentRouting: { card: 'manual', qr: 'gateway' },
          capabilities: [], accessScope: 'all_staff', staffAccountIds: [], devices: [] } });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(ctx.smsLog).toEqual([]);
  });
});
