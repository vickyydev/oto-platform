import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, idempotencyKey, session, station } from '@oto/db';
import { newId, stationPrefixReadiness } from '@oto/shared';
import { ADMIN, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let adminCookie: string;
let staffCookie: string;
let branchId: string;
let boxId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  staffCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const box = await boxBySlot(ctx.db, 'virtual-1');
  branchId = box.branchId;
  boxId = box.id;
});
afterAll(async () => { await ctx?.close(); await teardownAll(); });

async function draft(prefix: string | null = null) {
  const id = newId();
  const response = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/stations`,
    headers: { cookie: adminCookie, 'idempotency-key': newId() },
    payload: { id, name: `ZZ TEST prefix ${id}`, kind: 'till', boxId, codePrefix: prefix, paymentRouting: { card: 'manual', qr: 'none' } },
  });
  expect(response.statusCode).toBe(200);
  return response.json().station as { id: string; ready: boolean; reasons: string[] };
}
const pick = (stationId: string) => ctx.app.inject({ method: 'PUT', url: '/me/session/station',
  headers: { cookie: staffCookie }, payload: { stationId } });
const lease = (stationId: string) => ctx.app.inject({ method: 'POST', url: `/stations/${stationId}/lease`,
  headers: { cookie: staffCookie }, payload: { holder: `review-${stationId}` } });

describe('SCRUM-703 adversarial review: unfinished till setup', () => {
  it('HIGH pin: a blank draft saves and stays visible with the missing-prefix reason; fix the trading gate, not draft saving', async () => {
    const saved = await draft();
    expect(saved).toMatchObject({ ready: false, reasons: ['No receipt prefix'] });
    const mine = await ctx.app.inject({ method: 'GET', url: '/me/stations', headers: { cookie: staffCookie } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().stations.find((row: { id: string }) => row.id === saved.id)).toMatchObject({ id: saved.id, ready: false, reasons: saved.reasons });
    const list = await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/stations`, headers: { cookie: adminCookie } });
    expect(list.json().stations.find((row: { id: string }) => row.id === saved.id)).toMatchObject({ id: saved.id, ready: false, reasons: saved.reasons });
    const refusal = await pick(saved.id);
    expect(refusal.statusCode).toBe(409);
    expect(refusal.json().error).toMatchObject({ code: 'STATION_NOT_READY', message: saved.reasons[0] });
    expect(await ctx.db.select({ id: session.id }).from(session).where(eq(session.stationId, saved.id))).toHaveLength(0);
    expect(await ctx.db.select({ id: auditLog.id }).from(auditLog)
      .where(and(eq(auditLog.entityId, saved.id), eq(auditLog.action, 'session.station_pick')))).toHaveLength(0);
  });

  it('HIGH pin: a previously seated session cannot claim a lease after the prefix is cleared; re-read stored setup', async () => {
    const saved = await draft('Z703A');
    expect(saved).toMatchObject({ ready: true, reasons: [] });
    expect((await pick(saved.id)).statusCode).toBe(200);
    const cleared = await ctx.app.inject({ method: 'PATCH', url: `/stations/${saved.id}`,
      headers: { cookie: adminCookie }, payload: { codePrefix: null } });
    expect(cleared.statusCode).toBe(200);
    const refused = await lease(saved.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'STATION_NOT_READY', message: 'No receipt prefix' });
    const repaired = await ctx.app.inject({ method: 'PATCH', url: `/stations/${saved.id}`,
      headers: { cookie: adminCookie }, payload: { codePrefix: 'Z703A' } });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.json().station).toMatchObject({ ready: true, reasons: [] });
    expect((await lease(saved.id)).statusCode).toBe(200);
  });

  it('HIGH fixed finding: a cached lease bypasses changed setup; recheck readiness before replaying a lease', async () => {
    const saved = await draft('Z703B');
    expect((await pick(saved.id)).statusCode).toBe(200);
    const key = newId();
    const claim = () => ctx.app.inject({ method: 'POST', url: `/stations/${saved.id}/lease`,
      headers: { cookie: staffCookie, 'idempotency-key': key }, payload: { holder: 's703-replay' } });
    expect((await claim()).statusCode).toBe(200);
    await ctx.db.update(station).set({ codePrefix: null }).where(eq(station.id, saved.id));
    const replay = await claim();
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.message).toBe('No receipt prefix');
  });

  it('MEDIUM fixed finding: a pre-deploy station reply lacks readiness; compute current readiness when replaying it', async () => {
    const saved = await draft();
    const key = newId();
    const rename = () => ctx.app.inject({ method: 'PATCH', url: `/stations/${saved.id}`,
      headers: { cookie: adminCookie, 'idempotency-key': key }, payload: { name: 'ZZ TEST replayed draft' } });
    const first = await rename();
    expect(first.statusCode).toBe(200);
    const body = first.json();
    delete body.station.ready;
    delete body.station.reasons;
    await ctx.db.update(idempotencyKey).set({ responseBody: body }).where(eq(idempotencyKey.key, key));
    const replay = await rename();
    expect(replay.statusCode).toBe(200);
    expect(replay.json().station).toMatchObject({ ready: false, reasons: ['No receipt prefix'] });
  });

  it.each(['lower', 'TOOLONG', 'WEB', 'A B'])('MEDIUM pin: legacy invalid prefix %s is not selling-ready', async (prefix) => {
    const saved = await draft();
    await ctx.db.update(station).set({ codePrefix: prefix }).where(eq(station.id, saved.id));
    const response = await ctx.app.inject({ method: 'GET', url: `/stations/${saved.id}`, headers: { cookie: adminCookie } });
    expect(response.json().station.ready).toBe(false);
    expect((await pick(saved.id)).statusCode).toBe(409);
  });

  it('control: the till rule does not add requirements to a display or booth', () => {
    for (const kind of ['display', 'booth', 'gate']) {
      expect(stationPrefixReadiness({ kind, codePrefix: null })).toEqual({ ready: true, reasons: [] });
    }
  });
});
