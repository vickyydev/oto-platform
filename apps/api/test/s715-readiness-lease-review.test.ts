import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, device, station, stationDevice } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-715. Readiness says what the tender will do: a QR press on a till with
 * QR left unset reaches the terminal. And the till's real lease, the one through
 * the station bridge, asks the same question the station lease asks.
 */
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
const NO_QR_TERMINAL = 'QR is routed to the terminal but no terminal is assigned';
const NO_SUPPORTED = 'The assigned terminal has no supported protocol';

async function till(paymentRouting: unknown, devices: Array<{ role: string; deviceId: string }> = []) {
  const reply = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/stations`, headers: headers(),
    payload: { id: newId(), name: `ZZ TEST s715 ${newId()}`, kind: 'till', boxId, codePrefix: `T75${++count}`, paymentRouting, devices } });
  expect(reply.statusCode, reply.body).toBe(200);
  return reply.json().station as { id: string; ready: boolean; reasons: string[] };
}
const postDevice = (payload: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: `/boxes/${boxId}/devices`, headers: headers(),
  payload: { id: newId(), kind: 'terminal', label: `ZZ TEST s715 device ${newId()}`, transport: 'simulated', ...payload } });
async function terminal(protocol: string | null = 'digio_tlv') {
  const reply = await postDevice({ protocol });
  expect(reply.statusCode, reply.body).toBe(200);
  return reply.json().device.id as string;
}
const patchDevice = (id: string, payload: Record<string, unknown>) => ctx.app.inject({ method: 'PATCH', url: `/devices/${id}`, headers: headers(), payload });
const pick = (stationId: string) => ctx.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie: staffCookie }, payload: { stationId } });
const view = async (stationId: string) => (await ctx.app.inject({ method: 'GET', url: `/stations/${stationId}`, headers: headers() })).json().station;
const bridgeLease = (stationId: string, extra: Record<string, string> = {}) => ctx.app.inject({ method: 'POST', url: `/box/v1/station/${stationId}/lease`,
  headers: { cookie: staffCookie, ...extra }, payload: { holder: 's715-review' } });
const stationLease = (stationId: string) => ctx.app.inject({ method: 'POST', url: `/stations/${stationId}/lease`,
  headers: { cookie: staffCookie }, payload: { holder: 's715-review' } });

/** A till the session has taken, then its terminal's protocol cleared underneath it. */
async function takenThenCleared() {
  const terminalId = await terminal();
  const saved = await till({ card: 'manual', qr: 'qr_terminal' }, [{ role: 'qr_terminal', deviceId: terminalId }]);
  expect((await pick(saved.id)).statusCode).toBe(200);
  return { saved, clear: () => ctx.db.update(device).set({ protocol: null }).where(eq(device.id, terminalId)) };
}

describe('SCRUM-715: a QR tender on its default route', () => {
  it('HIGH fixed finding: QR unset with only a card terminal read ready; require the terminal the tender reaches', async () => {
    const saved = await till({ card: 'card_terminal' }, [{ role: 'card_terminal', deviceId: await terminal('ghl_linkpos') }]);
    expect(saved).toMatchObject({ ready: false, reasons: [NO_QR_TERMINAL] });
    const mine = await ctx.app.inject({ method: 'GET', url: '/me/stations', headers: { cookie: staffCookie } });
    expect(mine.json().stations.find((s: { id: string }) => s.id === saved.id)).toMatchObject({ ready: false, reasons: [NO_QR_TERMINAL] });
    const refusal = await pick(saved.id);
    expect(refusal.statusCode).toBe(409);
    expect(refusal.json().error).toMatchObject({ code: 'STATION_NOT_READY', message: NO_QR_TERMINAL });
  });
  it('HIGH fixed finding: a routing that fails to parse read as QR off; the tender ignores it, so both terminals are required', async () => {
    const saved = await till({ card: 'manual', qr: 'none' });
    await ctx.db.update(station).set({ paymentRouting: { card: 'manual', qr: 'bogus' } }).where(eq(station.id, saved.id));
    expect((await view(saved.id)).reasons).toEqual(['Card is routed to the terminal but no terminal is assigned', NO_QR_TERMINAL]);
  });
  it.each(['gateway', 'none'])('control: QR %s stays ready with only a card terminal', async (qr) => {
    const saved = await till({ card: 'card_terminal', qr }, [{ role: 'card_terminal', deviceId: await terminal('ghl_linkpos') }]);
    expect(saved).toMatchObject({ ready: true, reasons: [] });
    expect((await pick(saved.id)).statusCode).toBe(200);
  });
  it('control: QR unset with a usable QR terminal stays ready', async () => {
    const saved = await till({ card: 'manual' }, [{ role: 'qr_terminal', deviceId: await terminal('digio_tlv') }]);
    expect(saved).toMatchObject({ ready: true, reasons: [] });
    expect((await pick(saved.id)).statusCode).toBe(200);
  });
  it('control: QR unset with no routing at all, and both terminals, stays ready', async () => {
    const saved = await till(null, [
      { role: 'card_terminal', deviceId: await terminal('ghl_linkpos') },
      { role: 'qr_terminal', deviceId: await terminal('digio_tlv') },
    ]);
    expect(saved).toMatchObject({ ready: true, reasons: [] });
  });
  it('MEDIUM pin: QR unset with an unusable QR terminal is refused as a new assignment', async () => {
    const reply = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/stations`, headers: headers(),
      payload: { id: newId(), name: `ZZ TEST s715 ${newId()}`, kind: 'till', boxId, codePrefix: `T75${++count}`, paymentRouting: { card: 'manual' },
        devices: [{ role: 'qr_terminal', deviceId: await terminal(null) }] } });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.message).toBe(NO_SUPPORTED);
  });
  it('MEDIUM pin: drafts stay saveable; QR unset with no terminal saves, and an existing unusable assignment does not stop an edit', async () => {
    const saved = await till({ card: 'manual' });
    expect(saved).toMatchObject({ ready: false, reasons: [NO_QR_TERMINAL] });
    const terminalId = await terminal('digio_tlv');
    await ctx.db.insert(stationDevice).values({ id: newId(), stationId: saved.id, deviceId: terminalId, role: 'qr_terminal' });
    await ctx.db.update(device).set({ protocol: null }).where(eq(device.id, terminalId));
    const edited = await ctx.app.inject({ method: 'PATCH', url: `/stations/${saved.id}`, headers: headers(), payload: { name: `ZZ TEST s715 edited ${newId()}` } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().station).toMatchObject({ ready: false, reasons: [NO_SUPPORTED] });
  });
  it('HIGH pin: moving QR from none to unset routes it to an unusable terminal already assigned, and is refused', async () => {
    const terminalId = await terminal(null);
    const saved = await till({ card: 'manual', qr: 'none' }, [{ role: 'qr_terminal', deviceId: terminalId }]);
    const changed = await ctx.app.inject({ method: 'PATCH', url: `/stations/${saved.id}`, headers: headers(), payload: { paymentRouting: { card: 'manual' } } });
    expect(changed.statusCode).toBe(400);
    expect(changed.json().error.message).toBe(NO_SUPPORTED);
  });
});

describe('SCRUM-715: the lease the till really takes', () => {
  it('control: the bridge lease is allowed on a ready till', async () => {
    const saved = await till({ card: 'manual', qr: 'none' });
    expect((await pick(saved.id)).statusCode).toBe(200);
    const taken = await bridgeLease(saved.id);
    expect(taken.statusCode, taken.body).toBe(200);
    expect(taken.json().lease.leaseId).toEqual(expect.any(String));
  });
  it('HIGH fixed finding: the bridge lease opened a till that is not ready; refuse it with the sentence the station lease uses', async () => {
    const { saved, clear } = await takenThenCleared();
    await clear();
    const refusal = await bridgeLease(saved.id);
    expect(refusal.statusCode).toBe(409);
    expect(refusal.json().error).toMatchObject({ code: 'STATION_NOT_READY', message: NO_SUPPORTED, details: { reasons: [NO_SUPPORTED] } });
    const beside = await stationLease(saved.id);
    expect(beside.statusCode).toBe(409);
    expect(beside.json().error).toEqual(refusal.json().error);
  });
  it('HIGH fixed finding: a repeated bridge lease request could re-offer a lease after setup was cleared', async () => {
    const { saved, clear } = await takenThenCleared();
    const key = newId();
    const first = await bridgeLease(saved.id, { 'idempotency-key': key });
    expect(first.statusCode, first.body).toBe(200);
    await clear();
    const replay = await bridgeLease(saved.id, { 'idempotency-key': key });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.message).toBe(NO_SUPPORTED);
  });
  it('control: a repeated bridge lease request on a still-ready till answers as before', async () => {
    const saved = await till({ card: 'manual', qr: 'none' });
    expect((await pick(saved.id)).statusCode).toBe(200);
    const key = newId();
    const first = await bridgeLease(saved.id, { 'idempotency-key': key });
    const replay = await bridgeLease(saved.id, { 'idempotency-key': key });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(replay.json()).toEqual(first.json());
  });
  it('MEDIUM pin: a lease already held keeps renewing, as the station lease does; only a new claim is refused', async () => {
    const { saved, clear } = await takenThenCleared();
    const taken = await bridgeLease(saved.id);
    expect(taken.statusCode, taken.body).toBe(200);
    await clear();
    const renewed = await ctx.app.inject({ method: 'POST', url: `/box/v1/station/${saved.id}/lease/renew`,
      headers: { cookie: staffCookie }, payload: { leaseId: taken.json().lease.leaseId } });
    expect(renewed.statusCode, renewed.body).toBe(200);
  });
  it('control: somebody not standing at the till is told that first, and learns nothing about its setup', async () => {
    const saved = await till({ card: 'manual' });
    const refusal = await bridgeLease(saved.id);
    expect(refusal.statusCode).toBe(403);
    expect(refusal.json().error.code).toBe('STATION_NOT_PICKED');
  });
});

describe('SCRUM-715: a terminal write names a listed protocol or none', () => {
  it('HIGH fixed finding: POST accepted any protocol string for a terminal; refuse it in a plain sentence and write nothing', async () => {
    const id = newId();
    const refused = await postDevice({ id, protocol: 'pax_a35' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatchObject({ code: 'TERMINAL_PROTOCOL_UNSUPPORTED',
      message: 'That terminal protocol is not one the box can speak. Choose one from the list or leave it blank.' });
    expect(await ctx.db.select().from(device).where(eq(device.id, id))).toHaveLength(0);
    expect(await ctx.db.select().from(auditLog).where(eq(auditLog.entityId, id))).toHaveLength(0);
  });
  it('HIGH fixed finding: PATCH accepted any protocol string for a terminal; refuse it and keep the stored value', async () => {
    const id = await terminal('digio_tlv');
    const refused = await patchDevice(id, { protocol: 'pax_a35' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('TERMINAL_PROTOCOL_UNSUPPORTED');
    const [row] = await ctx.db.select({ protocol: device.protocol }).from(device).where(eq(device.id, id));
    expect(row!.protocol).toBe('digio_tlv');
  });
  it.each(['ghl_linkpos', 'digio_tlv'])('control: simulated and serial terminals save with %s', async (protocol) => {
    expect((await postDevice({ protocol })).statusCode).toBe(200);
    expect((await postDevice({ protocol, transport: 'serial', address: `/dev/ttyUSB${++count}` })).statusCode).toBe(200);
  });
  it.each([null, undefined, ''])('control: a blank protocol (%j) is kept on both writes, so a draft stays saveable', async (protocol) => {
    const created = await postDevice({ protocol });
    expect(created.statusCode, created.body).toBe(200);
    const id = await terminal('digio_tlv');
    if (protocol !== undefined) {
      const cleared = await patchDevice(id, { protocol });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json().device.protocol || null).toBeNull();
    }
  });
  it('MEDIUM pin: an edit that leaves an older stored value untouched still saves, whether or not it sends the value back', async () => {
    const id = await terminal('digio_tlv');
    await ctx.db.update(device).set({ protocol: 'older_dialect' }).where(eq(device.id, id));
    expect((await patchDevice(id, { label: `ZZ TEST s715 renamed ${newId()}` })).statusCode).toBe(200);
    const sentBack = await patchDevice(id, { label: `ZZ TEST s715 renamed ${newId()}`, protocol: 'older_dialect' });
    expect(sentBack.statusCode, sentBack.body).toBe(200);
    expect(sentBack.json().device.protocol).toBe('older_dialect');
    expect((await patchDevice(id, { protocol: 'another_dialect' })).statusCode).toBe(400);
    expect((await patchDevice(id, { protocol: 'ghl_linkpos' })).statusCode).toBe(200);
  });
  it('control: other kinds of device keep their own protocol words', async () => {
    const printer = await postDevice({ kind: 'receipt_printer', protocol: 'escpos', address: '192.168.88.77:9100' });
    expect(printer.statusCode, printer.body).toBe(200);
    expect((await patchDevice(printer.json().device.id, { protocol: 'tspl2' })).statusCode).toBe(200);
  });
});

describe('SCRUM-715: the reason for a terminal on another box', () => {
  it('MEDIUM fixed finding: a terminal on another box was described as no terminal assigned; say where it is', async () => {
    const terminalId = await terminal('ghl_linkpos');
    const saved = await till({ card: 'card_terminal', qr: 'none' }, [{ role: 'card_terminal', deviceId: terminalId }]);
    expect(saved.ready).toBe(true);
    const otherBox = await boxBySlot(ctx.db, 'virtual-2');
    await ctx.db.update(device).set({ boxId: otherBox.id }).where(eq(device.id, terminalId));
    expect(await view(saved.id)).toMatchObject({ ready: false, reasons: ['The assigned terminal is on another box'] });
    const refusal = await pick(saved.id);
    expect(refusal.statusCode).toBe(409);
    expect(refusal.json().error.message).toBe('The assigned terminal is on another box');
  });
});
