import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { paymentAttempt, printJob, stationDevice } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type AgentFetch, type BoxAgent } from '@oto/box-agent';
import { newId } from '@oto/shared';
import { provisionVirtualBox } from '../src/services/box';
import { boxStoreFor } from '../src/lib/box-store';
import { routeOnBox } from '../src/services/print';
import { ADMIN, boxBySlot, createTestContext, signInAs, takeStation, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-737 review: a new counter must print its first sale on the printers
 * committed by the create request, even between the box's config pulls.
 * HIGH if the normal command tick skips an assigned printer. Fix the stale
 * configuration boundary; do not retry the sale or rewrite old print jobs.
 * The second case is a control with an explicit config pull, not the fix.
 */
let ctx: TestContext;
let agent: BoxAgent;
let admin: string;
let boxId: string;
let branchId: string;
let productId: string;
let devices: Array<{ deviceId: string; role: 'receipt' | 'kitchen' }>;
let ordinal = 0;

const send = (method: 'POST' | 'GET', url: string, payload?: Record<string, unknown>) =>
  ctx.app.inject({ method, url, headers: { cookie: admin }, ...(payload ? { payload } : {}) });

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const box = await boxBySlot(ctx.db, 'virtual-1');
  boxId = box.id;
  branchId = box.branchId;
  const stations = await send('GET', `/branches/${branchId}/stations`);
  expect(stations.statusCode).toBe(200);
  const source = stations.json().stations.find((s: { boxId: string; codePrefix: string }) => s.boxId === boxId && s.codePrefix === 'T1');
  expect(source).toBeDefined();
  devices = source.devices.filter((d: { role: string }) => ['receipt', 'kitchen'].includes(d.role))
    .map((d: { deviceId: string; role: 'receipt' | 'kitchen' }) => ({ deviceId: d.deviceId, role: d.role }));
  expect(devices).toHaveLength(2);
  const category = await send('POST', '/menu/categories', {
    name: 'ZZ TEST SCRUM-737 food', taxableCategory: 'fnb', defaultPrepStation: 'kitchen',
  });
  expect(category.statusCode).toBe(200);
  const product = await send('POST', `/branches/${branchId}/menu/products`, {
    name: 'ZZ TEST SCRUM-737 item', kind: 'menu', categoryId: category.json().id,
    priceSatang: 100, priceWeekendSatang: 100, stockLinks: [], active: true,
  });
  expect(product.statusCode).toBe(200);
  productId = product.json().id;
  const transport: AgentFetch = async (url, init) => {
    const res = await ctx.app.inject({
      method: init.method as 'GET', url: url.replace(/^https?:\/\/[^/]+/, ''),
      headers: init.headers, payload: init.body,
    });
    return {
      status: res.statusCode, json: async () => res.body ? JSON.parse(res.body) : null,
      text: async () => res.body,
      header: (name) => { const value = res.headers[name.toLowerCase()]; return typeof value === 'string' ? value : null; },
    };
  };
  agent = createBoxAgent({
    apiBaseUrl: 'http://s737.test', credentials: memoryCredentialStore(),
    hostname: 'ZZ TEST SCRUM-737 agent', fetch: transport,
    claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
    printing: { retryDelayMs: 0 }, store: boxStoreFor(ctx.db),
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
}, 180_000);

afterAll(async () => { agent?.stop(); await ctx?.close(); await teardownAll(); });

async function firstCashSale(refresh: boolean) {
  ordinal += 1;
  const created = await send('POST', `/branches/${branchId}/stations`, {
    name: `ZZ TEST SCRUM-737 till ${ordinal}`, kind: 'till', boxId,
    codePrefix: `Z737${ordinal}`, accessScope: 'all_staff', devices,
    paymentRouting: { card: 'manual', qr: 'none' },
  });
  expect(created.statusCode).toBe(200);
  const stationId = created.json().station.id as string;
  expect(created.json().station.devices.map((d: { role: string }) => d.role).sort()).toEqual(['kitchen', 'receipt']);
  expect(agent.config()?.stations.some(s => s.id === stationId)).toBe(false);
  const assigned = await ctx.db.select().from(stationDevice).where(eq(stationDevice.stationId, stationId));
  expect(assigned).toHaveLength(2);
  for (const device of devices) expect(await routeOnBox(ctx.db, boxId, device.role, stationId)).toEqual({ deviceId: device.deviceId, stationId });
  await takeStation(ctx.app, admin, stationId);
  const saleId = newId();
  const sale = await send('POST', '/sales', {
    id: saleId, stationId, branchId, channel: 'fnb', pickupCode: '37', lines: [],
    items: [{ id: newId(), productId, quantity: 1, modifiers: [] }],
  });
  expect(sale.statusCode).toBe(200);
  const finalised = await send('POST', `/sales/${saleId}/finalise`, { method: 'cash', cashReceivedSatang: 100 });
  expect(finalised.statusCode).toBe(200);
  const jobs = finalised.json().printing.jobs as Array<{ id: string; kind: string; status: string; deviceId: string }>;
  expect(jobs.map(j => j.kind)).toEqual(['receipt', 'kitchen_ticket']);
  expect(jobs.every(j => j.status === 'queued' && devices.some(d => d.deviceId === j.deviceId))).toBe(true);
  if (refresh) await agent.syncConfig();
  await agent.runPendingCommands();
  const rows = await ctx.db.select().from(printJob).where(inArray(printJob.id, jobs.map(j => j.id)));
  const paid = await ctx.db.select().from(paymentAttempt).where(and(eq(paymentAttempt.saleId, saleId), eq(paymentAttempt.status, 'approved')));
  expect(paid.map(p => ({ method: p.method, amount: p.amountSatang }))).toEqual([{ method: 'cash', amount: 100 }]);
  console.info(JSON.stringify({ case: refresh ? 'fresh-config-control' : 'first-command-before-config-pull',
    assignmentsCommitted: assigned.length, cloudJobs: jobs.map(j => ({ kind: j.kind, status: j.status })),
    finalJobs: rows.map(j => ({ kind: j.kind, status: j.status, errorCode: j.errorCode, attempts: j.attempts })), cashAttempts: paid.length }));
  return rows;
}

describe('new station first cash sale through the real API and box agent', () => {
  it('HIGH: prints both assigned jobs when the command tick precedes the next config pull', async () => {
    const rows = await firstCashSale(false);
    expect(rows.map(j => j.status)).toEqual(['printed', 'printed']);
  });
  it('control: prints both jobs after the agent explicitly refreshes its configuration', async () => {
    const rows = await firstCashSale(true);
    expect(rows.map(j => j.status)).toEqual(['printed', 'printed']);
  });
});
