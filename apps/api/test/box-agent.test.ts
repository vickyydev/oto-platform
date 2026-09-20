import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { box, boxCommand, device, stationDevice } from '@oto/db';
import { newId } from '@oto/shared';
import {
  createBoxAgent,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
} from '@oto/box-agent';
import { createTestContext, teardownAll, type TestContext } from './helpers';
import { provisionVirtualBox } from '../src/services/box';

/**
 * S2-04 — the virtual box, driven as itself.
 *
 * What is under test here is not a mock of an agent: it is the agent from
 * `@oto/box-agent`, the same file that will run on a Raspberry Pi, pointed at
 * the api through `app.inject` instead of a socket. That is the whole reason
 * the package takes a four-method transport rather than `fetch` — the flow a
 * demo on Render depends on can be proved in a test that opens no ports.
 *
 * Its timers are never started. `start()` would set a heartbeat and a poll
 * going for the life of the file; each step is called by hand instead, which
 * is also the only way to assert what a single heartbeat did.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** `app.inject` behind the agent's transport interface. */
function injectTransport(): AgentFetch {
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const res = await ctx.app.inject({
      method: init.method as 'GET',
      url: path,
      headers: init.headers,
      payload: init.body,
    });
    return {
      status: res.statusCode,
      json: async () => (res.body ? JSON.parse(res.body) : null),
      text: async () => res.body,
      header: (name) => {
        const value = res.headers[name.toLowerCase()];
        return typeof value === 'string' ? value : null;
      },
    };
  };
}

async function buildAgent(
  opts: { faults?: Record<string, { paperStatus?: 'ok' | 'out'; reachability?: 'reachable' | 'unreachable' }> } = {},
): Promise<BoxAgent> {
  return createBoxAgent({
    apiBaseUrl: 'http://box-agent.test',
    credentials: memoryCredentialStore(),
    hostname: 'virtual-test',
    fetch: injectTransport(),
    faults: opts.faults,
    claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
  });
}

describe('the virtual box agent (S2-04)', () => {
  it('registers, pulls its config, reports itself and is online', async () => {
    const agent = await buildAgent();

    expect(await agent.ensureRegistered()).toBe(true);
    expect(agent.state.boxId).toBeTruthy();
    expect(agent.state.epoch).toBe(1);

    expect(await agent.syncConfig()).toBe(true);
    const bundle = agent.config()!;
    expect(bundle.stations.map((s) => s.name).sort()).toEqual(['Booth 1', 'Reception Till 1']);

    const ack = await agent.heartbeat();
    expect(ack).toBeTruthy();
    // Everything the seed assigned, each reported once even where one device
    // serves two roles.
    expect(ack!.devicesMatched).toBeGreaterThanOrEqual(8);
    expect(ack!.devicesUnknown).toBe(0);
    expect(ack!.configVersion).toBe(agent.state.configVersion);

    const [row] = await ctx.db.select().from(box).where(eq(box.id, agent.state.boxId!)).limit(1);
    expect(row!.status).toBe('online');
    expect(row!.hostname).toBe('virtual-test');
    expect(row!.agentVersion).toBe(agent.version);
    // Null, not zero: a box with no thermometer must not read as cold.
    expect((row!.lastStatus as { tempC: number | null }).tempC).toBeNull();
  });

  it('carries a simulated fault through to the device the Console shows', async () => {
    const agent = await buildAgent();
    await agent.ensureRegistered();
    await agent.syncConfig();
    const printer = agent
      .config()!
      .stations.flatMap((s) => s.devices)
      .find((d) => d.label === 'Band Printer (kids)')!;

    const faulty = await buildAgent({
      faults: { [printer.label]: { paperStatus: 'out', reachability: 'unreachable' } },
    });
    await faulty.ensureRegistered();
    await faulty.syncConfig();
    await faulty.heartbeat();

    const [row] = await ctx.db.select().from(device).where(eq(device.id, printer.id)).limit(1);
    expect(row!.paperStatus).toBe('out');
    expect(row!.reachability).toBe('unreachable');
  });

  it('runs a test print queued in the cloud and reports where it went', async () => {
    const agent = await buildAgent();
    await agent.ensureRegistered();
    await agent.syncConfig();

    const till = agent.config()!.stations.find((s) => s.name === 'Reception Till 1')!;
    const commandId = newId();
    await ctx.db.insert(boxCommand).values({
      id: commandId,
      boxId: agent.state.boxId!,
      kind: 'test_print',
      payload: { stationId: till.id, role: 'receipt' },
      actionId: 'act-testprint',
    });

    expect(await agent.runPendingCommands()).toBe(1);

    const [row] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.id, commandId)).limit(1);
    expect(row!.state).toBe('succeeded');
    expect(row!.result).toMatchObject({
      stationId: till.id,
      deviceLabel: 'Receipt Printer 1',
      protocol: 'escpos',
      simulated: true,
    });
  });

  it('fails a test print for a role no device is assigned to, by name', async () => {
    const agent = await buildAgent();
    await agent.ensureRegistered();
    await agent.syncConfig();
    const booth = agent.config()!.stations.find((s) => s.name === 'Booth 1')!;

    const commandId = newId();
    await ctx.db.insert(boxCommand).values({
      id: commandId,
      boxId: agent.state.boxId!,
      kind: 'test_print',
      payload: { stationId: booth.id, role: 'kids_band' },
    });
    await agent.runPendingCommands();

    const [row] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.id, commandId)).limit(1);
    expect(row!.state).toBe('failed');
    expect(row!.errorCode).toBe('NO_DEVICE_FOR_ROLE');
  });

  it('adopts the new journal epoch a reset mints, rather than computing one', async () => {
    const agent = await buildAgent();
    await agent.ensureRegistered();
    await agent.syncConfig();
    const before = agent.state.epoch;

    await ctx.db.insert(boxCommand).values({
      id: newId(),
      boxId: agent.state.boxId!,
      kind: 'reset_store',
    });
    await agent.runPendingCommands();

    expect(agent.state.epoch).toBe(before + 1);
    const [row] = await ctx.db.select().from(box).where(eq(box.id, agent.state.boxId!)).limit(1);
    expect(row!.currentEpoch).toBe(before + 1);
  });

  it('picks up a configuration change on the next heartbeat without being asked', async () => {
    const agent = await buildAgent();
    await agent.ensureRegistered();
    await agent.syncConfig();
    const applied = agent.state.configVersion;

    // What an administrator adding a device on the Console looks like from here.
    const boxRow = (await ctx.db.select().from(box).where(eq(box.id, agent.state.boxId!)).limit(1))[0]!;
    await ctx.db.insert(device).values({
      id: newId(),
      operatorId: boxRow.operatorId,
      branchId: boxRow.branchId,
      boxId: boxRow.id,
      kind: 'cash_drawer',
      label: 'Cash Drawer 1',
      transport: 'lan',
      address: '192.168.88.202:9100/drawer',
    });
    const till = agent.config()!.stations.find((s) => s.name === 'Reception Till 1')!;
    const drawer = (await ctx.db.select().from(device).where(eq(device.label, 'Cash Drawer 1')).limit(1))[0]!;
    // Written here rather than through a service because assigning a device to
    // a station belongs to the Console side of this ticket; what is under test
    // is the box noticing that somebody did.
    await ctx.db
      .insert(stationDevice)
      .values({ id: newId(), stationId: till.id, deviceId: drawer.id, role: 'cash_drawer' });

    const ack = await agent.heartbeat();
    expect(ack!.configVersion).not.toBe(applied);
    // The heartbeat itself pulled the bundle: nobody had to tell it to.
    expect(agent.state.configVersion).toBe(ack!.configVersion);
    expect(
      agent.config()!.stations.find((s) => s.name === 'Reception Till 1')!.devices.map((d) => d.role),
    ).toContain('cash_drawer');
  });

  it('stops and resumes reporting when the test control says so', async () => {
    const agent = await buildAgent();
    await agent.ensureRegistered();
    await agent.syncConfig();

    agent.pauseHeartbeats(true);
    expect(await agent.heartbeat()).toBeNull();

    agent.pauseHeartbeats(false);
    expect(await agent.heartbeat()).toBeTruthy();
  });

  it('registers again when its credential stops being honoured', async () => {
    const agent = await buildAgent();
    await agent.ensureRegistered();
    await agent.syncConfig();
    const firstBoxId = agent.state.boxId;

    // What rotating a stolen box's credential looks like from the box.
    await ctx.db.update(box).set({ secretHash: null }).where(eq(box.id, firstBoxId!));

    expect(await agent.heartbeat()).toBeNull();
    // Same box — the identity is the row, not the credential.
    expect(agent.state.boxId).toBe(firstBoxId);
    expect(agent.state.registered).toBe(true);
    expect(await agent.heartbeat()).toBeTruthy();
  });

  it('refuses to provision a box that is not virtual', async () => {
    const seeded = (await ctx.db.select().from(box).where(eq(box.slot, 'virtual-1')).limit(1))[0]!;
    await ctx.db.update(box).set({ role: 'counter' }).where(eq(box.id, seeded.id));
    expect(await provisionVirtualBox(ctx.db, ctx.app.log)).toBeNull();
    await ctx.db.update(box).set({ role: 'virtual' }).where(eq(box.id, seeded.id));
  });
});
