import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { auditLog, box, device } from '@oto/db';
import { boxCredential, type BoxConfigBundle } from '@oto/box-agent';
import {
  ADMIN,
  boxBySlot,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { issueClaimCode } from '../src/services/box';

/**
 * SCRUM-700 — the counter box reads the USB scanner itself.
 *
 * The api's half of it is small and has to be exactly right: a scanner row on
 * a box says which USB device it is and how the box reads it
 * (`settings.scanner`: mode, vendor and product ids, an optional path), that
 * row reaches the box in its config bundle like a printer's settings do, and
 * what the box then says about the scanner — does it see the cradle, has it
 * open, when the last code came through — is kept beside the row for the
 * Console's device panel.
 */

let ctx: TestContext;
let adminCookie: string;
let boxId: string;
let branchId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const b = await boxBySlot(ctx.db, 'virtual-1');
  boxId = b.id;
  branchId = b.branchId;
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

interface Injected {
  statusCode: number;
  body: Record<string, unknown>;
}

async function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  opts: { cookie?: string; payload?: unknown; headers?: Record<string, string> } = {},
): Promise<Injected> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    ...(opts.payload === undefined ? {} : { payload: opts.payload as never }),
  });
  let body: Record<string, unknown> = {};
  try {
    body = res.json() as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { statusCode: res.statusCode, body };
}

const errorCode = (res: Injected): string | undefined =>
  (res.body.error as { code?: string } | undefined)?.code;

const settingsOf = (res: Injected): unknown => (res.body.device as { settings: unknown }).settings;

/** Register the seeded box and return the bearer credential it was given. */
async function registerBox(): Promise<string> {
  const { code: claimCode } = await issueClaimCode(ctx.db, boxId);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/register',
    payload: { claimCode, agentVersion: '0.1.0', hostname: 'zz-test-scanner-box' },
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { boxId: string; secret: string };
  return boxCredential(body.boxId, body.secret);
}

let heartbeatClock = Date.now();
function nextReportedAt(): string {
  heartbeatClock = Math.max(Date.now(), heartbeatClock + 1000);
  return new Date(heartbeatClock).toISOString();
}

describe('a scanner the box reads itself (SCRUM-700)', () => {
  let scannerId: string;
  let stationId: string;

  it('is declared on the box with its mode and USB ids, read back on the answer and the list, and audited', async () => {
    const made = await call('POST', `/boxes/${boxId}/devices`, {
      cookie: adminCookie,
      payload: {
        kind: 'scanner',
        label: 'ZZ TEST Counter scanner',
        transport: 'usb',
        model: 'Zebra DS2278 (CR2278-PC cradle)',
        protocol: 'hid',
        settings: { scanner: { mode: 'hid', vendorId: '05E0', productId: '1200' } },
      },
    });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(200);
    expect(settingsOf(made)).toEqual({
      scanner: { mode: 'hid', vendorId: '05E0', productId: '1200' },
    });
    scannerId = (made.body.device as { id: string }).id;

    const listed = await call('GET', `/boxes/${boxId}/devices`, { cookie: adminCookie });
    expect(listed.statusCode).toBe(200);
    const row = (listed.body.devices as Array<{ id: string; kind: string; settings: unknown }>).find(
      (d) => d.id === scannerId,
    );
    expect(row?.kind).toBe('scanner');
    expect(row?.settings).toEqual({ scanner: { mode: 'hid', vendorId: '05E0', productId: '1200' } });

    const [recorded] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'device.create'), eq(auditLog.entityId, scannerId)))
      .limit(1);
    expect((recorded?.after as { settings?: unknown } | null)?.settings).toEqual({
      scanner: { mode: 'hid', vendorId: '05E0', productId: '1200' },
    });
  });

  it('is switched to serial (CDC) with a path, and the edit is audited with both sides', async () => {
    const edited = await call('PATCH', `/devices/${scannerId}`, {
      cookie: adminCookie,
      payload: {
        settings: {
          scanner: { mode: 'cdc', vendorId: '05e0', productId: '1701', devicePath: '/dev/ttyACM0' },
        },
      },
    });
    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
    expect(settingsOf(edited)).toEqual({
      scanner: { mode: 'cdc', vendorId: '05e0', productId: '1701', devicePath: '/dev/ttyACM0' },
    });
    const [recorded] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'device.update'), eq(auditLog.entityId, scannerId)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect((recorded?.before as { settings?: { scanner?: { mode?: string } } } | null)?.settings?.scanner?.mode).toBe('hid');
    expect((recorded?.after as { settings?: { scanner?: { mode?: string } } } | null)?.settings?.scanner?.mode).toBe('cdc');
  });

  it('refuses a USB id that is not four hex digits, and a key the box would not read, with 400 and no change', async () => {
    for (const scanner of [
      { mode: 'hid', vendorId: '5e0' },
      { mode: 'hid', productId: 'zz00' },
      { mode: 'serial' },
      // `.strict()`: a typo is refused at the edit, not discovered at a counter.
      { mode: 'hid', vendor: '05e0' },
    ]) {
      const res = await call('PATCH', `/devices/${scannerId}`, {
        cookie: adminCookie,
        payload: { settings: { scanner } },
      });
      expect(res.statusCode, JSON.stringify(scanner)).toBe(400);
      expect(errorCode(res)).toBe('VALIDATION');
    }
    const [row] = await ctx.db
      .select({ settings: device.settings })
      .from(device)
      .where(eq(device.id, scannerId))
      .limit(1);
    expect((row?.settings as { scanner?: { mode?: string } } | null)?.scanner?.mode).toBe('cdc');
  });

  it('rides the box’s config bundle on the station it is the scanner for, settings and all', async () => {
    const made = await call('POST', `/branches/${branchId}/stations`, {
      cookie: adminCookie,
      payload: {
        name: 'ZZ TEST Scanner till',
        kind: 'till',
        boxId,
        codePrefix: 'Z7',
        capabilities: ['tickets'],
        accessScope: 'all_staff',
        staffAccountIds: [],
        devices: [{ role: 'scanner', deviceId: scannerId }],
      },
    });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(200);
    stationId = (made.body.station as { id: string }).id;

    const credential = await registerBox();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/config',
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(res.statusCode).toBe(200);
    const bundle = res.json() as BoxConfigBundle;
    const onStation = bundle.stations.find((s) => s.id === stationId);
    expect(onStation, 'the new station is in the bundle').toBeTruthy();
    const scanner = onStation!.devices.find((d) => d.role === 'scanner');
    expect(scanner).toMatchObject({
      id: scannerId,
      kind: 'scanner',
      transport: 'usb',
      settings: {
        scanner: { mode: 'cdc', vendorId: '05e0', productId: '1701', devicePath: '/dev/ttyACM0' },
      },
    });
  });

  it('keeps what the box says about the scanner beside its row, for the Console', async () => {
    const credential = await registerBox();
    const lastScanAt = new Date(Date.now() - 30_000).toISOString();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/heartbeat',
      headers: { authorization: `Bearer ${credential}` },
      payload: {
        reportedAt: nextReportedAt(),
        agentVersion: '0.1.0',
        devices: [
          {
            id: scannerId,
            kind: 'scanner',
            reachability: 'reachable',
            scanner: {
              mode: 'cdc',
              present: true,
              open: true,
              path: '/dev/ttyACM0',
              lastScanAt,
              scans: 3,
              dropped: 1,
            },
          },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { devicesMatched: number }).devicesMatched).toBe(1);

    const [row] = await ctx.db.select().from(box).where(eq(box.id, boxId)).limit(1);
    const reported = (row!.lastStatus as { devices: Array<Record<string, unknown>> }).devices.find(
      (d) => d.id === scannerId,
    );
    expect(reported).toMatchObject({
      kind: 'scanner',
      reachability: 'reachable',
      scanner: { mode: 'cdc', present: true, open: true, path: '/dev/ttyACM0', lastScanAt, scans: 3, dropped: 1 },
    });
    const [scannerRow] = await ctx.db.select().from(device).where(eq(device.id, scannerId)).limit(1);
    expect(scannerRow?.reachability).toBe('reachable');
    expect(scannerRow?.lastSeenAt).not.toBeNull();

    // A scanner the box cannot see: the fault is the row's last error, and the
    // block says so in three facts rather than one word.
    const gone = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/heartbeat',
      headers: { authorization: `Bearer ${credential}` },
      payload: {
        reportedAt: nextReportedAt(),
        agentVersion: '0.1.0',
        devices: [
          {
            id: scannerId,
            kind: 'scanner',
            reachability: 'unreachable',
            lastError: 'No scanner with USB id 05e0:1701 is plugged into this box',
            scanner: { mode: 'cdc', present: false, open: false, path: null, lastScanAt },
          },
        ],
      },
    });
    expect(gone.statusCode, gone.body).toBe(200);
    const [after] = await ctx.db.select().from(device).where(eq(device.id, scannerId)).limit(1);
    expect(after?.reachability).toBe('unreachable');
    expect(after?.lastError).toBe('No scanner with USB id 05e0:1701 is plugged into this box');
    const [boxRow] = await ctx.db.select().from(box).where(eq(box.id, boxId)).limit(1);
    const latest = (boxRow!.lastStatus as { devices: Array<Record<string, unknown>> }).devices.find(
      (d) => d.id === scannerId,
    );
    expect(latest?.scanner).toEqual({ mode: 'cdc', present: false, open: false, path: null, lastScanAt });
  });

  it('accepts a heartbeat from an agent that sends no scanner block, as before', async () => {
    const credential = await registerBox();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/heartbeat',
      headers: { authorization: `Bearer ${credential}` },
      payload: {
        reportedAt: nextReportedAt(),
        agentVersion: '0.1.0',
        devices: [{ id: scannerId, kind: 'scanner', reachability: 'unknown' }],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await ctx.db.select().from(box).where(eq(box.id, boxId)).limit(1);
    const reported = (row!.lastStatus as { devices: Array<Record<string, unknown>> }).devices.find(
      (d) => d.id === scannerId,
    );
    expect(reported).toBeTruthy();
    expect('scanner' in reported!).toBe(false);
  });
});
