import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { box, boxOutbox, product, sale, station } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type AgentFetch, type BoxAgent, type BoxStore } from '@oto/box-agent';
import { newId, type BridgeSaleAnswer } from '@oto/shared';
import { ADMIN, RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * SCRUM-486 gate reproduction — TWO ADOPTIONS OF THE SAME EPOCH, ON THE
 * PLATFORM'S OWN `edge` STORE (the virtual box), RESTART THE SEQUENCE TWICE.
 *
 * `adoptPlatformEpoch` reads `box_state` with a plain SELECT and then calls
 * `setEpoch`, which sets `next_box_seq = 1` unconditionally. On Postgres the
 * SELECT takes no lock, so a push answer's adoption that read the OLD epoch,
 * and a heartbeat's adoption that commits the new one, can both write it.
 * A sale sealed between the two takes (E+1, 1); the second write puts the
 * generator back at 1; the next sale is sealed at (E+1, 1) again — an address
 * the cloud already holds — and is answered `duplicate`: a paid sale silently
 * gone, in neither the ledger nor quarantine.
 *
 * The interleaving is forced by pausing the push answer's adoption after its
 * read, inside its transaction — exactly where two concurrent timers on the
 * virtual box can leave it.
 */

let ctx: TestContext;
let cookies: { till1: string; admin: string };
let operatorId: string;
let till1: string;
let box1Id: string;
let capId: string;
let capUnitSatang: number;
let agent: BoxAgent;
const link: CuttableLink = { cut: false };
const loseResultAnswer = { next: false };

/** Pause the next `readState` made inside a transaction, once armed. */
const gate: { armed: boolean; reached: (() => void) | null; release: Promise<void> | null } = {
  armed: false,
  reached: null,
  release: null,
};

function gatedStore(real: BoxStore): BoxStore {
  const wrapTx = (tx: BoxStore): BoxStore =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop === 'readState' && gate.armed) {
          return async (boxId: string) => {
            const read = await target.readState(boxId);
            if (gate.armed) {
              gate.armed = false;
              gate.reached?.();
              await gate.release;
            }
            return read;
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'atomically') {
        return <T>(fn: (tx: BoxStore) => Promise<T>) => target.atomically((tx) => fn(wrapTx(tx)));
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

let armOnPushAnswer = false;

function raceAgent(boxId: string): BoxAgent {
  const through = injectedTransport(ctx, link);
  const fetch: AgentFetch = async (url, init) => {
    const res = await through(url, init);
    const path = new URL(url).pathname;
    if (/\/box\/v1\/commands\/[^/]+\/result$/.test(path) && loseResultAnswer.next) {
      loseResultAnswer.next = false;
      throw new Error('ECONNRESET: the answer was lost on the way back');
    }
    if (path === '/box/v1/sync/push' && armOnPushAnswer) {
      armOnPushAnswer = false;
      gate.armed = true;
    }
    return res;
  };
  return createBoxAgent({
    apiBaseUrl: 'http://race-box.test',
    credentials: memoryCredentialStore(),
    hostname: 'race-box',
    fetch,
    store: gatedStore(boxStoreFor(ctx.db)),
    claimCode: async () => (await issueClaimCode(ctx.db, boxId)).code,
    booth: { verifySecret: (hash, secret) => verifyArgon(hash, secret) },
    bridge: { verifyPassword: (hash, password) => verifyArgon(hash, password) },
    printing: { retryDelayMs: 0 },
    terminal: { enabled: false },
    bands: { key: currentBandKey },
  });
}

async function call(
  cookie: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as never }) });
  return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
}

async function sellCap(): Promise<string> {
  const saleId = newId();
  const res = await call(cookies.till1, 'POST', `/box/v1/station/${till1}/intents`, {
    type: 'sale.finalise',
    lastSeenSequence: 0,
    actionId: `s-${newId().slice(-12)}`,
    payload: {
      saleId,
      actionId: `pay-${newId().slice(-12)}`,
      staffName: 'Nok',
      cart: { items: [{ id: newId(), productId: capId, quantity: 1 }], channel: 'shop', expectedTotalSatang: capUnitSatang },
      tender: {
        actionId: `cash-${newId().slice(-12)}`,
        method: 'cash',
        kind: 'cash',
        amountSatang: capUnitSatang,
        tenderedSatang: capUnitSatang,
        changeSatang: 0,
      },
    },
  });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  expect((res.body.result as BridgeSaleAnswer).finalised).toBe(true);
  return saleId;
}

async function drain(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    for (let j = 0; j < 10; j += 1) {
      const outcome = await agent.outbox()!.flush().catch(() => ({ state: 'deferred' as const }));
      if (outcome.state !== 'pushed') break;
    }
    if ((await agent.outbox()!.depth()).queued === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const platformEpoch = async (): Promise<number> =>
  (await ctx.db.select({ epoch: box.currentEpoch }).from(box).where(eq(box.id, box1Id)))[0]!.epoch;

async function sealedAt(saleId: string): Promise<{ epoch: number; seq: number }> {
  const [row] = (
    await ctx.db.select().from(boxOutbox).where(and(eq(boxOutbox.boxId, box1Id), eq(boxOutbox.type, 'sale.finalised')))
  ).filter((e) => (e.payload as { saleId?: string }).saleId === saleId);
  return { epoch: row!.journalEpoch, seq: Number(row!.boxSeq) };
}

beforeAll(async () => {
  ctx = await createTestContext();
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  box1Id = box1.id;
  const [t1] = await ctx.db.select().from(station).where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  till1 = t1!.id;
  operatorId = t1!.operatorId;
  cookies = {
    till1: await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password),
    admin: await signInAs(ctx.app, ADMIN.phone, ADMIN.password),
  };
  expect((await call(cookies.till1, 'PUT', '/me/session/station', { stationId: till1 })).statusCode).toBe(200);
  const [cap] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, 'MR-CAP'), isNull(product.archivedAt)));
  capId = cap!.id;
  const quoted = await call(cookies.till1, 'POST', '/sales/quote', {
    stationId: till1,
    items: [{ id: newId(), productId: capId, quantity: 1 }],
    channel: 'shop',
  });
  expect(quoted.statusCode, JSON.stringify(quoted.body)).toBe(200);
  capUnitSatang = (quoted.body.quote as { totals: { grossSatang: number } }).totals.grossSatang;

  agent = raceAgent(box1.id);
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  await agent.syncCache();
  attachInProcessBox(agent);
  await agent.heartbeat();
}, 240_000);

afterAll(async () => {
  agent?.stop();
  if (agent) detachInProcessBox(agent);
  await ctx?.close();
  await teardownAll();
});

describe('SCRUM-486 gate: a push answer and a heartbeat adopting the same epoch at once', () => {
  it('never puts the sequence back under a sale already sealed on the adopted epoch', async () => {
    const before = await platformEpoch();
    expect((await call(cookies.admin, 'POST', `/boxes/${box1Id}/commands`, { kind: 'reset_store' })).statusCode).toBe(200);

    // A cap sold before anything is heard, on the current epoch (set aside later, by design).
    await agent.setOffline(true, { reason: 'gate race' });
    link.cut = true;
    await sellCap();
    link.cut = false;
    await boxStoreFor(ctx.db).setOffline(box1Id, false);

    // The reset runs; its answer is lost. Platform on E+1, store on E.
    loseResultAnswer.next = true;
    await expect(agent.heartbeat()).rejects.toThrow(/ECONNRESET/);
    expect(await platformEpoch()).toBe(before + 1);

    // B: the outbox pushes; its answer names E+1; its adoption reads E and pauses.
    let reached!: () => void;
    const atRead = new Promise<void>((resolve) => (reached = resolve));
    let release!: () => void;
    gate.reached = reached;
    gate.release = new Promise<void>((resolve) => (release = resolve));
    armOnPushAnswer = true;
    const flushB = agent.outbox()!.flush();
    await atRead;

    // A: the heartbeat adopts E+1 and commits.
    await agent.heartbeat();
    expect((await boxStoreFor(ctx.db).readState(box1Id)).journalEpoch).toBe(before + 1);

    // C: a sale sealed on E+1.
    await agent.setOffline(true, { reason: 'gate race C' });
    const saleC = await sellCap();
    expect(await sealedAt(saleC)).toEqual({ epoch: before + 1, seq: 1 });

    // B resumes and writes its adoption.
    release();
    await flushB;

    // The generator must still be past C's address.
    const held = await boxStoreFor(ctx.db).readState(box1Id);
    expect.soft(
      { epoch: held.journalEpoch, next: held.nextBoxSeq },
      'the second adoption put the sequence back under sale C',
    ).toEqual({ epoch: before + 1, next: 2 });

    // D and E: the next two sales are taken (not refused as duplicates of C's address).
    const statuses: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      const res = await call(cookies.till1, 'POST', `/box/v1/station/${till1}/intents`, {
        type: 'sale.finalise',
        lastSeenSequence: 0,
        actionId: `s-${newId().slice(-12)}`,
        payload: {
          saleId: newId(),
          actionId: `pay-${newId().slice(-12)}`,
          staffName: 'Nok',
          cart: { items: [{ id: newId(), productId: capId, quantity: 1 }], channel: 'shop', expectedTotalSatang: capUnitSatang },
          tender: {
            actionId: `cash-${newId().slice(-12)}`,
            method: 'cash',
            kind: 'cash',
            amountSatang: capUnitSatang,
            tenderedSatang: capUnitSatang,
            changeSatang: 0,
          },
        },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses, 'every fact after the race is refused DUPLICATE (box_outbox_journal_unique): the till is wedged').toEqual([
      200, 200,
    ]);

    await boxStoreFor(ctx.db).setOffline(box1Id, false);
    await agent.setOffline(false);
    await drain();
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleC))).toHaveLength(1);
  });
});
