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
let spareReceiptId: string;
let devices: Array<{ deviceId: string; role: 'receipt' | 'kitchen' }>;
let ordinal = 0;
let configReads = 0;
let configFault: '503' | 'network' | null = null;

const send = (method: 'POST' | 'GET' | 'PATCH', url: string, payload?: Record<string, unknown>) =>
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
  const deviceList = await send('GET', `/boxes/${boxId}/devices`);
  const receipt = deviceList.json().devices.find((d: { id: string }) => d.id === devices.find(d => d.role === 'receipt')!.deviceId);
  const spare = await send('POST', `/boxes/${boxId}/devices`, {
    kind: receipt.kind, label: 'ZZ TEST SCRUM-737 spare receipt', transport: 'simulated',
    address: 's737-spare:9100', model: receipt.model, protocol: receipt.protocol, settings: receipt.settings,
  });
  expect(spare.statusCode, spare.body).toBe(200);
  spareReceiptId = spare.json().device.id;
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
    if (url.endsWith('/box/v1/config')) {
      configReads += 1;
      if (configFault === 'network') throw new Error('ZZ TEST unavailable configuration connection');
      if (configFault === '503') return { status: 503, json: async () => null, text: async () => '' };
    }
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

async function firstCashSale(options: {
  refresh?: boolean; unassigned?: boolean; removeAfterQueue?: boolean; swapBeforeSale?: boolean;
  configFault?: typeof configFault;
} = {}) {
  ordinal += 1;
  const requested = options.unassigned ? [] : devices;
  const created = await send('POST', `/branches/${branchId}/stations`, {
    name: `ZZ TEST SCRUM-737 till ${ordinal}`, kind: 'till', boxId,
    codePrefix: `Z737${ordinal}`, accessScope: 'all_staff', devices: requested,
    paymentRouting: { card: 'manual', qr: 'none' },
  });
  expect(created.statusCode).toBe(200);
  const stationId = created.json().station.id as string;
  expect(created.json().station.devices.map((d: { role: string }) => d.role).sort()).toEqual(requested.map(d => d.role).sort());
  expect(agent.config()?.stations.some(s => s.id === stationId)).toBe(false);
  const assigned = await ctx.db.select().from(stationDevice).where(eq(stationDevice.stationId, stationId));
  expect(assigned).toHaveLength(requested.length);
  for (const device of requested) expect(await routeOnBox(ctx.db, boxId, device.role, stationId)).toEqual({ deviceId: device.deviceId, stationId });
  if (options.swapBeforeSale) {
    await agent.syncConfig();
    const changed = await send('PATCH', `/stations/${stationId}`, {
      devices: devices.map(d => ({ ...d, deviceId: d.role === 'receipt' ? spareReceiptId : d.deviceId })),
    });
    expect(changed.statusCode).toBe(200);
  }
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
  expect(jobs.every(j => options.unassigned ? j.status === 'skipped'
    : j.status === 'queued' && (devices.some(d => d.deviceId === j.deviceId) || j.deviceId === spareReceiptId))).toBe(true);
  if (options.refresh) await agent.syncConfig();
  if (options.removeAfterQueue) {
    const changed = await send('PATCH', `/stations/${stationId}`, { devices: [] });
    expect(changed.statusCode).toBe(200);
  }
  const readsBeforeCommand = configReads;
  const printed = () => [...devices.map(d => d.deviceId), spareReceiptId].map(id => agent.printing()!.printouts(id).length);
  const beforePrintouts = printed();
  configFault = options.configFault ?? null;
  try { await agent.runPendingCommands(); } finally { configFault = null; }
  const commandConfigReads = configReads - readsBeforeCommand;
  const rows = await ctx.db.select().from(printJob).where(inArray(printJob.id, jobs.map(j => j.id)));
  // A later ordinary command poll never sends another receipt or charges again.
  const printouts = printed();
  if (options.configFault || options.unassigned || options.removeAfterQueue) expect(printouts).toEqual(beforePrintouts);
  else expect(printouts.reduce((a, n) => a + n, 0) - beforePrintouts.reduce((a, n) => a + n, 0)).toBe(2);
  await agent.runPendingCommands();
  expect(printed()).toEqual(printouts);
  const paid = await ctx.db.select().from(paymentAttempt).where(and(eq(paymentAttempt.saleId, saleId), eq(paymentAttempt.status, 'approved')));
  expect(paid.map(p => ({ method: p.method, amount: p.amountSatang }))).toEqual([{ method: 'cash', amount: 100 }]);
  console.info(JSON.stringify({ options, commandConfigReads,
    assignmentsCommitted: assigned.length, cloudJobs: jobs.map(j => ({ kind: j.kind, status: j.status })),
    finalJobs: rows.map(j => ({ kind: j.kind, status: j.status, errorCode: j.errorCode, attempts: j.attempts })), cashAttempts: paid.length }));
  return { rows, jobs, commandConfigReads };
}

describe('new station first cash sale through the real API and box agent', () => {
  it('HIGH: prints both assigned jobs when the command tick precedes the next config pull', async () => {
    const { rows, commandConfigReads } = await firstCashSale();
    expect(rows.map(j => j.status)).toEqual(['printed', 'printed']);
    expect(rows.map(j => j.attempts)).toEqual([1, 1]);
    expect(commandConfigReads).toBe(1);
  });
  it('control: prints both jobs after the agent explicitly refreshes its configuration', async () => {
    const { rows, commandConfigReads } = await firstCashSale({ refresh: true });
    expect(rows.map(j => j.status)).toEqual(['printed', 'printed']);
    expect(commandConfigReads).toBe(0);
  });
  it('HIGH: refreshes an existing station whose assigned printer changed before the sale', async () => {
    const { rows, jobs, commandConfigReads } = await firstCashSale({ swapBeforeSale: true });
    expect(rows.every(row => row.status === 'printed' && row.deviceId === jobs.find(j => j.id === row.id)?.deviceId)).toBe(true);
    expect(commandConfigReads).toBe(1);
  });
  it.each(['503', 'network'] as const)('HIGH: a %s config failure sends no paper and reports failure, not a missing role', async (fault) => {
    const { rows, commandConfigReads } = await firstCashSale({ configFault: fault });
    expect(rows.map(j => ({ status: j.status, errorCode: j.errorCode, attempts: j.attempts }))).toEqual([
      { status: 'failed', errorCode: 'CONFIG_UNAVAILABLE', attempts: 0 },
      { status: 'failed', errorCode: 'CONFIG_UNAVAILABLE', attempts: 0 },
    ]);
    expect(commandConfigReads).toBe(2);
  });
  it('MEDIUM: the freshly read assignments win if printers were deliberately removed after queuing', async () => {
    const { rows } = await firstCashSale({ removeAfterQueue: true });
    expect(rows.map(j => ({ status: j.status, errorCode: j.errorCode }))).toEqual([
      { status: 'skipped', errorCode: 'NO_DEVICE_FOR_ROLE' },
      { status: 'skipped', errorCode: 'NO_DEVICE_FOR_ROLE' },
    ]);
  });
  it('MEDIUM: a till created without printers keeps its intentional skips and does not borrow another till printer', async () => {
    const { rows, commandConfigReads } = await firstCashSale({ unassigned: true });
    expect(rows.map(j => ({ status: j.status, attempts: j.attempts }))).toEqual([
      { status: 'skipped', attempts: 0 }, { status: 'skipped', attempts: 0 },
    ]);
    expect(commandConfigReads).toBe(0);
  });
});
