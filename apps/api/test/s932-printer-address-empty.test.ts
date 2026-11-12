import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, device, station } from '@oto/db';
import { newId, printerAddressWords } from '@oto/shared';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-932 (b) — AN EMPTY ADDRESS ANSWERS IN THE PRINTER-ADDRESS WORDS.
 *
 * Seen in the SCRUM-898 to 900 staging proof: editing a printer with an empty
 * address was refused by the route's schema (`address` had a minimum length),
 * so the answer was the generic 400 VALIDATION "Request does not match the
 * schema" instead of the plain printer-address line the Console shows. The
 * Console never sends an empty address, but the route now answers it the
 * same way as a missing one: 400 PRINTER_ADDRESS_REQUIRED with that line, and
 * nothing written. An empty address on any other kind of device is no
 * address, saved as none, where the schema used to refuse it.
 *
 * Driven through the routes against the seeded Reception Till 1's box.
 */

let ctx: TestContext;
let admin: string;
let boxId: string;
let branchId: string;
let operatorId: string;

const post = (payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/boxes/${boxId}/devices`, headers: { cookie: admin }, payload });
const patch = (id: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'PATCH', url: `/devices/${id}`, headers: { cookie: admin }, payload });
const rowOf = async (id: string) => (await ctx.db.select().from(device).where(eq(device.id, id)).limit(1))[0];
const updatesOf = async (id: string) =>
  (await ctx.db.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.action, 'device.update'), eq(auditLog.entityId, id)))).length;

const REQUIRED = printerAddressWords('missing');

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  boxId = till!.boxId!;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-932 — a printer edited with an empty address', () => {
  it('is refused 400 PRINTER_ADDRESS_REQUIRED in the printer-address line, as a cleared one is, and keeps its address', async () => {
    const made = await post({ kind: 'receipt_printer', label: 'ZZ TEST SCRUM-932 receipt', transport: 'lan', address: '192.0.2.41:9100' });
    expect(made.statusCode, made.body).toBe(200);
    const id = made.json().device.id as string;
    const audited = await updatesOf(id);

    for (const address of ['', '   ']) {
      const res = await patch(id, { label: 'ZZ TEST SCRUM-932 receipt', address });
      expect(res.statusCode, `${JSON.stringify(address)}: ${res.body}`).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'PRINTER_ADDRESS_REQUIRED', message: REQUIRED });
      expect(res.json().error.code).not.toBe('VALIDATION');
    }
    expect((await rowOf(id))?.address).toBe('192.0.2.41:9100');
    expect(await updatesOf(id)).toBe(audited);
  });

  it('a printer saved without one before the rule still renames when its form sends the empty address back', async () => {
    const id = newId();
    await ctx.db.insert(device).values({
      id, operatorId, branchId, boxId, kind: 'band_printer', label: 'ZZ TEST SCRUM-932 no address', transport: 'simulated',
      protocol: 'tspl2', reachability: 'unknown', paperStatus: 'unknown',
    });
    const res = await patch(id, { label: 'ZZ TEST SCRUM-932 no address, renamed', address: '' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().device).toMatchObject({ label: 'ZZ TEST SCRUM-932 no address, renamed', address: null });
  });
});

describe('SCRUM-932 — a new printer with an empty address', () => {
  it('is refused in the same words, and nothing is written', async () => {
    const label = 'ZZ TEST SCRUM-932 empty new';
    const res = await post({ kind: 'band_printer', label, transport: 'simulated', address: '', protocol: 'tspl2' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'PRINTER_ADDRESS_REQUIRED', message: REQUIRED });
    expect(await ctx.db.select().from(device).where(eq(device.label, label))).toEqual([]);
  });
});

describe('SCRUM-932 — any other device with an empty address', () => {
  it('is saved with no address, on creation and on an edit', async () => {
    const made = await post({ kind: 'scanner', label: 'ZZ TEST SCRUM-932 scanner', transport: 'usb', address: '' });
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().device.address).toBeNull();
    const id = made.json().device.id as string;

    const given = await patch(id, { address: '/dev/ttyACM0' });
    expect(given.statusCode, given.body).toBe(200);
    expect(given.json().device.address).toBe('/dev/ttyACM0');
    const cleared = await patch(id, { address: '' });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().device.address).toBeNull();
    expect((await rowOf(id))?.address).toBeNull();
  });
});
