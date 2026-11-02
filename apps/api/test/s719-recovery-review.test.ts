import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { account, box, boxCommand, receiptSeries, sale, station, syncAnomaly, syncQuarantine, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import {
  BoxHeartbeatRequestSchema,
  JournalEpochAwaitedError,
  SqlBoxStore,
  createBoxAgent,
  fileCredentialStore,
  type AgentFetch,
  type BoxAgent,
  type BoxHeartbeatRequest,
} from '@oto/box-agent';
import { prepareSqliteBoxStore, sqliteBoxDriver } from '@oto/box-agent/sqlite';
import { claimBox } from '@oto/box-agent/runner';
import { MIRROR_NAME, StoreMirror } from '../../../packages/box-agent/src/store-mirror';
import { restoreStore } from '../../../packages/box-agent/src/runner/store-restore';
import { evaluateBox, type BoxRuleSettings } from '../src/services/ops';
import { issueClaimCode } from '../src/services/box';
import {
  RECEPTION,
  boxBySlot,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-719 — A REPLACED DRIVE KEEPS EVERY SALE, ACROSS THE SEAM.
 *
 * The real agent (the file that runs on a Pi), on a real SQLite file, against
 * the real routes and handlers. No fact below is minted by this file: each sale
 * goes through `agent.sales()`, is sealed under the box's own key, is mirrored
 * by the real worker, restored by the real command, and reaches the ledger
 * through the real push. The order under test is the runbook's:
 *
 *   restore → claim → start and drain → Reset the store → sell.
 */

let ctx: TestContext;
let receptionCookie: string;
let receptionAccountId: string;
let branchId: string;
let operatorId: string;
let twoHoursId: string;
let root: string;
let linkUp = true;

const transport: AgentFetch = async (url, init) => {
  if (!linkUp) throw new Error('the mall link is down');
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

beforeAll(async () => {
  ctx = await createTestContext();
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [reception] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone)).limit(1);
  receptionAccountId = reception!.id;
  branchId = await branchIdByCode(ctx.db, 'hkt-central');
  operatorId = (await boxBySlot(ctx.db, 'virtual-1')).operatorId;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  root = mkdtempSync(join(tmpdir(), 'oto-s719-'));
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
  rmSync(root, { recursive: true, force: true });
});

let serial = 0;

/** A box with a till of its own, so a receipt series and a journal nothing else touches. */
async function counterBox() {
  const n = (serial += 1);
  const boxId = newId();
  await ctx.db.insert(box).values({
    id: boxId,
    operatorId,
    branchId,
    name: `ZZ TEST recovery ${n}`,
    slot: `recovery-${n}`,
    role: 'counter',
    status: 'unclaimed',
  });
  const stationId = newId();
  const prefix = `R${n}`;
  await ctx.db.insert(station).values({
    id: stationId,
    operatorId,
    branchId,
    boxId,
    name: `Recovery till ${n}`,
    kind: 'till',
    codePrefix: prefix,
  });
  const home = join(root, `drive-${n}`);
  return { boxId, stationId, prefix, home, mirrorDirectory: join(root, `second-drive-${n}`) };
}

/** The agent on the store in `home`, as the runner assembles it, with no timers of its own. */
async function agentOn(home: string): Promise<{ agent: BoxAgent; close: () => void }> {
  const db = new DatabaseSync(join(home, 'box.sqlite'));
  prepareSqliteBoxStore(db);
  const agent = createBoxAgent({
    apiBaseUrl: 'http://platform.test',
    credentials: fileCredentialStore(join(home, 'credential.json')),
    hostname: 'zz-recovery',
    fetch: transport,
    store: new SqlBoxStore({ driver: sqliteBoxDriver(db) }),
    terminal: { enabled: false },
  });
  await agent.prepare();
  return {
    agent,
    close: () => {
      agent.stop();
      db.close();
    },
  };
}

const claim = async (boxId: string, home: string) => {
  const { code } = await issueClaimCode(ctx.db, boxId);
  return claimBox({ home, apiBaseUrl: 'http://platform.test', code, fetch: transport, hostname: 'zz-recovery' });
};

async function quotedTotal(stationId: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales/quote',
    headers: { cookie: receptionCookie },
    payload: { stationId, lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 0 }] },
  });
  expect(res.statusCode).toBe(200);
  return Number(res.json().totals.grossSatang);
}

function sell(agent: BoxAgent, stationId: string, total: number) {
  const saleId = newId();
  const press = `press-${newId()}`;
  return agent
    .sales()!
    .record({
      saleId,
      stationId,
      actorAccountId: receptionAccountId,
      cart: { lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 0 }], expectedTotalSatang: total },
      tenders: [
        { actionId: press, methodCode: 'cash', kind: 'cash', amountSatang: total, tenderedSatang: total, changeSatang: 0 },
      ],
      actionId: press,
    })
    .then((taken) => ({ saleId, taken }));
}

const quarantineOf = (boxId: string) =>
  ctx.db.select().from(syncQuarantine).where(eq(syncQuarantine.boxId, boxId));
const droppedOf = async (boxId: string) =>
  (await ctx.db.select().from(syncAnomaly).where(eq(syncAnomaly.boxId, boxId))).filter(
    (row) => row.kind === 'late_arrival',
  );
const saleOf = async (saleId: string) =>
  (await ctx.db.select().from(sale).where(eq(sale.id, saleId)).limit(1))[0];
const epochOf = async (boxId: string) =>
  (await ctx.db.select({ epoch: box.currentEpoch }).from(box).where(eq(box.id, boxId)).limit(1))[0]!.epoch;

/**
 * A counter that has traded online, then lost its link and its drive.
 *
 * `acked` reached the platform BEFORE the copy; `inCopy` is unsent and in the
 * copy; `ackedAfterCopy` reached the platform after the copy; `lost` was sold
 * after the copy and never left the box. The drive then dies, so the only thing
 * left of any of it on the box is the copy.
 */
async function outage() {
  const c = await counterBox();
  await claim(c.boxId, c.home);
  const first = await agentOn(c.home);
  await first.agent.syncConfig();
  await first.agent.syncCache();
  const total = await quotedTotal(c.stationId);

  const acked = await sell(first.agent, c.stationId, total);
  await first.agent.outbox()!.flush();
  expect((await saleOf(acked.saleId))?.status).toBe('finalised');

  linkUp = false;
  const inCopy = await sell(first.agent, c.stationId, total);
  const mirror = new StoreMirror({
    database: join(c.home, 'box.sqlite'),
    directory: c.mirrorDirectory,
    allowSameDevice: true,
  });
  expect(await mirror.run()).toBe('mirrored');
  linkUp = true;
  // Pushing sends the unsent `inCopy` too, which is what a link coming back does,
  // and the copy still holds it as unsent. That is the shape of a late copy.
  const ackedAfterCopy = await sell(first.agent, c.stationId, total);
  await first.agent.outbox()!.flush();
  expect((await saleOf(ackedAfterCopy.saleId))?.status).toBe('finalised');
  linkUp = false;
  const lost = await sell(first.agent, c.stationId, total);
  linkUp = true;
  first.close();
  rmSync(c.home, { recursive: true, force: true });
  return { ...c, total, acked, inCopy, ackedAfterCopy, lost, file: join(c.mirrorDirectory, MIRROR_NAME) };
}

/** A copy holding sales nobody else has, because the drive died before the link came back. */
async function outageUnsent() {
  const c = await counterBox();
  await claim(c.boxId, c.home);
  const first = await agentOn(c.home);
  await first.agent.syncConfig();
  await first.agent.syncCache();
  const total = await quotedTotal(c.stationId);
  const online = await sell(first.agent, c.stationId, total);
  await first.agent.outbox()!.flush();
  expect((await saleOf(online.saleId))?.status).toBe('finalised');

  linkUp = false;
  const unsent = [
    await sell(first.agent, c.stationId, total),
    await sell(first.agent, c.stationId, total),
  ];
  const mirror = new StoreMirror({
    database: join(c.home, 'box.sqlite'),
    directory: c.mirrorDirectory,
    allowSameDevice: true,
  });
  expect(await mirror.run()).toBe('mirrored');
  const guestHolds = await sell(first.agent, c.stationId, total);
  first.close();
  linkUp = true;
  rmSync(c.home, { recursive: true, force: true });
  return { ...c, total, online, unsent, guestHolds, file: join(c.mirrorDirectory, MIRROR_NAME) };
}

/** A `reset_store` the Console let through, and the box answering it. */
async function resetTheStore(agent: BoxAgent, boxId: string) {
  const id = newId();
  await ctx.db.insert(boxCommand).values({ id, boxId, kind: 'reset_store', payload: null, actionId: `reset-${id.slice(0, 8)}` });
  await agent.runPendingCommands();
}

describe('the runbook’s order keeps every sale', () => {
  it('restored sales reach the ledger, none refused or lost; new sales wait; the next sale gets a new number', async () => {
    const o = await outageUnsent();
    const epochBefore = await epochOf(o.boxId);

    // 1. The replacement drive: the store is restored before anything else.
    const restored = await restoreStore(o.home, o.file, async () => {});
    expect(restored.unsent).toBe(2);

    // 2. Claim the same box. The store keeps its journal, so the epoch stays.
    expect((await claim(o.boxId, o.home)).boxId).toBe(o.boxId);
    expect(await epochOf(o.boxId)).toBe(epochBefore);

    // 3. Start. New sales are refused, by name, while the journal waits.
    const second = await agentOn(o.home);
    expect(second.agent.state.journalAwaitingEpoch).toBe(true);
    await second.agent.syncConfig();
    await second.agent.syncCache();
    await expect(sell(second.agent, o.stationId, o.total)).rejects.toBeInstanceOf(JournalEpochAwaitedError);

    // 4. Drain: what was restored goes up. Nothing is set aside.
    await second.agent.outbox()!.flush();
    for (const { saleId, taken } of o.unsent) {
      const row = await saleOf(saleId);
      expect(row?.status).toBe('finalised');
      expect(row?.receiptNumber).toBe(taken.receipt!.number);
    }
    expect(await quarantineOf(o.boxId)).toEqual([]);
    expect(await droppedOf(o.boxId)).toEqual([]);
    expect(await second.agent.outbox()!.depth()).toMatchObject({ queued: 0 });

    // 5. Still waiting after the drain, until a person resets the store.
    await expect(sell(second.agent, o.stationId, o.total)).rejects.toBeInstanceOf(JournalEpochAwaitedError);
    await resetTheStore(second.agent, o.boxId);
    expect(await epochOf(o.boxId)).toBe(epochBefore + 1);
    expect(second.agent.state.journalAwaitingEpoch).toBe(false);
    // An online sale from here is past what a guest may hold, before any box sale moves it.
    const [movedOn] = await ctx.db.select().from(receiptSeries).where(eq(receiptSeries.stationId, o.stationId));
    expect(movedOn!.nextSeq).toBeGreaterThan(o.guestHolds.taken.receipt!.seq);

    // 6. Sell: a new number, never the one a guest may already hold from the lost tail.
    const next = await sell(second.agent, o.stationId, o.total);
    const held = o.guestHolds.taken.receipt!;
    expect(next.taken.receipt!.seq).toBeGreaterThan(held.seq);
    expect(next.taken.receipt!.number).not.toBe(held.number);
    await second.agent.outbox()!.flush();
    const banked = await saleOf(next.saleId);
    expect(banked?.status).toBe('finalised');
    expect(banked?.receiptNumber).toBe(next.taken.receipt!.number);
    expect(await quarantineOf(o.boxId)).toEqual([]);
    expect(await droppedOf(o.boxId)).toEqual([]);

    // The gap is harmless, and the platform's own next number is past everything a
    // guest may hold: it took the margin at the reset, and the next sale's number after.
    const [series] = await ctx.db.select().from(receiptSeries).where(eq(receiptSeries.stationId, o.stationId));
    expect(series!.nextSeq).toBeGreaterThan(next.taken.receipt!.seq);
    second.close();
  }, 120_000);

  it('M3: a copy older than what the platform already holds re-sends as duplicates, and never lands on a taken address', async () => {
    const o = await outage();
    await restoreStore(o.home, o.file, async () => {});
    await claim(o.boxId, o.home);
    const second = await agentOn(o.home);
    expect(second.agent.state.journalAwaitingEpoch).toBe(true);
    await second.agent.syncConfig();
    await second.agent.syncCache();

    // The fence: what was sold after the copy holds addresses the restored journal
    // would otherwise reach again.
    await expect(sell(second.agent, o.stationId, o.total)).rejects.toBeInstanceOf(JournalEpochAwaitedError);
    await second.agent.outbox()!.flush();
    expect(await second.agent.outbox()!.depth()).toMatchObject({ queued: 0 });
    expect(await quarantineOf(o.boxId)).toEqual([]);
    expect(await droppedOf(o.boxId)).toEqual([]);
    for (const { saleId } of [o.acked, o.inCopy, o.ackedAfterCopy]) {
      expect((await saleOf(saleId))?.status).toBe('finalised');
      expect(
        await ctx.db.select().from(sale).where(and(eq(sale.id, saleId), eq(sale.boxId, o.boxId))),
      ).toHaveLength(1);
    }

    await resetTheStore(second.agent, o.boxId);
    const next = await sell(second.agent, o.stationId, o.total);
    await second.agent.outbox()!.flush();
    expect((await saleOf(next.saleId))?.status).toBe('finalised');
    expect(next.taken.receipt!.seq).toBeGreaterThan(o.lost.taken.receipt!.seq);
    expect(await quarantineOf(o.boxId)).toEqual([]);
    expect(await droppedOf(o.boxId)).toEqual([]);
    second.close();
  }, 120_000);

  it('Reset the store is refused by the box itself while anything it restored is unsent', async () => {
    const o = await outageUnsent();
    await restoreStore(o.home, o.file, async () => {});
    await claim(o.boxId, o.home);
    linkUp = true;
    const second = await agentOn(o.home);
    const epochBefore = await epochOf(o.boxId);

    // The last heartbeat the platform holds is the old drive's, and says nothing is
    // waiting, so the Console lets the button through. The box does not.
    await resetTheStore(second.agent, o.boxId);
    expect(await epochOf(o.boxId)).toBe(epochBefore);
    expect(second.agent.state.journalAwaitingEpoch).toBe(true);

    await second.agent.outbox()!.flush();
    for (const { saleId } of o.unsent) expect((await saleOf(saleId))?.status).toBe('finalised');
    expect(await quarantineOf(o.boxId)).toEqual([]);
    second.close();
  }, 120_000);

  it('M2: the blank-drive-first order is stopped before it strands anything', async () => {
    const o = await outageUnsent();
    const epochBefore = await epochOf(o.boxId);

    // The old runbook: claim the blank drive first. The platform has no way to know
    // the store is about to be restored, so it moves the epoch on.
    await claim(o.boxId, o.home);
    expect(await epochOf(o.boxId)).toBe(epochBefore + 1);

    // The restore sees that and says what would happen, rather than stranding them.
    await expect(restoreStore(o.home, o.file, async () => {})).rejects.toThrow(/refuse/i);
    expect(existsSync(join(o.home, 'box.sqlite'))).toBe(true);

    // Asked to go ahead anyway, they arrive as set aside, each paid fact saying so.
    await restoreStore(o.home, o.file, async () => {}, { acceptRefused: true });
    const second = await agentOn(o.home);
    await second.agent.outbox()!.flush();
    const set = await quarantineOf(o.boxId);
    expect(set.length).toBeGreaterThan(0);
    expect(set.every((row) => row.reason === 'epoch_regressed')).toBe(true);
    second.close();
  }, 120_000);

  it('a code for another box is refused without spending it, and the restored store stays whole', async () => {
    const o = await outageUnsent();
    await restoreStore(o.home, o.file, async () => {});
    const other = await counterBox();
    const { code } = await issueClaimCode(ctx.db, other.boxId);
    await expect(
      claimBox({ home: o.home, apiBaseUrl: 'http://platform.test', code, fetch: transport }),
    ).rejects.toThrow(new RegExp(o.boxId));
    expect(existsSync(join(o.home, 'credential.json'))).toBe(false);
    const [still] = await ctx.db.select().from(box).where(eq(box.id, other.boxId)).limit(1);
    expect(still!.registeredAt).toBeNull();
    expect(still!.claimCodeHash).not.toBeNull();

    // The right box still redeems it: the refusal spent nothing.
    const redeemed = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/register',
      payload: { claimCode: code, agentVersion: '0.1.0', expectedBoxId: other.boxId },
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json().boxId).toBe(other.boxId);
  }, 120_000);

  it('M1: three minutes of a blank store leave the copies whole, and Health hears about it', async () => {
    const o = await outageUnsent();
    // The unclaimed service on the blank drive, with the mirror drive attached.
    const blankHome = join(root, `blank-${newId()}`);
    mkdirSync(blankHome, { recursive: true });
    const blank = new DatabaseSync(join(blankHome, 'box.sqlite'));
    prepareSqliteBoxStore(blank);
    blank.close();
    const mirror = new StoreMirror({
      database: join(blankHome, 'box.sqlite'),
      directory: o.mirrorDirectory,
      allowSameDevice: true,
    });
    for (let round = 0; round < 3; round += 1) expect(await mirror.run()).not.toBe('mirrored');
    const copy = new DatabaseSync(o.file, { readOnly: true });
    const n = Number(
      copy.prepare("select count(*) as n from box_outbox where state in ('queued','sending','failed')").get()!.n,
    );
    copy.close();
    expect(n).toBe(2);
    expect(mirror.problem).toBe('holds_unsent');
    expect(mirror.failures).toBe(3);
  }, 60_000);
});

// --- Health ------------------------------------------------------------------------

const NOW = Date.now();
const settings: BoxRuleSettings = {
  offlineAfterS: 180,
  minAgentVersion: '0.1.0',
  syncStaleAfterS: 300,
  revocationStaleAfterS: 300,
};
type Storage = NonNullable<BoxHeartbeatRequest['storage']>;
const healthy: Storage = {
  freeBytes: 4_000_000_000,
  totalBytes: 10_000_000_000,
  readOnly: false,
  ioErrors: 0,
  mirrorConfigured: true,
  mirrorAgeS: 5,
  mirrorFreeBytes: 4_000_000_000,
  mirrorErrors: 0,
};
function conditions(storage?: Storage) {
  return evaluateBox(
    {
      id: '018f0000-0000-7000-8000-00000000b0c1',
      name: 'Counter',
      slot: 'test',
      role: 'counter',
      operatorId: 'operator',
      branchId: 'branch',
      status: 'online',
      registeredAt: new Date(NOW - 86400_000),
      lastHeartbeatAt: new Date(NOW),
      currentEpoch: 1,
      agentVersion: '0.1.0',
      lastStatus: { ...(storage ? { storage } : {}), errors: [] },
      branchName: 'Park',
      timezone: 'Asia/Bangkok',
      businessDayStart: '05:00:00',
      openingHours: null,
    },
    [],
    settings,
    NOW,
  ).conditions;
}
const condition = (storage: Storage, category: string) =>
  conditions(storage).find((c) => c.category === category);

describe('what Health says', () => {
  it.each([
    ['same_device', /same drive/],
    ['failing', /keeps failing/],
    ['not_answering', /not answering/],
  ] as const)('%s raises the mirror warning at once, however fresh the last copy is', (mirrorProblem, words) => {
    const raised = condition({ ...healthy, mirrorProblem }, 'box.mirror_stale')!;
    expect(raised.active).toBe(true);
    expect(raised.severity).toBe('warning');
    expect(raised.summary).toMatch(words);
  });

  it('copies holding sales the store lacks are critical, and name the way back', () => {
    const raised = condition({ ...healthy, mirrorProblem: 'holds_unsent' }, 'box.mirror_stale')!;
    expect(raised).toMatchObject({ active: true, severity: 'critical' });
    expect(raised.summary).toMatch(/does not have/);
  });

  it('clears on the next healthy reading', () => {
    expect(condition(healthy, 'box.mirror_stale')).toMatchObject({ active: false, clear: { reason: 'recovered' } });
  });

  it('a drive that does not answer is a failing drive', () => {
    const raised = condition({ ...healthy, freeBytes: null, totalBytes: null, driveNotAnswering: true }, 'box.storage_failing')!;
    expect(raised).toMatchObject({ active: true, severity: 'critical' });
    expect(raised.summary).toMatch(/not answering/);
  });

  it('a box just booted does not raise on an old age until a round has had its chance, and does not clear either', () => {
    const booting = { ...healthy, mirrorAgeS: 7200, mirrorSettling: true };
    expect(condition(booting, 'box.mirror_stale')).toBeUndefined();
    expect(condition({ ...booting, mirrorAgeS: null }, 'box.mirror_stale')).toBeUndefined();
    // Past its first round, the same age is the alert it always was.
    expect(condition({ ...healthy, mirrorAgeS: 7200 }, 'box.mirror_stale')!.active).toBe(true);
  });

  it('a problem the box already knows is raised even while settling', () => {
    const raised = condition({ ...healthy, mirrorSettling: true, mirrorProblem: 'same_device' }, 'box.mirror_stale')!;
    expect(raised.active).toBe(true);
  });

  it('an older agent still parses and raises nothing it did not raise before', () => {
    const parsed = BoxHeartbeatRequestSchema.safeParse({
      reportedAt: new Date().toISOString(),
      agentVersion: '0.1.0',
      storage: healthy,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data!.storage).toEqual(healthy);
    expect(conditions(healthy).filter((c) => c.active)).toEqual([]);
  });

  it('a problem name this platform has not heard of still parses and still warns, rather than losing the heartbeat', () => {
    const parsed = BoxHeartbeatRequestSchema.safeParse({
      reportedAt: new Date().toISOString(),
      agentVersion: '0.1.0',
      storage: { ...healthy, mirrorProblem: 'from_a_later_release' },
    });
    expect(parsed.success).toBe(true);
    expect(condition({ ...healthy, mirrorProblem: 'from_a_later_release' }, 'box.mirror_stale')!.active).toBe(true);
  });
});
