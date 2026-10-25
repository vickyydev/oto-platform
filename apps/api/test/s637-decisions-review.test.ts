import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account, alert, band, bandEvent, box, branch, checkin, endOfDay, occupancyResolution,
  operator, paymentAttempt, registration, role, roleAssignment, rolePermission, sale,
  station, syncQuarantine,
} from '@oto/db';
import { newId, type EodLine } from '@oto/shared';
import { summaryBranchToday, type SummaryBranch } from '../src/services/analytics-summary';
import { consoleDecisionsOf, type ConsoleDecisionsSnapshot, type DecisionKey } from '../src/services/console-decisions';
import { strandedOf } from '../src/services/occupancy';
import { BRANCH_MANAGER, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let cookie: string;
let actorId: string;
let operatorId: string;
let overviewRole: string;
const NOW = new Date('2026-10-25T03:30:00.000Z');
const BEFORE = new Date(NOW.getTime() - 60 * 60_000);
const KEYS: DecisionKey[] = ['pendingPayments', 'syncQuarantine', 'cashVariances', 'latePayments',
  'strandedOccupants', 'erasureRequests', 'approvalRequests'];
const privateMarker = 'ZZ TEST private source detail';

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [actor] = await ctx.db.select().from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  actorId = actor!.id;
  operatorId = actor!.operatorId!;
  overviewRole = newId();
  await ctx.db.insert(role).values({ id: overviewRole, operatorId, name: 'ZZ TEST decisions Overview only' });
  await ctx.db.insert(rolePermission).values({ id: newId(), roleId: overviewRole, permission: 'console:overview:read' });
}, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

async function estate() {
  const foreignOperator = newId();
  await ctx.db.insert(operator).values({ id: foreignOperator, name: 'ZZ TEST decisions foreign' });
  const ids = [newId(), newId(), newId(), newId()];
  const rows = await ctx.db.insert(branch).values(ids.map((id, index) => ({
    id, operatorId: index === 2 ? foreignOperator : operatorId,
    code: `ZZ TEST ${id}`, name: `ZZ TEST decisions park ${index}`,
    timezone: index === 1 ? 'Pacific/Honolulu' : 'Asia/Bangkok', businessDayStart: '05:00',
    archivedAt: index === 3 ? NOW : null,
  }))).returning();
  const a = rows.find(row => row.id === ids[0])!;
  const b = rows.find(row => row.id === ids[1])!;
  const foreign = rows.find(row => row.id === ids[2])!;
  const archived = rows.find(row => row.id === ids[3])!;
  const stations = await ctx.db.insert(station).values([a, b, foreign].map(park => ({
    id: newId(), operatorId: park.operatorId, branchId: park.id, name: `ZZ TEST station ${park.id}`,
  }))).returning();
  const boxes = await ctx.db.insert(box).values([a, b, foreign].map(park => ({
    id: newId(), operatorId: park.operatorId, branchId: park.id,
    name: `ZZ TEST box ${park.id}`, slot: `zz-test-${park.id}`,
  }))).returning();
  await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, actorId));
  await ctx.db.insert(roleAssignment).values([a, b].map(park => ({
    id: newId(), accountId: actorId, roleId: overviewRole, scopeType: 'branch' as const, scopeId: park.id,
  })));
  return { a, b, foreign, archived, foreignOperator,
    stationA: stations.find(row => row.branchId === a.id)!, stationB: stations.find(row => row.branchId === b.id)!,
    foreignStation: stations.find(row => row.branchId === foreign.id)!,
    boxA: boxes.find(row => row.branchId === a.id)!, boxB: boxes.find(row => row.branchId === b.id)!,
    foreignBox: boxes.find(row => row.branchId === foreign.id)!,
  };
}
type Estate = Awaited<ReturnType<typeof estate>>;
function read(f: Estate, selected: readonly SummaryBranch[] = [f.a, f.b], now = NOW) {
  return consoleDecisionsOf(ctx.db, { operatorId, selected, now, pendingMinutes: 10 });
}
async function overview(branchId?: string): Promise<ConsoleDecisionsSnapshot> {
  const response = await ctx.app.inject({ method: 'GET', url: `/overview${branchId ? `?branchId=${branchId}` : ''}`, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body).toHaveProperty('decisions');
  return body.decisions as ConsoleDecisionsSnapshot;
}
function item(snapshot: ConsoleDecisionsSnapshot, key: DecisionKey, branchId?: string) {
  const items = branchId ? snapshot.parks.find(park => park.branchId === branchId)?.items : snapshot.items;
  const result = items?.find(entry => entry.key === key);
  expect(result, `missing decision ${key}`).toBeDefined();
  return result!;
}
async function pending(f: Estate, extra: Partial<typeof paymentAttempt.$inferInsert> = {}) {
  const id = newId();
  await ctx.db.insert(paymentAttempt).values({
    id, operatorId, branchId: f.a.id, stationId: f.stationA.id, businessDate: '2026-10-25',
    method: 'card', provider: 'manual', status: 'unknown', createdAt: BEFORE,
    payload: { note: privateMarker }, ...extra,
  });
  return id;
}
async function quarantined(f: Estate, extra: Partial<typeof syncQuarantine.$inferInsert> = {}) {
  await ctx.db.insert(syncQuarantine).values({
    id: newId(), boxId: f.boxA.id, eventId: newId(), journalEpoch: 1, boxSeq: 1,
    reason: 'poison', status: 'open', payload: { note: privateMarker }, errorMessage: privateMarker, ...extra,
  });
}
async function late(f: Estate, extra: Partial<typeof alert.$inferInsert> = {}) {
  const id = newId();
  await ctx.db.insert(alert).values({
    id, key: `ZZ TEST ${id}`, operatorId, branchId: f.a.id, category: 'payments.late_payment',
    subject: privateMarker, summary: privateMarker, detail: { note: privateMarker }, ...extra,
  });
}
async function close(f: Estate, park: SummaryBranch, lines: EodLine[], extra: Partial<typeof endOfDay.$inferInsert> = {}) {
  await ctx.db.insert(endOfDay).values({
    id: newId(), operatorId, branchId: park.id, businessDate: summaryBranchToday(park, NOW), lines,
    floatSatang: 0, floatLeftSatang: 0, totalExpectedSatang: 0, totalActualSatang: 0,
    totalDifferenceSatang: 0, closedByAccountId: actorId, closedAt: NOW, notes: privateMarker, ...extra,
  });
}
const line = (channel: string, differenceSatang: number, actualSatang: number | null = 0): EodLine => ({
  channel, expectedSatang: 0, actualSatang, differenceSatang,
});

async function inside(f: Estate) {
  const saleId = newId(), adult = newId(), child = newId(), checkinId = newId(), registrationId = newId();
  const entered = new Date(NOW.getTime() - 20 * 60_000);
  await ctx.db.insert(sale).values({
    id: saleId, operatorId, branchId: f.a.id, stationId: f.stationA.id, createdByAccountId: actorId,
    businessDate: summaryBranchToday(f.a, NOW), businessDayStart: '05:00', timezone: f.a.timezone,
    occurredAt: entered, pricingMode: 'weekday', pricingModeReason: 'ZZ TEST local fixture',
    customerTier: 'ZZ TEST', engineVersion: 'ZZ TEST', taxConfig: {}, taxBreakdown: [],
  });
  await ctx.db.insert(band).values([
    { id: adult, operatorId, branchId: f.a.id, saleId, kind: 'adult', gateAccess: true, code: `ZZ TEST ${adult}` },
    { id: child, operatorId, branchId: f.a.id, saleId, kind: 'kid', gateAccess: false, code: `ZZ TEST ${child}` },
  ]);
  await ctx.db.insert(bandEvent).values({ id: newId(), bandId: adult, kind: 'entry', stationId: f.stationA.id, createdAt: entered });
  await ctx.db.insert(registration).values({ id: registrationId, operatorId, branchId: f.a.id, guardianName: privateMarker });
  await ctx.db.insert(checkin).values({ id: checkinId, operatorId, branchId: f.a.id, registrationId,
    childName: privateMarker, childAgeYears: 5, service: 'drop_off', status: 'in_park', checkedInAt: entered });
  return { adult, child, checkinId, entered };
}

describe('SCRUM-637 real HTTP decision add-on and native source contracts', () => {
  it('R1 high: one Overview read returns all seven scoped decision items without requiring detail-screen grants', async () => {
    const f = await estate();
    const result = await overview();
    expect(Number.isFinite(Date.parse(result.generatedAt))).toBe(true);
    expect(result.items.map(entry => entry.key)).toEqual(KEYS);
    expect(result.parks.map(park => park.branchId).sort()).toEqual([f.a.id, f.b.id].sort());
    for (const park of result.parks) expect(park.items.map(entry => entry.key)).toEqual(KEYS);
    expect(Object.keys(result).sort()).toEqual(['generatedAt', 'items', 'parks']);
    for (const entry of [...result.items, ...result.parks.flatMap(park => park.items)]) {
      expect(Object.keys(entry).sort()).toEqual(['basis', 'count', 'key', 'label', 'status']);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.basis.length).toBeGreaterThan(0);
    }
  });

  it('R2 high: pending payment counts preserve the native states and exclude stationless hosted checkouts', async () => {
    const f = await estate();
    for (const status of ['sent_to_terminal', 'unknown', 'inquiring'] as const) await pending(f, { status });
    await pending(f, { stationId: null });
    await pending(f, { status: 'created' });
    await pending(f, { status: 'approved' });
    await pending(f, { status: 'awaiting_staff_confirmation' });
    await pending(f, { createdAt: new Date(Date.now() + 60_000) });
    await pending(f, { branchId: f.b.id, stationId: f.stationB.id });
    const result = await overview(f.a.id);
    expect(item(result, 'pendingPayments')).toEqual({ key: 'pendingPayments', label: 'Payments awaiting an answer',
      status: 'available', count: 3, basis: 'station-attempts-older-than-native-pending-threshold' });
    expect(item(result, 'pendingPayments', f.a.id).count).toBe(3);
    expect(result.parks).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(privateMarker);
  });

  it('R3 high: open quarantine count is park-scoped rather than the existing operator-wide first-page count', async () => {
    const f = await estate();
    await quarantined(f);
    await quarantined(f, { status: 'replayed' });
    await quarantined(f, { status: 'discarded' });
    await quarantined(f, { boxId: f.boxB.id });
    await quarantined(f, { boxId: f.foreignBox.id });
    await ctx.db.update(box).set({ archivedAt: NOW }).where(eq(box.id, f.boxA.id));
    const result = await overview(f.a.id);
    expect(item(result, 'syncQuarantine')).toMatchObject({ status: 'available', count: 1, basis: 'open-quarantine-events-in-selected-parks' });
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    expect(JSON.stringify(result)).not.toContain(f.foreignBox.id);
  });

  it('R4 high: late-payment alerts retain both native categories and acknowledgment is not resolution', async () => {
    const f = await estate();
    await late(f, { occurrences: 9, reopenCount: 2 });
    await late(f, { category: 'bookings.late_payment', acknowledgedAt: NOW, acknowledgedByAccountId: actorId });
    await late(f, { resolvedAt: NOW, status: 'resolved' });
    await late(f, { category: 'payments.pending' });
    await late(f, { operatorId: null });
    await late(f, { operatorId: f.foreignOperator, branchId: f.a.id });
    await late(f, { branchId: f.b.id });
    const result = await overview(f.a.id);
    expect(item(result, 'latePayments')).toMatchObject({ status: 'available', count: 2, basis: 'unresolved-native-late-payment-alert-rows' });
    expect(JSON.stringify(result)).not.toContain(privateMarker);
  });

  it('R5 medium: missing erasure and approval queues are explicitly not built, never fabricated zeroes', async () => {
    const f = await estate();
    const result = await overview(f.a.id);
    for (const [key, basis] of [['erasureRequests', 'suite-erasure-request-queue-not-built'],
      ['approvalRequests', 'dual-control-request-queue-not-built']] as const) {
      expect(item(result, key)).toMatchObject({ status: 'not-built', count: null, basis });
      expect(item(result, key, f.a.id)).toMatchObject({ status: 'not-built', count: null, basis });
    }
  });

  it('R6 high: removing Overview reach refuses the next whole read rather than returning an old decision snapshot', async () => {
    const f = await estate();
    await overview(f.a.id);
    await ctx.db.delete(roleAssignment).where(eq(roleAssignment.accountId, actorId));
    const result = await ctx.app.inject({ method: 'GET', url: '/overview', headers: { cookie } });
    expect(result.statusCode).toBe(403);
    expect(result.json()).not.toHaveProperty('decisions');
  });
});

describe('SCRUM-637 exact clock, count and ownership review', () => {
  it('R7 medium: native pending threshold is strictly older, not equal or a replacement provider-poller rule', async () => {
    const f = await estate(), cutoff = new Date(NOW.getTime() - 10 * 60_000);
    await pending(f, { createdAt: new Date(cutoff.getTime() - 1), method: 'cash', provider: 'manual' });
    await pending(f, { createdAt: cutoff });
    await pending(f, { createdAt: new Date(cutoff.getTime() + 1) });
    expect(item(await read(f), 'pendingPayments').count).toBe(1);
  });

  it('R8 high: pending reference ownership is checked against the actual station and branch, including stale descriptors', async () => {
    const f = await estate();
    await pending(f);
    await pending(f, { operatorId: f.foreignOperator });
    await pending(f, { stationId: f.foreignStation.id });
    await pending(f, { stationId: f.stationB.id });
    await pending(f, { branchId: f.foreign.id, stationId: f.foreignStation.id });
    await pending(f, { branchId: f.archived.id });
    await ctx.db.update(station).set({ archivedAt: NOW }).where(eq(station.id, f.stationA.id));
    const result = await read(f, [f.a, f.foreign, { ...f.archived, archivedAt: null }]);
    expect(result.parks.map(park => park.branchId)).toEqual([f.a.id]);
    expect(item(result, 'pendingPayments').count).toBe(1);
  });

  it('R9 medium: exact pending and quarantine counts are not truncated to existing page or watchdog batch sizes', async () => {
    const f = await estate();
    await ctx.db.insert(paymentAttempt).values(Array.from({ length: 503 }, () => ({
      id: newId(), operatorId, branchId: f.a.id, stationId: f.stationA.id,
      businessDate: '2026-10-25', method: 'card' as const, status: 'unknown' as const, createdAt: BEFORE,
    })));
    await ctx.db.insert(syncQuarantine).values(Array.from({ length: 205 }, (_, index) => ({
      id: newId(), boxId: f.boxA.id, eventId: newId(), journalEpoch: 1, boxSeq: index + 1,
      reason: 'poison' as const, payload: {},
    })));
    const result = await read(f);
    expect(item(result, 'pendingPayments').count).toBe(503);
    expect(item(result, 'syncQuarantine').count).toBe(205);
  });

  it('R10 high: saved cash reconciliation uses native off-line tolerance, not a cancelling total difference', async () => {
    const f = await estate();
    await close(f, f.a, [line('cash', 101), line('card:ZZ-TEST', -101), line('method:ZZ-TEST', 100), line('bank_transfer', -100), line('credit', 9000, null)]);
    await close(f, f.b, [line('cash', 0)]);
    const result = await read(f);
    expect(item(result, 'cashVariances')).toEqual({ key: 'cashVariances', label: 'Recorded reconciliation lines off',
      status: 'available', count: 2, basis: 'counted-lines-off-in-saved-current-business-date-close' });
    expect(item(result, 'cashVariances', f.a.id).count).toBe(2);
    expect(item(result, 'cashVariances', f.b.id).count).toBe(0);
  });

  it('R11 medium: a missing current-day reconciliation is unavailable, not an uncounted zero or partial total', async () => {
    const f = await estate();
    await close(f, f.a, [line('cash', 101)]);
    await close(f, f.b, [line('cash', 9000)], { businessDate: '2026-10-23' });
    const result = await read(f);
    expect(item(result, 'cashVariances', f.a.id)).toMatchObject({ status: 'available', count: 1 });
    expect(item(result, 'cashVariances', f.b.id)).toMatchObject({ status: 'unavailable', count: null, basis: 'current-business-date-not-reconciled' });
    expect(item(result, 'cashVariances')).toMatchObject({ status: 'unavailable', count: null });
  });

  it('R12 high: each saved close follows that park business date and cannot be substituted with another operator record', async () => {
    const f = await estate();
    expect(summaryBranchToday(f.a, NOW)).not.toBe(summaryBranchToday(f.b, NOW));
    await close(f, f.a, [line('cash', 101)], { operatorId: f.foreignOperator });
    await close(f, f.b, [line('cash', -101)]);
    const result = await read(f);
    expect(item(result, 'cashVariances', f.a.id)).toMatchObject({ status: 'unavailable', count: null });
    expect(item(result, 'cashVariances', f.b.id)).toMatchObject({ status: 'available', count: 1 });
    expect(item(result, 'cashVariances')).toMatchObject({ status: 'unavailable', count: null });
  });

  it('R13 high: malformed saved reconciliation cannot be presented as successfully matched', async () => {
    const f = await estate();
    await close(f, f.a, [{}] as EodLine[]);
    await expect(read(f, [f.a])).rejects.toThrow();
  });

  it('R14 medium: native end-of-day review rows include ordinary current occupants and grouped children without an invented overdue threshold', async () => {
    const f = await estate();
    await inside(f);
    const native = await strandedOf(ctx.db, { operatorId, branchId: f.a.id, date: summaryBranchToday(f.a, NOW), now: NOW });
    expect(native.rows).toHaveLength(2);
    expect(native.rows.find(row => row.kind === 'band')!.childrenWithBand).toBe(1);
    const result = await read(f, [f.a]);
    expect(item(result, 'strandedOccupants')).toEqual({ key: 'strandedOccupants',
      label: 'End-of-day review rows still inside', status: 'available', count: native.rows.length,
      basis: 'current-business-date-native-end-of-day-rows' });
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    expect(JSON.stringify(result)).not.toContain('overdue');
  });

  it('R15 medium: native manual resolutions remove review rows at their effective time without inventing exit events', async () => {
    const f = await estate(), records = await inside(f);
    await ctx.db.insert(occupancyResolution).values({
      id: newId(), operatorId, branchId: f.a.id, businessDate: summaryBranchToday(f.a, NOW), kind: 'checkin',
      checkinId: records.checkinId, reason: 'left_without_scanning', resolvedByAccountId: actorId,
      resolvedAt: new Date(NOW.getTime() - 1_000), actionId: `ZZ TEST ${newId()}`,
    });
    const result = await read(f, [f.a]);
    expect(item(result, 'strandedOccupants').count).toBe(1);
    expect(item(result, 'strandedOccupants', f.a.id).count).toBe(1);
  });

  it('R16 high: an empty selection returns genuine scoped zeros while retaining not-built queue states', async () => {
    const f = await estate();
    await pending(f); await quarantined(f); await late(f);
    const result = await read(f, []);
    expect(result.parks).toEqual([]);
    expect(result.generatedAt).toBe(NOW.toISOString());
    for (const key of ['pendingPayments', 'syncQuarantine', 'latePayments', 'strandedOccupants'] as const) {
      expect(item(result, key)).toMatchObject({ status: 'available', count: 0 });
    }
    for (const key of ['erasureRequests', 'approvalRequests'] as const) expect(item(result, key)).toMatchObject({ status: 'not-built', count: null });
  });

  it('R17 high: repeated reads preserve every synthetic source record and expose only decision fields', async () => {
    const f = await estate();
    await pending(f); await quarantined(f); await late(f);
    await close(f, f.a, [line('cash', 101)]);
    const fingerprint = async () => createHash('sha256').update(JSON.stringify({
      attempts: await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.branchId, f.a.id)),
      quarantine: await ctx.db.select().from(syncQuarantine).where(eq(syncQuarantine.boxId, f.boxA.id)),
      alerts: await ctx.db.select().from(alert).where(eq(alert.branchId, f.a.id)),
      closes: await ctx.db.select().from(endOfDay).where(eq(endOfDay.branchId, f.a.id)),
    })).digest('hex');
    const before = await fingerprint();
    const first = await read(f, [f.a]), second = await read(f, [f.a]);
    expect(first).toEqual(second);
    expect(await fingerprint()).toBe(before);
    const raw = JSON.stringify(second);
    for (const key of ['amountSatang', 'payload', 'phone', 'childName', 'guardian', 'subjectId', 'qrPayload']) expect(raw).not.toContain(`"${key}"`);
    expect(raw).not.toContain(privateMarker);
    expect(second.items.map(entry => entry.key)).toEqual(KEYS);
  });
});
