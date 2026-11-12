import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, device, station, stationDevice } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-898 — A STATION FORM OPENED AT AN OLDER CONFIG VERSION CANNOT SAVE IT
 * BACK.
 *
 * Seen on staging in the SCRUM-861 proof: a till saved in Console > Devices >
 * Stations, reopened before the list refreshed, showed config v1 with the
 * drop-off band printer "Not set" while the card behind said v2 — and nothing
 * on the server would have stopped that form writing v1's settings back. The
 * Console now says which version its form was filled from
 * (`expectedConfigVersion`), and a save from any other is refused 409
 * `STATION_CHANGED` with nothing written. The field is optional: the till's
 * own station setup never sends it and saves exactly as before, keeping the
 * drop-off band printer it does not manage.
 *
 * Driven through the routes against the seeded Reception Till 1, with a ZZ
 * TEST drop-off band printer registered on its box.
 */

type View = {
  id: string;
  name: string;
  kind: string;
  boxId: string;
  capabilities: string[];
  configVersion: number;
  devices: Array<{ role: string; deviceId: string }>;
};

let ctx: TestContext;
let admin: string;
let tillId: string;
let dropoffPrinterId: string;

const read = async (): Promise<View> => {
  const res = await ctx.app.inject({ method: 'GET', url: `/stations/${tillId}`, headers: { cookie: admin } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().station as View;
};

const patch = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'PATCH', url: `/stations/${tillId}`, headers: { cookie: admin, ...headers }, payload });

const assignments = (view: View) => view.devices.map((d) => ({ role: d.role, deviceId: d.deviceId }));
const roleOf = (view: View, role: string) => view.devices.find((d) => d.role === role)?.deviceId ?? null;
const updatesAudited = async () =>
  (
    await ctx.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'station.update'), eq(auditLog.entityId, tillId)))
  ).length;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, hkt!.id), eq(station.codePrefix, 'T1')));
  tillId = till!.id;
  dropoffPrinterId = newId();
  await ctx.db.insert(device).values({
    id: dropoffPrinterId,
    operatorId: hkt!.operatorId,
    branchId: hkt!.id,
    boxId: till!.boxId!,
    kind: 'band_printer',
    label: 'ZZ TEST SCRUM-898 drop-off band printer',
    transport: 'simulated',
    address: '192.168.88.213:9100',
    model: '4B-2082A',
    protocol: 'tspl2',
    reachability: 'reachable',
    paperStatus: 'ok',
  });
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-898 — a save names the version its form was opened at', () => {
  it('a save from the current version lands and moves the version; the old form saved after it is refused 409 STATION_CHANGED and writes nothing', async () => {
    const opened = await read();
    expect(roleOf(opened, 'dropoff_band')).toBeNull();

    // The first form: the drop-off band printer given to the till.
    const saved = await patch({
      devices: [...assignments(opened), { role: 'dropoff_band', deviceId: dropoffPrinterId }],
      expectedConfigVersion: opened.configVersion,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const after = saved.json().station as View;
    expect(after.configVersion).toBe(opened.configVersion + 1);
    expect(roleOf(after, 'dropoff_band')).toBe(dropoffPrinterId);
    const audited = await updatesAudited();

    // The same till reopened from the list before it refreshed: the form still
    // holds the version it was opened at, and the printer "Not set".
    const stale = await patch({ devices: assignments(opened), expectedConfigVersion: opened.configVersion });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error).toMatchObject({
      code: 'STATION_CHANGED',
      message: 'This station was changed since you opened it. Close it and open it again.',
      details: { expectedConfigVersion: opened.configVersion, configVersion: opened.configVersion + 1 },
    });

    // Nothing was written: the printer stays, the version stays, no audit row.
    const now = await read();
    expect(now.configVersion).toBe(opened.configVersion + 1);
    expect(roleOf(now, 'dropoff_band')).toBe(dropoffPrinterId);
    expect(await updatesAudited()).toBe(audited);
    const [held] = await ctx.db
      .select()
      .from(stationDevice)
      .where(and(eq(stationDevice.stationId, tillId), eq(stationDevice.role, 'dropoff_band')));
    expect(held?.deviceId).toBe(dropoffPrinterId);
  });

  it('a version the station has never had is refused the same way, and a save from the current one that changes nothing still answers', async () => {
    const current = await read();
    const ahead = await patch({ name: 'ZZ TEST never saved', expectedConfigVersion: current.configVersion + 5 });
    expect(ahead.statusCode, ahead.body).toBe(409);
    expect(ahead.json().error.code).toBe('STATION_CHANGED');
    expect((await read()).name).toBe(current.name);

    const same = await patch({ devices: assignments(current), expectedConfigVersion: current.configVersion });
    expect(same.statusCode, same.body).toBe(200);
    // Nothing the box can see moved, so the version stands.
    expect((same.json().station as View).configVersion).toBe(current.configVersion);
  });

  it('a save whose answer was lost, sent again with its Idempotency-Key, answers as it did the first time rather than as a stale form', async () => {
    const current = await read();
    const key = `zz-s898-${newId()}`;
    const body = { name: 'ZZ TEST Reception Till 1', expectedConfigVersion: current.configVersion };
    const first = await patch(body, { 'idempotency-key': key });
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json().station as View).configVersion).toBe(current.configVersion + 1);

    const again = await patch(body, { 'idempotency-key': key });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.json().station).toMatchObject({
      name: 'ZZ TEST Reception Till 1',
      configVersion: current.configVersion + 1,
    });
  });
});

describe('SCRUM-898 — callers that do not say a version save as before', () => {
  it('the till’s own station setup (no version, its managed roles plus every role it does not manage) keeps the drop-off band printer', async () => {
    const seed = await read();
    expect(roleOf(seed, 'dropoff_band')).toBe(dropoffPrinterId);

    // What StationSetup sent before SCRUM-930 (`apps/pos/src/pages/StationSetup.tsx`,
    // `save` and `deviceAssignments`): the roles its wizard manages, as its
    // form holds them, then each role it does not manage carried over from
    // the station it read — no access pair when it never read one, and never
    // a version.
    const managed = new Set(['receipt', 'kids_band', 'adult_band', 'kitchen', 'bar', 'scanner']);
    const tillBody = {
      boxId: seed.boxId,
      name: seed.name,
      kind: seed.kind,
      capabilities: seed.capabilities,
      devices: [
        ...assignments(seed).filter((d) => managed.has(d.role)),
        ...assignments(seed).filter((d) => !managed.has(d.role)),
      ],
    };
    expect(tillBody.devices).toContainEqual({ role: 'dropoff_band', deviceId: dropoffPrinterId });
    const res = await patch(tillBody);
    expect(res.statusCode, res.body).toBe(200);
    expect(roleOf(res.json().station as View, 'dropoff_band')).toBe(dropoffPrinterId);

    // And from a view read before somebody else saved: the till says no
    // version, so its save is made as it always was.
    const moved = await patch({ name: 'ZZ TEST moved on', expectedConfigVersion: (await read()).configVersion });
    expect(moved.statusCode, moved.body).toBe(200);
    const fromOlder = await patch(tillBody);
    expect(fromOlder.statusCode, fromOlder.body).toBe(200);
    const final = await read();
    expect(final.name).toBe(seed.name);
    expect(roleOf(final, 'dropoff_band')).toBe(dropoffPrinterId);
  });

  it('a version that is not a positive whole number is refused by the schema', async () => {
    for (const expectedConfigVersion of [0, -1, 1.5, '2']) {
      const res = await patch({ name: 'ZZ TEST bad version', expectedConfigVersion });
      expect(res.statusCode, JSON.stringify(expectedConfigVersion)).toBe(400);
    }
  });
});
