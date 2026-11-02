import { generateKeyPairSync } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, checkin, idempotencyKey, registration, station, syncEvent, ticketPackage } from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import { newId } from '@oto/shared';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { linkedAgent, type CuttableLink } from './box-link';
import { ADMIN, CHALONG_MANAGER, SECOND_OPERATOR_ADMIN, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/** SCRUM-723: real route refusal, box queue and replay. The HIGH findings
 * reproduce on the missing route guard, then become passing regression pins.
 * The POS test separately starts on platform with a successful board read.
 */
let ctx: TestContext, agent: BoxAgent;
let cookie: string, consoleCookie: string, otherBranchCookie: string, otherOperatorCookie: string;
let stationId: string, branchId: string, boxId: string, packageId: string;
const link: CuttableLink = { cut: false };
const keys = generateKeyPairSync('ed25519');
const route = '/checkin/check-in-booked';
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, as = cookie, key = newId()) => ctx.app.inject({
  method, url, headers: { cookie: as, 'idempotency-key': key },
  ...(payload === undefined ? {} : { payload: payload as never }),
});
const arrive = (id: string, as = cookie, key = newId()) => call('POST', route, {
  entries: [{ checkinId: id }], consentAcknowledged: true,
}, as, key);
const child = async (id: string) => (await ctx.db.select().from(checkin).where(eq(checkin.id, id)))[0]!;
const consent = async (id: string) => (await ctx.db.select().from(registration).where(eq(registration.id, id)))[0]!.consentRecordedAt;
const consentAudits = (id: string) => ctx.db.select().from(auditLog).where(and(
  eq(auditLog.entityId, id), eq(auditLog.action, 'registration.update'), sql`${auditLog.after}->>'event' = 'consent_at_check_in'`,
));
const flush = async () => {
  link.cut = false;
  await agent.setOffline(false);
  for (let n = 0; n < 12; n++) if ((await agent.outbox()!.flush()).state !== 'pushed') break;
};
beforeAll(async () => {
  ctx = await createTestContext({ env: { OPS_TEST_CONTROLS: 'true',
    STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } });
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  consoleCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  otherBranchCookie = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  otherOperatorCookie = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const box = await boxBySlot(ctx.db, 'virtual-1'); boxId = box.id; branchId = box.branchId;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.boxId, boxId), eq(station.name, 'Reception Till 1')));
  stationId = till!.id;
  expect((await call('PUT', '/me/session/station', { stationId })).statusCode).toBe(200);
  const [pkg] = await ctx.db.select().from(ticketPackage).where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  packageId = pkg!.id;
  agent = linkedAgent(ctx, boxId, 's723-forced-offline', link, { devices: true });
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig(); await agent.syncCache(); attachInProcessBox(agent);
}, 180_000);
afterEach(async () => { ctx.app.env.OPS_TEST_CONTROLS = true; await flush(); });
afterAll(async () => { agent?.stop(); if (agent) detachInProcessBox(agent); await ctx?.close(); await teardownAll(); });

async function booked() {
  const registrationId = newId(), checkinId = newId(), saleId = newId();
  const created = await call('POST', '/checkin/registrations', {
    id: registrationId, branchId, stationId, guardianName: 'ZZ TEST offline review', contactChannel: 'whatsapp',
    consentAcknowledged: true, acknowledgedConfirmationIds: ['confirm-15min', 'confirm-no-refund', 'confirm-evac'],
    children: [{ checkinId, name: 'ZZ TEST child', ageYears: 7, service: 'drop_off' }],
  });
  expect(created.statusCode, created.body).toBe(200);
  const sale = await call('POST', '/sales', { id: saleId, stationId,
    lines: [{ id: checkinId, packageId, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 22_500 } }],
  });
  expect(sale.statusCode, sale.body).toBe(200);
  expect((await call('POST', `/sales/${saleId}/finalise`, {})).statusCode).toBe(200);
  expect((await call('POST', '/checkin/leave-as-booked', { saleId, entries: [{ checkinId }] })).statusCode).toBe(200);
  await ctx.db.update(registration).set({ consentRecordedAt: null }).where(eq(registration.id, registrationId));
  await agent.syncCheckin();
  return { registrationId, checkinId, saleId };
}
const forceOffline = async () => { await agent.setOffline(true); link.cut = true; };

describe('SCRUM-723: the fresh booked arrival honors the Console offline switch', () => {
  it('HIGH pin: cloud arrival bypasses forced offline; flag the route before idempotency and leave the platform untouched until box replay', async () => {
    const f = await booked(); await forceOffline();
    // A fresh page may still read its board from the platform. Its first
    // arrival must itself trigger the existing client fallback.
    expect((await call('GET', `/checkin/board?branchId=${branchId}`)).statusCode).toBe(200);
    const key = newId(), refused = await arrive(f.checkinId, cookie, key);
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.json().error.code).toBe('STATION_FORCED_OFFLINE');
    expect(refused.headers['x-oto-replay']).toBeUndefined();
    expect(await child(f.checkinId)).toMatchObject({ status: 'registered', bandId: null });
    expect(await consent(f.registrationId)).toBeNull();
    expect(await consentAudits(f.registrationId)).toHaveLength(0);
    expect(await ctx.db.select().from(idempotencyKey).where(eq(idempotencyKey.key, key))).toHaveLength(0);
    const at = new Date(Date.now() - 2_000).toISOString();
    const boxReply = await call('POST', `/box/v1/station/${stationId}/intents`, {
      type: 'checkin.update', actionId: newId(), lastSeenSequence: 0,
      payload: { event: 'check_in_now', saleId: f.saleId, entries: [{ checkinId: f.checkinId }], consent: { acknowledged: true, at } },
    });
    expect(boxReply.statusCode, boxReply.body).toBe(200);
    expect(boxReply.json().result.children[0].status).toBe('in_park');
    expect(await child(f.checkinId)).toMatchObject({ status: 'registered', bandId: null });
    expect(await consent(f.registrationId)).toBeNull();
    const queued = await call('GET', `/box/v1/station/${stationId}/status`);
    expect(queued.json().outboxDepth).toBe(1);
    await flush(); await flush();
    expect(await child(f.checkinId)).toMatchObject({ status: 'in_park', offline: true });
    expect((await consent(f.registrationId))?.toISOString()).toBe(at);
    const audits = await consentAudits(f.registrationId); expect(audits).toHaveLength(1);
    const [fact] = await ctx.db.select().from(syncEvent).where(eq(syncEvent.eventId, audits[0]!.sourceEventId!));
    expect(fact).toMatchObject({ boxId, stationId, type: 'checkin.updated' });
    expect(fact!.payload).toMatchObject({ consent: { acknowledged: true, at } });
  });

  it('HIGH pin: a stored online answer escapes the offline switch; refuse before replaying the idempotency key', async () => {
    const f = await booked(), key = newId();
    expect((await arrive(f.checkinId, cookie, key)).statusCode).toBe(200);
    await forceOffline();
    const repeated = await arrive(f.checkinId, cookie, key);
    expect(repeated.statusCode).toBe(503);
    expect(repeated.headers['x-oto-replay']).toBeUndefined();
    expect(await consentAudits(f.registrationId)).toHaveLength(1);
  });

  it('HIGH pin: an online arrival still validates consent and replays once under its existing key', async () => {
    const f = await booked(), key = newId();
    const missing = await call('POST', route, { entries: [{ checkinId: f.checkinId }] });
    expect(missing.statusCode).toBe(409); expect(missing.json().error.code).toBe('CONSENT_REQUIRED');
    const first = await arrive(f.checkinId, cookie, key), second = await arrive(f.checkinId, cookie, key);
    expect(first.statusCode, first.body).toBe(200); expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await consentAudits(f.registrationId)).toHaveLength(1);
    expect((await consentAudits(f.registrationId))[0]!.sourceEventId).toBeNull();
  });

  it('HIGH pin: authentication, body validation and the existing record permission remain enforced', async () => {
    const f = await booked();
    expect((await arrive(f.checkinId, '')).statusCode).toBe(401);
    expect((await arrive(f.checkinId, otherBranchCookie)).statusCode).toBe(403);
    expect((await arrive(f.checkinId, otherOperatorCookie)).statusCode).toBe(404);
    await forceOffline();
    expect((await arrive(f.checkinId, '')).statusCode).toBe(401);
    expect((await call('POST', route, { entries: [], extra: true })).statusCode).toBe(400);
    expect(await child(f.checkinId)).toMatchObject({ status: 'registered', bandId: null });
  });

  it('the switch does not catch an authorized Console session with no selected station', async () => {
    const f = await booked(); await forceOffline();
    expect((await arrive(f.checkinId, consoleCookie)).statusCode).toBe(200);
    expect(await child(f.checkinId)).toMatchObject({ status: 'in_park', offline: false });
  });

  it('the test refusal stays disabled when test controls are off', async () => {
    const f = await booked(); await forceOffline(); ctx.app.env.OPS_TEST_CONTROLS = false;
    expect((await arrive(f.checkinId)).statusCode).toBe(200);
    expect(await child(f.checkinId)).toMatchObject({ status: 'in_park', offline: false });
  });
});
