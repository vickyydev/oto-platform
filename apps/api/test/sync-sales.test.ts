import { createHash, generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  account,
  auditLog,
  box,
  boxCommand,
  device,
  paymentAttempt,
  receiptSeries,
  sale,
  station,
  stationDevice,
  syncAnomaly,
  syncQuarantine,
  ticketPackage,
} from '@oto/db';
import {
  SYNC_EVENT_SCHEMA_VERSION,
  canonicalSyncBytes,
  newId,
  type SyncEventEnvelope,
  type SyncPushResponse,
} from '@oto/shared';
import {
  boxCredential,
  createBoxAgent,
  createPrinting,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
  type BoxConfigBundle,
  type BoxConfigDevice,
  type BoxConfigStation,
} from '@oto/box-agent';
import {
  RECEPTION,
  SECOND_OPERATOR_NAME,
  boxBySlot,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { boxAuthFromRow, issueClaimCode, provisionVirtualBox } from '../src/services/box';
import { boxStoreFor } from '../src/lib/box-store';
import { replayQuarantined } from '../src/services/sync';
/**
 * B's own producer, imported rather than imitated: the `drawer_kick` cases
 * below assert the box against the payload the platform really queues, so a
 * change to either end fails here instead of at a counter.
 */
import { queueDrawerKick, resolveDrawerKick } from '../src/services/payments/drawer';

/**
 * S2-10a (SCRUM-206), Slice G — A SALE TAKEN WITH NO INTERNET, BANKED.
 *
 * The acceptance in one sentence: the mall's link goes down, a family pays in
 * cash and another pays by card, and when the link comes back both sales are on
 * the Sale list **exactly once** with the money against them.
 *
 * Before this ticket there was no sale in the sync path at all — six handlers,
 * none of them money — so everything below is new plumbing rather than a wire
 * that needed connecting, and the cases are chosen for the ways money goes
 * missing rather than for the happy path:
 *
 *   - the same batch arriving TWICE under new event ids, which is what a box
 *     that lost its acknowledgements and re-queued from its own records sends,
 *     and which the sync ledger's own duplicate index cannot see;
 *   - a batch delivered OUT OF ORDER, where the money arrives before the sale
 *     it paid for;
 *   - a station whose receipt numbering MOVED ON while the box was away;
 *   - a card approval and a terminal's own QR, which are the two tenders a box
 *     can take with nobody to ask.
 *
 * The last case drives the real agent — the same file that runs on a Pi — from
 * the till's side: `agent.sales()`, the box's own store, its own outbox, its own
 * signing key, and the api reached through `app.inject`. If the two ends ever
 * disagree about a byte, nothing in that case passes.
 */

let ctx: TestContext;
let receptionCookie: string;
let receptionAccountId: string;
let branchId: string;
let operatorId: string;
let twoHoursId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [reception] = await ctx.db
    .select()
    .from(account)
    .where(eq(account.phone, RECEPTION.phone))
    .limit(1);
  receptionAccountId = reception!.id;
  branchId = await branchIdByCode(ctx.db, 'hkt-central');
  const seeded = await boxBySlot(ctx.db, 'virtual-1');
  operatorId = seeded.operatorId;
  const packages = await ctx.db
    .select()
    .from(ticketPackage)
    .where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- A box with a counter of its own ----------------------------------------

const sha256 = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

interface TestBox {
  boxId: string;
  credential: string;
  privateKey: KeyObject;
  stationId: string;
  prefix: string;
  nextSeq: number;
}

let boxCounter = 0;

/**
 * A box with ONE till of its own, and a receipt series nothing else touches.
 *
 * Every case gets one. A journal is per-box state and a receipt series is
 * per-station state, so two cases sharing either would be two cases sharing a
 * counter — and the second would see the first's numbers for reasons that have
 * nothing to do with what it is testing.
 */
async function freshBox(operatorName?: string): Promise<TestBox> {
  const seeded = await boxBySlot(ctx.db, 'virtual-1', operatorName);
  const n = (boxCounter += 1);
  const boxId = newId();
  await ctx.db.insert(box).values({
    id: boxId,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    name: `Sale box ${n}`,
    slot: `sale-${n}`,
    role: 'virtual',
    status: 'unclaimed',
  });
  const stationId = newId();
  const prefix = `G${n}`;
  await ctx.db.insert(station).values({
    id: stationId,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    boxId,
    name: `Offline till ${n}`,
    kind: 'till',
    codePrefix: prefix,
  });

  const { code: claimCode } = await issueClaimCode(ctx.db, boxId);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const registered = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/register',
    payload: {
      claimCode,
      agentVersion: '0.1.0',
      hostname: `sale-${n}`,
      syncPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      syncKeyAlgorithm: 'ed25519',
    },
  });
  expect(registered.statusCode).toBe(200);
  const body = registered.json() as { boxId: string; secret: string };

  return {
    boxId,
    credential: boxCredential(body.boxId, body.secret),
    privateKey,
    stationId,
    prefix,
    nextSeq: 1,
  };
}

/** Mint an envelope the way a box does — canonical bytes, then the hash and the signature. */
function mint(
  b: TestBox,
  type: string,
  payload: Record<string, unknown>,
  over: Partial<SyncEventEnvelope> = {},
): SyncEventEnvelope {
  const base = {
    eventId: newId(),
    journalEpoch: 1,
    boxSeq: b.nextSeq++,
    type,
    schemaVersion: SYNC_EVENT_SCHEMA_VERSION,
    occurredAt: new Date().toISOString(),
    clockTrust: 'trusted' as const,
    stationId: b.stationId,
    actorKind: 'account' as const,
    actorAccountId: receptionAccountId,
    actorCredentialId: null,
    actionId: `act-${newId()}`,
    payload,
    ...over,
  };
  const canonical = canonicalSyncBytes({ ...base, boxId: b.boxId });
  return {
    ...base,
    payloadHash: sha256(canonical),
    sig: signDetached(null, Buffer.from(canonical, 'utf8'), b.privateKey).toString('base64'),
    sigAlg: 'ed25519',
  } as SyncEventEnvelope;
}

async function push(b: TestBox, events: SyncEventEnvelope[]): Promise<SyncPushResponse> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/sync/push',
    headers: { authorization: `Bearer ${b.credential}` },
    payload: { events },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as SyncPushResponse;
}

/** What one kid's two hours costs today, quoted by the platform's own engine. */
async function quotedTotal(stationId: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales/quote',
    headers: { cookie: receptionCookie },
    payload: {
      stationId,
      lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 0 }],
    },
  });
  expect(res.statusCode).toBe(200);
  return Number(res.json().totals.grossSatang);
}

/** One ticket line, as the till composed it before the link went. */
function cart(totalSatang: number, over: Record<string, unknown> = {}) {
  return {
    lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 0 }],
    expectedTotalSatang: totalSatang,
    ...over,
  };
}

function cashTender(amountSatang: number, over: Record<string, unknown> = {}) {
  return {
    actionId: `press-${newId()}`,
    methodCode: 'cash',
    kind: 'cash' as const,
    amountSatang,
    tenderedSatang: amountSatang,
    changeSatang: 0,
    ...over,
  };
}

const attemptsOf = (saleId: string) =>
  ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));

const saleRow = async (saleId: string) => {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId)).limit(1);
  return row;
};

// ---------------------------------------------------------------------------

describe('a sale taken with no internet reaches the ledger (SCRUM-206)', () => {
  it('prices it here, records its money, numbers it, and files it against the box', async () => {
    const b = await freshBox();
    const total = await quotedTotal(b.stationId);
    const saleId = newId();

    const answer = await push(b, [
      mint(b, 'sale.finalised', {
        saleId,
        cart: cart(total),
        tenders: [cashTender(total)],
        receipt: { series: b.prefix, seq: 1, number: `${b.prefix}-000001` },
      }),
    ]);
    expect(answer.applied).toBe(1);
    expect(answer.quarantined).toBe(0);

    const row = await saleRow(saleId);
    expect(row!.status).toBe('finalised');
    expect(row!.receiptNumber).toBe(`${b.prefix}-000001`);
    expect(row!.grossSatang).toBe(total);
    // The three columns that say this sale came off a box, which nothing had
    // ever written: `commitSale` stamps `origin: 'cloud'` for its own writes.
    expect(row!.origin).toBe('box');
    expect(row!.boxId).toBe(b.boxId);
    expect(Number(row!.boxSeq)).toBe(1);
    expect(row!.sourceEventId).toBeTruthy();

    const attempts = await attemptsOf(saleId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('approved');
    expect(attempts[0]!.amountSatang).toBe(total);
    expect(attempts[0]!.offline).toBe(true);
    expect(attempts[0]!.method).toBe('cash');
    expect(Number(attempts[0]!.boxSeq)).toBe(1);
    // The trading day is the sale's, so the cash-up counts this money on the
    // day it was taken rather than the day the link came back.
    expect(attempts[0]!.businessDate).toBe(row!.businessDate);

    // The one audit row that names the event, which is what ties the till line,
    // the box's journal position and the ledger together.
    const [audited] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.offline_replay')))
      .limit(1);
    expect(audited).toBeTruthy();
    expect(audited!.sourceEventId).toBeTruthy();
    expect(audited!.after).toMatchObject({ boxSeq: 1, status: 'finalised', attemptsWritten: 1 });
  });

  it('is priced by this engine, so a box that has drifted is refused rather than believed', async () => {
    const b = await freshBox();
    const total = await quotedTotal(b.stationId);
    const saleId = newId();

    // The box's catalogue says ฿1 less than the platform's. Somebody has to
    // look at that; what must not happen is a sale recorded at either number
    // with nobody told.
    const answer = await push(b, [
      mint(b, 'sale.finalised', {
        saleId,
        cart: cart(total - 100),
        tenders: [cashTender(total - 100)],
      }),
    ]);
    expect(answer.applied).toBe(0);
    expect(answer.quarantined).toBe(1);
    expect(await saleRow(saleId)).toBeUndefined();

    const [filed] = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, b.boxId), eq(syncQuarantine.status, 'open')))
      .limit(1);
    expect(filed!.reason).toBe('apply_failed');
    expect(filed!.errorCode).toBe('SALE_TOTAL_MISMATCH');
  });

  /**
   * THE GUARD ABOVE IS ONLY A GUARD IF IT ALWAYS RUNS.
   *
   * `expectedTotalSatang` was optional on the wire, and an optional price check
   * is no price check: a box that simply left the field out had its cart priced
   * here and banked at whatever this engine said, with the money it actually
   * took never compared to anything. The field is required, so a cart without
   * one is refused by the schema — poison, with the payload kept — rather than
   * quietly taking the path with no comparison in it.
   */
  it('refuses a cart that carries no total of its own, rather than pricing it unchecked', async () => {
    const b = await freshBox();
    const total = await quotedTotal(b.stationId);
    const saleId = newId();
    const { expectedTotalSatang: _theTillsOwnTotal, ...noTotal } = cart(total);

    const answer = await push(b, [
      mint(b, 'sale.finalised', { saleId, cart: noTotal, tenders: [cashTender(total)] }),
    ]);
    expect(answer.applied).toBe(0);
    expect(answer.quarantined).toBe(1);
    expect(answer.results[0]!.errorCode).toBe('SYNC_PAYLOAD_INVALID');
    expect(await saleRow(saleId)).toBeUndefined();
  });

  /**
   * THE OTHER WAY A REPLAY BANKS A NUMBER NOBODY QUOTED: the box agrees about
   * the cart and sends more money than the cart is worth.
   *
   * The counter's own path has held this line since S2-09a — "That tender is
   * more than this sale still owes" — but this path does not go through it: it
   * opens and settles attempts directly. Without the ceiling in `recordTenders`
   * the sale below is created, finalised and numbered while carrying approved
   * attempts over its gross, with nothing quarantined and nothing for the end
   * of day to reconcile it against.
   *
   * REFUSED WHOLE is the other half of the claim: the second tender is what
   * breaks the rule, and what must not survive is the first one, or the sale,
   * or the receipt number.
   */
  it('refuses a box that tenders more than the cart is worth, and keeps none of it', async () => {
    const b = await freshBox();
    const total = await quotedTotal(b.stationId);
    const saleId = newId();

    const answer = await push(b, [
      mint(b, 'sale.finalised', {
        saleId,
        cart: cart(total),
        // The whole price, and then ฿10 more on a second press.
        tenders: [cashTender(total), cashTender(1_000)],
        receipt: { series: b.prefix, seq: 1, number: `${b.prefix}-000001` },
      }),
    ]);
    expect(answer.applied).toBe(0);
    expect(answer.quarantined).toBe(1);
    expect(answer.results[0]!.errorCode).toBe('SALE_OVERTENDERED');

    // Nothing was kept: no sale, no attempt, and no number spent on either.
    expect(await saleRow(saleId)).toBeUndefined();
    expect(await attemptsOf(saleId)).toHaveLength(0);
    const [series] = await ctx.db
      .select()
      .from(receiptSeries)
      .where(and(eq(receiptSeries.stationId, b.stationId), eq(receiptSeries.series, b.prefix)));
    expect(series).toBeUndefined();
  });

  /**
   * A fully comped sale cannot be expressed as an offline event — the payload
   * requires at least one positive tender — so a ฿0 cart arrives carrying money
   * it says is not owed. It is named rather than left to fail on the ceiling
   * above, because "the till priced this at nothing" is the fact somebody
   * reading Failures needs, and it is true before anything is written.
   */
  it('refuses a cart the till priced at nothing, by name', async () => {
    const b = await freshBox();
    const saleId = newId();

    const answer = await push(b, [
      mint(b, 'sale.finalised', {
        saleId,
        cart: cart(0),
        tenders: [cashTender(14_400)],
      }),
    ]);
    expect(answer.applied).toBe(0);
    expect(answer.results[0]!.errorCode).toBe('SALE_NOTHING_TO_PAY');
    expect(await saleRow(saleId)).toBeUndefined();
  });

  it('refuses a sale that names no station and one that names nobody', async () => {
    const b = await freshBox();
    const total = await quotedTotal(b.stationId);

    const anonymous = await push(b, [
      mint(
        b,
        'sale.finalised',
        { saleId: newId(), cart: cart(total), tenders: [cashTender(total)] },
        { actorAccountId: null },
      ),
    ]);
    expect(anonymous.quarantined).toBe(1);
    expect(anonymous.results[0]!.errorCode).toBe('SYNC_SALE_ANONYMOUS');

    const stationless = await push(b, [
      mint(
        b,
        'sale.finalised',
        { saleId: newId(), cart: cart(total), tenders: [cashTender(total)] },
        { stationId: null },
      ),
    ]);
    expect(stationless.quarantined).toBe(1);
    expect(stationless.results[0]!.errorCode).toBe('SYNC_STATION_MISSING');
  });
});

describe('the same money arriving twice (SCRUM-206)', () => {
  /**
   * THE CASE THE SYNC LEDGER'S OWN DUPLICATE INDEX CANNOT SEE.
   *
   * `(box_id, journal_epoch, box_seq)` turns a RE-SEND into a duplicate, and
   * that covers the ordinary lost-acknowledgement. What it does not cover is
   * the same money arriving under NEW event ids at NEW positions — a box whose
   * queue was rebuilt from its own records, a journal epoch reset, an operator
   * replaying a batch by hand. Then the only thing between the guest and a
   * second charge is `payment_attempt_action_unique` on the press, and the
   * read that turns it into an ordinary answer.
   */
  it('replays the same offline batch twice and leaves one sale, one number, one attempt', async () => {
    const b = await freshBox();
    const total = await quotedTotal(b.stationId);
    const saleId = newId();
    const tender = cashTender(total);
    const payload = {
      saleId,
      cart: cart(total),
      tenders: [tender],
      receipt: { series: b.prefix, seq: 1, number: `${b.prefix}-000001` },
    };

    const first = await push(b, [mint(b, 'sale.finalised', payload)]);
    expect(first.applied).toBe(1);
    const after = await saleRow(saleId);

    // The SAME facts, re-minted: new event id, new position, same sale id and
    // same press. Nothing in the journal recognises it.
    const second = await push(b, [mint(b, 'sale.finalised', payload)]);
    expect(second.applied).toBe(1);
    expect(second.quarantined).toBe(0);

    const rows = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.receiptNumber).toBe(after!.receiptNumber);
    expect(rows[0]!.finalisedAt?.toISOString()).toBe(after!.finalisedAt?.toISOString());
    expect(await attemptsOf(saleId)).toHaveLength(1);

    // And no second number was spent on it either: the series moved once.
    const [series] = await ctx.db
      .select()
      .from(receiptSeries)
      .where(and(eq(receiptSeries.stationId, b.stationId), eq(receiptSeries.series, b.prefix)));
    expect(series!.nextSeq).toBe(2);
  });

  it('refuses a press that already took money against another sale', async () => {
    const b = await freshBox();
    const total = await quotedTotal(b.stationId);
    const tender = cashTender(total);

    const first = await push(b, [
      mint(b, 'sale.finalised', { saleId: newId(), cart: cart(total), tenders: [tender] }),
    ]);
    expect(first.applied).toBe(1);

    const confused = await push(b, [
      mint(b, 'sale.finalised', { saleId: newId(), cart: cart(total), tenders: [tender] }),
    ]);
    expect(confused.quarantined).toBe(1);
    expect(confused.results[0]!.errorCode).toBe('ACTION_ID_REUSED');
  });
});

describe('a batch delivered out of order (SCRUM-206)', () => {
  /**
   * THE ORDERING GUARD.
   *
   * The refusal is `apply_failed`: the payload is well formed and the event it
   * needs may be in the next batch, so it goes to quarantine where a replay
   * fixes it — and the replay is driven here, because "the ledger still ends
   * with one of each" is the claim, not "the batch was rejected".
   */
  it('refuses money for a sale that is not here yet, and the replay banks it', async () => {
    const b = await freshBox();
    const total = await quotedTotal(b.stationId);
    const saleId = newId();
    const half = Math.round(total / 2);
    const rest = total - half;

    const sameBatch = [
      // @3 — the second half of a split tender, delivered FIRST.
      mint(b, 'payment.recorded', { saleId, tender: cashTender(rest) }, { boxSeq: 3 }),
      // @2 — the sale and the first half of the money.
      mint(
        b,
        'sale.finalised',
        {
          saleId,
          cart: cart(total),
          tenders: [cashTender(half)],
          receipt: { series: b.prefix, seq: 1, number: `${b.prefix}-000001` },
        },
        { boxSeq: 2 },
      ),
    ];
    b.nextSeq = 4;

    const answer = await push(b, sameBatch);
    expect(answer.applied).toBe(1);
    expect(answer.quarantined).toBe(1);
    expect(answer.results[0]!.errorCode).toBe('SYNC_SALE_ABSENT');

    // The sale is here, part-paid: the money that DID arrive is recorded and no
    // receipt number has been spent on a sale that is not settled.
    const open = await saleRow(saleId);
    expect(open!.status).toBe('tendering');
    expect(open!.receiptNumber).toBeNull();
    expect(await attemptsOf(saleId)).toHaveLength(1);

    const [filed] = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, b.boxId), eq(syncQuarantine.status, 'open')))
      .limit(1);
    expect(filed!.reason).toBe('apply_failed');

    const [boxRow] = await ctx.db.select().from(box).where(eq(box.id, b.boxId)).limit(1);
    const replayed = await replayQuarantined(
      ctx.db,
      boxAuthFromRow(boxRow!),
      filed!.id,
      { requestId: 'test-replay', operatorId, branchId },
      receptionAccountId,
    );
    expect(replayed.result).toBe('applied');

    // One of each, in the end: one sale, one receipt number, two tenders that
    // between them are the whole price.
    const closed = await saleRow(saleId);
    expect(closed!.status).toBe('finalised');
    expect(closed!.receiptNumber).toBe(`${b.prefix}-000001`);
    const attempts = await attemptsOf(saleId);
    expect(attempts).toHaveLength(2);
    expect(attempts.reduce((sum, a) => sum + a.amountSatang, 0)).toBe(total);
  });

  /**
   * The other half of the same guard, and the one where removing it does not
   * merely change a code on the Failures page.
   *
   * `pos.payment_attempt.sale_id` has a foreign key, so a tender naming a sale
   * that does not exist AT ALL is refused by the database however this handler
   * is written. What the database will happily allow is a tender naming a sale
   * that exists in ANOTHER PARK: the key does not carry tenancy. Without the
   * check below, one operator's box settles another operator's sale and spends
   * a receipt number on their station — money in the wrong ledger, closed by
   * somebody who has never heard of the guest.
   */
  it('will not let one park’s box put money on another park’s sale', async () => {
    const ours = await freshBox();
    const total = await quotedTotal(ours.stationId);
    const saleId = newId();
    expect(
      (
        await push(ours, [
          mint(ours, 'sale.finalised', {
            saleId,
            cart: cart(total),
            tenders: [cashTender(Math.round(total / 2))],
          }),
        ])
      ).applied,
    ).toBe(1);

    /**
     * A QUARTER, deliberately: it does not close the sale. A tender that
     * settled the balance would reach `finaliseSale`, which has a tenancy check
     * of its own and would refuse there — so a case that closed the sale would
     * pass even with the guard below removed, and would be testing the wrong
     * net. A part payment is the one that actually lands.
     */
    const theirs = await freshBox(SECOND_OPERATOR_NAME);
    const answer = await push(theirs, [
      mint(theirs, 'payment.recorded', { saleId, tender: cashTender(Math.round(total / 4)) }),
    ]);
    expect(answer.applied).toBe(0);
    expect(answer.results[0]!.errorCode).toBe('SYNC_SALE_NOT_OURS');

    // Untouched: still open, still one tender, still no number spent on it.
    const row = await saleRow(saleId);
    expect(row!.status).toBe('tendering');
    expect(row!.receiptNumber).toBeNull();
    expect(await attemptsOf(saleId)).toHaveLength(1);
  });
});

describe('a receipt series that moved on while the box was away (SCRUM-206)', () => {
  /**
   * The number the box showed is provisional; the allocator's is the ledger's.
   *
   * A box mints from the high-water mark the cache bundle last shipped it
   * (`receipt-hwm.test.ts` proves that mark is the allocator's own). While it
   * is away the mark can move — a second till on the same station, a sale rung
   * up in the cloud — and the box has no way to know. What must never happen is
   * two sales under one number; what must happen is that somebody can find out
   * which paper number became which ledger number.
   */
  it('allocates after the mark, never a duplicate, and records both numbers', async () => {
    const b = await freshBox();
    const total = await quotedTotal(b.stationId);

    // The series moved on while the box was offline: three numbers issued here.
    await ctx.db.insert(receiptSeries).values({
      id: newId(),
      operatorId,
      branchId,
      stationId: b.stationId,
      series: b.prefix,
      kind: 'sale',
      nextSeq: 4,
    });

    const saleId = newId();
    const boxNumber = `${b.prefix}-000001`;
    const answer = await push(b, [
      mint(b, 'sale.finalised', {
        saleId,
        cart: cart(total),
        tenders: [cashTender(total)],
        receipt: { series: b.prefix, seq: 1, number: boxNumber },
      }),
    ]);
    expect(answer.applied).toBe(1);

    const row = await saleRow(saleId);
    expect(row!.receiptNumber).toBe(`${b.prefix}-000004`);
    expect(row!.receiptNumber).not.toBe(boxNumber);

    // Applied, with a caveat recorded: the guest is holding a slip that says
    // something else, and the anomaly is where that is answerable from.
    const anomalies = await ctx.db
      .select()
      .from(syncAnomaly)
      .where(eq(syncAnomaly.eventId, answer.results[0]!.eventId));
    expect(anomalies.map((a) => a.kind)).toContain('late_arrival');
    expect(anomalies.find((a) => a.kind === 'late_arrival')!.detail).toMatchObject({
      boxReceiptNumber: boxNumber,
      receiptNumber: `${b.prefix}-000004`,
    });
  });
});

describe('the tenders a box can take with nobody to ask (SCRUM-206)', () => {
  /** The park's own EDC, moved onto this box so the attempt may name it. */
  async function terminalOn(b: TestBox): Promise<string> {
    const [edc] = await ctx.db
      .select()
      .from(device)
      .where(and(eq(device.operatorId, operatorId), eq(device.kind, 'terminal')))
      .limit(1);
    await ctx.db.update(device).set({ boxId: b.boxId }).where(eq(device.id, edc!.id));
    return edc!.id;
  }

  it('carries a card approval — code, last four, TID — onto the attempt', async () => {
    const b = await freshBox();
    const total = await quotedTotal(b.stationId);
    const deviceId = await terminalOn(b);
    const saleId = newId();

    const answer = await push(b, [
      mint(b, 'sale.finalised', {
        saleId,
        cart: cart(total),
        tenders: [
          {
            actionId: `press-${newId()}`,
            methodCode: 'card',
            kind: 'card',
            provider: 'ghl',
            amountSatang: total,
            deviceId,
            terminalRef: '650123000001',
            approvalCode: '123456',
            last4: '4242',
            tid: '65703235',
            mid: '4648434010',
            responseCode: '00',
          },
        ],
      }),
    ]);
    expect(answer.applied).toBe(1);

    const [attempt] = await attemptsOf(saleId);
    expect(attempt!.method).toBe('card');
    expect(attempt!.provider).toBe('ghl');
    expect(attempt!.status).toBe('approved');
    expect(attempt!.approvalCode).toBe('123456');
    expect(attempt!.last4).toBe('4242');
    expect(attempt!.tid).toBe('65703235');
    expect(attempt!.terminalRef).toBe('650123000001');
    expect(attempt!.deviceId).toBe(deviceId);
    expect((await saleRow(saleId))!.status).toBe('finalised');
  });

  it('flags the terminal’s own QR as awaiting settlement, and still closes the sale', async () => {
    const b = await freshBox();
    const total = await quotedTotal(b.stationId);
    const deviceId = await terminalOn(b);
    const saleId = newId();

    /**
     * A 2C2P QR cannot be taken offline at all — minting one is an HTTPS call
     * to the gateway — so the offline QR is the PAX terminal's own (Digio
     * `A18`/`A3`). The money is ours and the sale closes; what is unsettled
     * about it is the reconciliation, which is what the word says.
     */
    const answer = await push(b, [
      mint(b, 'sale.finalised', {
        saleId,
        cart: cart(total),
        tenders: [
          {
            actionId: `press-${newId()}`,
            methodCode: 'promptpay',
            kind: 'qr',
            provider: 'digio',
            amountSatang: total,
            status: 'awaiting_settlement',
            deviceId,
            terminalRef: '000123',
            tranRef: 'DGO-0001',
            responseCode: '100',
          },
        ],
      }),
    ]);
    expect(answer.applied).toBe(1);

    const attempts = await attemptsOf(saleId);
    // ONE attempt, pinned: `awaiting_settlement` counts towards the balance on
    // both sides of this path, so a second, phantom cash tender opened to
    // "cover" the sale would be invisible to an assertion that only read the
    // first row.
    expect(attempts).toHaveLength(1);
    const [attempt] = attempts;
    expect(attempt!.status).toBe('awaiting_settlement');
    expect(attempt!.method).toBe('qr');
    expect(attempt!.tranRef).toBe('DGO-0001');
    // Taken money closes a sale whichever word it is filed under.
    expect((await saleRow(saleId))!.status).toBe('finalised');
    expect((await saleRow(saleId))!.receiptNumber).toBeTruthy();
  });

  it('refuses an attempt that names a terminal on somebody else’s box', async () => {
    const b = await freshBox();
    const total = await quotedTotal(b.stationId);
    const [elsewhere] = await ctx.db
      .select()
      .from(device)
      .where(and(eq(device.operatorId, operatorId), eq(device.kind, 'terminal')))
      .limit(1);
    // On another counter's box, which is where a terminal actually is when it
    // is not on this one: `core.device.box_id` is NOT NULL, because a device
    // belonging to no box is not a state the fleet has.
    const other = await freshBox();
    await ctx.db.update(device).set({ boxId: other.boxId }).where(eq(device.id, elsewhere!.id));

    const answer = await push(b, [
      mint(b, 'sale.finalised', {
        saleId: newId(),
        cart: cart(total),
        tenders: [
          {
            actionId: `press-${newId()}`,
            methodCode: 'card',
            kind: 'card',
            amountSatang: total,
            deviceId: elsewhere!.id,
          },
        ],
      }),
    ]);
    expect(answer.quarantined).toBe(1);
    expect(answer.results[0]!.errorCode).toBe('SYNC_DEVICE_NOT_ON_BOX');
  });
});

// --- The box's own side -----------------------------------------------------

/**
 * The cash drawer, pulsed through the printer it hangs off.
 *
 * No database and no HTTP: this is the adapter and the simulator, which is
 * where the pulse lives. It is here rather than in `packages/box-agent/test`
 * for the reason `printing-box.test.ts` records — that package's runner cannot
 * load `@oto/print` at all.
 */
describe('the cash drawer opens where the cash is (SCRUM-206)', () => {
  function printerBundle(devices: BoxConfigDevice[]): BoxConfigBundle {
    const st: BoxConfigStation = {
      id: 'station-1',
      name: 'Reception Till 1',
      kind: 'till',
      codePrefix: 'T1',
      capabilities: [],
      configVersion: 1,
      paymentRouting: null,
      offlineWalletCapSatang: null,
      accessScope: 'branch',
      devices,
    };
    return {
      configVersion: 'v1',
      box: { id: 'box-1', name: 'Box 1', slot: 'virtual-1', role: 'virtual', epoch: 1, status: 'online' },
      branch: {
        id: 'branch-1',
        code: 'HKT',
        name: 'HKT Central',
        operatorId: 'op-1',
        timezone: 'Asia/Bangkok',
        openingHours: null,
        businessDayStart: '06:00',
      },
      stations: [st],
      printTemplates: [],
      signingKeys: [],
      heartbeatIntervalS: 60,
      minSupportedAgentVersion: '0.1.0',
    };
  }

  const receiptPrinter: BoxConfigDevice = {
    id: 'printer-1',
    role: 'receipt',
    kind: 'receipt_printer',
    label: 'Receipt Printer 1',
    transport: 'simulated',
    address: '192.168.88.202:9100',
    model: 'Welltech G4 (Xprinter XP-C260)',
    protocol: 'escpos',
    serialNumber: null,
    terminalId: null,
    merchantId: null,
    settings: { escpos: { drawerKick: true } },
  } as BoxConfigDevice;

  it('writes the pulse and nothing else — no paper, no cut', async () => {
    const printing = createPrinting({ templates: () => [], bundle: () => printerBundle([receiptPrinter]) });
    const outcome = await printing.pulseDrawer({ stationId: 'station-1' });

    expect(outcome.opened).toBe(true);
    expect(outcome.deviceId).toBe('printer-1');
    expect(outcome.role).toBe('receipt');

    const sim = printing.simulator('printer-1')!;
    const kicks = sim.events().filter((e) => e.kind === 'drawer.kick');
    expect(kicks).toHaveLength(1);
    /**
     * And nothing else went down the socket. The simulator turns every closed
     * session into a picture, so it draws an empty one here — no raster bands
     * and no cut, which on a real printer is no paper moving at all. A receipt
     * is S2-13's job, and a drawer that printed one would hand every cash guest
     * a blank slip.
     */
    const printed = sim.events().find((e) => e.kind === 'job.printed');
    expect(printed!.detail).toMatchObject({ bands: 0, cuts: 0, drawerKicks: 1 });
    expect(sim.printouts()[0]!.heightDots).toBe(0);
    expect(sim.events().some((e) => e.kind === 'cut')).toBe(false);
  });

  it('opens the drawer even when the roll has run out', async () => {
    const printing = createPrinting({ templates: () => [], bundle: () => printerBundle([receiptPrinter]) });
    // Stand the simulator up, then take its paper away.
    await printing.pulseDrawer({ stationId: 'station-1' });
    printing.setFault('printer-1', 'paper_out');

    const outcome = await printing.pulseDrawer({ stationId: 'station-1' });
    // The cash is in the drawer whatever the paper is doing. `print` refuses on
    // an empty roll — correct for a receipt and exactly wrong for this.
    expect(outcome.opened).toBe(true);
  });

  it('says which printer it could not find when the station has none', async () => {
    const printing = createPrinting({ templates: () => [], bundle: () => printerBundle([]) });
    const outcome = await printing.pulseDrawer({ stationId: 'station-1' });
    expect(outcome.opened).toBe(false);
    expect(outcome.errorCode).toBe('NO_DEVICE_FOR_ROLE');
  });

  it('answers a band printer honestly rather than pretending', async () => {
    const band = {
      ...receiptPrinter,
      id: 'band-1',
      role: 'receipt',
      kind: 'band_printer',
      protocol: 'tspl2',
      model: '4B-2082A',
      settings: {},
    } as BoxConfigDevice;
    const printing = createPrinting({ templates: () => [], bundle: () => printerBundle([band]) });
    const outcome = await printing.pulseDrawer({ stationId: 'station-1' });
    expect(outcome.opened).toBe(false);
    expect(outcome.errorCode).toBe('PRINTER_HAS_NO_DRAWER');
  });
});

/**
 * The whole seam, crossed by the agent that runs on the Pi.
 *
 * Everything above mints envelopes with this file's own helper, which proves
 * the cloud against itself. This one does not: the sale is handed to
 * `agent.sales()`, sealed by the agent's own key, queued in the box's own
 * store, taken by the real outbox and pushed at the real route.
 */
describe('the box takes the sale and the ledger banks it (SCRUM-206)', () => {
  let agent: BoxAgent;
  let tillId: string;

  const transport: AgentFetch = async (url, init) => {
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
    agent = createBoxAgent({
      apiBaseUrl: 'http://sync-sales.test',
      credentials: memoryCredentialStore(),
      hostname: 'offline-sale-test',
      fetch: transport,
      store: boxStoreFor(ctx.db),
      claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
    });
    expect(await agent.ensureRegistered()).toBe(true);
    await agent.syncConfig();
    // The receipt mark comes down here, on the tick a box makes while it still
    // has a link. Everything after this happens with the link down.
    await agent.syncCache();
    tillId = agent.config()!.stations.find((s) => s.codePrefix === 'T1')!.id;
  }, 60_000);

  it('numbers it from the mark, queues it, opens the drawer, and banks it once', async () => {
    const mark = await agent.sales()!.receiptMark(tillId);
    expect(mark).toBeTruthy();
    const total = await quotedTotal(tillId);

    await agent.setOffline(true, { reason: 'the mall link is down' });
    const saleId = newId();
    const press = `press-${newId()}`;
    const taken = await agent.sales()!.record({
      saleId,
      stationId: tillId,
      actorAccountId: receptionAccountId,
      cart: cart(total),
      tenders: [
        {
          actionId: press,
          methodCode: 'cash',
          kind: 'cash',
          amountSatang: total,
          tenderedSatang: total,
          changeSatang: 0,
        },
      ],
      actionId: press,
    });

    // What the till shows the guest: the next number after the mark, minted on
    // the box because there is nobody to ask.
    expect(taken.receipt!.number).toBe(`T1-${String(mark!.highWaterMark + 1).padStart(6, '0')}`);
    expect(taken.boxSeq).toBeGreaterThan(0);
    expect(taken.queued).toBe(1);
    // Cash opens the drawer, and it is the box that opens it: the cloud's own
    // `drawer_kick` command cannot reach a box with no link.
    expect(taken.drawer).toBe('opened');
    expect(taken.outboxDepth).toBeGreaterThan(0);
    // Nothing has reached the cloud while the link is down.
    expect(await saleRow(saleId)).toBeUndefined();

    // The link comes back. `setOffline(false)` flushes.
    await agent.setOffline(false);
    await agent.outbox()!.flush();

    const row = await saleRow(saleId);
    expect(row!.status).toBe('finalised');
    expect(row!.origin).toBe('box');
    expect(row!.receiptNumber).toBe(taken.receipt!.number);
    const attempts = await attemptsOf(saleId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.offline).toBe(true);
    expect(attempts[0]!.actionId).toBe(press);

    // And a second flush of the same queue changes nothing.
    await agent.outbox()!.flush();
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toHaveLength(1);
    expect(await attemptsOf(saleId)).toHaveLength(1);
  }, 60_000);

  /**
   * The routing, on a box whose printers come from the cloud's own fleet rows
   * rather than from a bundle written in this file.
   *
   * Everything in "the cash drawer opens where the cash is" above drives the
   * print subsystem against a hand-built bundle; this drives the same call on
   * the agent the tests register, so the station, the role and the device are
   * the ones a Console user would see. It is NOT the command path — that is the
   * two cases below.
   */
  it('pulses the drawer through the printer this station prints its receipts on', async () => {
    const outcome = await agent.printing()!.pulseDrawer({ stationId: tillId });
    expect(outcome.role).toBe('receipt');
    expect(outcome.opened).toBe(true);
    expect(outcome.deviceId).toBeTruthy();
    const sim = agent.printing()!.simulator(outcome.deviceId!);
    expect(sim!.events().some((e) => e.kind === 'drawer.kick')).toBe(true);
  });

  /**
   * THE SEAM B HANDED OVER, driven end to end at last.
   *
   * B's cash finalise queues a `drawer_kick` the moment a cash tender closes a
   * sale (`services/payments/drawer.ts`), and until this slice landed the box
   * answered `UNKNOWN_COMMAND` and the drawer stayed shut. What is proved below
   * is the JOIN rather than either half: the command is queued by B's own
   * producer — so the payload is the one the platform really sends, not a
   * literal retyped here — polled and run by the real agent, and its answer is
   * read off the command row the Console reads.
   *
   * The sale and attempt ids are minted here and are carried ONLY as an echo:
   * the box does not resolve them and could not, being offline half the time.
   * They exist so the Console's command history can be read beside the sale.
   */
  it('runs the cloud’s drawer_kick command and reports that the drawer opened', async () => {
    await agent.setOffline(false);
    const [stationRow] = await ctx.db.select().from(station).where(eq(station.id, tillId)).limit(1);
    const saleId = newId();
    const attemptId = newId();
    const actionId = `act-${newId()}`;

    const kick = await resolveDrawerKick(ctx.db, {
      stationRow: stationRow!,
      saleId,
      attemptId,
      actionId,
    });
    expect(kick).toBeTruthy();
    expect(kick!.deviceId).toBeTruthy();
    const commandId = await queueDrawerKick(
      ctx.db,
      { requestId: 'test-drawer-kick', operatorId, branchId },
      { accountId: receptionAccountId, operatorId },
      kick!,
    );
    expect(commandId).toBeTruthy();

    // What B queues, before the box has seen it: the station, the role the
    // pulse rides, the flag the print queue honours, and the money it belongs
    // to. If this shape ever changes, the box's reader changes with it.
    const [queued] = await ctx.db
      .select()
      .from(boxCommand)
      .where(eq(boxCommand.id, commandId!))
      .limit(1);
    expect(queued!.kind).toBe('drawer_kick');
    expect(queued!.payload).toMatchObject({
      saleId,
      attemptId,
      stationId: tillId,
      deviceId: kick!.deviceId,
      role: 'receipt',
      finish: { drawerKick: true },
    });

    const sim = agent.printing()!.simulator(kick!.deviceId!)!;
    const before = sim.events().filter((e) => e.kind === 'drawer.kick').length;

    expect(await agent.runPendingCommands()).toBeGreaterThanOrEqual(1);

    // The drawer physically opened: one more pulse on the machine, written by
    // the adapter that drives the real printer.
    const after = sim.events().filter((e) => e.kind === 'drawer.kick').length;
    expect(after).toBe(before + 1);

    const [ran] = await ctx.db
      .select()
      .from(boxCommand)
      .where(eq(boxCommand.id, commandId!))
      .limit(1);
    expect(ran!.state).toBe('succeeded');
    expect(ran!.errorCode).toBeNull();
    expect(ran!.result).toMatchObject({
      opened: true,
      stationId: tillId,
      role: 'receipt',
      // The box re-resolved the printer and landed on the same one the cloud
      // named, so there is no `cloudDeviceId` disagreement to report.
      deviceId: kick!.deviceId,
      saleId,
      attemptId,
    });
    expect(ran!.result).not.toHaveProperty('cloudDeviceId');
  }, 60_000);

  /**
   * A drawer that stayed shut is a FAILED command, and this is the case that
   * says so.
   *
   * Unlike a test print — whose command succeeds the moment the job is routed,
   * because the job's own row carries what the paper did — a pulse has no
   * second row anywhere. This acknowledgement is the only place the answer can
   * live, so a green command over a drawer that never opened would be the
   * Console lying about the one thing somebody walked over to check.
   *
   * The station below is a real configuration rather than a broken one: its
   * receipts come off a band printer, and the 4B-2082A family has no drawer
   * line at all (§9.1, `cut_kick: none`). The honest answer is the name, not a
   * pretended pulse.
   */
  it('reports the command failed when the station’s printer has no drawer line', async () => {
    await agent.setOffline(false);
    const boxId = agent.state.boxId!;
    const bandStationId = newId();
    const bandPrinterId = newId();
    await ctx.db.insert(device).values({
      id: bandPrinterId,
      operatorId,
      branchId,
      boxId,
      kind: 'band_printer',
      label: 'Band Printer (drawerless till)',
      transport: 'simulated',
      address: '192.168.88.222:9100',
      model: '4B-2082A',
      protocol: 'tspl2',
    });
    await ctx.db.insert(station).values({
      id: bandStationId,
      operatorId,
      branchId,
      boxId,
      name: 'Band-only till',
      kind: 'till',
      codePrefix: 'GB',
    });
    await ctx.db
      .insert(stationDevice)
      .values({ id: newId(), stationId: bandStationId, deviceId: bandPrinterId, role: 'receipt' });
    // The box learns what it has been given, exactly as it would on the next
    // heartbeat after somebody assigned the printer on the Console.
    await agent.syncConfig();

    const [stationRow] = await ctx.db
      .select()
      .from(station)
      .where(eq(station.id, bandStationId))
      .limit(1);
    const kick = await resolveDrawerKick(ctx.db, {
      stationRow: stationRow!,
      saleId: newId(),
      attemptId: newId(),
      actionId: `act-${newId()}`,
    });
    expect(kick!.deviceId).toBe(bandPrinterId);
    const commandId = await queueDrawerKick(
      ctx.db,
      { requestId: 'test-drawer-kick-band', operatorId, branchId },
      { accountId: receptionAccountId, operatorId },
      kick!,
    );

    expect(await agent.runPendingCommands()).toBeGreaterThanOrEqual(1);

    const [ran] = await ctx.db
      .select()
      .from(boxCommand)
      .where(eq(boxCommand.id, commandId!))
      .limit(1);
    expect(ran!.state).toBe('failed');
    expect(ran!.errorCode).toBe('PRINTER_HAS_NO_DRAWER');
    expect(ran!.result).toMatchObject({ opened: false, stationId: bandStationId, role: 'receipt' });
  }, 60_000);
});
