import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { station } from '@oto/db';
import {
  PRODUCT_BARCODE_HANDLER,
  ScanRouter,
  StationSessionManager,
  type BoxAgent,
} from '@oto/box-agent';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';

/**
 * S2-09b — a scan the BOX reads reaches the shop screen.
 *
 * The shop screen watches its station through `GET /stations/:id/channel`,
 * which attaches it to the session manager the api keeps for that box. The
 * virtual box that the api also RUNS (`PROCESS_ROLES=edge`, which is how
 * staging runs) has a manager of its own inside the agent, and the box's
 * scanner — including the Console's scanner simulator, which reaches the box
 * as a command — publishes there. Before `services/station-scans.ts` the two
 * never met, so a scan the box read was heard by nobody.
 *
 * The agent here is the real `ScanRouter` and the real `StationSessionManager`
 * from `@oto/box-agent` on the api's own store, wired exactly as `agent.ts`
 * wires them, registered as running in this process. `router.deliver(…)` is
 * the call `agent.ts` makes for a `scanner.scan` simulator command.
 */

const SEEDED_BARCODE = '8850000000017';

let ctx: TestContext;
let origin: string;
let receptionCookie: string;
let tillId: string;
let boxId: string;

/** The in-process box, as `agent.ts` builds its two halves. */
let boxSessions: StationSessionManager;
let boxScanner: ScanRouter;
let fakeAgent: BoxAgent;

beforeAll(async () => {
  ctx = await createTestContext();
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const stations = await ctx.db.select().from(station);
  const till = stations.find((s) => s.name === 'Reception Till 1')!;
  tillId = till.id;
  boxId = till.boxId!;

  // Standing at the till is what makes the channel the till's own.
  const picked = await ctx.app.inject({
    method: 'PUT',
    url: '/me/session/station',
    headers: { cookie: receptionCookie },
    payload: { stationId: tillId },
  });
  expect(picked.statusCode, picked.body).toBe(200);

  const store = boxStoreFor(ctx.db);
  boxSessions = new StationSessionManager({
    store,
    boxId,
    resolveStation: (id) =>
      id === tillId
        ? { stationId: tillId, boxId, operatorId: till.operatorId, branchId: till.branchId }
        : null,
  });
  boxScanner = new ScanRouter({
    boxId,
    store,
    publish: (stationId, message) => boxSessions.emitScan(stationId, message),
  });
  fakeAgent = {
    state: { boxId },
    sessions: () => boxSessions,
    scanner: () => boxScanner,
  } as unknown as BoxAgent;

  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const address = ctx.app.server.address();
  if (!address || typeof address === 'string') throw new Error('the api did not bind a port');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  detachInProcessBox(fakeAgent);
  await ctx.close();
  await teardownAll();
});

/** One screen on the channel, read the way an EventSource reads it. */
async function watch(): Promise<{
  next: (kind: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  heard: (kind: string) => number;
  close: () => Promise<void>;
}> {
  const abort = new AbortController();
  const res = await fetch(`${origin}/stations/${tillId}/channel?view=staff`, {
    headers: { cookie: receptionCookie },
    signal: abort.signal,
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  let taken = 0;
  let done = false;

  const pump = async () => {
    for (;;) {
      const { value, done: finished } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (finished) {
        done = true;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const kind = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (kind && data) events.push({ kind, data: JSON.parse(data) as Record<string, unknown> });
      }
    }
  };
  void pump();

  return {
    async next(kind, timeoutMs = 5_000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const at = events.findIndex((e, i) => i >= taken && e.kind === kind);
        if (at >= 0) {
          taken = at + 1;
          return events[at]!.data;
        }
        if (done) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`no "${kind}" event on the channel within ${timeoutMs} ms`);
    },
    heard: (kind) => events.filter((e) => e.kind === kind).length,
    async close() {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

describe('a scan the box reads reaches a screen on the api’s channel (S2-09b)', () => {
  it('relays a size barcode from the in-process box, resolved against the catalogue', async () => {
    attachInProcessBox(fakeAgent);
    const screen = await watch();
    try {
      await screen.next('snapshot');
      // Attaching the screen put the catalogue's handler on the box's scanner.
      expect(boxScanner.registered()).toContain(PRODUCT_BARCODE_HANDLER);

      // What `agent.ts` does with a `scanner.scan` simulator command.
      await boxScanner.deliver(tillId, { code: SEEDED_BARCODE, source: 'simulator' });

      const scan = await screen.next('scan');
      expect(scan).toMatchObject({
        kind: 'scan',
        codeKind: 'product',
        outcome: 'handled',
        handler: PRODUCT_BARCODE_HANDLER,
      });
      const add = (scan.detail as { add: Record<string, unknown> }).add;
      expect(add).toMatchObject({
        kind: 'product',
        name: 'Grip Socks',
        label: 'Grip Socks M',
        variant: { id: 'm', label: 'M' },
        priceSatang: 12000,
        quantity: 1,
      });
    } finally {
      await screen.close();
      detachInProcessBox(fakeAgent);
    }
  });

  it('relays an unknown barcode as the refusal it is, with nothing to add', async () => {
    attachInProcessBox(fakeAgent);
    const screen = await watch();
    try {
      await screen.next('snapshot');
      await boxScanner.deliver(tillId, { code: '0000000000000', source: 'simulator' });
      const scan = await screen.next('scan');
      expect(scan).toMatchObject({
        codeKind: 'product',
        outcome: 'refused',
        errorCode: 'UNKNOWN_BARCODE',
        detail: { message: 'Unknown barcode' },
      });
      expect((scan.detail as Record<string, unknown>).add).toBeUndefined();
    } finally {
      await screen.close();
      detachInProcessBox(fakeAgent);
    }
  });

  it('delivers a scan through the api’s own door exactly once, with the box attached or not', async () => {
    // The scan route publishes on the api's manager when this process is not
    // running the box's agent through `virtualBoxAgent()` — true in a test —
    // and the relay listens only to the box's. One scan, one event, either way.
    for (const attached of [true, false]) {
      if (attached) attachInProcessBox(fakeAgent);
      const screen = await watch();
      try {
        await screen.next('snapshot');
        const sent = await ctx.app.inject({
          method: 'POST',
          url: `/stations/${tillId}/scan/simulate`,
          headers: { cookie: receptionCookie },
          payload: { code: SEEDED_BARCODE, mode: 'hid' },
        });
        expect(sent.statusCode, sent.body).toBe(200);
        const scan = await screen.next('scan');
        expect((scan.detail as { add: { label: string } }).add.label).toBe('Grip Socks M');
        // Give a second copy the time it would take to arrive, then count.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(screen.heard('scan')).toBe(1);
      } finally {
        await screen.close();
        if (attached) detachInProcessBox(fakeAgent);
      }
    }
  });

  it('stops relaying when the screen goes away', async () => {
    attachInProcessBox(fakeAgent);
    try {
      const before = boxSessions.subscriberCount(tillId);
      const screen = await watch();
      await screen.next('snapshot');
      expect(boxSessions.subscriberCount(tillId)).toBe(before + 1);
      await screen.close();
      const until = Date.now() + 5_000;
      while (boxSessions.subscriberCount(tillId) !== before && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(boxSessions.subscriberCount(tillId)).toBe(before);
    } finally {
      detachInProcessBox(fakeAgent);
    }
  });
});

describe('the channel with no box running here', () => {
  it('joins nothing, and the station still has its box row', async () => {
    const [row] = await ctx.db.select().from(station).where(eq(station.id, tillId));
    expect(row!.boxId).toBe(boxId);
    const before = boxSessions.subscriberCount(tillId);
    const screen = await watch();
    try {
      await screen.next('snapshot');
      expect(boxSessions.subscriberCount(tillId)).toBe(before);
    } finally {
      await screen.close();
    }
  });
});
