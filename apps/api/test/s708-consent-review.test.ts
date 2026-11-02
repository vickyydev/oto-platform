import { generateKeyPairSync } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, checkin, registration, station, syncEvent, syncQuarantine, ticketPackage } from '@oto/db';
import { type BoxAgent } from '@oto/box-agent';
import { CHECKIN_FACTS, newId } from '@oto/shared';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { linkedAgent, type CuttableLink } from './box-link';
import { ADMIN, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/** SCRUM-708 adversarial review: a real box fact, replay transaction and audit.
 * Each HIGH pin states the failure and prescribed guard. Deliberate mutations
 * are run as it.fails findings, then restored to these passing regression pins.
 * The native SQLite suite separately cuts power before commit and restarts.
 */
let ctx: TestContext, agent: BoxAgent;
let cookie: string, stationId: string, branchId: string, boxId: string, packageId: string;
const link: CuttableLink = { cut: false };
const keys = generateKeyPairSync('ed25519');
const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => ctx.app.inject({
  method, url, headers: { cookie, 'idempotency-key': newId() },
  ...(payload === undefined ? {} : { payload: payload as never }),
});
const intent = (payload: Record<string, unknown>) => call('POST', `/box/v1/station/${stationId}/intents`, {
  type: 'checkin.update', payload, lastSeenSequence: 0, actionId: newId(),
});
const flush = async () => {
  link.cut = false;
  await agent.setOffline(false);
  for (let n = 0; n < 12; n++) if ((await agent.outbox()!.flush()).state !== 'pushed') break;
};
const readConsent = async (id: string) => (await ctx.db.select().from(registration).where(eq(registration.id, id)))[0]!.consentRecordedAt?.toISOString() ?? null;
const consentAudits = (id: string) => ctx.db.select().from(auditLog).where(and(
  eq(auditLog.entityType, 'registration'), eq(auditLog.entityId, id), eq(auditLog.action, 'registration.update'),
  sql`${auditLog.after}->>'event' = 'consent_at_check_in'`,
));

beforeAll(async () => {
  ctx = await createTestContext({ env: { OPS_TEST_CONTROLS: 'true',
    STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } });
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const box = await boxBySlot(ctx.db, 'virtual-1'); boxId = box.id; branchId = box.branchId;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.boxId, boxId), eq(station.name, 'Reception Till 1')));
  stationId = till!.id;
  expect((await call('PUT', '/me/session/station', { stationId })).statusCode).toBe(200);
  const [pkg] = await ctx.db.select().from(ticketPackage).where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  packageId = pkg!.id;
  agent = linkedAgent(ctx, boxId, 's708-consent', link, { devices: true });
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig(); await agent.syncCache(); attachInProcessBox(agent);
}, 180_000);
afterEach(async () => { await flush(); });
afterAll(async () => { agent?.stop(); if (agent) detachInProcessBox(agent); await ctx?.close(); await teardownAll(); });

async function booked(consentAt: string | null = null) {
  const registrationId = newId(), checkinId = newId(), saleId = newId();
  const created = await call('POST', '/checkin/registrations', {
    id: registrationId, branchId, stationId, guardianName: 'ZZ TEST consent review', contactChannel: 'whatsapp',
    consentAcknowledged: true, acknowledgedConfirmationIds: ['confirm-15min', 'confirm-no-refund', 'confirm-evac'],
    children: [{ checkinId, name: 'ZZ TEST child', ageYears: 7, service: 'drop_off' }],
  });
  expect(created.statusCode, created.body).toBe(200);
  const sale = await call('POST', '/sales', { id: saleId, stationId,
    lines: [{ id: checkinId, packageId, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 22_500 } }],
  });
  expect(sale.statusCode, sale.body).toBe(200);
  const paid = await call('POST', `/sales/${saleId}/finalise`, {});
  expect(paid.statusCode, paid.body).toBe(200);
  const left = await call('POST', '/checkin/leave-as-booked', { saleId, entries: [{ checkinId }] });
  expect(left.statusCode, left.body).toBe(200);
  // Only this synthetic registration: represent the older incomplete record
  // described by D3. Ordinary registration correctly requires consent.
  await ctx.db.update(registration).set({ consentRecordedAt: consentAt ? new Date(consentAt) : null }).where(eq(registration.id, registrationId));
  expect(await agent.syncCheckin()).toBe(true);
  await agent.setOffline(true); link.cut = true;
  return { registrationId, checkinId, saleId };
}
async function arrive(stay: Awaited<ReturnType<typeof booked>>, at?: string) {
  const response = await intent({ event: 'check_in_now', saleId: stay.saleId, entries: [{ checkinId: stay.checkinId }],
    ...(at ? { consent: { acknowledged: true, at } } : {}),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().result;
}
async function factFor(checkinId: string) {
  const [fact] = await ctx.db.select().from(syncEvent).where(and(eq(syncEvent.type, CHECKIN_FACTS.updated),
    sql`${syncEvent.payload}->>'checkinId' = ${checkinId}`));
  expect(fact).toBeDefined();
  return fact!;
}

describe('SCRUM-708: fresh consent at the counter, preserved through reconnect', () => {
  it('HIGH pin: never replay with the reconnect time; carry the acknowledgement time and name the source fact in one audit', async () => {
    const stay = await booked();
    const at = new Date(Date.now() - 120_000).toISOString();
    await arrive(stay, at);
    expect(await readConsent(stay.registrationId)).toBeNull();
    await flush();
    expect(await readConsent(stay.registrationId)).toBe(at);
    const fact = await factFor(stay.checkinId);
    expect(fact.payload).toMatchObject({ consent: { acknowledged: true, at } });
    const audits = await consentAudits(stay.registrationId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ sourceEventId: fact.eventId, before: { consentRecordedAt: null },
      after: { consentRecordedAt: at, event: 'consent_at_check_in' } });
    // A restored store can resend the same press under a new envelope. The
    // original band/sale guard must also protect the registration audit.
    await agent.outbox()!.queue({ type: CHECKIN_FACTS.updated, stationId, actorKind: 'account',
      actorAccountId: fact.actorAccountId, actionId: newId(), payload: fact.payload as Record<string, unknown> });
    await flush(); await flush();
    expect(await readConsent(stay.registrationId)).toBe(at);
    expect(await consentAudits(stay.registrationId)).toHaveLength(1);
  });

  it.each(['cached', 'recorded online after the cache'] as const)(
    'HIGH pin: preserve consent %s; update only a null registration, including the replay race', async mode => {
      const existing = new Date(Date.now() - 600_000).toISOString();
      const stay = await booked(mode === 'cached' ? existing : null);
      await arrive(stay, new Date(Date.now() - 60_000).toISOString());
      if (mode !== 'cached') await ctx.db.update(registration).set({ consentRecordedAt: new Date(existing) }).where(eq(registration.id, stay.registrationId));
      await flush();
      expect(await readConsent(stay.registrationId)).toBe(existing);
      expect(await consentAudits(stay.registrationId)).toHaveLength(0);
    },
  );

  it('HIGH pin: an older fact without consent still checks in and leaves null consent unchanged; keep the field optional', async () => {
    const stay = await booked(new Date(Date.now() - 600_000).toISOString());
    await arrive(stay);
    // Produce the pre-708 shape with a real agent, then model the incomplete
    // platform record it encounters. No acknowledgement is invented by replay.
    await ctx.db.update(registration).set({ consentRecordedAt: null }).where(eq(registration.id, stay.registrationId));
    await flush();
    expect((await factFor(stay.checkinId)).payload).not.toHaveProperty('consent');
    expect(await readConsent(stay.registrationId)).toBeNull();
    const [child] = await ctx.db.select().from(checkin).where(eq(checkin.id, stay.checkinId));
    expect(child).toMatchObject({ status: 'in_park', saleId: stay.saleId, offline: true });
    expect(await consentAudits(stay.registrationId)).toHaveLength(0);
  });

  it('HIGH pin: missing acknowledgement refuses before issuing a band, with the online consent sentence', async () => {
    const stay = await booked();
    const response = await intent({ event: 'check_in_now', saleId: stay.saleId, entries: [{ checkinId: stay.checkinId }] });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: 'CONSENT_REQUIRED',
      message: "The guardian's consent isn't on file — tick the consent before checking them in." });
    expect(await readConsent(stay.registrationId)).toBeNull();
  });

  it('no accepted arrival was quarantined', async () => {
    const held = await ctx.db.select().from(syncQuarantine).where(and(eq(syncQuarantine.boxId, boxId), eq(syncQuarantine.status, 'open')));
    expect(held.map(row => row.errorCode)).toEqual([]);
  });
});
