import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  auditLog,
  box,
  boxCommand,
  device,
  deviceCredential,
  idempotencyKey,
  opsRun,
  role,
  roleAssignment,
  session as sessionTable,
  station,
  stationStaff,
  account,
} from '@oto/db';
import { newId } from '@oto/shared';
import { boxCredential } from '@oto/box-agent';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { expireStaleCommands, issueClaimCode } from '../src/services/box';

/**
 * S2-04, second half — the fleet's ordinary HTTP surface.
 *
 * The first half shipped the schema, the box protocol and two front ends that
 * each invented their own contract for routes nobody had written. What this
 * pins is the part the ticket actually exists for: **a station somebody may
 * not use is absent from their picker**, which until now was enforced in no
 * query anywhere — `station_staff` had not a single reader in the whole api —
 * and whose acceptance criterion could therefore neither pass nor fail.
 *
 * Beside it, the four security findings: a station edit that resolves its own
 * branch rather than borrowing the caller's, a one-time code that never enters
 * the idempotency store, revocation that takes effect at the next request, and
 * a refused box that is attributable.
 */

let ctx: TestContext;
let adminCookie: string;
let receptionCookie: string;
let branchId: string;
let boxId: string;
let tillId: string;
let boothId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [b] = await ctx.db.select().from(box).where(eq(box.slot, 'virtual-1')).limit(1);
  boxId = b!.id;
  branchId = b!.branchId;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(eq(station.name, 'Reception Till 1'))
    .limit(1);
  tillId = till!.id;
  const [booth] = await ctx.db.select().from(station).where(eq(station.name, 'Booth 1')).limit(1);
  boothId = booth!.id;
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

interface Injected {
  statusCode: number;
  body: Record<string, unknown>;
  /** `x-oto-replay` is how a replay is told apart from a second piece of work. */
  replayed: boolean;
}

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  opts: { cookie?: string; payload?: unknown; headers?: Record<string, string> } = {},
): Promise<Injected> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    ...(opts.payload === undefined ? {} : { payload: opts.payload as never }),
  });
  let body: unknown = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return {
    statusCode: res.statusCode,
    body: body as Injected['body'],
    replayed: res.headers['x-oto-replay'] === 'true',
  };
}

/**
 * A slot nothing else at the branch has taken. NOT the head of a `newId()`:
 * the first characters of a UUIDv7 are a millisecond timestamp, so two of them
 * minted in the same tick are the same string and the test fails on a unique
 * index rather than on what it is testing.
 */
let slotCounter = 0;
const uniqueSlot = (prefix: string): string => `${prefix}-${(slotCounter += 1)}`;

const errorCode = (res: Injected): string =>
  (res.body as { error?: { code?: string } }).error?.code ?? `(no error, ${res.statusCode})`;

// ---------------------------------------------------------------------------

describe('the station picker — the visibility rule (S2-04)', () => {
  it('reception sees the open station and not the restricted one; the administrator sees both', async () => {
    const mine = await call('GET', '/me/stations', { cookie: receptionCookie });
    expect(mine.statusCode).toBe(200);
    const names = (mine.body.stations as Array<{ name: string }>).map((s) => s.name);
    // The whole ticket, in one assertion: Booth 1 is ABSENT, not flagged.
    expect(names).toEqual(['Reception Till 1']);

    const asAdmin = await call('GET', '/me/stations', { cookie: adminCookie });
    expect((asAdmin.body.stations as Array<{ name: string }>).map((s) => s.name)).toEqual([
      'Booth 1',
      'Reception Till 1',
    ]);
  });

  it('carries the box and what is plugged into it, and nothing a hidden station could be read from', async () => {
    const mine = await call('GET', '/me/stations', { cookie: receptionCookie });
    const [tile] = mine.body.stations as Array<Record<string, unknown>>;
    expect(tile).toMatchObject({ id: tillId, kind: 'till', boxId, boxName: 'Virtual box 1' });
    expect(tile!.deviceCount).toBe(7);
    // No `visible`, no `available`, no `reason`: a field a client could use to
    // discover a hidden station defeats the rule this route exists for.
    expect(Object.keys(tile!).sort()).toEqual([
      'accessScope',
      'boxId',
      'boxName',
      'boxStatus',
      'deviceCount',
      'id',
      'kind',
      'name',
    ]);
  });

  it('refuses a restricted station picked by id, and says which kind of no it is', async () => {
    const res = await call('PUT', '/me/session/station', {
      cookie: receptionCookie,
      payload: { stationId: boothId },
    });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('STATION_NOT_YOURS');
  });

  it('lets the administrator take it, records the station on the session, and audits the pick', async () => {
    const res = await call('PUT', '/me/session/station', {
      cookie: adminCookie,
      payload: { stationId: boothId },
    });
    expect(res.statusCode).toBe(200);
    const picked = res.body.station as Record<string, unknown>;
    expect(picked.id).toBe(boothId);
    // The answer goes to the device that just took the station; who ELSE may
    // take it is the administrator's business and is not sent here.
    expect(picked.staff).toEqual([]);

    const [row] = await ctx.db
      .select({ stationId: sessionTable.stationId })
      .from(sessionTable)
      .where(eq(sessionTable.stationId, boothId))
      .limit(1);
    expect(row?.stationId).toBe(boothId);

    const [recorded] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'session.station_pick'), eq(auditLog.entityId, boothId)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(recorded).toBeTruthy();
  });

  it('adding somebody to the list makes the station appear on their next load, and picking it works', async () => {
    const [acc] = await ctx.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.phone, RECEPTION.phone))
      .limit(1);
    const [admin] = await ctx.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.phone, ADMIN.phone))
      .limit(1);
    await ctx.db
      .insert(stationStaff)
      .values({ id: newId(), stationId: boothId, accountId: acc!.id, addedBy: admin!.id });

    const mine = await call('GET', '/me/stations', { cookie: receptionCookie });
    expect((mine.body.stations as Array<{ name: string }>).map((s) => s.name)).toEqual([
      'Booth 1',
      'Reception Till 1',
    ]);
    const pick = await call('PUT', '/me/session/station', {
      cookie: receptionCookie,
      payload: { stationId: boothId },
    });
    expect(pick.statusCode).toBe(200);

    // And taking it away hides it again — the removal bites at the next load.
    await ctx.db
      .delete(stationStaff)
      .where(and(eq(stationStaff.stationId, boothId), eq(stationStaff.accountId, acc!.id)));
    const after = await call('GET', '/me/stations', { cookie: receptionCookie });
    expect((after.body.stations as Array<{ name: string }>).map((s) => s.name)).toEqual([
      'Reception Till 1',
    ]);
    /**
     * Not evicted mid-shift, deliberately: `session.station_id` still points at
     * Booth 1 and the person keeps working it until they switch or sign out.
     * This is the ABSENCE of a check rather than a check that passes, so it is
     * pinned here to stop a later reviewer "fixing" it.
     */
    const [held] = await ctx.db
      .select({ stationId: sessionTable.stationId })
      .from(sessionTable)
      .where(eq(sessionTable.accountId, acc!.id))
      .orderBy(desc(sessionTable.createdAt))
      .limit(1);
    expect(held?.stationId).toBe(boothId);
    // Put reception back where the rest of the file expects to find it.
    await call('PUT', '/me/session/station', {
      cookie: receptionCookie,
      payload: { stationId: tillId },
    });
  });

  it('answers a station that does not exist, and an archived one, the same way', async () => {
    const missing = await call('PUT', '/me/session/station', {
      cookie: receptionCookie,
      payload: { stationId: newId() },
    });
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing)).toBe('STATION_NOT_FOUND');

    const id = newId();
    await ctx.db.insert(station).values({
      id,
      operatorId: (await ctx.db.select().from(station).where(eq(station.id, tillId)).limit(1))[0]!
        .operatorId,
      branchId,
      boxId,
      name: 'Archived Till',
      kind: 'till',
      archivedAt: new Date(),
    });
    const archived = await call('PUT', '/me/session/station', {
      cookie: receptionCookie,
      payload: { stationId: id },
    });
    // "Taken off the floor" and "no such till" are the same fact to somebody
    // who cannot see the estate.
    expect(archived.statusCode).toBe(404);
    const mine = await call('GET', '/me/stations', { cookie: receptionCookie });
    expect((mine.body.stations as Array<{ name: string }>)).not.toContainEqual(
      expect.objectContaining({ name: 'Archived Till' }),
    );
  });
});

// ---------------------------------------------------------------------------

describe('a station edit resolves its own branch (S2-04 review, finding 2)', () => {
  let otherBranchId: string;
  let otherStationId: string;

  it('sets up a second branch with a station of its own', async () => {
    const created = await call('POST', '/branches', {
      cookie: adminCookie,
      payload: { name: 'Second Branch', code: 'second-branch', timezone: 'Asia/Bangkok' },
    });
    expect(created.statusCode).toBe(200);
    otherBranchId = created.body.id as string;

    const madeBox = await call('POST', `/branches/${otherBranchId}/boxes`, {
      cookie: adminCookie,
      payload: { name: 'Second box', slot: 'counter-1', role: 'counter' },
    });
    expect(madeBox.statusCode).toBe(200);
    const otherBoxId = (madeBox.body.box as { id: string }).id;

    const madeStation = await call('POST', `/branches/${otherBranchId}/stations`, {
      cookie: adminCookie,
      payload: {
        name: 'Second Till',
        kind: 'till',
        boxId: otherBoxId,
        capabilities: ['tickets'],
        accessScope: 'all_staff',
        staffAccountIds: [],
        devices: [],
      },
    });
    expect(madeStation.statusCode).toBe(200);
    otherStationId = (madeStation.body.station as { id: string }).id;
  });

  it('refuses a branch-scoped manager editing a station at another branch', async () => {
    // Give reception a manager's permissions at HKT Central and nowhere else.
    const [acc] = await ctx.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.phone, RECEPTION.phone))
      .limit(1);
    const [managerRole] = await ctx.db
      .select({ id: role.id })
      .from(role)
      .where(eq(role.name, 'branch_manager'))
      .limit(1);
    await ctx.db.insert(roleAssignment).values({
      id: newId(),
      accountId: acc!.id,
      roleId: managerRole!.id,
      scopeType: 'branch',
      scopeId: branchId,
    });
    // A fresh session, because effective permissions are resolved per request
    // but the session's branch is set at sign-in.
    const managerCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

    const own = await call('PATCH', `/stations/${tillId}`, {
      cookie: managerCookie,
      payload: { name: 'Reception Till 1' },
    });
    expect(own.statusCode).toBe(200);

    /**
     * The finding: with a plain `config: { permission }` and no target, the
     * guard would have checked `admin:station:update` against this caller's
     * SESSION branch — HKT Central, where they hold it — and then edited a
     * till at the other branch entirely.
     */
    const elsewhere = await call('PATCH', `/stations/${otherStationId}`, {
      cookie: managerCookie,
      payload: { name: 'Renamed from another branch' },
    });
    expect(elsewhere.statusCode).toBe(403);
    expect(errorCode(elsewhere)).toBe('FORBIDDEN');

    const [unchanged] = await ctx.db
      .select({ name: station.name })
      .from(station)
      .where(eq(station.id, otherStationId))
      .limit(1);
    expect(unchanged!.name).toBe('Second Till');

    // Hand the role back: everything after this asks what a plain member of
    // reception can reach, and a manager would answer differently.
    await ctx.db
      .delete(roleAssignment)
      .where(and(eq(roleAssignment.accountId, acc!.id), eq(roleAssignment.roleId, managerRole!.id)));
  });

  it('refuses a station at another branch on the pick, with its own code', async () => {
    const res = await call('PUT', '/me/session/station', {
      cookie: receptionCookie,
      payload: { stationId: otherStationId },
    });
    expect(res.statusCode).toBe(403);
    // Not 409: the till forgets a remembered station on 403 and 404 and keeps
    // working on anything else, so a 409 here would leave it serving a station
    // at another site.
    expect(errorCode(res)).toBe('STATION_WRONG_BRANCH');
  });

  it('answers another operator’s station as not found, never as not allowed', async () => {
    const res = await call('GET', `/stations/${newId()}`, { cookie: adminCookie });
    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe('STATION_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------

describe('writing a station (S2-04)', () => {
  let scannerId: string;
  let receiptId: string;

  beforeAll(async () => {
    const devices = await ctx.db
      .select()
      .from(device)
      .where(and(eq(device.boxId, boxId), isNull(device.archivedAt)));
    scannerId = devices.find((d) => d.kind === 'scanner')!.id;
    receiptId = devices.find((d) => d.label === 'Receipt Printer 1')!.id;
  });

  const base = (over: Record<string, unknown> = {}) => ({
    name: `Till ${Math.random().toString(36).slice(2, 8)}`,
    kind: 'till',
    boxId,
    capabilities: ['tickets'],
    accessScope: 'all_staff',
    staffAccountIds: [],
    devices: [],
    ...over,
  });

  it('refuses a device that is not on this station’s box', async () => {
    const [otherBox] = await ctx.db
      .select()
      .from(box)
      .where(and(eq(box.slot, 'counter-1'), isNull(box.archivedAt)))
      .limit(1);
    const foreign = newId();
    await ctx.db.insert(device).values({
      id: foreign,
      operatorId: otherBox!.operatorId,
      branchId: otherBox!.branchId,
      boxId: otherBox!.id,
      kind: 'receipt_printer',
      label: 'Somebody else’s printer',
      transport: 'simulated',
    });
    const res = await call('POST', `/branches/${branchId}/stations`, {
      cookie: adminCookie,
      payload: base({ devices: [{ role: 'receipt', deviceId: foreign }] }),
    });
    /**
     * Nothing enforced this before: `configBundle` filtered a cross-box
     * assignment out rather than refusing it, so the Console showed a printer
     * and the till printed nothing, with no error anywhere.
     */
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('DEVICE_NOT_ON_BOX');
  });

  it('refuses a device that cannot do the job asked of it', async () => {
    const res = await call('POST', `/branches/${branchId}/stations`, {
      cookie: adminCookie,
      payload: base({ devices: [{ role: 'receipt', deviceId: scannerId }] }),
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('DEVICE_ROLE_MISMATCH');
  });

  it('refuses two devices on one role, and a station with no box', async () => {
    const twice = await call('POST', `/branches/${branchId}/stations`, {
      cookie: adminCookie,
      payload: base({
        devices: [
          { role: 'receipt', deviceId: receiptId },
          { role: 'receipt', deviceId: receiptId },
        ],
      }),
    });
    expect(twice.statusCode).toBe(400);

    const boxless = await call('POST', `/branches/${branchId}/stations`, {
      cookie: adminCookie,
      payload: base({ boxId: null }),
    });
    expect(boxless.statusCode).toBe(400);
    expect(errorCode(boxless)).toBe('STATION_NEEDS_BOX');
  });

  it('refuses a staff list naming somebody who is not at this branch', async () => {
    const stranger = newId();
    const [seed] = await ctx.db.select().from(account).limit(1);
    await ctx.db.insert(account).values({
      id: stranger,
      operatorId: seed!.operatorId,
      phone: '+66900999001',
      status: 'active',
    });
    const res = await call('POST', `/branches/${branchId}/stations`, {
      cookie: adminCookie,
      payload: base({ accessScope: 'selected_staff', staffAccountIds: [stranger] }),
    });
    // An entry the picker's branch filter would hide the station from anyway
    // looks like access and grants none.
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('STAFF_NOT_AT_BRANCH');
  });

  it('accepts a restricted station with nobody on it yet — a till being prepared', async () => {
    const res = await call('POST', `/branches/${branchId}/stations`, {
      cookie: adminCookie,
      payload: base({ name: 'Prepared Till', accessScope: 'selected_staff', staffAccountIds: [] }),
    });
    expect(res.statusCode).toBe(200);
    const mine = await call('GET', '/me/stations', { cookie: adminCookie });
    expect((mine.body.stations as Array<{ name: string }>)).not.toContainEqual(
      expect.objectContaining({ name: 'Prepared Till' }),
    );
  });

  it('refuses a name a live station at the branch already has', async () => {
    const res = await call('POST', `/branches/${branchId}/stations`, {
      cookie: adminCookie,
      payload: base({ name: 'Reception Till 1' }),
    });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('STATION_NAME_TAKEN');
  });

  it('moves config_version when the box can see the change, and leaves it alone otherwise', async () => {
    const created = await call('POST', `/branches/${branchId}/stations`, {
      cookie: adminCookie,
      payload: base({ name: 'Version Till', codePrefix: 'V1' }),
    });
    const id = (created.body.station as { id: string; configVersion: number }).id;
    const first = (created.body.station as { configVersion: number }).configVersion;

    const noop = await call('PATCH', `/stations/${id}`, {
      cookie: adminCookie,
      payload: { name: 'Version Till' },
    });
    expect((noop.body.station as { configVersion: number }).configVersion).toBe(first);

    const real = await call('PATCH', `/stations/${id}`, {
      cookie: adminCookie,
      payload: { devices: [{ role: 'receipt', deviceId: receiptId }] },
    });
    expect((real.body.station as { configVersion: number }).configVersion).toBe(first + 1);
    expect((real.body.station as { devices: unknown[] }).devices).toHaveLength(1);

    // accessScope is in the bundle the box hashes, so it moves the number too.
    const scope = await call('PATCH', `/stations/${id}`, {
      cookie: adminCookie,
      payload: { accessScope: 'selected_staff' },
    });
    expect((scope.body.station as { configVersion: number }).configVersion).toBe(first + 2);
  });

  it('archives a station and audits it, and will not archive it twice', async () => {
    const created = await call('POST', `/branches/${branchId}/stations`, {
      cookie: adminCookie,
      payload: base({ name: 'Doomed Till' }),
    });
    const id = (created.body.station as { id: string }).id;
    const gone = await call('DELETE', `/stations/${id}`, { cookie: adminCookie });
    expect(gone.statusCode).toBe(200);
    const again = await call('DELETE', `/stations/${id}`, { cookie: adminCookie });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('STATION_ALREADY_ARCHIVED');

    const [recorded] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'station.archive'), eq(auditLog.entityId, id)))
      .limit(1);
    expect(recorded).toBeTruthy();
  });

  it('answers the branch’s staff, and refuses somebody who cannot edit a station', async () => {
    const res = await call('GET', `/branches/${branchId}/staff`, { cookie: adminCookie });
    expect(res.statusCode).toBe(200);
    const phones = (res.body.staff as Array<{ phone: string }>).map((s) => s.phone);
    // The employee half of the definition (reception) and the role-assignment
    // half (the administrator) both have to be in it.
    expect(phones).toContain(RECEPTION.phone);
    expect(phones).toContain(ADMIN.phone);
  });
});

// ---------------------------------------------------------------------------

describe('one-time codes never enter the idempotency store (S2-04 review, F2)', () => {
  /** Everything stored under a key, as the replay would serve it back. */
  async function storedBody(key: string): Promise<string> {
    const [row] = await ctx.db
      .select()
      .from(idempotencyKey)
      .where(eq(idempotencyKey.key, key))
      .limit(1);
    return JSON.stringify(row?.responseBody ?? null);
  }

  it('returns a claim code once, stores a body without it, and replays without it', async () => {
    const key = `box-${newId()}`;
    const res = await call('POST', `/branches/${branchId}/boxes`, {
      cookie: adminCookie,
      headers: { 'idempotency-key': key },
      payload: { name: 'Coded box', slot: uniqueSlot('slot'), role: 'counter' },
    });
    expect(res.statusCode).toBe(200);
    const claimCode = res.body.claimCode as string;
    expect(claimCode).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);

    /**
     * The plugin stores the response body verbatim for the whole replay
     * window, so a code in it is a credential sitting in the database for a
     * day. `withTx` stores the value the callback returned — the one without
     * the code — and claims the key, which is what stops `onSend` storing the
     * fuller body that goes out on the wire.
     */
    expect(await storedBody(key)).not.toContain(claimCode);
    expect(await storedBody(key)).toContain('"box"');

    /**
     * The same request again — a till on a flaky mall connection retrying. It
     * is answered from the stored body, which is the whole point: the box is
     * there and the code is NOT, because a one-time code handed out twice is
     * not one-time. An absent code here means "this was already answered and
     * the code was shown then", and the page has to say so.
     */
    const replay = await call('POST', `/branches/${branchId}/boxes`, {
      cookie: adminCookie,
      headers: { 'idempotency-key': key },
      payload: { name: 'Coded box', slot: (res.body.box as { slot: string }).slot, role: 'counter' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body.claimCode).toBeUndefined();
    expect((replay.body.box as { id: string }).id).toBe((res.body.box as { id: string }).id);

    // And the same key aimed at a different request is still refused.
    const mismatch = await call('POST', `/branches/${branchId}/boxes`, {
      cookie: adminCookie,
      headers: { 'idempotency-key': key },
      payload: { name: 'A different box', slot: uniqueSlot('mismatch'), role: 'counter' },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(errorCode(mismatch)).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('does the same for a re-issued claim code and for a pairing code', async () => {
    const reissueKey = `claim-${newId()}`;
    const reissue = await call('POST', `/boxes/${boxId}/claim-code`, {
      cookie: adminCookie,
      headers: { 'idempotency-key': reissueKey },
    });
    expect(reissue.statusCode).toBe(200);
    expect(await storedBody(reissueKey)).not.toContain(reissue.body.claimCode as string);

    const pairKey = `pair-${newId()}`;
    const paired = await call('POST', `/stations/${tillId}/credentials`, {
      cookie: adminCookie,
      headers: { 'idempotency-key': pairKey },
      payload: { kind: 'display', label: 'Customer display 1' },
    });
    expect(paired.statusCode).toBe(200);
    const pairingCode = paired.body.pairingCode as string;
    expect(pairingCode).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    expect(await storedBody(pairKey)).not.toContain(pairingCode);

    // And the row keeps only the hash: nothing can fetch the code back.
    const [row] = await ctx.db
      .select()
      .from(deviceCredential)
      .where(eq(deviceCredential.id, (paired.body.credential as { id: string }).id))
      .limit(1);
    expect(row!.pairingCodeHash).not.toBe(pairingCode);
    expect(row!.pairingCodeHash).toMatch(/^[0-9a-f]{64}$/);

    // A replay is answered from the stored body — the credential, no code.
    const replay = await call('POST', `/stations/${tillId}/credentials`, {
      cookie: adminCookie,
      headers: { 'idempotency-key': pairKey },
      payload: { kind: 'display', label: 'Customer display 1' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body.pairingCode).toBeUndefined();
    expect(replay.body.credential).toBeTruthy();
  });

  it('never audits a code, only that one was issued and when it dies', async () => {
    const [recorded] = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'device_credential.pair'))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(JSON.stringify(recorded!.after)).not.toMatch(/[0-9A-Z]{5}-[0-9A-Z]{5}/);
    expect(JSON.stringify(recorded!.after)).toContain('expiresAt');
  });

  it('revokes a credential once, and keeps the row', async () => {
    const paired = await call('POST', `/stations/${tillId}/credentials`, {
      cookie: adminCookie,
      payload: { kind: 'kiosk' },
    });
    const id = (paired.body.credential as { id: string }).id;
    const revoked = await call('POST', `/credentials/${id}/revoke`, {
      cookie: adminCookie,
      payload: { reason: 'lost' },
    });
    expect(revoked.statusCode).toBe(200);
    const again = await call('POST', `/credentials/${id}/revoke`, {
      cookie: adminCookie,
      payload: { reason: 'lost' },
    });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('CREDENTIAL_ALREADY_REVOKED');

    const listed = await call('GET', `/branches/${branchId}/credentials`, { cookie: adminCookie });
    expect((listed.body.credentials as Array<{ id: string }>).map((c) => c.id)).not.toContain(id);
    const withRevoked = await call('GET', `/branches/${branchId}/credentials?includeRevoked=true`, {
      cookie: adminCookie,
    });
    expect((withRevoked.body.credentials as Array<{ id: string }>).map((c) => c.id)).toContain(id);
  });

  it('refuses a box credential minted from a station', async () => {
    const res = await call('POST', `/stations/${tillId}/credentials`, {
      cookie: adminCookie,
      payload: { kind: 'box' },
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('CREDENTIAL_KIND_INVALID');
  });

  /**
   * The live secret, not an hour-long code. `POST /box/v1/register` answers
   * with the box's 256-bit credential, and the only thing keeping it out of the
   * store was `!req.auth` in the idempotency plugin — a property of the CALLER.
   * Send the same request with a session cookie and a key and the whole body
   * was filed verbatim for a day, replayable by anyone holding the key.
   */
  it('never files a box’s live secret, even when the register call carries a session', async () => {
    const created = await call('POST', `/branches/${branchId}/boxes`, {
      cookie: adminCookie,
      payload: { name: 'Cookie box', slot: uniqueSlot('cookie'), role: 'counter' },
    });
    const claimCode = created.body.claimCode as string;

    const key = `register-${newId()}`;
    const register = async () =>
      ctx.app.inject({
        method: 'POST',
        url: '/box/v1/register',
        headers: { cookie: adminCookie, 'idempotency-key': key },
        payload: { claimCode, agentVersion: '0.1.0', hostname: 'cookie' },
      });

    const first = await register();
    expect(first.statusCode).toBe(200);
    const secret = (first.json() as { secret: string }).secret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    // No row at all: the route declares `secretResponse`, so no key is claimed
    // and there is nothing to store, nothing to expire and nothing to replay.
    const [row] = await ctx.db
      .select()
      .from(idempotencyKey)
      .where(eq(idempotencyKey.key, key))
      .limit(1);
    expect(row).toBeUndefined();
    expect(await storedBody(key)).not.toContain(secret);

    // And pressing again hands back no secret: the claim code was consumed, so
    // the box is refused rather than answered from a store that never took it.
    const again = await register();
    expect(again.statusCode).toBe(401);
    expect(JSON.stringify(again.json())).not.toContain(secret);
    expect(again.headers['x-oto-replay']).toBeUndefined();
  });

  /**
   * The same shape found by sweeping for it: a temporary password is a working
   * credential for somebody else's account, returned from inside `withTx` and
   * therefore stored by it.
   */
  it('never files a temporary password either', async () => {
    // A throwaway account: issuing a temporary password evicts every live
    // session of the account it is issued for, and the tests after this one
    // are still holding reception's.
    const made = await call('POST', '/accounts', {
      cookie: adminCookie,
      payload: { phone: '+66900999077', employeeName: 'Temp Target', roles: [] },
    });
    expect(made.statusCode).toBe(200);

    const key = `temp-${newId()}`;
    const res = await call('POST', `/accounts/${made.body.id as string}/temp-password`, {
      cookie: adminCookie,
      headers: { 'idempotency-key': key },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.temporaryPassword).toBe('string');

    const [row] = await ctx.db
      .select()
      .from(idempotencyKey)
      .where(eq(idempotencyKey.key, key))
      .limit(1);
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('a double press is absorbed, not answered 500 (S2-04 review)', () => {
  /**
   * `withTx` stores what its callback returns, and the replay sends that back
   * through the route's own serializer. Five services handed back a bare view
   * while their route wrapped it in `{ station }`, `{ box }` or `{ device }`,
   * so the stored body could not satisfy the response schema: the first press
   * answered 200, and the second — the double press the safeguard exists to
   * absorb — answered 500 INTERNAL with `x-oto-replay: true` for the life of
   * the key, writing a failed `ops_run` and a report behind it each time.
   */
  async function press(
    method: 'POST' | 'PATCH',
    url: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const key = `press-${newId()}`;
    const headers = { 'idempotency-key': key };
    const first = await call(method, url, { cookie: adminCookie, payload, headers });
    expect(first.statusCode, `${method} ${url} first press`).toBe(200);
    const second = await call(method, url, { cookie: adminCookie, payload, headers });
    expect(second.statusCode, `${method} ${url} replay`).toBe(200);
    expect(second.replayed, `${method} ${url} should be answered from the store`).toBe(true);
    expect(second.body).toEqual(first.body);
  }

  it('answers both presses of all five fleet writes with the same 200', async () => {
    await press('POST', `/branches/${branchId}/stations`, {
      name: 'Pressed Till',
      kind: 'till',
      boxId,
      capabilities: ['tickets'],
      accessScope: 'all_staff',
      staffAccountIds: [],
      devices: [],
    });
    const [pressed] = await ctx.db
      .select({ id: station.id })
      .from(station)
      .where(eq(station.name, 'Pressed Till'))
      .limit(1);
    await press('PATCH', `/stations/${pressed!.id}`, { name: 'Pressed Till renamed' });

    const madeBox = await call('POST', `/branches/${branchId}/boxes`, {
      cookie: adminCookie,
      payload: { name: 'Pressed box', slot: uniqueSlot('press'), role: 'counter' },
    });
    const pressedBoxId = (madeBox.body.box as { id: string }).id;
    await press('PATCH', `/boxes/${pressedBoxId}`, { name: 'Pressed box renamed' });

    await press('POST', `/boxes/${pressedBoxId}/devices`, {
      kind: 'receipt_printer',
      label: 'Pressed printer',
      transport: 'lan',
      address: '10.0.0.77:9100',
    });
    const [madeDevice] = await ctx.db
      .select({ id: device.id })
      .from(device)
      .where(eq(device.label, 'Pressed printer'))
      .limit(1);
    await press('PATCH', `/devices/${madeDevice!.id}`, { label: 'Pressed printer renamed' });

    // One station created, not two: the replay answered from the store rather
    // than doing the work again.
    const stations = await ctx.db
      .select({ id: station.id })
      .from(station)
      .where(eq(station.name, 'Pressed Till renamed'));
    expect(stations).toHaveLength(1);
  });

  it('leaves no failed run behind — a replay must not poison the 5xx signal', async () => {
    const runs = await ctx.db
      .select({ name: opsRun.name, outcome: opsRun.outcome })
      .from(opsRun)
      .where(eq(opsRun.kind, 'http'));
    const fleetWrites = runs.filter((r) =>
      [
        'http:POST /branches/:branchId/stations',
        'http:PATCH /stations/:id',
        'http:PATCH /boxes/:id',
        'http:POST /boxes/:boxId/devices',
        'http:PATCH /devices/:id',
      ].includes(r.name),
    );
    expect(fleetWrites).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('a change to who may use a station is audited (S2-04 review)', () => {
  let restricted: string;
  let receptionAccountId: string;

  beforeAll(async () => {
    const [acc] = await ctx.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.phone, RECEPTION.phone))
      .limit(1);
    receptionAccountId = acc!.id;
    const created = await call('POST', `/branches/${branchId}/stations`, {
      cookie: adminCookie,
      payload: {
        name: 'Audited Booth',
        kind: 'booth',
        boxId,
        capabilities: [],
        accessScope: 'selected_staff',
        staffAccountIds: [],
        devices: [],
      },
    });
    expect(created.statusCode).toBe(200);
    restricted = (created.body.station as { id: string }).id;
  });

  const rows = async () =>
    ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'station.update'), eq(auditLog.entityId, restricted)))
      .orderBy(desc(auditLog.createdAt));

  /**
   * The mutation this ticket exists for. `changed` was computed from
   * `bundleFields`, which lists what the BOX can see — and who may use a
   * station is rightly not in it — so a grant and a revoke both returned
   * before `audit.record` and left nothing anywhere. A revoke is the worse
   * half: `station_staff` is reconciled rather than tombstoned, so the audit
   * row is the only record that anybody was ever on the list.
   */
  it('records a grant, naming who was added', async () => {
    const res = await call('PATCH', `/stations/${restricted}`, {
      cookie: adminCookie,
      payload: { staffAccountIds: [receptionAccountId] },
    });
    expect(res.statusCode).toBe(200);

    const recorded = await rows();
    expect(recorded).toHaveLength(1);
    const after = recorded[0]!.after as { staffAdded: Array<{ accountId: string }>; staffRemoved: unknown[] };
    expect(after.staffAdded.map((s) => s.accountId)).toEqual([receptionAccountId]);
    expect(after.staffRemoved).toEqual([]);
    expect(JSON.stringify(recorded[0]!.before)).not.toContain(receptionAccountId);
  });

  it('records a revoke, naming who came off — the only trace a revoke leaves', async () => {
    const res = await call('PATCH', `/stations/${restricted}`, {
      cookie: adminCookie,
      payload: { staffAccountIds: [] },
    });
    expect(res.statusCode).toBe(200);

    const recorded = await rows();
    expect(recorded).toHaveLength(2);
    const after = recorded[0]!.after as { staffRemoved: Array<{ accountId: string }> };
    expect(after.staffRemoved.map((s) => s.accountId)).toEqual([receptionAccountId]);

    // The station row itself did not move, so the box has no new bundle to
    // fetch: who may stand at a till is not a fact the till needs.
    const [row] = await ctx.db
      .select({ configVersion: station.configVersion })
      .from(station)
      .where(eq(station.id, restricted))
      .limit(1);
    const [created] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'station.create'), eq(auditLog.entityId, restricted)))
      .limit(1);
    expect(row!.configVersion).toBe((created!.after as { configVersion: number }).configVersion);
  });

  it('still writes nothing when a save changes nothing at all', async () => {
    const before = (await rows()).length;
    const res = await call('PATCH', `/stations/${restricted}`, {
      cookie: adminCookie,
      payload: { staffAccountIds: [] },
    });
    expect(res.statusCode).toBe(200);
    expect((await rows()).length).toBe(before);
  });

  it('keeps added_at where it stood for somebody who was already on the list', async () => {
    await call('PATCH', `/stations/${restricted}`, {
      cookie: adminCookie,
      payload: { staffAccountIds: [receptionAccountId] },
    });
    const [granted] = await ctx.db
      .select({ addedAt: stationStaff.addedAt })
      .from(stationStaff)
      .where(
        and(eq(stationStaff.stationId, restricted), eq(stationStaff.accountId, receptionAccountId)),
      )
      .limit(1);

    // A save that leaves the list alone must not restamp it: `added_by` and
    // `added_at` are the record of when somebody was given this station.
    await call('PATCH', `/stations/${restricted}`, {
      cookie: adminCookie,
      payload: { name: 'Audited Booth renamed', staffAccountIds: [receptionAccountId] },
    });
    const [after] = await ctx.db
      .select({ addedAt: stationStaff.addedAt })
      .from(stationStaff)
      .where(
        and(eq(stationStaff.stationId, restricted), eq(stationStaff.accountId, receptionAccountId)),
      )
      .limit(1);
    expect(after!.addedAt.getTime()).toBe(granted!.addedAt.getTime());
  });
});

// ---------------------------------------------------------------------------

describe('revoking a box actually revokes it (S2-04 review, F1)', () => {
  /** Register a box of our own so the seeded one is left where the others expect it. */
  async function ownBox(): Promise<{ id: string; credential: string }> {
    const created = await call('POST', `/branches/${branchId}/boxes`, {
      cookie: adminCookie,
      payload: { name: 'Revocation box', slot: uniqueSlot('rev'), role: 'counter' },
    });
    const id = (created.body.box as { id: string }).id;
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/register',
      payload: { claimCode: created.body.claimCode, agentVersion: '0.1.0', hostname: 'rev' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { boxId: string; secret: string };
    return { id, credential: boxCredential(body.boxId, body.secret) };
  }

  const config = (credential: string) =>
    ctx.app.inject({
      method: 'GET',
      url: '/box/v1/config',
      headers: { authorization: `Bearer ${credential}` },
    });

  it('cuts a box off at its very next request when its claim code is re-issued', async () => {
    const { id, credential } = await ownBox();
    expect((await config(credential)).statusCode).toBe(200);

    const reissued = await call('POST', `/boxes/${id}/claim-code`, { cookie: adminCookie });
    expect(reissued.statusCode).toBe(200);

    /**
     * Before the fix the secret stayed live until somebody else completed a
     * registration, so an administrator pressing the only button next to a
     * stolen box changed nothing for as long as the thief kept it plugged in.
     */
    const after = await config(credential);
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('BOX_UNAUTHORIZED');
  });

  it('cuts it off when it is taken out of service, and answers 401 rather than a 403 it retries for ever', async () => {
    const { id, credential } = await ownBox();
    expect((await config(credential)).statusCode).toBe(200);

    const disabled = await call('PATCH', `/boxes/${id}`, {
      cookie: adminCookie,
      payload: { status: 'disabled' },
    });
    expect(disabled.statusCode).toBe(200);
    expect((disabled.body.box as { status: string }).status).toBe('disabled');

    const after = await config(credential);
    expect(after.statusCode).toBe(401);
    const [row] = await ctx.db.select().from(box).where(eq(box.id, id)).limit(1);
    expect(row!.secretHash).toBeNull();

    // Back in service: it has no credential any more, so `unclaimed` is the
    // honest status and a new claim code is what brings it back.
    const enabled = await call('PATCH', `/boxes/${id}`, {
      cookie: adminCookie,
      payload: { status: 'offline' },
    });
    expect((enabled.body.box as { status: string }).status).toBe('unclaimed');
  });

  it('refuses a status only the watchdog may set', async () => {
    const res = await call('PATCH', `/boxes/${boxId}`, {
      cookie: adminCookie,
      payload: { status: 'online' },
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('BOX_STATUS_INVALID');
  });

  it('refuses to archive a box that still carries live stations', async () => {
    const res = await call('DELETE', `/boxes/${boxId}`, { cookie: adminCookie });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('BOX_HAS_LIVE_STATIONS');
  });
});

// ---------------------------------------------------------------------------

describe('a refused box is attributable (S2-04 review, F4)', () => {
  it('records which box id was presented, why it was refused, and nothing of the secret', async () => {
    const presented = newId();
    const secret = 'f'.repeat(64);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/config',
      headers: { authorization: `Bearer ${presented}.${secret}` },
    });
    expect(res.statusCode).toBe(401);

    const [recorded] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'box.auth_denied'), eq(auditLog.entityId, presented)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(recorded).toBeTruthy();
    const after = JSON.stringify(recorded!.after);
    expect(after).toContain('unknown_box');
    // No secret, no prefix of one, and no length — a length is a measurement
    // of a secret, and measurements accumulate.
    expect(after).not.toContain(secret);
    expect(after).not.toContain(secret.slice(0, 8));
    expect(after).not.toMatch(/"(secretLength|length)"/);
  });

  it('tells a malformed credential apart from an unknown box, internally only', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/config',
      headers: { authorization: 'Bearer nonsense' },
    });
    expect(res.statusCode).toBe(401);
    // The caller is told exactly what an unknown box is told.
    expect(res.json().error.code).toBe('BOX_UNAUTHORIZED');
    const [recorded] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'box.auth_denied'), eq(auditLog.entityId, 'unknown')))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(JSON.stringify(recorded!.after)).toContain('malformed');
  });
});

// ---------------------------------------------------------------------------

describe('boxes, devices and commands (S2-04)', () => {
  it('lists a branch’s boxes with the heartbeat age computed here', async () => {
    const res = await call('GET', `/branches/${branchId}/boxes`, { cookie: adminCookie });
    expect(res.statusCode).toBe(200);
    const seeded = (res.body.boxes as Array<Record<string, unknown>>).find((b) => b.id === boxId);
    expect(seeded).toMatchObject({ slot: 'virtual-1', role: 'virtual' });
    expect(seeded!.stationCount).toBeGreaterThanOrEqual(2);
    expect(seeded!.deviceCount).toBeGreaterThanOrEqual(8);
    // Whether a code is outstanding, never the code.
    expect(Object.keys(seeded!)).not.toContain('claimCode');
    expect(Object.keys(seeded!)).not.toContain('secretHash');
  });

  it('declares a device on a box, refuses a second at the same address, and says what breaks when it goes', async () => {
    const made = await call('POST', `/boxes/${boxId}/devices`, {
      cookie: adminCookie,
      payload: {
        kind: 'receipt_printer',
        label: 'Spare printer',
        transport: 'lan',
        address: '192.168.88.250:9100',
      },
    });
    expect(made.statusCode).toBe(200);
    const id = (made.body.device as { id: string }).id;

    const twice = await call('POST', `/boxes/${boxId}/devices`, {
      cookie: adminCookie,
      payload: {
        kind: 'receipt_printer',
        label: 'Same socket',
        transport: 'lan',
        address: '192.168.88.250:9100',
      },
    });
    expect(twice.statusCode).toBe(409);
    expect(errorCode(twice)).toBe('DEVICE_ADDRESS_TAKEN');

    // Put it on a station, then archive it: the answer has to name the station
    // that just stopped printing rather than letting a till find out itself.
    const onStation = await call('POST', `/branches/${branchId}/stations`, {
      cookie: adminCookie,
      payload: {
        name: 'Spare Till',
        kind: 'till',
        boxId,
        capabilities: [],
        accessScope: 'all_staff',
        staffAccountIds: [],
        devices: [{ role: 'receipt', deviceId: id }],
      },
    });
    expect(onStation.statusCode).toBe(200);

    const archived = await call('DELETE', `/devices/${id}`, { cookie: adminCookie });
    expect(archived.statusCode).toBe(200);
    expect(archived.body.stillAssignedTo).toEqual([
      { stationId: (onStation.body.station as { id: string }).id, stationName: 'Spare Till', role: 'receipt' },
    ]);
    const again = await call('DELETE', `/devices/${id}`, { cookie: adminCookie });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('DEVICE_ALREADY_ARCHIVED');
  });

  it('queues a command with an action id and answers the history', async () => {
    const { code } = await issueClaimCode(ctx.db, boxId);
    const registered = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/register',
      payload: { claimCode: code, agentVersion: '0.1.0' },
    });
    expect(registered.statusCode).toBe(200);

    const [printer] = await ctx.db
      .select()
      .from(device)
      .where(and(eq(device.boxId, boxId), eq(device.label, 'Receipt Printer 1')))
      .limit(1);

    const queued = await call('POST', `/boxes/${boxId}/commands`, {
      cookie: adminCookie,
      headers: { 'x-oto-action-id': 'test-print-0001' },
      payload: { kind: 'test_print', payload: { deviceId: printer!.id } },
    });
    expect(queued.statusCode).toBe(200);
    expect(queued.body.actionId).toBe('test-print-0001');

    const history = await call('GET', `/boxes/${boxId}/commands`, { cookie: adminCookie });
    const first = (history.body.commands as Array<Record<string, unknown>>)[0];
    expect(first).toMatchObject({ kind: 'test_print', state: 'queued', actionId: 'test-print-0001' });
    expect(first!.expiresAt).not.toBeNull();

    const [recorded] = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'box.command.test_print'))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(recorded).toBeTruthy();
  });

  it('refuses a test print aimed at a device on another box, and an unknown command', async () => {
    const [foreign] = await ctx.db
      .select()
      .from(device)
      .where(eq(device.label, 'Somebody else’s printer'))
      .limit(1);
    const wrongDevice = await call('POST', `/boxes/${boxId}/commands`, {
      cookie: adminCookie,
      payload: { kind: 'test_print', payload: { deviceId: foreign!.id } },
    });
    expect(wrongDevice.statusCode).toBe(400);
    expect(errorCode(wrongDevice)).toBe('COMMAND_PAYLOAD_INVALID');

    const nonsense = await call('POST', `/boxes/${boxId}/commands`, {
      cookie: adminCookie,
      payload: { kind: 'make_tea' },
    });
    expect(nonsense.statusCode).toBe(400);
    expect(errorCode(nonsense)).toBe('COMMAND_KIND_INVALID');
  });

  it('refuses any command to a box that has never registered', async () => {
    const created = await call('POST', `/branches/${branchId}/boxes`, {
      cookie: adminCookie,
      payload: { name: 'Never claimed', slot: uniqueSlot('nc'), role: 'counter' },
    });
    const id = (created.body.box as { id: string }).id;
    const res = await call('POST', `/boxes/${id}/commands`, {
      cookie: adminCookie,
      payload: { kind: 'restart' },
    });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('BOX_UNCLAIMED');
  });

  it('refuses a store reset while the box still holds sales nobody has a copy of', async () => {
    await ctx.db
      .update(box)
      .set({ lastStatus: { outboxDepth: 3 } as never })
      .where(eq(box.id, boxId));
    const res = await call('POST', `/boxes/${boxId}/commands`, {
      cookie: adminCookie,
      payload: { kind: 'reset_store' },
    });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('BOX_OUTBOX_UNSYNCED');
    await ctx.db
      .update(box)
      .set({ lastStatus: { outboxDepth: 0 } as never })
      .where(eq(box.id, boxId));
  });

  it('expires a command the box never came back for, from the hourly sweep', async () => {
    const id = newId();
    await ctx.db.insert(boxCommand).values({
      id,
      boxId,
      kind: 'restart',
      state: 'queued',
      expiresAt: new Date(Date.now() - 60_000),
    });
    /**
     * `pollCommands` expires only for the box that is asking, which is never
     * the box that died with work queued for it — so a test print aimed at a
     * dead Pi showed as pending on Devices for ever.
     */
    const swept = await expireStaleCommands(ctx.db);
    expect(swept).toBeGreaterThanOrEqual(1);
    const [row] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.id, id)).limit(1);
    expect(row!.state).toBe('expired');
    expect(row!.finishedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('who may reach the admin fleet surface (S2-04)', () => {
  it('refuses reception the stations, the boxes, the devices and the staff picker', async () => {
    for (const url of [
      // The admin station list and one station by id: both carry the staff
      // list, the code prefix, every device address and the payment routing.
      `/branches/${branchId}/stations`,
      `/stations/${tillId}`,
      `/branches/${branchId}/boxes`,
      `/boxes/${boxId}/devices`,
      `/branches/${branchId}/staff`,
      `/branches/${branchId}/credentials`,
    ]) {
      const res = await call('GET', url, { cookie: receptionCookie });
      expect(res.statusCode, `${url} should be refused for reception`).toBe(403);
    }
  });

  it('refuses anonymous callers everywhere on this surface', async () => {
    /**
     * Bodies the schema accepts, so every refusal below is the guard's rather
     * than a complaint about a field an anonymous caller was never entitled to
     * send. Validation runs before the handler, so an empty body would have
     * answered 400 and proved nothing.
     */
    const validBody: Record<string, unknown> = {
      '/me/session/station': { stationId: tillId },
      [`/branches/${branchId}/stations`]: {
        name: 'Anonymous Till',
        kind: 'till',
        boxId,
        capabilities: [],
        accessScope: 'all_staff',
        staffAccountIds: [],
        devices: [],
      },
      [`/branches/${branchId}/boxes`]: { name: 'Anonymous box', slot: 'anon', role: 'counter' },
      [`/boxes/${boxId}/commands`]: { kind: 'restart' },
      [`/boxes/${boxId}/devices`]: {
        kind: 'receipt_printer',
        label: 'Anonymous printer',
        transport: 'lan',
      },
      [`/stations/${tillId}/credentials`]: { kind: 'display' },
    };
    for (const [method, url] of [
      ['GET', '/me/stations'],
      ['PUT', '/me/session/station'],
      ['GET', `/branches/${branchId}/stations`],
      ['POST', `/branches/${branchId}/stations`],
      ['GET', `/stations/${tillId}`],
      ['PATCH', `/stations/${tillId}`],
      ['DELETE', `/stations/${tillId}`],
      ['GET', `/branches/${branchId}/staff`],
      ['GET', `/branches/${branchId}/boxes`],
      ['POST', `/branches/${branchId}/boxes`],
      ['PATCH', `/boxes/${boxId}`],
      ['POST', `/boxes/${boxId}/claim-code`],
      ['DELETE', `/boxes/${boxId}`],
      ['GET', `/boxes/${boxId}/commands`],
      ['POST', `/boxes/${boxId}/commands`],
      ['GET', `/boxes/${boxId}/heartbeats`],
      ['GET', `/boxes/${boxId}/devices`],
      ['POST', `/boxes/${boxId}/devices`],
      ['GET', `/branches/${branchId}/credentials`],
      ['POST', `/stations/${tillId}/credentials`],
    ] as Array<['GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', string]>) {
      const res = await call(method, url, {
        payload: method === 'GET' ? undefined : (validBody[url] ?? {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  /**
   * The gap that defeated the ticket's own rule for every staff account:
   * `admin:station:read` sat in `READ_COUNTER`, so `staff` ⊆ `reception` ⊆
   * everyone held it and a member of reception could enumerate the whole
   * branch through the ADMIN list — restricted stations, their staff lists,
   * their printers' LAN addresses and their payment routing included. It is
   * now a permission for whoever configures the estate, and the picker is
   * unaffected: it takes no permission at all and filters on the access scope.
   */
  it('hides a restricted station from the picker AND from the admin list', async () => {
    const admin = await call('GET', `/branches/${branchId}/stations`, { cookie: receptionCookie });
    expect(admin.statusCode).toBe(403);
    expect(errorCode(admin)).toBe('FORBIDDEN');

    const mine = await call('GET', '/me/stations', { cookie: receptionCookie });
    expect((mine.body.stations as Array<{ name: string }>).map((s) => s.name)).not.toContain(
      'Booth 1',
    );
  });
});
