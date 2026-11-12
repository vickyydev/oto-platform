import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, device, station, stationDevice } from '@oto/db';
import { newId } from '@oto/shared';
import { printerReading } from '../src/services/printer-reading';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-952 point 6 — A PRINTER WITH NO ADDRESS IS NOT READ AS HEALTHY.
 *
 * Seen in the SCRUM-930 staging proof (pictures 11a, 11b): the seeded
 * Receipt Printer 1 at Robinson Chalong had no address, and the platform's
 * reading of it still said "reachable" and "paper ok" — what the seed wrote
 * and no box ever corrected. Only the Console's box drawer, which looks at
 * the address itself, showed it as not set up.
 *
 * The platform now reads such a printer the way its box does on every
 * heartbeat (`probeAll` in `packages/box-agent/src/printing/queue.ts`):
 * nothing known of its reachability or paper, and `DEVICE_NO_ADDRESS` as its
 * last error — on the box's device list, the station's printers (the till's
 * light) and the Health page's boxes. A printer WITH an address reads exactly
 * what its row says, as before.
 *
 * The printer is written straight to the table, as the seed wrote Chalong's:
 * the api refuses to save a printer without an address (SCRUM-899, SCRUM-932).
 */

let ctx: TestContext;
let admin: string;
let boxId: string;
let tillId: string;
let branchId: string;
let operatorId: string;
let bareId: string;

const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie: admin } });

const NOT_SET_UP = { reachability: 'unknown', paperStatus: 'unknown', lastError: 'DEVICE_NO_ADDRESS' };

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  tillId = till!.id;
  boxId = till!.boxId!;

  bareId = newId();
  // As the seed left Chalong's: no address, and a reading nobody ever corrected.
  await ctx.db.insert(device).values({
    id: bareId,
    operatorId,
    branchId,
    boxId,
    kind: 'receipt_printer',
    label: 'ZZ TEST SCRUM-952 printer without an address',
    transport: 'simulated',
    protocol: 'escpos',
    reachability: 'reachable',
    paperStatus: 'ok',
    lastSeenAt: new Date(),
  });
  // On the till, where its light reads it: the bar role is free on the seeded T1.
  await ctx.db.insert(stationDevice).values({ id: newId(), stationId: tillId, role: 'bar', deviceId: bareId });
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** Every seeded printer on the box with an address, as its row has it. */
async function addressedRows() {
  const rows = await ctx.db.select().from(device).where(eq(device.boxId, boxId));
  return rows.filter((r) => r.kind.endsWith('printer') && r.address);
}

describe('SCRUM-952 — the platform reads a printer with no address as not set up', () => {
  it('the box’s device list: not set up, never "reachable" and "paper ok"', async () => {
    const res = await get(`/boxes/${boxId}/devices`);
    expect(res.statusCode, res.body).toBe(200);
    const devices = res.json().devices as Array<Record<string, unknown>>;
    expect(devices.find((d) => d.id === bareId)).toMatchObject({ address: null, ...NOT_SET_UP });

    const addressed = await addressedRows();
    expect(addressed.length).toBeGreaterThan(0);
    for (const row of addressed) {
      expect(devices.find((d) => d.id === row.id), row.label).toMatchObject({
        reachability: row.reachability,
        paperStatus: row.paperStatus,
        lastError: row.lastError,
      });
    }
  });

  it('the station’s printers, which the till’s light reads: "no address set", the others as before', async () => {
    const res = await get(`/stations/${tillId}/printers`);
    expect(res.statusCode, res.body).toBe(200);
    const printers = res.json().printers as Array<Record<string, unknown>>;
    expect(printers.find((p) => p.deviceId === bareId)).toMatchObject({ role: 'bar', ...NOT_SET_UP });
    const receipt = printers.find((p) => p.role === 'receipt')!;
    const [row] = await ctx.db.select().from(device).where(eq(device.id, receipt.deviceId as string));
    expect(row!.address).toBeTruthy();
    expect(receipt).toMatchObject({ reachability: row!.reachability, paperStatus: row!.paperStatus, lastError: row!.lastError });
  });

  it('the Health page’s boxes: not set up, the addressed printers as before', async () => {
    const res = await get('/ops/health');
    expect(res.statusCode, res.body).toBe(200);
    const boxes = res.json().boxes as Array<{ id: string; devices: Array<Record<string, unknown>> }>;
    const mine = boxes.find((b) => b.id === boxId)!;
    expect(mine.devices.find((d) => d.id === bareId)).toMatchObject(NOT_SET_UP);
    for (const row of await addressedRows()) {
      expect(mine.devices.find((d) => d.id === row.id), row.label).toMatchObject({
        reachability: row.reachability,
        paperStatus: row.paperStatus,
        lastError: row.lastError,
      });
    }
  });

  it('an edit answers with the same reading; the audit keeps the row as it is', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/devices/${bareId}`,
      headers: { cookie: admin, 'idempotency-key': newId() },
      payload: { label: 'ZZ TEST SCRUM-952 printer without an address, renamed' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().device).toMatchObject({ address: null, ...NOT_SET_UP });
    const [audited] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'device.update'), eq(auditLog.entityId, bareId)));
    expect(audited!.after).toMatchObject({ reachability: 'reachable', paperStatus: 'ok' });
  });

  it('the reading itself: only a printer with no address is read anew', () => {
    const row = { reachability: 'reachable', paperStatus: 'ok', lastError: null };
    expect(printerReading({ ...row, kind: 'receipt_printer', address: null })).toEqual(NOT_SET_UP);
    expect(printerReading({ ...row, kind: 'band_printer', address: '   ' })).toEqual(NOT_SET_UP);
    expect(printerReading({ ...row, kind: 'kitchen_printer', address: '192.0.2.206:9100' })).toEqual(row);
    expect(printerReading({ ...row, kind: 'scanner', address: null })).toEqual(row);
    expect(printerReading({ reachability: 'unreachable', paperStatus: 'out', lastError: 'PRINTER_PAPER_OUT', kind: 'receipt_printer', address: '192.0.2.202:9100' }))
      .toEqual({ reachability: 'unreachable', paperStatus: 'out', lastError: 'PRINTER_PAPER_OUT' });
  });
});
