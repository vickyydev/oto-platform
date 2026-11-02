import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { device, stationDevice } from '@oto/db';
import { newId, SELLING_TERMINAL_PROTOCOLS } from '@oto/shared';
import { TERMINAL_PROTOCOLS } from '@oto/box-agent';
import { ADMIN, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let adminCookie: string;
let staffCookie: string;
let branchId: string;
let boxId: string;
let count = 0;
beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  staffCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const box = await boxBySlot(ctx.db, 'virtual-1');
  branchId = box.branchId; boxId = box.id;
});
afterAll(async () => { await ctx?.close(); await teardownAll(); });
const headers = () => ({ cookie: adminCookie, 'idempotency-key': newId() });
async function draft(paymentRouting: unknown = { card: 'card_terminal', qr: 'none' }) {
  const reply = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/stations`, headers: headers(),
    payload: { id: newId(), name: `ZZ TEST terminal readiness ${newId()}`, kind: 'till', boxId, codePrefix: `T7${++count}`, paymentRouting } });
  expect(reply.statusCode).toBe(200);
  return reply.json().station as { id: string; ready: boolean; reasons: string[] };
}
async function terminal(protocol: string | null) {
  const reply = await ctx.app.inject({ method: 'POST', url: `/boxes/${boxId}/devices`, headers: headers(),
    payload: { id: newId(), kind: 'terminal', label: `ZZ TEST terminal ${newId()}`, transport: 'simulated', protocol } });
  expect(reply.statusCode).toBe(200);
  return reply.json().device.id as string;
}
const assign = (stationId: string, deviceId: string, role = 'card_terminal') => ctx.app.inject({ method: 'PATCH', url: `/stations/${stationId}`, headers: headers(), payload: { devices: [{ role, deviceId }] } });
const pick = (stationId: string) => ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie: staffCookie }, payload: { stationId } });
const lease = (stationId: string) => ctx.app.inject({ method: 'POST', url: `/stations/${stationId}/lease`, headers: { cookie: staffCookie }, payload: { holder: 's704-review' } });
const view = async (stationId: string) => (await ctx.app.inject({ method: 'GET', url: `/stations/${stationId}`, headers: headers() })).json().station;

describe('SCRUM-704 adversarial review: routed terminal setup', () => {
  it('HIGH fixed finding: an absent card terminal is offered for selling; compute the reason in both lists and refuse selection', async () => {
    const saved = await draft();
    expect(saved).toMatchObject({ ready: false, reasons: ['Card is routed to the terminal but no terminal is assigned'] });
    const mine = await ctx.app.inject({ method: 'GET', url: '/me/stations', headers: { cookie: staffCookie } });
    expect(mine.json().stations.find((s: { id: string }) => s.id === saved.id)).toMatchObject({ ready: false, reasons: saved.reasons });
    expect((await pick(saved.id)).statusCode).toBe(409);
  });
  it('HIGH fixed finding: an absent QR terminal is offered for selling; apply readiness to each routed tender', async () => {
    expect(await draft({ card: 'manual', qr: 'qr_terminal' })).toMatchObject({ ready: false, reasons: ['QR is routed to the terminal but no terminal is assigned'] });
  });
  it('HIGH fixed finding: unset routing bypasses the terminal requirement; preserve the existing default routes to both terminals', async () => {
    expect(await draft(null)).toMatchObject({ ready: false, reasons: ['Card is routed to the terminal but no terminal is assigned', 'QR is routed to the terminal but no terminal is assigned'] });
  });
  it.each([null, 'unknown'])('HIGH fixed finding: protocol %s can be assigned to a routed tender; refuse the unusable assignment', async (protocol) => {
    const saved = await draft();
    // A terminal write now refuses an unlisted value, so 'unknown' is one stored before that rule.
    const terminalId = await terminal(null);
    if (protocol) await ctx.db.update(device).set({ protocol }).where(eq(device.id, terminalId));
    const response = await assign(saved.id, terminalId);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe('The assigned terminal has no supported protocol');
    expect(await ctx.db.select().from(stationDevice).where(eq(stationDevice.stationId, saved.id))).toHaveLength(0);
  });
  it('HIGH fixed finding: an already selected till can lease after its protocol is cleared; re-read current terminal setup', async () => {
    const saved = await draft(); const terminalId = await terminal('digio_tlv');
    expect((await assign(saved.id, terminalId)).statusCode).toBe(200);
    expect((await pick(saved.id)).statusCode).toBe(200);
    await ctx.db.update(device).set({ protocol: null }).where(eq(device.id, terminalId));
    expect(await view(saved.id)).toMatchObject({ ready: false, reasons: ['The assigned terminal has no supported protocol'] });
    const refusal = await lease(saved.id);
    expect(refusal.statusCode).toBe(409);
    expect(refusal.json().error.message).toBe('The assigned terminal has no supported protocol');
  });
  it('HIGH fixed finding: a legacy cross-box role is counted as usable; require an active matching terminal on this station box', async () => {
    const saved = await draft(); const terminalId = await terminal('ghl_linkpos');
    await ctx.db.insert(stationDevice).values({ id: newId(), stationId: saved.id, deviceId: terminalId, role: 'card_terminal' });
    const otherBox = await boxBySlot(ctx.db, 'virtual-2');
    await ctx.db.update(device).set({ boxId: otherBox.id }).where(eq(device.id, terminalId));
    expect((await view(saved.id)).ready).toBe(false);
    expect((await pick(saved.id)).statusCode).toBe(409);
  });
  it('HIGH fixed finding: an archived assigned terminal remains selling-ready; ignore archived devices', async () => {
    const saved = await draft(); const terminalId = await terminal('ghl_linkpos');
    expect((await assign(saved.id, terminalId)).statusCode).toBe(200);
    await ctx.db.update(device).set({ archivedAt: new Date() }).where(eq(device.id, terminalId));
    expect((await view(saved.id)).ready).toBe(false);
  });
  it('MEDIUM pin: an existing unusable assignment does not prevent saving an incomplete draft', async () => {
    const saved = await draft(); const terminalId = await terminal('ghl_linkpos');
    expect((await assign(saved.id, terminalId)).statusCode).toBe(200);
    await ctx.db.update(device).set({ protocol: null }).where(eq(device.id, terminalId));
    const changed = await ctx.app.inject({ method: 'PATCH', url: `/stations/${saved.id}`, headers: headers(),
      payload: { name: `ZZ TEST edited draft ${newId()}`, devices: [{ role: 'card_terminal', deviceId: terminalId }] } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().station).toMatchObject({ ready: false, reasons: ['The assigned terminal has no supported protocol'] });
  });
  it('HIGH pin: enabling routing to an existing unusable role is refused', async () => {
    const saved = await draft({ card: 'manual', qr: 'none' });
    expect((await assign(saved.id, await terminal(null))).statusCode).toBe(200);
    const changed = await ctx.app.inject({ method: 'PATCH', url: `/stations/${saved.id}`, headers: headers(), payload: { paymentRouting: { card: 'card_terminal' } } });
    expect(changed.statusCode).toBe(400);
  });
  it('HIGH pin: a QR role requires its own active terminal; a card role alone does not satisfy it', async () => {
    const saved = await draft({ card: 'card_terminal', qr: 'qr_terminal' });
    const terminalId = await terminal('digio_tlv');
    expect((await assign(saved.id, terminalId)).statusCode).toBe(200);
    expect(await view(saved.id)).toMatchObject({ ready: false, reasons: ['QR is routed to the terminal but no terminal is assigned'] });
    const complete = await ctx.app.inject({ method: 'PATCH', url: `/stations/${saved.id}`, headers: headers(), payload: { devices: [
      { role: 'card_terminal', deviceId: terminalId }, { role: 'qr_terminal', deviceId: terminalId },
    ] } });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().station.ready).toBe(true);
  });
  it('HIGH pin: legacy non-terminal equipment cannot satisfy a terminal role', async () => {
    const saved = await draft(); const terminalId = await terminal('ghl_linkpos');
    expect((await assign(saved.id, terminalId)).statusCode).toBe(200);
    await ctx.db.update(device).set({ kind: 'receipt_printer' }).where(eq(device.id, terminalId));
    expect((await view(saved.id)).ready).toBe(false);
  });
  it('control: the selectable dialects exactly match the box adapters', () => {
    expect(SELLING_TERMINAL_PROTOCOLS).toEqual(TERMINAL_PROTOCOLS);
  });
  it('control: supported simulated terminals permit selection and a lease', async () => {
    for (const protocol of ['ghl_linkpos', 'digio_tlv']) {
      const saved = await draft();
      expect((await assign(saved.id, await terminal(protocol))).statusCode).toBe(200);
      expect(await view(saved.id)).toMatchObject({ ready: true, reasons: [] });
      expect((await pick(saved.id)).statusCode).toBe(200);
      expect((await lease(saved.id)).statusCode).toBe(200);
    }
  });
  it('control: manual card and gateway QR do not require a terminal', async () => {
    expect(await draft({ card: 'manual', qr: 'gateway' })).toMatchObject({ ready: true, reasons: [] });
  });
});
