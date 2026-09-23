import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { station } from '@oto/db';
import {
  PRODUCT_BARCODE_HANDLER,
  ScanRouter,
  StationSessionManager,
  type BoxAgent,
  type StationScanMessage,
} from '@oto/box-agent';
import {
  ADMIN,
  BRANCH_MANAGER,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { stationChannels } from '../src/lib/station-channel';
import { STATION_SCAN_TAPE_SIZE, stationScanTape } from '../src/lib/station-scan-tape';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';

/**
 * SCRUM-392 — the station's scans, for a screen that cannot hold the channel
 * open.
 *
 * On staging the POS is a static site whose `/api/*` rewrite on Render never
 * passes a streaming answer through, so the shop screen's
 * `GET /stations/:id/channel` never opened there and no scan reached the cart.
 * The screen now falls back to polling `GET /stations/:id/scans?after=n`,
 * which reads a per-station tape of the last hundred scans, fed where scans
 * are published rather than where they are delivered.
 *
 * What is pinned here is everything that makes a poll tell a screen what the
 * stream would have told it: the numbering and the cap, a scan published while
 * NOBODY is attached still being there for the next poll — from both places a
 * scan is published in the api — the first call replaying nothing, the
 * customer view redacted exactly as the stream redacts it, the channel's own
 * refusals, and a poll never counting as a channel on `/ready`.
 *
 * The in-process box is the real `ScanRouter` and `StationSessionManager` from
 * `@oto/box-agent` on the api's own store, wired as `agent.ts` wires them and
 * registered as running in this process — as in `station-scans.test.ts`.
 * `boxScanner.deliver(…)` is the call `agent.ts` makes for a `scanner.scan`
 * simulator command, which is how the Console's scanner simulator reaches it.
 */

const SEEDED_BARCODE = '8850000000017';
const UNKNOWN_CODE = '0000000000000';

let ctx: TestContext;
let origin: string;
let receptionCookie: string;
let adminCookie: string;
let tillId: string;
let boothId: string;
let chalongTillId: string;
let boxlessId: string;
let boxId: string;

let boxSessions: StationSessionManager;
let boxScanner: ScanRouter;
let fakeAgent: BoxAgent;

beforeAll(async () => {
  ctx = await createTestContext();
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  const stations = await ctx.db.select().from(station);
  const till = stations.find((s) => s.name === 'Reception Till 1' && s.codePrefix === 'T1')!;
  tillId = till.id;
  boxId = till.boxId!;
  boothId = stations.find((s) => s.name === 'Booth 1')!.id;
  chalongTillId = stations.find((s) => s.codePrefix === 'T3')!.id;

  // A station nobody has put a box behind yet — a row Sprint 1 could have left.
  boxlessId = randomUUID();
  await ctx.db.insert(station).values({
    id: boxlessId,
    operatorId: till.operatorId,
    branchId: till.branchId,
    boxId: null,
    name: 'Kiosk with no box',
    kind: 'till',
    accessScope: 'all_staff',
  });

  // Reception stands at the till; the administrator stands nowhere, which is
  // the position of a manager watching from the Console.
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

interface Page {
  next: number;
  scans: StationScanMessage[];
}

/** One poll, the way the shop screen sends it. */
async function poll(
  opts: { after?: number; view?: 'staff' | 'customer'; cookie?: string; stationId?: string } = {},
): Promise<Page> {
  const res = await pollRaw(opts);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Page;
}

function pollRaw(
  opts: {
    after?: number;
    view?: 'staff' | 'customer';
    cookie?: string | null;
    stationId?: string;
  } = {},
) {
  const query = new URLSearchParams({ view: opts.view ?? 'staff' });
  if (opts.after !== undefined) query.set('after', String(opts.after));
  const cookie = opts.cookie === undefined ? receptionCookie : opts.cookie;
  return ctx.app.inject({
    method: 'GET',
    url: `/stations/${opts.stationId ?? tillId}/scans?${query.toString()}`,
    headers: cookie ? { cookie } : {},
  });
}

/** One screen on the channel, read the way an EventSource reads it. */
async function watch(view: 'staff' | 'customer' = 'staff'): Promise<{
  next: (kind: string, timeoutMs?: number) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const abort = new AbortController();
  const res = await fetch(`${origin}/stations/${tillId}/channel?view=${view}`, {
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

  void (async () => {
    for (;;) {
      const { value, done: finished } = await reader
        .read()
        .catch(() => ({ value: undefined, done: true }));
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
  })();

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
    async close() {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

/** Poll until a condition holds; a closed socket is noticed, not awaited on. */
async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition did not hold in time');
}

/** A scan as the box's scanner publishes one — the shape, not a real code. */
function syntheticScan(i: number): StationScanMessage {
  return {
    kind: 'scan',
    source: 'simulator',
    codeKind: 'product',
    codeFingerprint: `fp${String(i).padStart(14, '0')}`,
    outcome: 'handled',
    handler: PRODUCT_BARCODE_HANDLER,
    errorCode: null,
    detail: { n: i },
    actionId: null,
    scannedAt: new Date(1_790_000_000_000 + i).toISOString(),
  };
}

describe('the tape: numbered, capped, and read from a cursor (SCRUM-392)', () => {
  it('numbers each station’s scans up by one and keeps the newest hundred, oldest first', () => {
    const id = randomUUID();
    const empty = stationScanTape.read(id);
    expect(empty.scans).toEqual([]);
    const start = empty.next;

    for (let i = 1; i <= 105; i += 1) {
      expect(stationScanTape.record(id, syntheticScan(i))).toBe(start + i);
    }
    // Another station's scans do not move this one's numbers.
    stationScanTape.record(randomUUID(), syntheticScan(999));

    const all = stationScanTape.read(id, start);
    expect(all.next).toBe(start + 105);
    expect(all.scans).toHaveLength(STATION_SCAN_TAPE_SIZE);
    expect(STATION_SCAN_TAPE_SIZE).toBe(100);
    // The first five fell off the front; what is left is 6..105 in order.
    expect(all.scans.map((s) => (s.detail as { n: number }).n)).toEqual(
      Array.from({ length: 100 }, (_, k) => k + 6),
    );

    const tail = stationScanTape.read(id, start + 103);
    expect(tail.scans.map((s) => (s.detail as { n: number }).n)).toEqual([104, 105]);
    expect(tail.next).toBe(start + 105);

    expect(stationScanTape.read(id, start + 105)).toEqual({ next: start + 105, scans: [] });
  });

  it('answers a first call and a cursor it never issued with the number and nothing to replay', () => {
    const id = randomUUID();
    const start = stationScanTape.read(id).next;
    stationScanTape.record(id, syntheticScan(1));
    stationScanTape.record(id, syntheticScan(2));

    // No cursor: a screen that has just opened.
    expect(stationScanTape.read(id)).toEqual({ next: start + 2, scans: [] });
    // A cursor ahead of the tape: not one this tape handed out.
    expect(stationScanTape.read(id, start + 50)).toEqual({ next: start + 2, scans: [] });
    // A cursor from before this process started — a screen that kept its
    // number across a deploy — is below everything this process numbered, so
    // it is sent everything since.
    expect(stationScanTape.read(id, 0).scans).toHaveLength(2);
  });
});

describe('GET /stations/:id/scans (SCRUM-392)', () => {
  it('answers a first call with the current number and no scans, even with scans on the tape', async () => {
    const res = await pollRaw();
    expect(res.statusCode, res.body).toBe(200);
    // Every answer is a moment: nothing in between may keep a copy.
    expect(res.headers['cache-control']).toBe('private, no-store');
    const first = res.json() as Page;

    const sent = await ctx.app.inject({
      method: 'POST',
      url: `/stations/${tillId}/scan/simulate`,
      headers: { cookie: receptionCookie },
      payload: { code: SEEDED_BARCODE, mode: 'hid' },
    });
    expect(sent.statusCode, sent.body).toBe(200);

    const again = await poll();
    expect(again.next).toBe(first.next + 1);
    expect(again.scans).toEqual([]);
  });

  it('returns a scan published through the api’s own door while nobody was attached', async () => {
    await waitFor(() => stationChannels.total() === 0);
    const { next: cursor } = await poll();

    const sent = await ctx.app.inject({
      method: 'POST',
      url: `/stations/${tillId}/scan/simulate`,
      headers: { cookie: receptionCookie },
      payload: { code: SEEDED_BARCODE, mode: 'hid' },
    });
    expect(sent.statusCode, sent.body).toBe(200);

    const page = await poll({ after: cursor });
    expect(page.next).toBe(cursor + 1);
    expect(page.scans).toHaveLength(1);
    const [scan] = page.scans;
    expect(scan).toMatchObject({
      kind: 'scan',
      source: 'simulator',
      codeKind: 'product',
      outcome: 'handled',
      handler: PRODUCT_BARCODE_HANDLER,
    });
    expect((scan!.detail as { add: Record<string, unknown> }).add).toMatchObject({
      kind: 'product',
      name: 'Grip Socks',
      label: 'Grip Socks M',
      variant: { id: 'm', label: 'M' },
      quantity: 1,
    });
    // The fingerprint travels, and the scan carries no field for the code.
    expect(scan!.codeFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.keys(scan!).sort()).toEqual(
      [
        'actionId',
        'codeFingerprint',
        'codeKind',
        'detail',
        'errorCode',
        'handler',
        'kind',
        'outcome',
        'scannedAt',
        'source',
      ].sort(),
    );

    // Read again from the same cursor: the same scan, still there.
    expect((await poll({ after: cursor })).scans).toHaveLength(1);
    expect(await poll({ after: page.next })).toEqual({ next: page.next, scans: [] });
  });

  it('returns a scan the in-process box read while nobody was subscribed to it', async () => {
    attachInProcessBox(fakeAgent);
    try {
      // The poll joins the box: its scanner learns the catalogue, and its
      // manager's scans start going onto the tape.
      const { next: cursor } = await poll();
      expect(boxScanner.registered()).toContain(PRODUCT_BARCODE_HANDLER);
      // Nobody at all is listening to the box's manager.
      expect(boxSessions.subscriberCount(tillId)).toBe(0);
      await waitFor(() => stationChannels.total() === 0);

      // What `agent.ts` does with the Console simulator's `scanner.scan`.
      await boxScanner.deliver(tillId, { code: SEEDED_BARCODE, source: 'simulator' });
      await boxScanner.deliver(tillId, { code: UNKNOWN_CODE, source: 'simulator' });

      const res = await pollRaw({ after: cursor });
      const page = res.json() as Page;
      expect(page.next).toBe(cursor + 2);
      expect(page.scans).toHaveLength(2);
      expect((page.scans[0]!.detail as { add: { label: string } }).add.label).toBe('Grip Socks M');
      expect(page.scans[1]).toMatchObject({
        codeKind: 'product',
        outcome: 'refused',
        errorCode: 'UNKNOWN_BARCODE',
        detail: { message: 'Unknown barcode' },
      });
      expect((page.scans[1]!.detail as Record<string, unknown>).add).toBeUndefined();
      // An unknown code is named by nothing but its fingerprint.
      expect(res.body).not.toContain(UNKNOWN_CODE);
    } finally {
      detachInProcessBox(fakeAgent);
    }
  });

  it('puts a scan on the tape once however many screens are watching, and the stream still hears it', async () => {
    attachInProcessBox(fakeAgent);
    const screen = await watch('staff');
    try {
      await screen.next('snapshot');
      const { next: cursor } = await poll();
      await boxScanner.deliver(tillId, { code: SEEDED_BARCODE, source: 'simulator' });
      const streamed = await screen.next('scan');
      const page = await poll({ after: cursor });
      expect(page.scans).toHaveLength(1);
      expect(page.scans[0]).toEqual(streamed);
    } finally {
      await screen.close();
      detachInProcessBox(fakeAgent);
    }
  });

  it('redacts the customer view exactly as the stream does, and leaves the staff view whole', async () => {
    // A handler whose answer names a person, as a member lookup's will — the
    // one kind of scan the customer display must not be shown in full.
    const MEMBER_CODE = 'MEMBER-CARD-0001';
    const unregister = boxScanner.register({
      name: 'test-member-card',
      kind: 'benefit',
      matches: (code) => code === MEMBER_CODE,
      handle: () => ({
        outcome: 'handled',
        detail: {
          message: 'Member found',
          member: { displayName: 'Mali', notes: 'pays late', allergies: ['peanuts'] },
          children: [
            {
              name: 'Nong',
              age: 7,
              medical_notes: 'inhaler',
              medicalAlert: true,
              dob: '2019-04-01',
            },
          ],
          staffNote: 'regular',
        },
      }),
    });
    attachInProcessBox(fakeAgent);
    const customerScreen = await watch('customer');
    const staffScreen = await watch('staff');
    try {
      await customerScreen.next('snapshot');
      await staffScreen.next('snapshot');
      const { next: cursor } = await poll({ view: 'customer' });

      await boxScanner.deliver(tillId, { code: MEMBER_CODE, source: 'simulator' });

      const streamedCustomer = await customerScreen.next('scan');
      const streamedStaff = await staffScreen.next('scan');
      const customerRes = await pollRaw({ view: 'customer', after: cursor });
      const polledCustomer = (customerRes.json() as Page).scans;
      const polledStaff = (await poll({ view: 'staff', after: cursor })).scans;
      expect(polledCustomer).toHaveLength(1);
      expect(polledStaff).toHaveLength(1);

      // What the stream sent each view is what the poll answers each view.
      expect(polledCustomer[0]).toEqual(streamedCustomer);
      expect(polledStaff[0]).toEqual(streamedStaff);

      // And the redaction did something: the customer view keeps the name and
      // loses every note, allergy, medical flag and birth date, at any depth.
      expect(polledCustomer[0]!.detail).toEqual({
        message: 'Member found',
        member: { displayName: 'Mali' },
        children: [{ name: 'Nong', age: 7 }],
      });
      expect((polledStaff[0]!.detail as { member: { notes: string } }).member.notes).toBe(
        'pays late',
      );
      // The code itself never travels, to either view.
      expect(customerRes.body).not.toContain(MEMBER_CODE);
      expect(JSON.stringify(polledStaff)).not.toContain(MEMBER_CODE);
    } finally {
      await customerScreen.close();
      await staffScreen.close();
      detachInProcessBox(fakeAgent);
      unregister();
    }
  });

  it('refuses exactly what the channel refuses', async () => {
    const managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
    const foreignCookie = await signInAs(
      ctx.app,
      SECOND_OPERATOR_ADMIN.phone,
      SECOND_OPERATOR_ADMIN.password,
    );
    const cases: Array<{
      label: string;
      stationId: string;
      cookie: string | null;
      status: number;
      code: string;
    }> = [
      {
        label: 'no session at all',
        stationId: tillId,
        cookie: null,
        status: 401,
        code: 'UNAUTHORIZED',
      },
      {
        label: 'reception, not at the booth and not allowed to watch it',
        stationId: boothId,
        cookie: receptionCookie,
        status: 403,
        code: 'FORBIDDEN',
      },
      {
        label: 'a branch manager, at a station in the other park',
        stationId: chalongTillId,
        cookie: managerCookie,
        status: 403,
        // Not "you do not have this" but "not here" (SCRUM-300).
        code: 'OUT_OF_BRANCH_SCOPE',
      },
      {
        label: 'another operator’s administrator, at this operator’s till',
        stationId: tillId,
        cookie: foreignCookie,
        status: 404,
        code: 'STATION_NOT_FOUND',
      },
      {
        label: 'a station with no box behind it',
        stationId: boxlessId,
        cookie: adminCookie,
        status: 409,
        code: 'STATION_HAS_NO_BOX',
      },
    ];

    for (const c of cases) {
      const channel = await ctx.app.inject({
        method: 'GET',
        url: `/stations/${c.stationId}/channel?view=staff`,
        headers: c.cookie ? { cookie: c.cookie } : {},
      });
      const polled = await pollRaw({ stationId: c.stationId, cookie: c.cookie });
      const code = (body: string) =>
        (JSON.parse(body) as { error?: { code?: string } }).error?.code;

      expect(polled.statusCode, `${c.label}: ${polled.body}`).toBe(c.status);
      expect(code(polled.body), c.label).toBe(c.code);
      // The channel says the same thing, word for word.
      expect(channel.statusCode, `${c.label}: ${channel.body}`).toBe(polled.statusCode);
      expect(code(channel.body), c.label).toBe(code(polled.body));
    }

    // And a cursor that is not a number is the caller's mistake, not a replay.
    for (const after of ['-1', 'abc', '1.5']) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/stations/${tillId}/scans?view=staff&after=${after}`,
        headers: { cookie: receptionCookie },
      });
      expect(res.statusCode, `after=${after}`).toBe(400);
    }
  });

  it('never counts a poll as a channel on /ready', async () => {
    const readyChannels = async () => {
      const res = await fetch(`${origin}/ready`);
      const body = (await res.json()) as {
        checks: { stationChannels: { stations: number; connections: number } };
      };
      return body.checks.stationChannels;
    };

    await waitFor(() => stationChannels.total() === 0);
    expect(await readyChannels()).toMatchObject({ stations: 0, connections: 0 });
    const { next } = await poll();
    await poll({ after: next });
    await poll({ view: 'customer' });
    expect(await readyChannels()).toMatchObject({ stations: 0, connections: 0 });
    expect(stationChannels.total()).toBe(0);

    // With a screen on the stream the count is that screen, however many
    // polls come and go beside it.
    const screen = await watch('staff');
    try {
      await screen.next('snapshot');
      expect(stationChannels.total()).toBe(1);
      for (let i = 0; i < 3; i += 1) await poll({ after: next });
      expect(await readyChannels()).toMatchObject({ stations: 1, connections: 1 });
    } finally {
      await screen.close();
    }
    await waitFor(() => stationChannels.total() === 0);
  });
});

describe('the tape is the station’s own (SCRUM-392)', () => {
  it('keeps one station’s scans off another station’s poll', async () => {
    const [counter] = await ctx.db
      .select({ id: station.id })
      .from(station)
      .where(eq(station.name, 'Counter 2'))
      .limit(1);
    const before = stationScanTape.read(counter!.id).next;
    const { next: cursor } = await poll();
    stationScanTape.record(counter!.id, syntheticScan(1));
    expect((await poll({ after: cursor })).scans).toEqual([]);
    expect(stationScanTape.read(counter!.id).next).toBe(before + 1);
  });
});
