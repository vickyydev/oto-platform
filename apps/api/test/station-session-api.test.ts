import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import {
  account,
  auditLog,
  box,
  boxOutbox,
  boxState,
  station,
  stationSession,
  type Db,
} from '@oto/db';
import {
  SqlBoxStore,
  createBoxAgent,
  memoryCredentialStore,
  postgresBoxDriver,
  type AgentFetch,
  type BoxAgent,
  type PgPoolLike,
  type StationLease,
} from '@oto/box-agent';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { provisionVirtualBox } from '../src/services/box';

/**
 * S2-05 — the station session document, reached the way a screen reaches it.
 *
 * Three things are under test here and each was a hole the ticket could not be
 * demonstrated through:
 *
 *   - **The routes exist and are guarded.** The lease, the intents, the
 *     snapshot and the channel, with the till standing at the station and a
 *     manager watching it from somewhere else. A `console` observer is refused
 *     whatever lease it quotes, which is what read-only has to mean.
 *   - **`SqlBoxStore` over POSTGRES.** The package's own suite drives it over
 *     SQLite because a Pi's store is a SQLite file; this drives the identical
 *     file over the `edge` schema, so the claim that the two dialects are one
 *     implementation is checked rather than asserted. The lease race is the
 *     case that matters: a renewal landing between another till's read and its
 *     write must not cost a live till its station.
 *   - **A virtual box with a store.** Toggle it offline, queue three facts,
 *     throw the api away and build a new one on the same database: the offline
 *     flag, the epoch and the outbox depth are all still there, because none
 *     of them was ever in this process's memory.
 */

let ctx: TestContext;
let receptionCookie: string;
let adminCookie: string;
let tillId: string;
let boothId: string;
let boxId: string;
let receptionAccountId: string;
let adminAccountId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  const stations = await ctx.db.select().from(station);
  tillId = stations.find((s) => s.name === 'Reception Till 1')!.id;
  boothId = stations.find((s) => s.name === 'Booth 1')!.id;
  boxId = stations.find((s) => s.name === 'Reception Till 1')!.boxId!;

  const accounts = await ctx.db.select({ id: account.id, phone: account.phone }).from(account);
  receptionAccountId = accounts.find((a) => a.phone === RECEPTION.phone)!.id;
  adminAccountId = accounts.find((a) => a.phone === ADMIN.phone)!.id;

  await pick(receptionCookie, tillId);
  // The administrator starts at the booth, which makes them an OBSERVER of the
  // till — the position a manager watching from the Console is in.
  await pick(adminCookie, boothId);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

interface Injected {
  statusCode: number;
  body: Record<string, unknown>;
}

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  opts: { cookie?: string; payload?: unknown; headers?: Record<string, string> } = {},
): Promise<Injected> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
    ...(opts.payload === undefined ? {} : { payload: opts.payload as never }),
  });
  let body: unknown = {};
  try {
    body = res.body ? JSON.parse(res.body) : {};
  } catch {
    body = { raw: res.body };
  }
  return { statusCode: res.statusCode, body: body as Record<string, unknown> };
}

/** Stand at a station, which is what the picker does at the start of a shift. */
async function pick(cookie: string, stationId: string): Promise<void> {
  const res = await call('PUT', '/me/session/station', { cookie, payload: { stationId } });
  if (res.statusCode !== 200) {
    throw new Error(`could not take station ${stationId}: ${JSON.stringify(res.body)}`);
  }
}

const errorCode = (res: Injected): string =>
  (res.body as { error?: { code?: string } }).error?.code ?? `(no error, ${res.statusCode})`;

const document = (res: Injected): Record<string, unknown> =>
  res.body.document as Record<string, unknown>;

// ---------------------------------------------------------------------------

describe('the station session document over HTTP (S2-05)', () => {
  let lease: StationLease;

  it('answers the till standing at the station, and says who it thinks is asking', async () => {
    const res = await call('GET', `/stations/${tillId}/session`, { cookie: receptionCookie });
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('till');
    expect(res.body.view).toBe('staff');
    expect(document(res)).toMatchObject({ stationId: tillId, boxId, stage: 'identify', lease: null });
    expect(res.body.leaseTtlSeconds).toBe(60);
  });

  it('claims the station, and the lease is on the row rather than in a process', async () => {
    const res = await call('POST', `/stations/${tillId}/lease`, {
      cookie: receptionCookie,
      payload: { holder: 'tab-1' },
    });
    expect(res.statusCode).toBe(200);
    lease = res.body.lease as StationLease;
    expect(lease.holderKind).toBe('till');
    // From the session, never from the body: this is the name a takeover audits.
    expect(lease.accountId).toBe(receptionAccountId);
    expect(res.body.takenOver).toBe(false);

    const [row] = await ctx.db
      .select()
      .from(stationSession)
      .where(eq(stationSession.stationId, tillId))
      .limit(1);
    expect(row?.leaseId).toBe(lease.leaseId);
    expect(row?.leaseAccountId).toBe(receptionAccountId);
  });

  it('applies an intent, and refuses the same one twice because the sequence moved', async () => {
    const before = await call('GET', `/stations/${tillId}/session`, { cookie: receptionCookie });
    const sequence = document(before).sequence as number;

    const applied = await call('POST', `/stations/${tillId}/intents`, {
      cookie: receptionCookie,
      payload: {
        type: 'display.set_language',
        leaseId: lease.leaseId,
        lastSeenSequence: sequence,
        payload: { language: 'th' },
      },
    });
    expect(applied.statusCode).toBe(200);
    expect(document(applied).language).toBe('th');
    expect(document(applied).sequence).toBe(sequence + 1);

    const behind = await call('POST', `/stations/${tillId}/intents`, {
      cookie: receptionCookie,
      payload: {
        type: 'display.set_language',
        leaseId: lease.leaseId,
        lastSeenSequence: sequence,
        payload: { language: 'en' },
      },
    });
    expect(behind.statusCode).toBe(409);
    expect(errorCode(behind)).toBe('STATION_STALE');
    // The current document comes back with the refusal, so a till rehydrates
    // in the same round trip rather than needing a second one.
    const carried = (behind.body.error as { details?: { document?: { sequence?: number } } })
      .details?.document;
    expect(carried?.sequence).toBe(sequence + 1);
  });

  it('renews without moving the sequence, which is what lets two screens agree', async () => {
    const before = await call('GET', `/stations/${tillId}/session`, { cookie: receptionCookie });
    const sequence = document(before).sequence as number;

    const renewed = await call('POST', `/stations/${tillId}/lease/renew`, {
      cookie: receptionCookie,
      payload: { leaseId: lease.leaseId },
    });
    expect(renewed.statusCode).toBe(200);
    expect(document(renewed).sequence).toBe(sequence);
    const next = renewed.body.lease as StationLease;
    expect(next.leaseId).toBe(lease.leaseId);
    expect(Date.parse(next.expiresAt)).toBeGreaterThanOrEqual(Date.parse(lease.expiresAt));
    lease = next;
  });

  it('shows the customer view with the till’s step and the member’s details taken out', async () => {
    const seq = document(
      await call('GET', `/stations/${tillId}/session`, { cookie: receptionCookie }),
    ).sequence as number;
    const attached = await call('POST', `/stations/${tillId}/intents`, {
      cookie: receptionCookie,
      payload: {
        type: 'member.attach',
        leaseId: lease.leaseId,
        lastSeenSequence: seq,
        payload: {
          member: {
            id: '018f0000-0000-7000-8000-0000000000f1',
            displayName: 'Nok',
            phone: '+66811111111',
            children: [{ name: 'Ploy', allergies: 'peanuts' }],
          },
        },
      },
    });
    expect(attached.statusCode).toBe(200);

    const customer = await call('GET', `/stations/${tillId}/session?view=customer`, {
      cookie: receptionCookie,
    });
    const member = document(customer).member as Record<string, unknown>;
    expect(member.displayName).toBe('Nok');
    expect('phone' in member).toBe(false);
    expect('children' in member).toBe(false);
    expect(document(customer).step).toBeNull();

    // The till's own view is untouched: the redaction happens on the way out.
    const staff = await call('GET', `/stations/${tillId}/session`, { cookie: receptionCookie });
    expect((document(staff).member as Record<string, unknown>).phone).toBe('+66811111111');
  });

  it('refuses a station this session is not standing at and may not look at either', async () => {
    // Reception cannot see Booth 1 at all — the S2-04 visibility rule — so it
    // has no permission to observe it and no session standing at it.
    const res = await call('GET', `/stations/${boothId}/session`, { cookie: receptionCookie });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
  });

  it('refuses anybody with no session at all', async () => {
    // Bodies that would otherwise be answered 400 by the schema before the
    // guard is ever reached. What is under test is the refusal, not the shape.
    const surface: Array<['GET' | 'POST', string, unknown?]> = [
      ['GET', `/stations/${tillId}/session`],
      ['POST', `/stations/${tillId}/lease`, { holder: 'anon' }],
      ['POST', `/stations/${tillId}/lease/renew`, { leaseId: '018f0000-0000-7000-8000-00000000dead' }],
      ['POST', `/stations/${tillId}/lease/release`, { leaseId: '018f0000-0000-7000-8000-00000000dead' }],
      ['POST', `/stations/${tillId}/intents`, { type: 'session.reset', lastSeenSequence: 0, payload: {} }],
      ['GET', `/stations/${tillId}/channel`],
      ['GET', '/me/station/link'],
    ];
    for (const [method, url, payload] of surface) {
      const res = await call(method, url, { payload });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('a manager watching from the Console is an observer (S2-05)', () => {
  /**
   * Every till-only intent this box understands today. The cart's own intents
   * belong to the money path and are not registered yet, so the rule is proved
   * against a registered one here and against a registered `cart.add_line` in
   * `packages/box-agent/test/station-session.test.ts` — which is where the
   * money path will add it.
   */
  const TILL_WORK = ['session.set_stage', 'member.clear', 'prompt.clear', 'session.reset'];

  it('sees the document and cannot change it, whatever lease it quotes', async () => {
    const seen = await call('GET', `/stations/${tillId}/session`, { cookie: adminCookie });
    expect(seen.statusCode).toBe(200);
    // Not a till: the box judges what this session may send by this word.
    expect(seen.body.source).toBe('console');

    const held = document(seen).lease as StationLease;
    const sequence = document(seen).sequence as number;

    for (const type of TILL_WORK) {
      const attempt = await call('POST', `/stations/${tillId}/intents`, {
        cookie: adminCookie,
        payload: {
          type,
          // Quoting the LIVE lease, so the refusal cannot be "no lease": what
          // is under test is the source, not what it is holding.
          leaseId: held.leaseId,
          lastSeenSequence: sequence,
          payload: { stage: 'order' },
        },
      });
      expect(attempt.statusCode, type).toBe(403);
      expect(errorCode(attempt), type).toBe('STATION_NOT_PERMITTED');
    }

    const after = await call('GET', `/stations/${tillId}/session`, { cookie: adminCookie });
    expect(document(after).sequence).toBe(sequence);
    expect(document(after).cart).toBeNull();
  });

  it('cannot take the lease either, because it is not standing at the station', async () => {
    const res = await call('POST', `/stations/${tillId}/lease`, {
      cookie: adminCookie,
      payload: { holder: 'console-tab', takeover: true },
    });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('STATION_NOT_PICKED');
  });
});

describe('taking a live station needs a manager, and says who (S2-05)', () => {
  it('refuses a second till on a live lease, and tells it a manager can take over', async () => {
    const res = await call('POST', `/stations/${tillId}/lease`, {
      cookie: receptionCookie,
      payload: { holder: 'tab-2' },
    });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('STATION_NO_LEASE');
    expect((res.body.error as { message: string }).message).toMatch(/manager can take it over/);
  });

  it('refuses a takeover by somebody who does not hold pos:station:takeover', async () => {
    const res = await call('POST', `/stations/${tillId}/lease`, {
      cookie: receptionCookie,
      payload: { holder: 'tab-2', takeover: true },
    });
    expect(res.statusCode).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
  });

  it('lets a manager standing at the station take it, and audits who did', async () => {
    // The manager walks to the counter: their session takes the station, which
    // is what makes them a holder rather than an observer.
    await pick(adminCookie, tillId);

    const before = await call('GET', `/stations/${tillId}/session`, { cookie: adminCookie });
    const displaced = document(before).lease as StationLease;

    const res = await call('POST', `/stations/${tillId}/lease`, {
      cookie: adminCookie,
      payload: { holder: 'till-2', takeover: true },
      headers: { 'x-oto-action-id': 'takeover-test-0001' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.takenOver).toBe(true);
    expect(document(res).takeoverCount).toBe(1);

    const [recorded] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'station.takeover'), eq(auditLog.entityId, tillId)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(recorded, 'a takeover is audited by name').toBeTruthy();
    expect(recorded!.actorAccountId).toBe(adminAccountId);
    expect(recorded!.actionId).toBe('takeover-test-0001');
    expect((recorded!.before as { leaseId?: string }).leaseId).toBe(displaced.leaseId);
    expect((recorded!.after as { accountId?: string }).accountId).toBe(adminAccountId);
  });

  it('tells the displaced till that the session moved, with the current document', async () => {
    const res = await call('POST', `/stations/${tillId}/intents`, {
      cookie: receptionCookie,
      payload: {
        type: 'session.reset',
        leaseId: '018f0000-0000-7000-8000-00000000dead',
        lastSeenSequence: 0,
        payload: {},
      },
    });
    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('STATION_STALE');
    expect((res.body.error as { message: string }).message).toMatch(/moved to another till/);
  });
});

/**
 * Standing at a station is not holding it (S2-05).
 *
 * Two tills, two signed-in people, one counter. A holds the lease; B has
 * picked the same station, so B is a `till` rather than an observer and every
 * source check lets it through. What B does not have is the lease — and the
 * lease id is on every snapshot B is allowed to read, so B can quote it.
 *
 * That is the whole of this block: B is refused the station through the front
 * door and must then be refused through the lease id it can simply read. Each
 * of these went through with a 200 while the only check was `leaseId ===
 * leaseId`, and one of them — the claim — handed the station over quietly,
 * with `takenOver: false` and no `station.takeover` row for anybody to find.
 */
describe('standing at a station is not holding it (S2-05)', () => {
  /** A's lease. B never receives this from a claim; B reads it off the document. */
  let held: StationLease;

  async function takeoverRows(): Promise<number> {
    const rows = await ctx.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'station.takeover'), eq(auditLog.entityId, tillId)));
    return rows.length;
  }

  const leaseOf = (res: Injected): StationLease => document(res).lease as StationLease;

  beforeAll(async () => {
    // Both sessions take the station: A and B are two screens at one counter,
    // which is the position the picker's visibility rule actually allows.
    await pick(adminCookie, tillId);
    await pick(receptionCookie, tillId);
    const claimed = await call('POST', `/stations/${tillId}/lease`, {
      cookie: adminCookie,
      payload: { holder: 'ipad-A2', takeover: true },
    });
    if (claimed.statusCode !== 200) {
      throw new Error(`A could not take the station: ${JSON.stringify(claimed.body)}`);
    }
    held = claimed.body.lease as StationLease;
  });

  it('refuses B the lease, and refuses B the takeover that would earn it', async () => {
    const claim = await call('POST', `/stations/${tillId}/lease`, {
      cookie: receptionCookie,
      payload: { holder: 'ipad-B1' },
    });
    expect(claim.statusCode).toBe(409);
    expect(errorCode(claim)).toBe('STATION_NO_LEASE');

    const forced = await call('POST', `/stations/${tillId}/lease`, {
      cookie: receptionCookie,
      payload: { holder: 'ipad-B1', takeover: true },
    });
    expect(forced.statusCode).toBe(403);
    expect(errorCode(forced)).toBe('FORBIDDEN');
  });

  it('hands B the lease id and the holder, which is exactly why neither is the check', async () => {
    const seen = await call('GET', `/stations/${tillId}/session`, { cookie: receptionCookie });
    expect(seen.statusCode).toBe(200);
    // Deliberate, and the reason the account is what the box compares: a till
    // that was just refused the station can read both of these.
    expect(leaseOf(seen).leaseId).toBe(held.leaseId);
    expect(leaseOf(seen).holder).toBe('ipad-A2');
    expect(leaseOf(seen).accountId).toBe(adminAccountId);
  });

  it('refuses every till intent B sends under A’s lease, and leaves the sale alone', async () => {
    const before = await call('GET', `/stations/${tillId}/session`, { cookie: receptionCookie });
    const sequence = document(before).sequence as number;
    const stage = document(before).stage as string;

    for (const [type, payload] of [
      ['session.set_stage', { stage: 'order' }],
      ['session.reset', {}],
      ['prompt.set', { kind: 'phone' }],
      ['member.clear', {}],
    ] as const) {
      const attempt = await call('POST', `/stations/${tillId}/intents`, {
        cookie: receptionCookie,
        payload: { type, leaseId: held.leaseId, lastSeenSequence: sequence, payload },
      });
      expect(attempt.statusCode, type).toBe(403);
      expect(errorCode(attempt), type).toBe('STATION_NOT_PERMITTED');
    }

    const after = await call('GET', `/stations/${tillId}/session`, { cookie: receptionCookie });
    expect(document(after).sequence).toBe(sequence);
    expect(document(after).stage).toBe(stage);
  });

  it('does not hand B the station for typing back the holder it can read', async () => {
    const audited = await takeoverRows();

    const copied = await call('POST', `/stations/${tillId}/lease`, {
      cookie: receptionCookie,
      // The holder string exactly as the document publishes it. Read as a
      // renewal, this returned 200 with the live lease and `takenOver: false`.
      payload: { holder: 'ipad-A2' },
    });
    expect(copied.statusCode).toBe(409);
    expect(errorCode(copied)).toBe('STATION_NO_LEASE');

    const [row] = await ctx.db
      .select()
      .from(stationSession)
      .where(eq(stationSession.stationId, tillId))
      .limit(1);
    expect(row?.leaseId).toBe(held.leaseId);
    expect(row?.leaseAccountId).toBe(adminAccountId);
    // A takeover that is not audited is the failure this refusal exists to
    // prevent, so the count is the assertion, not the status code alone.
    expect(await takeoverRows()).toBe(audited);
  });

  it('refuses B the renewal and the release of a lease B does not hold', async () => {
    const renewed = await call('POST', `/stations/${tillId}/lease/renew`, {
      cookie: receptionCookie,
      payload: { leaseId: held.leaseId },
    });
    expect(renewed.statusCode).toBe(403);
    expect(errorCode(renewed)).toBe('STATION_NOT_PERMITTED');

    const released = await call('POST', `/stations/${tillId}/lease/release`, {
      cookie: receptionCookie,
      payload: { leaseId: held.leaseId },
    });
    expect(released.statusCode).toBe(403);
    expect(errorCode(released)).toBe('STATION_NOT_PERMITTED');

    const [row] = await ctx.db
      .select()
      .from(stationSession)
      .where(eq(stationSession.stationId, tillId))
      .limit(1);
    expect(row?.leaseId, 'A is still working, and still holds the station').toBe(held.leaseId);
  });

  it('lets A carry on, from a reloaded tab as well as the one that claimed it', async () => {
    const renewed = await call('POST', `/stations/${tillId}/lease/renew`, {
      cookie: adminCookie,
      payload: { leaseId: held.leaseId },
    });
    expect(renewed.statusCode).toBe(200);

    // The tab reloads and claims again under the name it stored. Same account,
    // same screen: a renewal, not a second till and not a takeover.
    const reloaded = await call('POST', `/stations/${tillId}/lease`, {
      cookie: adminCookie,
      payload: { holder: 'ipad-A2' },
    });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.body.takenOver).toBe(false);
    expect((reloaded.body.lease as StationLease).leaseId).toBe(held.leaseId);

    const seq = document(
      await call('GET', `/stations/${tillId}/session`, { cookie: adminCookie }),
    ).sequence as number;
    const applied = await call('POST', `/stations/${tillId}/intents`, {
      cookie: adminCookie,
      payload: {
        type: 'session.set_stage',
        leaseId: held.leaseId,
        lastSeenSequence: seq,
        payload: { stage: 'order' },
      },
    });
    expect(applied.statusCode).toBe(200);
    expect(document(applied).stage).toBe('order');

    const gone = await call('POST', `/stations/${tillId}/lease/release`, {
      cookie: adminCookie,
      payload: { leaseId: held.leaseId },
    });
    expect(gone.statusCode).toBe(200);
    expect(gone.body.released).toBe(true);
  });

  it('lets B have the station once A has given it up, with no manager needed', async () => {
    const claim = await call('POST', `/stations/${tillId}/lease`, {
      cookie: receptionCookie,
      payload: { holder: 'ipad-B1' },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.body.takenOver).toBe(false);
    expect((claim.body.lease as StationLease).accountId).toBe(receptionAccountId);

    // And now it is A that may not reach in: the rule is about the lease, not
    // about which of the two accounts is the more senior.
    const seq = document(
      await call('GET', `/stations/${tillId}/session`, { cookie: adminCookie }),
    ).sequence as number;
    const leaseId = (claim.body.lease as StationLease).leaseId;
    const attempt = await call('POST', `/stations/${tillId}/intents`, {
      cookie: adminCookie,
      payload: {
        type: 'session.reset',
        leaseId,
        lastSeenSequence: seq,
        payload: {},
      },
    });
    expect(attempt.statusCode).toBe(403);
    expect(errorCode(attempt)).toBe('STATION_NOT_PERMITTED');

    await call('POST', `/stations/${tillId}/lease/release`, {
      cookie: receptionCookie,
      payload: { leaseId },
    });
  });
});

describe('what the till’s banner reads (S2-05)', () => {
  it('answers for the session’s own station, with no permission at all', async () => {
    const res = await call('GET', '/me/station/link', { cookie: receptionCookie });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      stationId: tillId,
      boxId,
      boxName: 'Virtual box 1',
      offline: false,
      outboxDepth: 0,
      syncStale: false,
    });
  });

  it('says the box is working alone once somebody has taken it offline', async () => {
    await ctx.db
      .insert(boxState)
      .values({ boxId, offline: true, offlineSince: new Date(), offlineReason: 'console' })
      .onConflictDoUpdate({
        target: boxState.boxId,
        set: { offline: true, offlineSince: new Date(), offlineReason: 'console' },
      });
    const res = await call('GET', '/me/station/link', { cookie: receptionCookie });
    expect(res.body.offline).toBe(true);
    expect(res.body.offlineReason).toBe('console');

    await ctx.db
      .update(boxState)
      .set({ offline: false, offlineSince: null, offlineReason: null })
      .where(eq(boxState.boxId, boxId));
  });
});

/**
 * The channel, over a real socket.
 *
 * `app.inject` cannot carry this one: the whole behaviour is a response that
 * does not end, and light-my-request buffers until it does. So the app listens
 * on a port the operating system picks and the test reads the stream the way a
 * browser's EventSource would — which is also the only way to prove the thing
 * `/ready` is actually counting.
 */
describe('the station channel, and what /ready can see of it (S2-05)', () => {
  let origin: string;

  beforeAll(async () => {
    await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    const address = ctx.app.server.address();
    if (!address || typeof address === 'string') throw new Error('the api did not bind a port');
    origin = `http://127.0.0.1:${address.port}`;
  });

  async function readyChannels(): Promise<{
    stations: number;
    connections: number;
    perStation: Record<string, number>;
  }> {
    const res = await fetch(`${origin}/ready`);
    const body = (await res.json()) as {
      checks: { stationChannels: { stations: number; connections: number; perStation: Record<string, number> } };
    };
    return body.checks.stationChannels;
  }

  it('sends the current snapshot on connect and is counted while it is open', async () => {
    expect(await readyChannels()).toMatchObject({ stations: 0, connections: 0 });

    const abort = new AbortController();
    const res = await fetch(`${origin}/stations/${tillId}/channel`, {
      headers: { cookie: receptionCookie },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(/^event: snapshot\n/);
    const snapshot = JSON.parse(first.slice(first.indexOf('data: ') + 6).trim()) as {
      kind: string;
      view: string;
      document: { stationId: string };
    };
    expect(snapshot.kind).toBe('snapshot');
    expect(snapshot.view).toBe('staff');
    expect(snapshot.document.stationId).toBe(tillId);

    const open = await readyChannels();
    expect(open.connections).toBe(1);
    expect(open.stations).toBe(1);
    expect(open.perStation[tillId]).toBe(1);

    // And the count comes back down when the screen goes away, because a
    // connection counted forever is a station that reads as busy forever.
    abort.abort();
    await reader.cancel().catch(() => undefined);
    await waitFor(async () => (await readyChannels()).connections === 0);
    expect(await readyChannels()).toMatchObject({ stations: 0, connections: 0, perStation: {} });
  });
});

/** Poll until a condition holds; a closed socket is noticed, not awaited on. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition did not hold in time');
}

// ---------------------------------------------------------------------------
// The store itself, over Postgres

describe('SqlBoxStore over the edge schema (S2-05)', () => {
  /** The same file the Pi runs, pointed at the api's own pool. */
  function openStore(now: () => Date): SqlBoxStore {
    const pool = (ctx.db as unknown as { $client: PgPoolLike }).$client;
    return new SqlBoxStore({ driver: postgresBoxDriver(pool), now });
  }

  it('hands out a gapless sequence under the row lock, however concurrent the queueing', async () => {
    const store = openStore(() => new Date());
    const [row] = await ctx.db.select().from(box).where(eq(box.slot, 'virtual-2')).limit(1);
    const id = row!.id;
    await store.init(id);
    const before = (await store.readState(id)).nextBoxSeq;

    const seal = (draft: Parameters<Parameters<typeof store.enqueue>[2]>[0]) => ({
      ...draft,
      payloadHash: 'a'.repeat(64),
      sig: 'test',
      sigAlg: 'ed25519' as const,
    });
    const queued = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        store.enqueue(id, { type: 'member.created', payload: { n } }, seal),
      ),
    );
    const sequences = queued.map((r) => r.envelope.boxSeq).sort((a, b) => a - b);
    expect(sequences).toEqual([before, before + 1, before + 2, before + 3, before + 4]);
    expect((await store.depth(id)).queued).toBe(5);

    // And every one of them is a row, not a promise somebody is holding.
    const rows = await ctx.db.select().from(boxOutbox).where(eq(boxOutbox.boxId, id));
    expect(rows.length).toBe(5);
    await ctx.db.delete(boxOutbox).where(eq(boxOutbox.boxId, id));
  });

  /**
   * The race the expiry inside the compare-and-set exists for, in the dialect
   * the virtual box actually runs.
   *
   * A holds the station. Sixty-one seconds pass with nothing reaching the
   * store, so B reads the row, sees an expired lease and decides to claim it.
   * A's heartbeat then lands — late, but alive — inside B's read-to-write
   * window. B must lose, because the till it would displace is somebody
   * standing at a counter mid-sale.
   */
  it('refuses a claim of a lease that was renewed between the read and the write', async () => {
    let now = new Date('2026-09-20T03:00:00.000Z');
    const store = openStore(() => now);
    const [row] = await ctx.db.select().from(station).where(eq(station.name, 'Counter 2')).limit(1);
    const identity = {
      stationId: row!.id,
      boxId: row!.boxId!,
      operatorId: row!.operatorId,
      branchId: row!.branchId,
    };
    await store.init(identity.boxId);
    await store.ensureSession(identity, now.toISOString());

    const leaseA = {
      leaseId: '018f0000-0000-7000-8000-0000000a0001',
      holder: 'till-A',
      holderKind: 'till' as const,
      accountId: null,
      startedAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    };
    expect(
      await store.applyLease(identity.stationId, { leaseId: null }, { lease: leaseA }, now.toISOString()),
    ).toBeTruthy();

    // B reads the row past the TTL and judges the lease abandoned.
    now = new Date(Date.parse(leaseA.expiresAt) + 1_000);
    const readByB = await store.readSession(identity.stationId);
    expect(Date.parse(readByB!.lease!.expiresAt)).toBeLessThanOrEqual(now.getTime());
    const bDecidedAt = now.toISOString();

    // A's heartbeat lands first, keeping the same lease id on purpose.
    const renewedA = await store.applyLease(
      identity.stationId,
      { leaseId: leaseA.leaseId },
      { lease: { ...leaseA, heartbeatAt: bDecidedAt, expiresAt: new Date(now.getTime() + 60_000).toISOString() } },
      bDecidedAt,
    );
    expect(renewedA).toBeTruthy();

    // B's write, quoting what it read AND when it judged it dead.
    const bWon = await store.applyLease(
      identity.stationId,
      { leaseId: leaseA.leaseId, expiredBefore: bDecidedAt },
      {
        lease: {
          leaseId: '018f0000-0000-7000-8000-0000000a0002',
          holder: 'till-B',
          holderKind: 'till',
          accountId: null,
          startedAt: bDecidedAt,
          heartbeatAt: bDecidedAt,
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        },
      },
      bDecidedAt,
    );
    expect(bWon, 'B must not take a station from a till that renewed').toBeNull();

    const final = await store.readSession(identity.stationId);
    expect(final!.lease!.holder).toBe('till-A');
    expect(final!.takeoverCount).toBe(0);

    // And a lease that really has run out is still claimable, with no manager:
    // that is what makes a closed browser tab recoverable on its own.
    now = new Date(Date.parse(final!.lease!.expiresAt) + 1_000);
    const claimed = await store.applyLease(
      identity.stationId,
      { leaseId: final!.lease!.leaseId, expiredBefore: now.toISOString() },
      {
        lease: {
          leaseId: '018f0000-0000-7000-8000-0000000a0003',
          holder: 'till-B',
          holderKind: 'till',
          accountId: null,
          startedAt: now.toISOString(),
          heartbeatAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        },
      },
      now.toISOString(),
    );
    expect(claimed).toBeTruthy();
    expect(claimed!.lease!.holder).toBe('till-B');
    expect(claimed!.takeoverCount).toBe(0);

    await ctx.db
      .delete(stationSession)
      .where(eq(stationSession.stationId, identity.stationId));
  });
});

// ---------------------------------------------------------------------------
// The virtual box, with somewhere to remember things

describe('the virtual box keeps its queue across a restart (S2-05)', () => {
  /** `app.inject` behind the agent's transport, as `box-agent.test.ts` does it. */
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

  /**
   * The box's identity, kept across the restart on purpose.
   *
   * A Pi's credential is a file on its memory card, so a box that comes back
   * from a power cut is the same box with the same signing key. The virtual
   * box's is in memory, because there is nowhere on a Render container that is
   * both durable and private — which means a redeploy makes it register again
   * and ROTATE its key, and `POST /box/v1/sync/key` says what that costs:
   * events already queued under the old key no longer verify. This block is
   * about the store surviving a restart, so it holds the identity still and
   * the key rotation is left as the separate problem it is.
   */
  const credentials = memoryCredentialStore();

  async function buildAgent(db: Db): Promise<BoxAgent> {
    const pool = (db as unknown as { $client: PgPoolLike }).$client;
    const agent = createBoxAgent({
      apiBaseUrl: 'http://virtual-box.test',
      credentials,
      hostname: 'virtual-test',
      fetch: injectTransport(),
      claimCode: async () => (await provisionVirtualBox(db, ctx.app.log))?.claimCode ?? null,
      // The whole point of this block: the box has somewhere to remember, and
      // it is the `edge` schema rather than this process's heap.
      store: new SqlBoxStore({ driver: postgresBoxDriver(pool) }),
    });
    await agent.ensureRegistered();
    await agent.syncConfig();
    return agent;
  }

  it('remembers the offline flag and three queued facts through a new api', async () => {
    const agent = await buildAgent(ctx.db);
    expect(agent.state.boxId).toBe(boxId);

    await agent.setOffline(true, { reason: 'console' });
    for (const n of [1, 2, 3]) {
      await agent.outbox()!.queue({
        type: 'member.created',
        stationId: tillId,
        payload: {
          memberId: `018f0000-0000-7000-8000-0000000cafe${n}`,
          phone: `08120000${n}${n}`,
          nickname: `Queued ${n}`,
          createdVia: 'pos',
        },
      });
    }
    expect((await agent.outbox()!.depth()).queued).toBe(3);

    // A Render "Restart": the api is thrown away and a new one built on the
    // same database. Nothing the box was holding was in it.
    await ctx.restart();

    const [state] = await ctx.db.select().from(boxState).where(eq(boxState.boxId, boxId)).limit(1);
    expect(state!.offline, 'a box put offline for the evening stays offline').toBe(true);

    const fresh = await buildAgent(ctx.db);
    expect(fresh.state.offline).toBe(true);
    expect(fresh.state.epoch).toBe(state!.journalEpoch);
    expect((await fresh.outbox()!.depth()).queued).toBe(3);

    // Back online, and the queue goes where it was always going.
    await fresh.setOffline(false);
    expect((await fresh.outbox()!.depth()).queued).toBe(0);
    const rows = await ctx.db.select().from(boxOutbox).where(eq(boxOutbox.boxId, boxId));
    expect(rows.every((r) => r.state === 'acked')).toBe(true);
    fresh.stop();
    agent.stop();
  });
});
