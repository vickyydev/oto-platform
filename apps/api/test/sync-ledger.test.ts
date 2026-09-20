import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import {
  account,
  alert,
  box,
  member,
  syncAnomaly,
  syncCursor,
  syncEvent,
  syncQuarantine,
} from '@oto/db';
import { newId, type SyncPushResponse } from '@oto/shared';
import {
  SqlBoxStore,
  boxCredential,
  createOutbox,
  generateSyncKeyPair,
  postgresBoxDriver,
  sealEnvelope,
  type BoxStore,
  type Outbox,
  type PgPoolLike,
} from '@oto/box-agent';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxAuthFromRow, issueClaimCode } from '../src/services/box';
import { injectPoisonEvent } from '../src/services/sync';

/**
 * S2-05 — the seam between a box and the cloud, crossed for real.
 *
 * `sync-api.test.ts` next door mints envelopes with a helper of its own, and
 * `packages/box-agent/test/store.test.ts` mints them with the agent's. Both
 * passed while no Pi could have synced a single event, because each was
 * checking one side of the seam against itself: the helper hashed without
 * `boxId`, the api recomputed without `boxId`, and the two agreed with each
 * other and with nothing that runs. A contract test comparing the two
 * `canonicalSyncBytes` functions did not catch it either — the functions are
 * identical; what differed is what each CALLER feeds them.
 *
 * So this file has no minting helper. Events are sealed by `@oto/box-agent`,
 * queued through the box's real `Store`, taken by the real outbox and pushed at
 * the real HTTP route. If the two ends ever disagree about a byte again,
 * nothing here passes.
 *
 * The store is the Postgres one, which is what the virtual box runs on Render:
 * the `edge` schema of the same database the api is holding open.
 */

let ctx: TestContext;
let adminCookie: string;
let adminAccountId: string;
let pool: pg.Pool;

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [admin] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone)).limit(1);
  adminAccountId = admin!.id;
  // The box's own pool. The api's belongs to the api, and a component that
  // closes a handle it was lent is how a redeploy turns into an outage.
  pool = new pg.Pool({ connectionString: ctx.app.env.DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
  await ctx.close();
  await teardownAll();
});

/** A registered box with its keypair, its store and its outbox — the real ones. */
interface RunningBox {
  boxId: string;
  branchId: string;
  operatorId: string;
  credential: string;
  privateKeyPem: string;
  store: BoxStore;
  outbox: Outbox;
}

let slotCounter = 0;

/**
 * Claim a box the way the agent does — the public key goes up at registration —
 * then open its store and its outbox over the same database.
 */
async function startBox(): Promise<RunningBox> {
  const [seeded] = await ctx.db.select().from(box).where(eq(box.slot, 'virtual-1')).limit(1);
  if (!seeded) throw new Error('the seed did not create a virtual box');

  const id = newId();
  const slot = `seam-${(slotCounter += 1)}`;
  await ctx.db.insert(box).values({
    id,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    name: `Seam box ${slotCounter}`,
    slot,
    role: 'virtual',
    status: 'unclaimed',
  });

  const { code: claimCode } = await issueClaimCode(ctx.db, id);
  const keys = generateSyncKeyPair();
  const registered = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/register',
    payload: {
      claimCode,
      agentVersion: '0.1.0',
      hostname: slot,
      syncPublicKey: keys.publicKeyPem,
      syncKeyAlgorithm: 'ed25519',
    },
  });
  expect(registered.statusCode).toBe(200);
  const body = registered.json() as { boxId: string; secret: string };
  const credential = boxCredential(body.boxId, body.secret);

  const store = new SqlBoxStore({ driver: postgresBoxDriver(pool as unknown as PgPoolLike) });
  await store.init(body.boxId);

  const outbox = createOutbox({
    store,
    boxId: body.boxId,
    privateKey: () => keys.privateKeyPem,
    isOffline: async () => false,
    push: async (request) => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/box/v1/sync/push',
        headers: { authorization: `Bearer ${credential}` },
        payload: request,
      });
      return {
        status: res.statusCode,
        body: res.statusCode === 200 ? (res.json() as SyncPushResponse) : null,
      };
    },
  });

  return {
    boxId: body.boxId,
    branchId: seeded.branchId,
    operatorId: seeded.operatorId,
    credential,
    privateKeyPem: keys.privateKeyPem,
    store,
    outbox,
  };
}

let phoneCounter = 0;
const uniquePhone = (): string => `+6690222${String(1000 + (phoneCounter += 1)).slice(-4)}`;

const memberFact = (phone: string, nickname = 'Seam family') => ({
  type: 'member.created',
  payload: { memberId: newId(), phone, nickname, createdVia: 'pos' as const },
});

/** Push a raw body the way a box with a damaged queue row would. */
async function pushRaw(
  b: RunningBox,
  events: unknown[],
): Promise<{ status: number; body: SyncPushResponse & { error?: { code: string } } }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/sync/push',
    headers: { authorization: `Bearer ${b.credential}` },
    payload: { events },
  });
  return { status: res.statusCode, body: res.json() };
}

/** One well-formed envelope, sealed by the agent, for standing beside broken ones. */
function sealed(b: RunningBox, boxSeq: number, phone: string) {
  return sealEnvelope(
    {
      eventId: newId(),
      journalEpoch: 1,
      boxSeq,
      type: 'member.created',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      clockTrust: 'trusted',
      stationId: null,
      actorKind: 'system',
      actorAccountId: null,
      actorCredentialId: null,
      actionId: `seam-${boxSeq}`,
      payload: { memberId: newId(), phone, nickname: 'Survivor', createdVia: 'pos' },
    },
    b.boxId,
    b.privateKeyPem,
  );
}

/** An envelope shaped right in every way but one. `over` is the damage. */
function broken(boxSeq: number, over: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {
    eventId: newId(),
    journalEpoch: 1,
    boxSeq,
    type: 'member.created',
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    clockTrust: 'trusted',
    stationId: null,
    actorKind: 'system',
    actorAccountId: null,
    actorCredentialId: null,
    actionId: `broken-${boxSeq}`,
    payload: { memberId: newId(), phone: uniquePhone(), nickname: 'Broken', createdVia: 'pos' },
    payloadHash: 'a'.repeat(64),
    sig: 'AAAAAAAAAAAAAAAAAAAAAAAA',
    sigAlg: 'ed25519',
  };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete row[key];
    else row[key] = value;
  }
  return row;
}

/** The cloud's high-water mark for this box, read from the row itself. */
async function cursorNow(b: RunningBox): Promise<number> {
  const [row] = await ctx.db
    .select()
    .from(syncCursor)
    .where(and(eq(syncCursor.boxId, b.boxId), eq(syncCursor.journalEpoch, 1)));
  return row?.lastBoxSeq ?? 0;
}

const openQuarantine = (b: RunningBox) =>
  ctx.db
    .select()
    .from(syncQuarantine)
    .where(and(eq(syncQuarantine.boxId, b.boxId), eq(syncQuarantine.status, 'open')));

const memberRows = (phone: string) =>
  ctx.db.select().from(member).where(eq(member.phone, phone));

async function injectPoison(b: RunningBox, requestId: string): Promise<SyncPushResponse> {
  const [row] = await ctx.db.select().from(box).where(eq(box.id, b.boxId)).limit(1);
  return injectPoisonEvent(
    ctx.db,
    boxAuthFromRow(row!),
    { requestId, operatorId: b.operatorId, branchId: b.branchId },
    adminAccountId,
  );
}

// ---------------------------------------------------------------------------

describe('a fact minted on a box and pushed at the api', () => {
  it('applies, and the ledger holds the bytes the box sealed', async () => {
    const b = await startBox();
    const phone = uniquePhone();
    const queued = await b.outbox.queue(memberFact(phone, 'The Suwan family'));

    const outcome = await b.outbox.flush();
    expect(outcome.state).toBe('pushed');
    if (outcome.state !== 'pushed') return;
    expect(outcome).toMatchObject({ applied: 1, duplicates: 0, quarantined: 0, cursorSeq: 1 });

    const [created] = await ctx.db.select().from(member).where(eq(member.phone, phone));
    expect(created?.nickname).toBe('The Suwan family');

    /**
     * The hash on the row is the one the BOX computed, over bytes that include
     * its own id, and the cloud recomputed it independently and agreed. That
     * agreement is the whole property, and it is what nothing before this file
     * checked.
     */
    const [ledger] = await ctx.db
      .select()
      .from(syncEvent)
      .where(eq(syncEvent.eventId, queued.envelope.eventId));
    expect(ledger?.payloadHash).toBe(queued.envelope.payloadHash);
    expect(ledger?.sig).toBe(queued.envelope.sig);

    // And the box's queue is empty because the cloud said so, not because the
    // box assumed it.
    expect((await b.outbox.depth()).queued).toBe(0);
  });

  it('re-sends the same batch as duplicates and creates one member', async () => {
    const b = await startBox();
    const phone = uniquePhone();
    await b.outbox.queue(memberFact(phone));
    await b.outbox.flush();

    expect(await b.outbox.replayLastBatch(1)).toBe(1);
    const again = await b.outbox.flush();
    expect(again.state).toBe('pushed');
    if (again.state !== 'pushed') return;
    expect(again).toMatchObject({ applied: 0, duplicates: 1, quarantined: 0 });

    const rows = await ctx.db.select().from(member).where(eq(member.phone, phone));
    expect(rows).toHaveLength(1);
  });

  it('cannot express a fact attributed to another box', async () => {
    const b = await startBox();
    const other = await startBox();

    // Honest in every way but the identity it sealed under. The bytes this box
    // signed name `other`; the cloud recomputes over the credential the push
    // arrived on, so nothing about the envelope adds up on arrival.
    const stolen = sealEnvelope(
      {
        eventId: newId(),
        journalEpoch: 1,
        boxSeq: 1,
        type: 'member.created',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        clockTrust: 'trusted',
        stationId: null,
        actorKind: 'system',
        actorAccountId: null,
        actorCredentialId: null,
        actionId: 'stolen',
        payload: {
          memberId: newId(),
          phone: uniquePhone(),
          nickname: 'Not ours',
          createdVia: 'pos',
        },
      },
      other.boxId,
      b.privateKeyPem,
    );

    const { body } = await pushRaw(b, [stolen]);
    expect(body.results[0]).toMatchObject({
      result: 'quarantined',
      reason: 'poison',
      errorCode: 'SYNC_HASH_MISMATCH',
    });
  });
});

/**
 * The ticket is explicit that one bad event in two hundred must not cost the
 * other hundred and ninety-nine. It used to, and worse than the SAVEPOINT case
 * it was written for: the route validated the whole array, so a single
 * unparseable element was a 400 for the batch — and a 400 is not recoverable by
 * re-sending, because the next attempt carries the same element and gets the
 * same answer, for ever.
 */
describe('a malformed envelope in a batch', () => {
  for (const [position, index] of [
    ['first', 0],
    ['in the middle', 1],
    ['last', 2],
  ] as const) {
    it(`costs only itself when it is ${position}`, async () => {
      const b = await startBox();
      const phones = [uniquePhone(), uniquePhone()];
      let nextPhone = 0;
      const events: unknown[] = [0, 1, 2].map((i) =>
        i === index
          ? broken(i + 1, { type: 'MemberCreated' })
          : sealed(b, i + 1, phones[nextPhone++]!),
      );

      const { status, body } = await pushRaw(b, events);
      expect(status).toBe(200);
      expect(body).toMatchObject({ applied: 2, duplicates: 0, quarantined: 1 });
      expect(body.results.map((r) => r.result)).toEqual(
        [0, 1, 2].map((i) => (i === index ? 'quarantined' : 'applied')),
      );
      expect(body.results[index]).toMatchObject({
        reason: 'poison',
        errorCode: 'SYNC_ENVELOPE_INVALID',
      });

      // Both survivors reached the member table, exactly once each.
      for (const phone of phones) {
        const rows = await ctx.db.select().from(member).where(eq(member.phone, phone));
        expect(rows).toHaveLength(1);
      }
      const ledger = await ctx.db
        .select()
        .from(syncEvent)
        .where(eq(syncEvent.boxId, b.boxId))
        .orderBy(asc(syncEvent.boxSeq));
      expect(ledger.map((r) => r.boxSeq)).toEqual([0, 1, 2].filter((i) => i !== index).map((i) => i + 1));

      /**
       * And the cursor moved past all three, so re-sending the batch — which is
       * exactly what a box does when it is unsure — is three duplicates and one
       * quarantine row, not a second refusal every minute.
       */
      expect(body.cursorSeq).toBe(3);
      const repeat = await pushRaw(b, events);
      expect(repeat.body).toMatchObject({ applied: 0, duplicates: 3, quarantined: 0 });
      const filed = await ctx.db
        .select()
        .from(syncQuarantine)
        .where(eq(syncQuarantine.boxId, b.boxId));
      expect(filed).toHaveLength(1);
    });
  }

  const shapes: Array<[string, Record<string, unknown>]> = [
    ['a type that is not entity.verb', { type: 'MemberCreated' }],
    ['a payload hash that is not a hash', { payloadHash: 'nope' }],
    ['no signature at all', { sig: undefined }],
    ['a sequence of zero', { boxSeq: 0 }],
    ['an event id that is not a uuid', { eventId: 'the-first-one' }],
  ];

  for (const [what, damage] of shapes) {
    it(`files ${what} as poison rather than refusing the batch`, async () => {
      const b = await startBox();
      const phone = uniquePhone();
      const { status, body } = await pushRaw(b, [broken(1, damage), sealed(b, 2, phone)]);
      expect(status).toBe(200);
      expect(body).toMatchObject({ applied: 1, quarantined: 1 });
      expect(body.results[0]?.result).toBe('quarantined');
      const [created] = await ctx.db.select().from(member).where(eq(member.phone, phone));
      expect(created).toBeTruthy();
    });
  }

  it('files something with no identity at all without wedging the batch', async () => {
    const b = await startBox();
    const phone = uniquePhone();
    const { status, body } = await pushRaw(b, ['not an envelope', sealed(b, 1, phone)]);
    expect(status).toBe(200);
    expect(body).toMatchObject({ applied: 1, quarantined: 1 });
    expect(body.results[0]).toMatchObject({
      result: 'quarantined',
      reason: 'poison',
      errorCode: 'SYNC_ENVELOPE_UNADDRESSABLE',
    });

    // Nothing is dropped on the floor: it is on Failures, whole, under an id
    // the cloud minted because the thing carried none.
    const [filed] = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, b.boxId), eq(syncQuarantine.boxSeq, 0)));
    expect(filed?.reason).toBe('poison');
    expect(filed?.errorMessage).toContain('no id or sequence');

    // An event with no sequence never moves the high-water mark, so the good
    // one beside it still holds position 1.
    expect(body.cursorSeq).toBe(1);
  });

  it('still refuses a batch that is not a batch', async () => {
    const b = await startBox();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/sync/push',
      headers: { authorization: `Bearer ${b.credential}` },
      payload: { events: 'all of them' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });
});

describe('"Inject poison event"', () => {
  it('leaves the box able to sync the very next fact it mints', async () => {
    const b = await startBox();
    await b.outbox.queue(memberFact(uniquePhone()));
    await b.outbox.flush();

    const cursorNow = async (): Promise<number> => {
      const [row] = await ctx.db
        .select()
        .from(syncCursor)
        .where(and(eq(syncCursor.boxId, b.boxId), eq(syncCursor.journalEpoch, 1)));
      return row?.lastBoxSeq ?? 0;
    };
    expect(await cursorNow()).toBe(1);

    const injected = await injectPoison(b, 'test-inject');
    expect(injected.results[0]).toMatchObject({ result: 'quarantined', reason: 'poison' });

    /**
     * The mark has not moved, and it must not: the injected event sits at the
     * next position and the box is about to mint that very sequence, so a mark
     * moved past it would put the box's own next fact below the watermark,
     * where it is counted a duplicate and dropped. The old control jumped the
     * cursor by a million and everything the box made afterwards vanished.
     */
    expect(await cursorNow()).toBe(1);
    expect(injected.cursorSeq).toBe(1);

    // The box's next real fact — at the sequence the injection borrowed.
    const phone = uniquePhone();
    const queued = await b.outbox.queue(memberFact(phone, 'After the injection'));
    expect(queued.envelope.boxSeq).toBe(2);
    const outcome = await b.outbox.flush();
    expect(outcome.state).toBe('pushed');
    if (outcome.state !== 'pushed') return;
    expect(outcome).toMatchObject({ applied: 1, duplicates: 0, quarantined: 0 });

    const [created] = await ctx.db.select().from(member).where(eq(member.phone, phone));
    expect(created?.nickname).toBe('After the injection');
    expect((await b.outbox.depth()).queued).toBe(0);
  });

  it('claims no missing events, because it skips none', async () => {
    const b = await startBox();
    await b.outbox.queue(memberFact(uniquePhone()));
    await b.outbox.flush();
    await injectPoison(b, 'test-inject-2');

    const gaps = await ctx.db
      .select()
      .from(syncAnomaly)
      .where(and(eq(syncAnomaly.boxId, b.boxId), eq(syncAnomaly.kind, 'sequence_gap')));
    expect(gaps).toEqual([]);

    // It is open on Failures with an alert, which is what the control is for.
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/ops/quarantine?status=open',
      headers: { cookie: adminCookie },
    });
    const open = list.json().quarantine as Array<{ boxId: string; reason: string }>;
    expect(open.some((q) => q.boxId === b.boxId && q.reason === 'poison')).toBe(true);
  });

  /**
   * The injection was careful with the mark and the Replay button beside it was
   * not, which put the whole fault back through the front door: the replay's
   * refusal moved the mark to `lastBoxSeq + 1` — the sequence the box was about
   * to mint — and the next fact a till recorded came back a duplicate and was
   * never written. Both buttons are acceptance criteria and both are pressed in
   * the QA demo, so this is the demo path rather than a corner of it.
   */
  it('survives the Replay button beside it, pressed twice', async () => {
    const b = await startBox();
    await b.outbox.queue(memberFact(uniquePhone()));
    await b.outbox.flush();
    expect(await cursorNow(b)).toBe(1);

    await injectPoison(b, 'test-inject-replay');
    const [row] = await openQuarantine(b);
    expect(row).toBeTruthy();

    for (const press of [1, 2]) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/ops/quarantine/${row!.id}/replay`,
        headers: { cookie: adminCookie },
      });
      expect(res.statusCode).toBe(200);
      const answer = res.json() as {
        result: string;
        outcome: { errorCode?: string };
        message: string;
      };

      /**
       * Refused for its payload, which is the true thing about it, rather than
       * for a signature it never carried. The cloud holds only the public half
       * of the box's key, so an event the cloud minted cannot be signed; every
       * press used to answer `SYNC_SIGNATURE_INVALID`, which demonstrates the
       * wrong failure.
       */
      expect(answer.result).toBe('quarantined');
      expect(answer.outcome.errorCode).toBe('SYNC_PAYLOAD_INVALID');
      expect(answer.message).toContain('Discard');

      // And one row after each press, not one more. It is the same event.
      expect(await openQuarantine(b)).toHaveLength(1);
      expect(await cursorNow(b), `after press ${press}`).toBe(1);
    }

    // The box's own next fact, at the sequence the injection and both replays
    // borrowed.
    const phone = uniquePhone();
    const queued = await b.outbox.queue(memberFact(phone, 'After the replay'));
    expect(queued.envelope.boxSeq).toBe(2);
    const outcome = await b.outbox.flush();
    expect(outcome.state).toBe('pushed');
    if (outcome.state !== 'pushed') return;
    expect(outcome).toMatchObject({ applied: 1, duplicates: 0, quarantined: 0 });
    expect(await memberRows(phone)).toHaveLength(1);
    expect((await b.outbox.depth()).queued).toBe(0);
  });

  it('does not sweep the outbox of a box that was offline when it was pressed', async () => {
    const b = await startBox();
    await b.outbox.queue(memberFact(uniquePhone()));
    await b.outbox.flush();

    // Three facts made at the counter with no internet. They have never been
    // sent, so nothing the cloud says about its own cursor may retire them.
    const offline = [uniquePhone(), uniquePhone(), uniquePhone()];
    for (const phone of offline) await b.outbox.queue(memberFact(phone, 'Made offline'));
    expect((await b.outbox.depth()).queued).toBe(3);

    await injectPoison(b, 'test-inject-3');

    const outcome = await b.outbox.flush();
    expect(outcome.state).toBe('pushed');
    if (outcome.state !== 'pushed') return;
    expect(outcome.applied).toBe(3);
    for (const phone of offline) {
      const rows = await ctx.db.select().from(member).where(eq(member.phone, phone));
      expect(rows).toHaveLength(1);
    }
    expect((await b.outbox.depth()).queued).toBe(0);
  });
});

/**
 * How far one batch may move the high-water mark.
 *
 * The mark is a claim rather than a note: everything at or below it has been
 * dealt with and the box may retire it. Nothing used to bound how far one batch
 * could push that claim, and a single sequence — read out of a queue row that
 * was never an envelope, or carried by an event the box really did seal a
 * million positions ahead — moved it over positions nothing had touched. What
 * the box sent next sat at those positions, arrived below the watermark, and
 * was counted a duplicate: facts a till had recorded, acknowledged and dropped,
 * with no anomaly and no alert.
 *
 * The ceiling is one line — a batch of N handed to a mark at H accounts for
 * H+1 … H+N and no more — and everything below is what it is worth.
 */
describe('how far one batch may move the high-water mark', () => {
  it('does not let one unreadable sequence sweep the facts standing beside it', async () => {
    const b = await startBox();
    const phones = [uniquePhone(), uniquePhone()];
    const { status, body } = await pushRaw(b, [
      broken(999_999, { type: 'MemberCreated' }),
      sealed(b, 1, phones[0]!),
      sealed(b, 2, phones[1]!),
    ]);

    expect(status).toBe(200);
    expect(body).toMatchObject({ applied: 2, duplicates: 0, quarantined: 1, cursorSeq: 2 });
    for (const phone of phones) expect(await memberRows(phone)).toHaveLength(1);
    // The broken row is on Failures under its own identity, where it can be
    // looked at. It is the mark it may not touch, not the tab.
    expect(await openQuarantine(b)).toHaveLength(1);
  });

  it('holds the mark for a sequence three ahead, which is the same fault smaller', async () => {
    const b = await startBox();
    const phone = uniquePhone();
    const { body } = await pushRaw(b, [broken(4, { type: 'MemberCreated' }), sealed(b, 1, phone)]);

    expect(body).toMatchObject({ applied: 1, duplicates: 0, quarantined: 1, cursorSeq: 1 });
    expect(await memberRows(phone)).toHaveLength(1);
  });

  it('leaves three durably queued facts syncable after a corrupt row has gone up', async () => {
    const b = await startBox();
    const phones = [uniquePhone(), uniquePhone(), uniquePhone()];
    for (const phone of phones) await b.outbox.queue(memberFact(phone, 'Made offline'));
    expect((await b.outbox.depth()).queued).toBe(3);

    // A half-written queue row reaching the api ahead of the real ones. A
    // healthy agent orders by sequence and would not send this first, which is
    // exactly why the api has a salvage path for it at all.
    await pushRaw(b, [broken(999_999, { type: 'MemberCreated' })]);

    const outcome = await b.outbox.flush();
    expect(outcome.state).toBe('pushed');
    if (outcome.state !== 'pushed') return;
    expect(outcome).toMatchObject({ applied: 3, duplicates: 0, cursorSeq: 3 });
    for (const phone of phones) expect(await memberRows(phone)).toHaveLength(1);
    expect((await b.outbox.depth()).queued).toBe(0);
  });

  /**
   * The same shape from the accepted side. This event is sealed, hashes right
   * and verifies against the box's key, so the box genuinely minted it a
   * million positions ahead — and the cloud still may not claim the positions
   * in between, because it holds nothing for them.
   */
  it('does not jump for a sealed event far ahead of the journal either', async () => {
    const b = await startBox();
    const far = uniquePhone();
    const first = await pushRaw(b, [sealed(b, 999_999, far)]);
    expect(first.body).toMatchObject({ applied: 1, cursorSeq: 0 });
    expect(await memberRows(far)).toHaveLength(1);

    const phone = uniquePhone();
    const second = await pushRaw(b, [sealed(b, 1, phone)]);
    expect(second.body).toMatchObject({ applied: 1, duplicates: 0, cursorSeq: 1 });
    expect(await memberRows(phone)).toHaveLength(1);
  });

  /**
   * The cost of holding the mark back: sequences the box sends are now above it
   * rather than below, so the cursor shortcut cannot answer for them and the
   * ledger has to. A box re-sends whenever an answer was lost on the way back,
   * and that re-send must be a duplicate — filing it as a conflict would put a
   * fact that is already applied in front of somebody as a failure.
   */
  it('answers a re-send above the mark from the ledger rather than filing a conflict', async () => {
    const b = await startBox();
    const event = sealed(b, 999_999, uniquePhone());
    expect((await pushRaw(b, [event])).body).toMatchObject({ applied: 1, cursorSeq: 0 });

    const again = await pushRaw(b, [event]);
    expect(again.body).toMatchObject({ applied: 0, duplicates: 1, quarantined: 0 });
    expect(await openQuarantine(b)).toEqual([]);
  });

  /**
   * A wedged box is the failure this whole design exists to prevent, so after
   * any run of refusals one thing must still be true: the next sequence the box
   * legitimately mints is still acceptable.
   *
   * "Legitimately" is doing work in that sentence. A refusal at a position the
   * box really has minted does claim that position — the event is filed whole on
   * Failures and the box's journal has moved past it — and the box's next mint
   * is the position after. What must not block the box is a refusal at a
   * position it has NOT reached, which is what a damaged queue row carrying a
   * garbage sequence is, and which is the input that used to take the mark with
   * it.
   */
  it('accepts the next legitimate sequence after a run of refusals', async () => {
    const b = await startBox();
    await pushRaw(b, [
      broken(999_999, { type: 'MemberCreated' }),
      broken(500, { payloadHash: 'nope' }),
      broken(77, { sig: undefined }),
      'not an envelope',
    ]);
    expect(await cursorNow(b)).toBe(0);

    const phone = uniquePhone();
    const queued = await b.outbox.queue(memberFact(phone, 'After the refusals'));
    expect(queued.envelope.boxSeq).toBe(1);
    const outcome = await b.outbox.flush();
    expect(outcome.state).toBe('pushed');
    if (outcome.state !== 'pushed') return;
    expect(outcome).toMatchObject({ applied: 1, duplicates: 0, cursorSeq: 1 });
    expect(await memberRows(phone)).toHaveLength(1);
    expect((await b.outbox.depth()).queued).toBe(0);
  });

  /**
   * And the other half of it: a queue row damaged on the way up, re-sent whole,
   * is recognised as the event it is rather than dropped for sitting at a
   * position the refusal already claimed. Same event id, because it is the same
   * row — which is what quarantine is read for.
   */
  it('takes a refused event back when the box sends it whole', async () => {
    const b = await startBox();
    const phone = uniquePhone();
    const event = sealed(b, 1, phone);
    const truncated = { ...event, payload: {} };

    const first = await pushRaw(b, [truncated]);
    expect(first.body).toMatchObject({ applied: 0, quarantined: 1, cursorSeq: 1 });

    const second = await pushRaw(b, [event]);
    expect(second.body).toMatchObject({ applied: 0, duplicates: 1, quarantined: 0 });
    // Quietly: it is on Failures under this very id, waiting for somebody to
    // press Replay, which is the ending the ticket asks for.
    expect(await openQuarantine(b)).toHaveLength(1);
    const raised = await ctx.db
      .select()
      .from(alert)
      .where(eq(alert.key, `sync.dropped_without_record:${b.boxId}`));
    expect(raised).toEqual([]);
  });

  /**
   * The backstop under the ceiling. Counting an event a duplicate on the
   * cursor's word, with nothing in the ledger and nothing in quarantine to back
   * the word up, is the only way a fact can leave the push without being
   * written down anywhere. It has one legitimate cause — the ledger's retention
   * sweep, which is why the cursor is never swept — and one illegitimate one, a
   * mark ahead of the ledger. Both are now said out loud.
   */
  it('says so out loud when it counts a duplicate it has no record of', async () => {
    const b = await startBox();
    const phone = uniquePhone();
    const event = sealed(b, 1, phone);
    expect((await pushRaw(b, [event])).body).toMatchObject({ applied: 1, cursorSeq: 1 });

    // The ledger row gone and the cursor kept: what the retention sweep leaves
    // behind, and what a mark ahead of the ledger looks like from here.
    await ctx.db.delete(syncEvent).where(eq(syncEvent.eventId, event.eventId));

    const again = await pushRaw(b, [event]);
    // Still a duplicate — applying a year-old sale twice is the worse mistake —
    // but no longer a silent one.
    expect(again.body).toMatchObject({ applied: 0, duplicates: 1, quarantined: 0 });
    expect(await memberRows(phone)).toHaveLength(1);

    const [anomaly] = await ctx.db
      .select()
      .from(syncAnomaly)
      .where(and(eq(syncAnomaly.boxId, b.boxId), eq(syncAnomaly.kind, 'late_arrival')));
    expect(anomaly?.detail).toMatchObject({ droppedWithoutRecord: true, boxSeq: 1 });

    const [raised] = await ctx.db
      .select()
      .from(alert)
      .where(eq(alert.key, `sync.dropped_without_record:${b.boxId}`));
    expect(raised?.status).toBe('open');
    expect(raised?.severity).toBe('critical');
  });

  /**
   * And it is quiet about the ordinary case, because an alarm that fires on
   * every retry is an alarm nobody reads. A refused event has no ledger row —
   * that is what being refused means — so quarantine is the second place the
   * push looks before it calls anything unrecorded.
   */
  it('is quiet about a refused event coming round again, which is not loss', async () => {
    const b = await startBox();
    const phone = uniquePhone();
    const events = [broken(1, { type: 'MemberCreated' }), sealed(b, 2, phone)];
    await pushRaw(b, events);

    const again = await pushRaw(b, events);
    expect(again.body).toMatchObject({ applied: 0, duplicates: 2, quarantined: 0 });

    const anomalies = await ctx.db
      .select()
      .from(syncAnomaly)
      .where(and(eq(syncAnomaly.boxId, b.boxId), eq(syncAnomaly.kind, 'late_arrival')));
    expect(anomalies).toEqual([]);
    const raised = await ctx.db
      .select()
      .from(alert)
      .where(eq(alert.key, `sync.dropped_without_record:${b.boxId}`));
    expect(raised).toEqual([]);
  });
});
