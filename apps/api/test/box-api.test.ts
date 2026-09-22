import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { auditLog, box, boxCommand, boxHeartbeat, device, opsRun, station } from '@oto/db';
import { newId } from '@oto/shared';
import { boxCredential, type BoxConfigBundle, type BoxHeartbeatAck } from '@oto/box-agent';
import { boxBySlot, createTestContext, teardownAll, type TestContext } from './helpers';
import {
  issueClaimCode,
  markSilentBoxesOffline,
  purgeOldBoxHeartbeats,
  withinOpeningHours,
} from '../src/services/box';

/**
 * S2-04 — the surface a box talks to, tested as a machine in a mall rather
 * than as a well-behaved client.
 *
 * The cases that matter most here are the refusals: a claim code used twice, a
 * heartbeat replayed, a command result submitted twice, and one box reaching
 * for another box's devices and commands. Each of those is a thing somebody
 * with a stolen Pi or a packet capture would try, and each has a defence in
 * `services/box.ts` that is only worth having if it is pinned.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

async function seededBox(): Promise<typeof box.$inferSelect> {
  // Scoped to the park (SCRUM-289): a slot is unique per branch, not per estate.
  return boxBySlot(ctx.db, 'virtual-1');
}

/** Register the seeded box and return the credential it was given. */
async function registerSeededBox(): Promise<{ boxId: string; credential: string; secret: string }> {
  const row = await seededBox();
  const { code: claimCode } = await issueClaimCode(ctx.db, row.id);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/register',
    payload: { claimCode, agentVersion: '0.1.0', hostname: 'test-box' },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { boxId: string; secret: string };
  return { boxId: body.boxId, credential: boxCredential(body.boxId, body.secret), secret: body.secret };
}

function auth(credential: string): Record<string, string> {
  return { authorization: `Bearer ${credential}` };
}

/** Each heartbeat must report a time after the last one this box sent. */
let heartbeatClock = Date.now();
function nextReportedAt(): string {
  heartbeatClock = Math.max(Date.now(), heartbeatClock + 1000);
  return new Date(heartbeatClock).toISOString();
}

async function heartbeat(
  credential: string,
  body: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: BoxHeartbeatAck & { error?: { code: string } } }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/heartbeat',
    headers: auth(credential),
    payload: {
      reportedAt: nextReportedAt(),
      agentVersion: '0.1.0',
      uptimeS: 42,
      tempC: null,
      outboxDepth: 0,
      ...body,
    },
  });
  return { statusCode: res.statusCode, body: res.json() };
}

describe('box registration (S2-04)', () => {
  it('redeems a claim code exactly once and mints a secret nobody can ask for again', async () => {
    const row = await seededBox();
    const { code: claimCode } = await issueClaimCode(ctx.db, row.id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/register',
      payload: { claimCode, agentVersion: '0.1.0', hostname: 'pi-counter-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.boxId).toBe(row.id);
    expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(body.epoch).toBe(1);
    expect(body.slot).toBe('virtual-1');

    const [after] = await ctx.db.select().from(box).where(eq(box.id, row.id)).limit(1);
    expect(after!.secretHash).toBe(sha256(body.secret));
    // Consumed: the hash is gone, which is what makes the code single-use.
    expect(after!.claimCodeHash).toBeNull();
    expect(after!.registeredAt).not.toBeNull();
    expect(after!.hostname).toBe('pi-counter-1');
    // Registered is not alive — the first heartbeat is what makes it online.
    expect(after!.status).toBe('offline');

    const [recorded] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'box.register'), eq(auditLog.entityId, row.id)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(recorded).toBeTruthy();
    // A machine redeemed a code; no person did this.
    expect(recorded!.actorAccountId).toBeNull();

    // The same code again — which is also what a box retrying a registration
    // whose answer was lost would send.
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/register',
      payload: { claimCode, agentVersion: '0.1.0' },
    });
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('BOX_CLAIM_INVALID');
  });

  it('refuses an unknown code, and clears an expired one instead of leaving it alive', async () => {
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/register',
      payload: { claimCode: 'ZZZZZ-ZZZZZ', agentVersion: '0.1.0' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error.code).toBe('BOX_CLAIM_INVALID');

    const row = await seededBox();
    const { code: expired } = await issueClaimCode(ctx.db, row.id, { ttlSeconds: -60 });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/register',
      payload: { claimCode: expired, agentVersion: '0.1.0' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('BOX_CLAIM_EXPIRED');
    const [after] = await ctx.db.select().from(box).where(eq(box.id, row.id)).limit(1);
    expect(after!.claimCodeHash).toBeNull();
  });

  it('refuses a box an administrator has taken out of service', async () => {
    const row = await seededBox();
    const { code: claimCode } = await issueClaimCode(ctx.db, row.id);
    await ctx.db.update(box).set({ status: 'disabled' }).where(eq(box.id, row.id));
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/register',
      payload: { claimCode, agentVersion: '0.1.0' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('BOX_DISABLED');
    await ctx.db.update(box).set({ status: 'offline' }).where(eq(box.id, row.id));
  });
});

describe('box heartbeat (S2-04)', () => {
  it('brings the box, its devices and its heartbeat history up to date', async () => {
    const { boxId, credential } = await registerSeededBox();

    const configRes = await ctx.app.inject({ method: 'GET', url: '/box/v1/config', headers: auth(credential) });
    const bundle = configRes.json() as BoxConfigBundle;
    const printer = bundle.stations.flatMap((s) => s.devices).find((d) => d.role === 'receipt');
    expect(printer).toBeTruthy();

    const { statusCode, body } = await heartbeat(credential, {
      configVersion: bundle.configVersion,
      devices: [{ id: printer!.id, reachability: 'reachable', paperStatus: 'low' }],
    });
    expect(statusCode).toBe(200);
    expect(body.devicesMatched).toBe(1);
    expect(body.devicesUnknown).toBe(0);
    expect(body.configVersion).toBe(bundle.configVersion);
    expect(body.heartbeatIntervalS).toBeGreaterThan(0);
    expect(Math.abs(body.clockOffsetMs)).toBeLessThan(5000);

    const [after] = await ctx.db.select().from(box).where(eq(box.id, boxId)).limit(1);
    expect(after!.status).toBe('online');
    expect(after!.lastHeartbeatAt).not.toBeNull();
    expect((after!.lastStatus as { agentVersion: string }).agentVersion).toBe('0.1.0');

    const [printerRow] = await ctx.db.select().from(device).where(eq(device.id, printer!.id)).limit(1);
    expect(printerRow!.paperStatus).toBe('low');
    expect(printerRow!.reachability).toBe('reachable');
    expect(printerRow!.lastSeenAt).not.toBeNull();

    const beats = await ctx.db.select().from(boxHeartbeat).where(eq(boxHeartbeat.boxId, boxId));
    expect(beats.length).toBeGreaterThanOrEqual(1);
    // Null rather than zero: a virtual box has no thermometer.
    expect(beats[0]!.tempC).toBeNull();

    // Applying a config version the cloud had not seen before is the only
    // moment anybody can say the box is running what it was told to.
    const applied = await ctx.db
      .select()
      .from(opsRun)
      .where(eq(opsRun.name, 'device:box.config.applied'))
      .limit(1);
    expect(applied.length).toBe(1);
  });

  it('refuses a replayed heartbeat', async () => {
    const { credential } = await registerSeededBox();
    const reportedAt = nextReportedAt();
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/heartbeat',
      headers: auth(credential),
      payload: { reportedAt, agentVersion: '0.1.0' },
    });
    expect(first.statusCode).toBe(200);

    // Exactly what a captured heartbeat sent again looks like.
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/heartbeat',
      headers: auth(credential),
      payload: { reportedAt, agentVersion: '0.1.0' },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error.code).toBe('BOX_HEARTBEAT_STALE');

    const older = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/heartbeat',
      headers: auth(credential),
      payload: { reportedAt: new Date(Date.parse(reportedAt) - 30_000).toISOString(), agentVersion: '0.1.0' },
    });
    expect(older.statusCode).toBe(409);
  });

  it('refuses a clock too far out to trust', async () => {
    const { credential } = await registerSeededBox();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/heartbeat',
      headers: auth(credential),
      payload: { reportedAt: new Date(Date.now() + 3 * 3600_000).toISOString(), agentVersion: '0.1.0' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BOX_CLOCK_SKEW');
  });

  it('refuses a wrong secret, an unknown box and a missing credential alike', async () => {
    const { boxId } = await registerSeededBox();
    const wrongSecret = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/heartbeat',
      headers: auth(boxCredential(boxId, 'f'.repeat(64))),
      payload: { reportedAt: nextReportedAt(), agentVersion: '0.1.0' },
    });
    expect(wrongSecret.statusCode).toBe(401);
    expect(wrongSecret.json().error.code).toBe('BOX_UNAUTHORIZED');

    const unknownBox = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/heartbeat',
      headers: auth(boxCredential(newId(), 'f'.repeat(64))),
      payload: { reportedAt: nextReportedAt(), agentVersion: '0.1.0' },
    });
    // Identical answer: which of the two it was is which box ids exist.
    expect(unknownBox.statusCode).toBe(401);
    expect(unknownBox.json().error.code).toBe('BOX_UNAUTHORIZED');

    const none = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/config',
    });
    expect(none.statusCode).toBe(401);
  });

  it('cannot report on a device belonging to another box', async () => {
    const { credential } = await registerSeededBox();
    const mine = await seededBox();

    const otherBoxId = newId();
    await ctx.db.insert(box).values({
      id: otherBoxId,
      operatorId: mine.operatorId,
      branchId: mine.branchId,
      name: 'Counter 2 box',
      slot: 'counter-2',
      role: 'counter',
    });
    const otherDeviceId = newId();
    await ctx.db.insert(device).values({
      id: otherDeviceId,
      operatorId: mine.operatorId,
      branchId: mine.branchId,
      boxId: otherBoxId,
      kind: 'receipt_printer',
      label: 'Counter 2 receipt printer',
      transport: 'lan',
      address: '192.168.88.250:9100',
    });

    // By id AND by address: neither route reaches across boxes.
    const { statusCode, body } = await heartbeat(credential, {
      devices: [
        { id: otherDeviceId, reachability: 'unreachable', lastError: 'not mine to say' },
        { address: '192.168.88.250:9100', reachability: 'unreachable' },
      ],
    });
    expect(statusCode).toBe(200);
    expect(body.devicesMatched).toBe(0);
    expect(body.devicesUnknown).toBe(2);

    const [untouched] = await ctx.db.select().from(device).where(eq(device.id, otherDeviceId)).limit(1);
    expect(untouched!.reachability).toBe('unknown');
    expect(untouched!.lastError).toBeNull();
    expect(untouched!.lastSeenAt).toBeNull();
  });
});

describe('box config bundle (S2-04)', () => {
  it('carries this box’s stations and devices, and nobody else’s', async () => {
    const { boxId, credential } = await registerSeededBox();
    const res = await ctx.app.inject({ method: 'GET', url: '/box/v1/config', headers: auth(credential) });
    expect(res.statusCode).toBe(200);
    const bundle = res.json() as BoxConfigBundle;

    expect(bundle.box.id).toBe(boxId);
    expect(bundle.branch.code).toBe('hkt-central');
    expect(bundle.branch.businessDayStart).toMatch(/^05:00/);
    expect(bundle.stations.map((s) => s.name).sort()).toEqual(['Booth 1', 'Reception Till 1']);
    const till = bundle.stations.find((s) => s.name === 'Reception Till 1')!;
    expect(till.devices.map((d) => d.role).sort()).toEqual([
      'adult_band',
      'card_terminal',
      'kids_band',
      'kitchen',
      'qr_terminal',
      'receipt',
      'scanner',
    ]);
    // The box is told what it needs to drive the terminal, and no more.
    const terminal = till.devices.find((d) => d.role === 'card_terminal')!;
    expect(terminal.terminalId).toBe('65703235');
    expect(terminal.protocol).toBe('ghl_linkpos');
    expect(bundle.minSupportedAgentVersion).toBeTruthy();
  });

  it('answers a poll that already has the bundle with 304, and changes version when a station does', async () => {
    const { credential } = await registerSeededBox();
    const first = await ctx.app.inject({ method: 'GET', url: '/box/v1/config', headers: auth(credential) });
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    const unchanged = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/config',
      headers: { ...auth(credential), 'if-none-match': etag },
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe('');

    const [till] = await ctx.db
      .select()
      .from(station)
      .where(eq(station.name, 'Reception Till 1'))
      .limit(1);
    await ctx.db
      .update(station)
      .set({ codePrefix: 'T9', configVersion: till!.configVersion + 1 })
      .where(eq(station.id, till!.id));

    const changed = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/config',
      headers: { ...auth(credential), 'if-none-match': etag },
    });
    expect(changed.statusCode).toBe(200);
    expect((changed.json() as BoxConfigBundle).configVersion).not.toBe(
      (first.json() as BoxConfigBundle).configVersion,
    );
    await ctx.db.update(station).set({ codePrefix: 'T1' }).where(eq(station.id, till!.id));
  });
});

describe('box commands (S2-04)', () => {
  async function queueCommand(boxId: string, kind: string, extra: Record<string, unknown> = {}): Promise<string> {
    const id = newId();
    await ctx.db.insert(boxCommand).values({
      id,
      boxId,
      kind: kind as 'test_print',
      payload: { role: 'receipt' },
      actionId: `act-${id.slice(0, 8)}`,
      ...extra,
    });
    return id;
  }

  it('hands a command out once, takes its result once, and replays the second', async () => {
    const { boxId, credential } = await registerSeededBox();
    const commandId = await queueCommand(boxId, 'test_print');

    const poll = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/commands/poll',
      headers: auth(credential),
      payload: { max: 5 },
    });
    expect(poll.statusCode).toBe(200);
    const handed = poll.json().commands as Array<{ id: string; kind: string; attempts: number }>;
    expect(handed.map((c) => c.id)).toContain(commandId);
    expect(handed.find((c) => c.id === commandId)!.attempts).toBe(1);

    // Already running: a second poll must not hand the same test print out.
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/commands/poll',
      headers: auth(credential),
      payload: { max: 5 },
    });
    expect((second.json().commands as unknown[]).length).toBe(0);

    const result = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/commands/${commandId}/result`,
      headers: auth(credential),
      payload: { state: 'succeeded', result: { simulated: true, deviceLabel: 'Receipt Printer 1' } },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ state: 'succeeded', replayed: false });

    const [row] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.id, commandId)).limit(1);
    expect(row!.state).toBe('succeeded');
    expect(row!.finishedAt).not.toBeNull();

    const runs = await ctx.db.select().from(opsRun).where(eq(opsRun.name, 'device:box.test_print'));
    expect(runs.length).toBe(1);
    expect(runs[0]!.outcome).toBe('ok');

    // The box retrying because the acknowledgement was lost.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/commands/${commandId}/result`,
      headers: auth(credential),
      payload: { state: 'failed', errorCode: 'SHOULD_NOT_STICK' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ state: 'succeeded', replayed: true });
    const [unchangedRow] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.id, commandId)).limit(1);
    expect(unchangedRow!.state).toBe('succeeded');
    expect(unchangedRow!.errorCode).toBeNull();
    // And no second run row: a replay did none of the work.
    expect((await ctx.db.select().from(opsRun).where(eq(opsRun.name, 'device:box.test_print'))).length).toBe(1);
  });

  it('records a failure with the code the box reported', async () => {
    const { boxId, credential } = await registerSeededBox();
    const commandId = await queueCommand(boxId, 'collect_logs');
    await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/commands/poll',
      headers: auth(credential),
      payload: { max: 5 },
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/commands/${commandId}/result`,
      headers: auth(credential),
      payload: { state: 'failed', errorCode: 'NO_DEVICE_FOR_ROLE', errorMessage: 'No receipt device on this station' },
    });
    expect(res.statusCode).toBe(200);
    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(eq(opsRun.name, 'device:box.collect_logs'))
      .limit(1);
    expect(run!.outcome).toBe('failed');
    expect(run!.errorCode).toBe('NO_DEVICE_FOR_ROLE');
  });

  it('mints a new journal epoch for a reset, exactly once however many results arrive', async () => {
    const { boxId, credential } = await registerSeededBox();
    const [before] = await ctx.db.select().from(box).where(eq(box.id, boxId)).limit(1);
    const commandId = await queueCommand(boxId, 'reset_store');
    await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/commands/poll',
      headers: auth(credential),
      payload: { max: 5 },
    });

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/commands/${commandId}/result`,
      headers: auth(credential),
      payload: { state: 'succeeded', result: { cleared: true } },
    });
    expect(first.json().epoch).toBe(before!.currentEpoch + 1);

    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/commands/${commandId}/result`,
      headers: auth(credential),
      payload: { state: 'succeeded', result: { cleared: true } },
    });
    expect(replay.json().replayed).toBe(true);

    const [after] = await ctx.db.select().from(box).where(eq(box.id, boxId)).limit(1);
    expect(after!.currentEpoch).toBe(before!.currentEpoch + 1);

    const epochRows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'box.epoch_reset'), eq(auditLog.entityId, boxId)));
    expect(epochRows.length).toBe(1);
  });

  it('refuses a result for a command that was never handed out, and one belonging to another box', async () => {
    const { boxId, credential } = await registerSeededBox();
    const queued = await queueCommand(boxId, 'restart');
    const notClaimed = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/commands/${queued}/result`,
      headers: auth(credential),
      payload: { state: 'succeeded' },
    });
    expect(notClaimed.statusCode).toBe(409);
    expect(notClaimed.json().error.code).toBe('BOX_COMMAND_NOT_CLAIMED');

    const [other] = await ctx.db.select().from(box).where(eq(box.slot, 'counter-2')).limit(1);
    const foreign = await queueCommand(other!.id, 'restart');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/commands/${foreign}/result`,
      headers: auth(credential),
      payload: { state: 'succeeded' },
    });
    // Not found rather than forbidden: a command of another box does not
    // exist as far as this credential is concerned.
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('BOX_COMMAND_NOT_FOUND');
  });

  it('expires a command the box never came back for instead of firing it late', async () => {
    const { boxId, credential } = await registerSeededBox();
    const stale = await queueCommand(boxId, 'test_print', {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const poll = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/commands/poll',
      headers: auth(credential),
      payload: { max: 5 },
    });
    expect((poll.json().commands as Array<{ id: string }>).map((c) => c.id)).not.toContain(stale);
    const [row] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.id, stale)).limit(1);
    expect(row!.state).toBe('expired');
  });
});

describe('what the watchdog and the retention sweep call (S2-04)', () => {
  it('moves a box that has stopped saying anything to offline', async () => {
    const { boxId, credential } = await registerSeededBox();
    expect((await heartbeat(credential)).statusCode).toBe(200);

    await ctx.db
      .update(box)
      .set({ status: 'online', lastHeartbeatAt: new Date(Date.now() - 3600_000) })
      .where(eq(box.id, boxId));

    const silent = await markSilentBoxesOffline(ctx.db, 180);
    expect(silent.map((b) => b.id)).toContain(boxId);
    const [after] = await ctx.db.select().from(box).where(eq(box.id, boxId)).limit(1);
    expect(after!.status).toBe('offline');
    // The caller decides whether a silent box is worth waking somebody for;
    // this only says whether the park was open when it went quiet.
    expect(typeof silent[0]!.duringOpeningHours).toBe('boolean');

    // Already offline: nothing to transition, and no repeat alert to raise.
    expect((await markSilentBoxesOffline(ctx.db, 180)).map((b) => b.id)).not.toContain(boxId);
  });

  it('ages out heartbeats older than the retention window', async () => {
    const row = await seededBox();
    await ctx.db.insert(boxHeartbeat).values({
      id: newId(),
      boxId: row.id,
      receivedAt: new Date(Date.now() - 40 * 24 * 3600_000),
      agentVersion: '0.1.0',
    });
    const deleted = await purgeOldBoxHeartbeats(ctx.db, 14);
    expect(deleted).toBeGreaterThanOrEqual(1);
    const left = await ctx.db.select().from(boxHeartbeat).where(eq(boxHeartbeat.boxId, row.id));
    expect(left.every((b) => b.receivedAt.getTime() > Date.now() - 14 * 24 * 3600_000)).toBe(true);
  });
});

describe('opening hours (S2-04)', () => {
  const allWeek = (open: string, close: string): Record<string, { open: string; close: string }> =>
    Object.fromEntries(
      ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open, close }]),
    );

  // 09:00 UTC is 16:00 in Bangkok; 17:00 UTC is midnight.
  const afternoon = new Date('2026-09-21T09:00:00Z');
  const midnight = new Date('2026-09-21T17:00:00Z');

  it('is true inside the park’s own hours and false outside them', () => {
    expect(withinOpeningHours(allWeek('10:00', '21:00'), 'Asia/Bangkok', afternoon)).toBe(true);
    expect(withinOpeningHours(allWeek('10:00', '21:00'), 'Asia/Bangkok', midnight)).toBe(false);
  });

  it('treats hours nobody has set as "do not raise", never as "closed"', () => {
    expect(withinOpeningHours(null, 'Asia/Bangkok', afternoon)).toBe(false);
    expect(withinOpeningHours({}, 'Asia/Bangkok', afternoon)).toBe(false);
  });

  it('handles a day that runs past midnight', () => {
    expect(withinOpeningHours(allWeek('20:00', '02:00'), 'Asia/Bangkok', midnight)).toBe(true);
    expect(withinOpeningHours(allWeek('20:00', '02:00'), 'Asia/Bangkok', afternoon)).toBe(false);
  });
});
