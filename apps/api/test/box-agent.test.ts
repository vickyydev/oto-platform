import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { box, boxCommand, boxState, device, stationDevice } from '@oto/db';
import { newId } from '@oto/shared';
import {
  createBoxAgent,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
} from '@oto/box-agent';
import { boxBySlot, createTestContext, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
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

/**
 * One request a box made, kept for the one case below that is about what an
 * offline box does NOT send.
 */
interface SentRequest {
  method: string;
  path: string;
  body: unknown;
}

/** `app.inject` behind the agent's transport interface. */
function injectTransport(sent?: SentRequest[]): AgentFetch {
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    sent?.push({
      method: init.method,
      path,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    });
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
  opts: {
    faults?: Record<string, { paperStatus?: 'ok' | 'out'; reachability?: 'reachable' | 'unreachable' }>;
    sent?: SentRequest[];
    /**
     * A box that remembers, over the `edge` schema — the store the api's own
     * virtual box runs on. Off by default, which is the S2-04 box these cases
     * were written against; on where a case is about the offline flag, since
     * without a store `syncCache` returns early for want of somewhere to write
     * rather than because the box is offline.
     */
    store?: boolean;
  } = {},
): Promise<BoxAgent> {
  return createBoxAgent({
    apiBaseUrl: 'http://box-agent.test',
    credentials: memoryCredentialStore(),
    hostname: 'virtual-test',
    fetch: injectTransport(opts.sent),
    faults: opts.faults,
    store: opts.store ? boxStoreFor(ctx.db) : undefined,
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

  /**
   * S2-04 queued this command and answered it with a shape describing what
   * WOULD have been printed. S2-06 replaced the placeholder with the real
   * adapter, so the assertion moved with it: the command now reports the print
   * job's id and its outcome, and paper — a PNG of exactly the dots the device
   * was told to burn — is on the simulator.
   */
  it('runs a test print queued in the cloud and puts paper on the printer', async () => {
    const agent = await buildAgent();
    await agent.ensureRegistered();
    await agent.syncConfig();

    const till = agent.config()!.stations.find((s) => s.name === 'Reception Till 1')!;
    const printer = till.devices.find((d) => d.role === 'receipt')!;
    const commandId = newId();
    await ctx.db.insert(boxCommand).values({
      id: commandId,
      boxId: agent.state.boxId!,
      kind: 'test_print',
      payload: { stationId: till.id, role: 'receipt', kind: 'receipt' },
      actionId: 'act-testprint',
    });

    expect(await agent.runPendingCommands()).toBe(1);

    const [row] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.id, commandId)).limit(1);
    expect(row!.state).toBe('succeeded');
    expect(row!.result).toMatchObject({
      stationId: till.id,
      deviceId: printer.id,
      role: 'receipt',
      kind: 'receipt',
      status: 'printed',
    });

    const printouts = agent.printing()!.printouts(printer.id);
    expect(printouts).toHaveLength(1);
    expect(printouts[0]!.truncated).toBe(false);
    expect(printouts[0]!.widthDots).toBe(576);
    expect([...printouts[0]!.preview.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  /**
   * A station with no band printer is a configuration somebody chose, not a
   * machine that broke — so the box understood the command (succeeded) and the
   * JOB is skipped with the reason. S2-04 answered `failed` here because there
   * was no job to carry the outcome; now there is.
   */
  it('skips a test print for a role no device is assigned to, by name', async () => {
    const agent = await buildAgent();
    await agent.ensureRegistered();
    await agent.syncConfig();
    const booth = agent.config()!.stations.find((s) => s.name === 'Booth 1')!;

    const commandId = newId();
    await ctx.db.insert(boxCommand).values({
      id: commandId,
      boxId: agent.state.boxId!,
      kind: 'test_print',
      payload: { stationId: booth.id, role: 'kids_band', kind: 'kids_wristband' },
    });
    await agent.runPendingCommands();

    const [row] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.id, commandId)).limit(1);
    expect(row!.state).toBe('succeeded');
    expect(row!.errorCode).toBe('NO_DEVICE_FOR_ROLE');
    expect(row!.result).toMatchObject({ status: 'skipped', role: 'kids_band', deviceId: null });
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

  /**
   * SCRUM-328 — the way back into a box that has been told to stop listening.
   *
   * The Console's "Go online" queues a `go_online` command like every other
   * button on the drawer, and until this the agent returned early on
   * `state.offline` before it polled: the one command that could undo the
   * switch was the one command the box had stopped collecting, and the only
   * way back was editing `edge.box_state` by hand.
   *
   * The case is written as one story because both halves have to hold at once:
   * an offline box has to be reachable by `go_online`, AND the offline switch
   * has to keep meaning what it meant. So the leak half asserts on the
   * requests the box actually made — the only one is the command poll, and it
   * asks for one kind — rather than on the absence of an effect, and the test
   * print queued behind it is checked to be still `queued` and un-attempted,
   * because a command a box did not run must not be marked as taken.
   *
   * It runs in this file, not in `packages/box-agent/test`, for a mechanical
   * reason: that suite is Node's own runner under `--experimental-strip-types`
   * and `agent.ts` cannot be imported there (it reaches `@oto/print`, whose
   * constructor parameter properties strip-only mode refuses).
   */
  it('while offline polls for the one command that brings it back, and leaves the rest queued', async () => {
    const sent: SentRequest[] = [];
    const agent = await buildAgent({ sent, store: true });
    await agent.ensureRegistered();
    await agent.syncConfig();

    const till = agent.config()!.stations.find((s) => s.name === 'Reception Till 1')!;
    const printId = newId();
    await ctx.db.insert(boxCommand).values({
      id: printId,
      boxId: agent.state.boxId!,
      kind: 'test_print',
      payload: { stationId: till.id, role: 'receipt', kind: 'receipt' },
      actionId: 'act-offline-waits',
    });

    await agent.setOffline(true, { reason: 'test' });
    sent.length = 0;

    // Every tick an offline box takes, by hand: the heartbeat timer's, the
    // cache timer's and the poll timer's.
    expect(await agent.heartbeat()).toBeNull();
    expect(await agent.syncConfig()).toBe(false);
    expect(await agent.syncCache()).toEqual([]);
    expect(await agent.runPendingCommands()).toBe(0);

    // The only request it made — no heartbeat, no config pull, no cache pull,
    // no push — and the one kind of command it asked for.
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /box/v1/commands/poll']);
    expect(sent[0]!.body).toMatchObject({ kinds: ['go_online'] });

    // And the test print is exactly where it was left: not handed out, not
    // attempted, not marked as taken by a box that never ran it.
    const [waiting] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.id, printId)).limit(1);
    expect(waiting!.state).toBe('queued');
    expect(waiting!.attempts).toBe(0);
    expect(waiting!.claimedAt).toBeNull();

    // Now the button. Same queue, same route, nothing special about it.
    const onlineId = newId();
    await ctx.db.insert(boxCommand).values({
      id: onlineId,
      boxId: agent.state.boxId!,
      kind: 'go_online',
      actionId: 'act-go-online',
    });

    expect(await agent.runPendingCommands()).toBe(1);
    expect(agent.state.offline).toBe(false);
    const [back] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.id, onlineId)).limit(1);
    expect(back!.state).toBe('succeeded');
    expect(back!.result).toMatchObject({ offline: false });
    // The box is online in its own store too, not only in this process.
    const [stateRow] = await ctx.db
      .select()
      .from(boxState)
      .where(eq(boxState.boxId, agent.state.boxId!))
      .limit(1);
    expect(stateRow!.offline).toBe(false);

    // And the print that waited runs on the next poll, because it was never
    // taken away from the queue.
    expect(await agent.runPendingCommands()).toBe(1);
    const [printed] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.id, printId)).limit(1);
    expect(printed!.state).toBe('succeeded');
    expect(printed!.attempts).toBe(1);
  });

  it('refuses to provision a box that is not virtual', async () => {
    // The park's own `virtual-1` (SCRUM-289). Taking whichever box carried
    // that slot flipped the OTHER operator's to `counter` and left this one
    // provisionable, so the refusal under test never happened.
    const seeded = await boxBySlot(ctx.db, 'virtual-1');
    await ctx.db.update(box).set({ role: 'counter' }).where(eq(box.id, seeded.id));
    expect(await provisionVirtualBox(ctx.db, ctx.app.log)).toBeNull();
    await ctx.db.update(box).set({ role: 'virtual' }).where(eq(box.id, seeded.id));
  });
});
