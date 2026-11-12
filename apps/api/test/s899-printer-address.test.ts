import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, device, station, stationDevice } from '@oto/db';
import { newId, parsePrinterAddress } from '@oto/shared';
import { parseAddress } from '@oto/box-agent';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-899 — A PRINTER IS SAVED WITH THE ADDRESS THE BOX PRINTS TO.
 *
 * Seen on staging in the SCRUM-861 proof: ZZ TEST printers declared
 * "simulated" with no address were accepted by the Console and the api, a till
 * was given one, and the box skipped every job routed to it
 * `DEVICE_NO_ADDRESS` (`adapterFor`, packages/box-agent/src/printing/queue.ts)
 * — so nothing printed. The api now refuses a printer without an address, or
 * with one the box cannot open, on creation and on an edit that changes it;
 * the forms it accepts are exactly the box's (`parseAddress`, channel.ts): the
 * park network, the Pi's USB bridge on 127.0.0.1, a simulator's own address.
 * A printer already saved without one still renames and archives, and a
 * station that holds one still saves, so no saved configuration is locked.
 */

let ctx: TestContext;
let admin: string;
let boxId: string;
let branchId: string;
let operatorId: string;
let tillId: string;

const post = (payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/boxes/${boxId}/devices`, headers: { cookie: admin }, payload });
const patch = (id: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'PATCH', url: `/devices/${id}`, headers: { cookie: admin }, payload });
const rowsLabelled = (label: string) => ctx.db.select().from(device).where(eq(device.label, label));

/** A printer as the SCRUM-861 proof left them: saved straight to the table, with no address. */
async function addresslessPrinter(label: string): Promise<string> {
  const id = newId();
  await ctx.db.insert(device).values({
    id, operatorId, branchId, boxId, kind: 'band_printer', label, transport: 'simulated',
    model: '4B-2082A', protocol: 'tspl2', reachability: 'unknown', paperStatus: 'unknown',
  });
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  tillId = till!.id;
  boxId = till!.boxId!;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-899 — a new printer', () => {
  it('without an address is refused 400 PRINTER_ADDRESS_REQUIRED, whatever kind of printer and however it is reached, and nothing is written', async () => {
    for (const [kind, transport] of [
      ['receipt_printer', 'lan'],
      ['band_printer', 'simulated'],
      ['kitchen_printer', 'usb'],
      ['bar_printer', 'lan'],
    ] as const) {
      const label = `ZZ TEST SCRUM-899 no address ${kind}`;
      for (const address of [undefined, null]) {
        const res = await post({ kind, label, transport, ...(address === undefined ? {} : { address }) });
        expect(res.statusCode, `${kind} ${String(address)}: ${res.body}`).toBe(400);
        expect(res.json().error.code).toBe('PRINTER_ADDRESS_REQUIRED');
        expect(res.json().error.message).toContain('192.168.88.204:9100');
      }
      expect(await rowsLabelled(label)).toEqual([]);
    }
    const audited = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'device.create'));
    expect(audited.filter((row) => JSON.stringify(row.after).includes('SCRUM-899 no address'))).toEqual([]);
  });

  it('with an address the box cannot open is refused 400 PRINTER_ADDRESS_INVALID', async () => {
    for (const address of ['/dev/usb/lp0', '192.168.88.300:9100', '192.168.88.204:65536', 'tcp://192.168.88.204', 'two words']) {
      const label = `ZZ TEST SCRUM-899 bad address ${address}`;
      const res = await post({ kind: 'receipt_printer', label, transport: 'lan', address });
      expect(res.statusCode, `${address}: ${res.body}`).toBe(400);
      expect(res.json().error.code).toBe('PRINTER_ADDRESS_INVALID');
      expect(await rowsLabelled(label)).toEqual([]);
    }
  });

  it('is saved in each form the box prints to — the park network, the Pi’s USB bridge, a simulator’s address, a bare host — and the box reads each as the rule does', async () => {
    for (const [address, stored] of [
      ['192.168.88.231:9100', '192.168.88.231:9100'],
      ['127.0.0.1:9101', '127.0.0.1:9101'],
      ['zz-s899-simulator:9100', 'zz-s899-simulator:9100'],
      ['192.168.88.232', '192.168.88.232'],
      ['  192.168.88.233:9100  ', '192.168.88.233:9100'],
    ] as const) {
      const res = await post({ kind: 'band_printer', label: `ZZ TEST SCRUM-899 at ${stored}`, transport: 'simulated', address, protocol: 'tspl2' });
      expect(res.statusCode, `${address}: ${res.body}`).toBe(200);
      expect(res.json().device.address).toBe(stored);
      // The box's own reading of the stored address is the rule's.
      expect(parseAddress(stored)).toEqual(parsePrinterAddress(stored));
    }
  });

  it('is the only kind held to it: a scanner and a terminal are still declared without one', async () => {
    const scanner = await post({ kind: 'scanner', label: 'ZZ TEST SCRUM-899 scanner', transport: 'usb', protocol: 'hid' });
    expect(scanner.statusCode, scanner.body).toBe(200);
    const terminal = await post({ kind: 'terminal', label: 'ZZ TEST SCRUM-899 terminal', transport: 'serial' });
    expect(terminal.statusCode, terminal.body).toBe(200);
  });
});

describe('SCRUM-899 — an edit to a printer', () => {
  it('that clears its address is refused 400 PRINTER_ADDRESS_REQUIRED, one the box cannot open PRINTER_ADDRESS_INVALID, and the printer keeps its address', async () => {
    const made = await post({ kind: 'receipt_printer', label: 'ZZ TEST SCRUM-899 receipt', transport: 'lan', address: '192.168.88.241:9100' });
    expect(made.statusCode, made.body).toBe(200);
    const id = made.json().device.id as string;

    const cleared = await patch(id, { label: 'ZZ TEST SCRUM-899 receipt', address: null });
    expect(cleared.statusCode, cleared.body).toBe(400);
    expect(cleared.json().error.code).toBe('PRINTER_ADDRESS_REQUIRED');
    const invalid = await patch(id, { address: '/dev/usb/lp0' });
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(invalid.json().error.code).toBe('PRINTER_ADDRESS_INVALID');
    const [row] = await ctx.db.select().from(device).where(eq(device.id, id));
    expect(row?.address).toBe('192.168.88.241:9100');

    const moved = await patch(id, { address: '192.168.88.242:9100' });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().device.address).toBe('192.168.88.242:9100');
    // Sent back as it is, with the other fields the Console's form sends whole.
    const renamed = await patch(id, { label: 'ZZ TEST SCRUM-899 receipt, renamed', address: '192.168.88.242:9100', model: null, protocol: null });
    expect(renamed.statusCode, renamed.body).toBe(200);
  });

  it('saved without an address still renames — the Console form sends its empty address back — and is given one, and archives', async () => {
    const id = await addresslessPrinter('ZZ TEST SCRUM-899 proof band printer');
    const consoleRename = await patch(id, {
      label: 'ZZ TEST SCRUM-899 proof band printer, renamed', address: null, model: '4B-2082A', protocol: 'tspl2',
      terminalId: null, merchantId: null,
    });
    expect(consoleRename.statusCode, consoleRename.body).toBe(200);
    expect(consoleRename.json().device).toMatchObject({ label: 'ZZ TEST SCRUM-899 proof band printer, renamed', address: null });
    const labelOnly = await patch(id, { label: 'ZZ TEST SCRUM-899 proof band printer' });
    expect(labelOnly.statusCode, labelOnly.body).toBe(200);
    const given = await patch(id, { address: '192.168.88.243:9100' });
    expect(given.statusCode, given.body).toBe(200);
    expect(given.json().device.address).toBe('192.168.88.243:9100');

    const other = await addresslessPrinter('ZZ TEST SCRUM-899 second proof printer');
    const archived = await ctx.app.inject({ method: 'DELETE', url: `/devices/${other}`, headers: { cookie: admin } });
    expect(archived.statusCode, archived.body).toBe(200);
  });

  it('saved without an address and already doing a job at a till does not lock that till: the station still saves', async () => {
    const id = await addresslessPrinter('ZZ TEST SCRUM-899 assigned without address');
    await ctx.db.insert(stationDevice).values({ id: newId(), stationId: tillId, role: 'dropoff_band', deviceId: id });
    const view = await ctx.app.inject({ method: 'GET', url: `/stations/${tillId}`, headers: { cookie: admin } });
    expect(view.statusCode, view.body).toBe(200);
    const devices = (view.json().station.devices as Array<{ role: string; deviceId: string }>).map((d) => ({ role: d.role, deviceId: d.deviceId }));
    const saved = await ctx.app.inject({
      method: 'PATCH', url: `/stations/${tillId}`, headers: { cookie: admin },
      payload: { name: 'ZZ TEST SCRUM-899 till', devices, expectedConfigVersion: view.json().station.configVersion },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().station.devices).toContainEqual(expect.objectContaining({ role: 'dropoff_band', deviceId: id }));
  });
});
