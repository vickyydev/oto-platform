import {
  createHash,
  generateKeyPairSync,
  sign as signDetached,
  type KeyObject,
} from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, desc, eq } from 'drizzle-orm';
import {
  account,
  auditLog,
  box,
  branch,
  child,
  member,
  opsRun,
  station,
  syncAnomaly,
  syncChange,
  syncCursor,
  syncEvent,
  syncQuarantine,
  visit,
  visitChild,
} from '@oto/db';
import {
  SYNC_EVENT_SCHEMA_VERSION,
  canonicalSyncBytes,
  newId,
  type SyncEventEnvelope,
  type SyncPushResponse,
} from '@oto/shared';
import { boxCredential } from '@oto/box-agent';
import {
  ADMIN,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { issueClaimCode } from '../src/services/box';

/**
 * S2-05 — the cloud half of the sync core, tested as a machine in a mall.
 *
 * The happy path here is one line and is not what this file is for. What is
 * pinned is every way a batch can be wrong, because each of them is a way the
 * park loses money or gains a member twice:
 *
 *   - the SAME batch arriving again because the answer was lost;
 *   - the same event id carrying DIFFERENT content, which is not a duplicate;
 *   - a batch replayed from a journal the box no longer has;
 *   - one poison event in a batch of five, and the other four surviving it;
 *   - a signature that does not belong to the box presenting it;
 *   - a box whose clock is wrong stamping a sale onto the wrong trading day;
 *   - the same phone typed at two counters that cannot see each other.
 *
 * The box's keypair is real and the signatures are real: a test that skipped
 * the signature would be testing a different endpoint from the one that runs.
 */

let ctx: TestContext;
let adminCookie: string;

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const sha256 = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

// --- A box with a keypair ---------------------------------------------------

interface TestBox {
  boxId: string;
  credential: string;
  branchId: string;
  operatorId: string;
  privateKey: KeyObject;
  publicKeyPem: string;
  /** The next journal position this box will mint. */
  nextSeq: number;
}

/**
 * A box of this test's own, at the seeded branch.
 *
 * Every push case gets one. A journal is per-box state — the cursor, the
 * high-water mark, the epoch — so two cases sharing a box would be two cases
 * sharing a sequence number, and the second would see the first's events as
 * duplicates for reasons that have nothing to do with what it is testing. The
 * cases that need the SEEDED box (its stations, its staff list) ask for it by
 * slot and do not push.
 */
let slotCounter = 0;

async function freshBox(): Promise<TestBox> {
  const [seeded] = await ctx.db.select().from(box).where(eq(box.slot, 'virtual-1')).limit(1);
  if (!seeded) throw new Error('the seed did not create a virtual box');
  const id = newId();
  const slot = `test-${(slotCounter += 1)}`;
  await ctx.db.insert(box).values({
    id,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    name: `Test box ${slotCounter}`,
    slot,
    role: 'virtual',
    status: 'unclaimed',
  });
  return claim(slot);
}

async function claim(slot: string): Promise<TestBox> {
  const [row] = await ctx.db.select().from(box).where(eq(box.slot, slot)).limit(1);
  if (!row) throw new Error(`no box in slot ${slot}`);
  const { code: claimCode } = await issueClaimCode(ctx.db, row.id);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/register',
    payload: { claimCode, agentVersion: '0.1.0', hostname: `test-${slot}` },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { boxId: string; secret: string };

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

  return {
    boxId: body.boxId,
    credential: boxCredential(body.boxId, body.secret),
    branchId: row.branchId,
    operatorId: row.operatorId,
    privateKey,
    publicKeyPem,
    nextSeq: 1,
  };
}

const headers = (b: TestBox): Record<string, string> => ({
  authorization: `Bearer ${b.credential}`,
});

async function registerKey(b: TestBox): Promise<void> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/sync/key',
    headers: headers(b),
    payload: { publicKey: b.publicKeyPem },
  });
  expect(res.statusCode).toBe(200);
}

/**
 * Mint an envelope the way a box would: canonical bytes first, then the hash
 * and the signature over exactly those bytes.
 *
 * **With `boxId` in the bytes**, which is the one thing this helper cannot get
 * wrong without testing a different api from the one that runs: `boxId` is in
 * `SYNC_CANONICAL_FIELDS` and is not a field of the envelope, so both ends put
 * it back — the box from its own identity, the cloud from the credential. A
 * helper that left it out would mirror a cloud that also left it out, and the
 * pair would agree with each other and with no real box. `sync-ledger.test.ts`
 * is the guard against exactly that: it seals with `@oto/box-agent` itself.
 */
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
    stationId: null,
    actorKind: 'account' as const,
    actorAccountId: null,
    actorCredentialId: null,
    actionId: `act-${Math.random().toString(36).slice(2, 10)}`,
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

async function push(
  b: TestBox,
  events: SyncEventEnvelope[],
): Promise<{ status: number; body: SyncPushResponse & { error?: { code: string } } }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/sync/push',
    headers: headers(b),
    payload: { events },
  });
  return { status: res.statusCode, body: res.json() };
}

const memberPayload = (phone: string, nickname = 'Test family') => ({
  memberId: newId(),
  phone,
  nickname,
  createdVia: 'pos' as const,
});

/** A phone nothing else in the suite has taken. */
let phoneCounter = 0;
const uniquePhone = (): string => `+6690111${String(1000 + (phoneCounter += 1)).slice(-4)}`;

// ---------------------------------------------------------------------------

describe('the key a box signs with', () => {
  it('refuses a whole batch from a box with no registered key, and quarantines nothing', async () => {
    const b = await freshBox();
    const { status, body } = await push(b, [mint(b, 'member.created', memberPayload(uniquePhone()))]);
    expect(status).toBe(409);
    expect(body.error?.code).toBe('SYNC_KEY_UNKNOWN');

    // Nothing is filed: there is nothing wrong with the events, only with what
    // the cloud is holding about the box. The same batch works once the key is
    // registered, which is the point of refusing rather than quarantining.
    const open = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(eq(syncQuarantine.boxId, b.boxId));
    expect(open).toEqual([]);
  });

  /**
   * The two doors the agent actually uses. `POST /box/v1/sync/key` is the
   * explicit one and is what a rotation reaches for; these are the ones a box
   * comes up through, so they are the ones that decide whether the demo works
   * at all.
   */
  it('takes the key at registration, so a box can push on its first batch', async () => {
    const [seeded] = await ctx.db.select().from(box).where(eq(box.slot, 'virtual-1')).limit(1);
    const id = newId();
    const slot = `reg-${Date.now()}`;
    await ctx.db.insert(box).values({
      id,
      operatorId: seeded!.operatorId,
      branchId: seeded!.branchId,
      name: 'Registering box',
      slot,
      role: 'virtual',
      status: 'unclaimed',
    });
    const { code: claimCode } = await issueClaimCode(ctx.db, id);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/register',
      payload: { claimCode, agentVersion: '0.1.0', syncPublicKey: publicKeyPem },
    });
    expect(res.statusCode).toBe(200);
    const registered = res.json() as { boxId: string; secret: string };

    const b: TestBox = {
      boxId: registered.boxId,
      credential: boxCredential(registered.boxId, registered.secret),
      branchId: seeded!.branchId,
      operatorId: seeded!.operatorId,
      privateKey,
      publicKeyPem,
      nextSeq: 1,
    };
    // No separate key call: the batch works straight away.
    const { body } = await push(b, [mint(b, 'member.created', memberPayload(uniquePhone()))]);
    expect(body.applied).toBe(1);
  });

  it('takes the key on a heartbeat, which is the only door left to a box claimed before the sync core', async () => {
    const b = await freshBox();
    const beat = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/heartbeat',
      headers: headers(b),
      payload: {
        reportedAt: new Date().toISOString(),
        agentVersion: '0.1.0',
        syncPublicKey: b.publicKeyPem,
      },
    });
    expect(beat.statusCode).toBe(200);

    const { body } = await push(b, [mint(b, 'member.created', memberPayload(uniquePhone()))]);
    expect(body.applied).toBe(1);

    const [audited] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, b.boxId), eq(auditLog.action, 'box.sync_key_register')))
      .limit(1);
    expect(audited?.after).toMatchObject({ via: 'heartbeat' });
  });

  it('accepts the same key twice without calling it a rotation, and audits both', async () => {
    const b = await freshBox();
    await registerKey(b);
    await registerKey(b);
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, b.boxId), eq(auditLog.action, 'box.sync_key_register')));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const rotations = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, b.boxId), eq(auditLog.action, 'box.sync_key_rotate')));
    expect(rotations).toEqual([]);
  });
});

describe('applying a batch', () => {
  it('creates the member, writes the ledger row, the audit row and the change feed', async () => {
    const b = await freshBox();
    await registerKey(b);
    const phone = uniquePhone();
    const payload = memberPayload(phone, 'The Chairat family');
    const event = mint(b, 'member.created', payload);

    const { status, body } = await push(b, [event]);
    expect(status).toBe(200);
    expect(body).toMatchObject({ applied: 1, duplicates: 0, quarantined: 0, cursorSeq: 1 });
    expect(body.results[0]).toMatchObject({
      result: 'applied',
      businessDateSource: 'occurred_at',
    });

    const [created] = await ctx.db.select().from(member).where(eq(member.phone, phone));
    expect(created?.id).toBe(payload.memberId);
    expect(created?.nickname).toBe('The Chairat family');

    const [ledger] = await ctx.db
      .select()
      .from(syncEvent)
      .where(eq(syncEvent.eventId, event.eventId));
    expect(ledger).toMatchObject({
      boxId: b.boxId,
      journalEpoch: 1,
      boxSeq: 1,
      type: 'member.created',
      payloadHash: event.payloadHash,
      batchId: body.batchId,
    });

    /**
     * One action id ties the till line, the box log and this row together, and
     * `source_event_id` is how somebody gets from the audit row back to the
     * envelope. That is the ticket's last acceptance criterion.
     */
    const [audited] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'member.create'), eq(auditLog.entityId, payload.memberId)));
    expect(audited?.actionId).toBe(event.actionId);
    expect(audited?.sourceEventId).toBe(event.eventId);

    // And the other box at the branch learns about it without being told.
    const [delta] = await ctx.db
      .select()
      .from(syncChange)
      .where(and(eq(syncChange.entityType, 'member'), eq(syncChange.entityId, payload.memberId)));
    expect(delta?.scope).toBe('members');
    expect(delta?.op).toBe('upsert');

    // One `ops_run` for the batch, addressable by the id the answer carried.
    const [run] = await ctx.db.select().from(opsRun).where(eq(opsRun.id, body.batchId));
    expect(run?.name).toBe('sync:push');
    expect(run?.outcome).toBe('ok');
  });

  it('carries a visit and its children across as one fact', async () => {
    const b = await freshBox();
    await registerKey(b);
    const phone = uniquePhone();
    const m = memberPayload(phone);
    const childId = newId();
    const visitId = newId();

    const { body } = await push(b, [
      mint(b, 'member.created', m),
      mint(b, 'child.created', {
        childId,
        memberId: m.memberId,
        name: 'Nong Ploy',
        ageYears: 5,
        allergies: 'peanuts',
      }),
      mint(b, 'visit.created', {
        visitId,
        memberId: m.memberId,
        visitDate: new Date().toISOString().slice(0, 10),
        childIds: [childId],
      }),
    ]);
    expect(body.applied).toBe(3);

    const [c] = await ctx.db.select().from(child).where(eq(child.id, childId));
    expect(c?.allergies).toBe('peanuts');
    // An allergy sets the alert without anybody having to tick it, the same
    // rule the HTTP route applies.
    expect(c?.medicalAlert).toBe(true);

    const [v] = await ctx.db.select().from(visit).where(eq(visit.id, visitId));
    expect(v?.branchId).toBe(b.branchId);
    const links = await ctx.db.select().from(visitChild).where(eq(visitChild.visitId, visitId));
    expect(links).toHaveLength(1);
  });

  /**
   * The takeover reaching the cloud's audit THROUGH the ledger.
   *
   * It travels as a fact rather than being written where the button was
   * pressed because the box may have had no internet at the time, and an audit
   * trail with holes in it on exactly the days the link was bad is worth very
   * little. What the row has to carry is who did it — a takeover that reads
   * "somebody took the till" answers nothing — so an anonymous one is
   * quarantined rather than filed.
   */
  it('records a takeover against the station, by name, and refuses an anonymous one', async () => {
    const b = await freshBox();
    await registerKey(b);
    const stationId = newId();
    await ctx.db.insert(station).values({
      id: stationId,
      operatorId: b.operatorId,
      branchId: b.branchId,
      boxId: b.boxId,
      name: `Takeover till ${stationId.slice(-4)}`,
      kind: 'till',
    });
    const [manager] = await ctx.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.phone, ADMIN.phone))
      .limit(1);

    const takeover = mint(
      b,
      'station.takeover',
      {
        displacedLeaseId: newId(),
        displacedHolderKind: 'till',
        displacedAccountId: null,
        newLeaseId: newId(),
        newHolderKind: 'till',
        newAccountId: manager!.id,
        takeoverCount: 1,
      },
      { stationId, actorAccountId: manager!.id },
    );
    const { body } = await push(b, [takeover]);
    expect(body.applied).toBe(1);

    const [audited] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'station.takeover'), eq(auditLog.entityId, stationId)))
      .limit(1);
    expect(audited?.actorAccountId).toBe(manager!.id);
    expect(audited?.sourceEventId).toBe(takeover.eventId);
    expect((audited?.after as { takeoverCount?: number }).takeoverCount).toBe(1);

    const anonymous = await push(b, [
      mint(
        b,
        'station.takeover',
        { displacedLeaseId: newId(), newLeaseId: newId() },
        { stationId },
      ),
    ]);
    expect(anonymous.body.results[0]).toMatchObject({
      result: 'quarantined',
      reason: 'actor_unknown',
    });
  });
});

describe('a batch that arrives twice', () => {
  it('applies nothing the second time, counts every event as a duplicate, and leaves the cursor alone', async () => {
    const b = await freshBox();
    await registerKey(b);
    const events = [
      mint(b, 'member.created', memberPayload(uniquePhone())),
      mint(b, 'member.created', memberPayload(uniquePhone())),
      mint(b, 'member.created', memberPayload(uniquePhone())),
    ];

    const first = await push(b, events);
    expect(first.body).toMatchObject({ applied: 3, duplicates: 0, cursorSeq: 3 });

    // Byte for byte, as a box that never saw the answer would send it.
    const second = await push(b, events);
    expect(second.body).toMatchObject({ applied: 0, duplicates: 3, quarantined: 0, cursorSeq: 3 });

    const rows = await ctx.db.select().from(syncEvent).where(eq(syncEvent.boxId, b.boxId));
    expect(rows).toHaveLength(3);
    const [cursor] = await ctx.db
      .select()
      .from(syncCursor)
      .where(eq(syncCursor.boxId, b.boxId));
    expect(cursor?.lastBoxSeq).toBe(3);
    expect(cursor?.eventsApplied).toBe(3);
    expect(cursor?.eventsDuplicate).toBe(3);
  });

  it('is still recognisably a replay after the ledger row has been swept', async () => {
    const b = await freshBox();
    await registerKey(b);
    const event = mint(b, 'member.created', memberPayload(uniquePhone()));
    await push(b, [event]);

    /**
     * The whole reason `sync_cursor` exists and is never swept. With the ledger
     * row gone there is nothing left to compare hashes against, and the event
     * must still be dropped — otherwise pruning would quietly re-open the door
     * to double-applying a year-old sale.
     */
    await ctx.db.delete(syncEvent).where(eq(syncEvent.eventId, event.eventId));

    const again = await push(b, [event]);
    expect(again.body).toMatchObject({ applied: 0, duplicates: 1, quarantined: 0 });
  });
});

describe('the same id carrying different content', () => {
  it('is quarantined rather than resolved by picking one, and both hashes are kept', async () => {
    const b = await freshBox();
    await registerKey(b);
    const first = mint(b, 'member.created', memberPayload(uniquePhone(), 'First name'));
    await push(b, [first]);

    // The same identity — same event id, same journal position — with a
    // different payload underneath it. Two facts wearing one id.
    b.nextSeq -= 1;
    const forged = mint(b, 'member.created', memberPayload(uniquePhone(), 'Second name'), {
      eventId: first.eventId,
    });

    const { body } = await push(b, [forged]);
    expect(body).toMatchObject({ applied: 0, duplicates: 0, quarantined: 1 });
    expect(body.results[0]).toMatchObject({ result: 'quarantined', reason: 'conflict' });

    const [row] = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.eventId, first.eventId), eq(syncQuarantine.reason, 'conflict')));
    expect(row?.status).toBe('open');
    // Both, so the two are comparable by whoever has to decide.
    expect(row?.payloadHash).toBe(forged.payloadHash);
    expect(row?.existingPayloadHash).toBe(first.payloadHash);

    // And nothing was overwritten.
    const [ledger] = await ctx.db
      .select()
      .from(syncEvent)
      .where(eq(syncEvent.eventId, first.eventId));
    expect(ledger?.payloadHash).toBe(first.payloadHash);
  });

  it('refuses an envelope that does not hash to the value it carries', async () => {
    const b = await freshBox();
    await registerKey(b);
    const event = mint(b, 'member.created', memberPayload(uniquePhone()));
    // The payload rewritten after the seal, which is what a half-written queue
    // row or a truncated write looks like.
    const tampered = {
      ...event,
      payload: { ...event.payload, nickname: 'Rewritten' },
    } as SyncEventEnvelope;

    const { body } = await push(b, [tampered]);
    expect(body.results[0]).toMatchObject({
      result: 'quarantined',
      reason: 'poison',
      errorCode: 'SYNC_HASH_MISMATCH',
    });
  });
});

describe('the signature', () => {
  it('refuses a batch signed by a keypair that is not this box’s', async () => {
    const b = await freshBox();
    await registerKey(b);
    const impostor = generateKeyPairSync('ed25519');

    const event = mint(b, 'member.created', memberPayload(uniquePhone()));
    const canonical = canonicalSyncBytes({ ...event, boxId: b.boxId });
    const resigned = {
      ...event,
      sig: signDetached(null, Buffer.from(canonical, 'utf8'), impostor.privateKey).toString(
        'base64',
      ),
    } as SyncEventEnvelope;

    const { body } = await push(b, [resigned]);
    expect(body.results[0]).toMatchObject({
      result: 'quarantined',
      reason: 'signature_invalid',
    });
    // Nothing of it reached the business tables.
    const created = await ctx.db
      .select()
      .from(member)
      .where(eq(member.id, (event.payload as { memberId: string }).memberId));
    expect(created).toEqual([]);
  });
});

describe('one bad event in a batch', () => {
  it('applies 1, 2, 4 and 5 exactly once, quarantines 3, and advances the cursor past all five', async () => {
    const b = await freshBox();
    await registerKey(b);
    const good = (n: number) => mint(b, 'member.created', memberPayload(uniquePhone(), `Good ${n}`));

    const one = good(1);
    const two = good(2);
    // A known type whose payload cannot possibly be one: the SAVEPOINT is what
    // keeps its failure from taking the other four with it.
    const poison = mint(b, 'member.created', { nothing: 'useful' });
    const four = good(4);
    const five = good(5);

    const { body } = await push(b, [one, two, poison, four, five]);
    expect(body).toMatchObject({ applied: 4, duplicates: 0, quarantined: 1, cursorSeq: 5 });
    expect(body.results.map((r) => r.result)).toEqual([
      'applied',
      'applied',
      'quarantined',
      'applied',
      'applied',
    ]);

    const ledger = await ctx.db
      .select()
      .from(syncEvent)
      .where(eq(syncEvent.boxId, b.boxId))
      .orderBy(asc(syncEvent.boxSeq));
    expect(ledger.map((r) => r.boxSeq)).toEqual([1, 2, 4, 5]);

    const [quarantined] = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(eq(syncQuarantine.eventId, poison.eventId));
    expect(quarantined?.reason).toBe('poison');

    // The batch is recorded as failed, with the counts on it, so the Failures
    // page groups a box that has started producing rubbish.
    const [run] = await ctx.db.select().from(opsRun).where(eq(opsRun.id, body.batchId));
    expect(run?.outcome).toBe('failed');
    expect(run?.detail).toMatchObject({ applied: 4, quarantined: 1 });

    /**
     * And sending the whole batch again costs nothing and files nothing twice:
     * the cursor moved past the quarantined event too, because it has been
     * DEALT WITH — it is filed, whole, waiting on a person.
     */
    const again = await push(b, [one, two, poison, four, five]);
    expect(again.body).toMatchObject({ applied: 0, duplicates: 5, quarantined: 0 });
    const filed = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(eq(syncQuarantine.eventId, poison.eventId));
    expect(filed).toHaveLength(1);
  });

  it('refuses a type this api has no handler for, and says so', async () => {
    const b = await freshBox();
    await registerKey(b);
    const { body } = await push(b, [mint(b, 'sale.completed', { total: 1 })]);
    expect(body.results[0]).toMatchObject({ result: 'quarantined', reason: 'unknown_type' });
  });

  it('refuses an envelope from a schema version it cannot read', async () => {
    const b = await freshBox();
    await registerKey(b);
    const { body } = await push(b, [
      mint(b, 'member.created', memberPayload(uniquePhone()), {
        schemaVersion: SYNC_EVENT_SCHEMA_VERSION + 5,
      }),
    ]);
    expect(body.results[0]).toMatchObject({ result: 'quarantined', reason: 'schema_too_new' });
  });

  it('refuses an event naming a station that is not on this box', async () => {
    const b = await freshBox();
    await registerKey(b);
    const [elsewhere] = await ctx.db
      .select()
      .from(station)
      .where(eq(station.name, 'Counter 2'))
      .limit(1);
    const { body } = await push(b, [
      mint(b, 'member.created', memberPayload(uniquePhone()), { stationId: elsewhere!.id }),
    ]);
    expect(body.results[0]).toMatchObject({
      result: 'quarantined',
      errorCode: 'SYNC_STATION_NOT_ON_BOX',
    });
  });
});

describe('the epoch', () => {
  it('refuses a batch replayed from a journal the store reset replaced', async () => {
    const b = await freshBox();
    await registerKey(b);
    const old = mint(b, 'member.created', memberPayload(uniquePhone()));

    // What "Reset store" does when the box reports it has wiped itself.
    await ctx.db
      .update(box)
      .set({ currentEpoch: 2 })
      .where(eq(box.id, b.boxId));

    const { body } = await push(b, [old]);
    expect(body).toMatchObject({ applied: 0, quarantined: 1, epoch: 2 });
    expect(body.results[0]).toMatchObject({
      result: 'quarantined',
      reason: 'epoch_regressed',
      errorCode: 'SYNC_EPOCH_REGRESSED',
    });

    // No row is dropped silently: it is filed, and an anomaly and an alert say
    // what happened.
    const [filed] = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(eq(syncQuarantine.eventId, old.eventId));
    expect(filed?.reason).toBe('epoch_regressed');
    const [anomaly] = await ctx.db
      .select()
      .from(syncAnomaly)
      .where(and(eq(syncAnomaly.eventId, old.eventId), eq(syncAnomaly.kind, 'epoch_regressed')));
    expect(anomaly?.detail).toMatchObject({ sentEpoch: 1, currentEpoch: 2 });

    // And the same sequence number in the NEW epoch is free, because the
    // journal key carries the epoch.
    b.nextSeq = 1;
    const fresh = mint(b, 'member.created', memberPayload(uniquePhone()), { journalEpoch: 2 });
    const after = await push(b, [fresh]);
    expect(after.body).toMatchObject({ applied: 1, cursorSeq: 1 });
  });
});

describe('the clock', () => {
  it('re-dates a sale from a box that cannot say what time it is, and records both candidates', async () => {
    const b = await freshBox();
    await registerKey(b);
    // A box that came up after a power cut: yesterday's date, and it says so.
    const yesterday = new Date(Date.now() - 36 * 3_600_000).toISOString();
    const event = mint(b, 'member.created', memberPayload(uniquePhone()), {
      occurredAt: yesterday,
      clockTrust: 'untrusted',
    });

    const { body } = await push(b, [event]);
    expect(body.results[0]).toMatchObject({
      result: 'applied',
      businessDateSource: 'received_at',
    });

    const [ledger] = await ctx.db
      .select()
      .from(syncEvent)
      .where(eq(syncEvent.eventId, event.eventId));
    // `occurred_at` is kept exactly as sent, even though it was disbelieved.
    expect(ledger?.occurredAt.toISOString()).toBe(new Date(yesterday).toISOString());
    expect(ledger?.businessDateSource).toBe('received_at');
    expect(ledger?.clockTrust).toBe('untrusted');

    const [anomaly] = await ctx.db
      .select()
      .from(syncAnomaly)
      .where(and(eq(syncAnomaly.eventId, event.eventId), eq(syncAnomaly.kind, 'clock_recomputed')));
    // Both dates, so a day's takings that look wrong are explainable months
    // later from the row itself.
    expect(anomaly?.detail).toMatchObject({ clockTrust: 'untrusted' });
    const detail = anomaly?.detail as { fromOccurredAt: string; fromReceivedAt: string };
    expect(detail.fromOccurredAt).not.toBe(detail.fromReceivedAt);
  });

  it('overrules a box that claims a trusted clock while reporting a large offset', async () => {
    const b = await freshBox();
    await registerKey(b);
    const event = mint(b, 'member.created', memberPayload(uniquePhone()), {
      clockTrust: 'trusted',
      clockOffsetMs: 10 * 60_000,
    });
    const { body } = await push(b, [event]);
    expect(body.results[0]?.businessDateSource).toBe('received_at');
    const [ledger] = await ctx.db
      .select()
      .from(syncEvent)
      .where(eq(syncEvent.eventId, event.eventId));
    expect(ledger?.clockTrust).toBe('skewed');
  });
});

describe('the same phone at two counters', () => {
  it('merges at sync into one member, with an anomaly naming both events', async () => {
    const one = await freshBox();
    const two = await freshBox();
    await registerKey(one);
    await registerKey(two);

    const phone = uniquePhone();
    const atReception = mint(one, 'member.created', {
      ...memberPayload(phone),
      nickname: 'Typed at reception',
    });
    const atCounterTwo = mint(two, 'member.created', {
      ...memberPayload(phone),
      nickname: 'Typed at counter 2',
    });

    const first = await push(one, [atReception]);
    expect(first.body.applied).toBe(1);
    // Both boxes were offline and both were right; the second to arrive is the
    // one that has to be reconciled.
    const second = await push(two, [atCounterTwo]);
    expect(second.body.applied).toBe(1);

    const survivors = await ctx.db.select().from(member).where(eq(member.phone, phone));
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.id).toBe((atReception.payload as { memberId: string }).memberId);

    const [anomaly] = await ctx.db
      .select()
      .from(syncAnomaly)
      .where(and(eq(syncAnomaly.kind, 'merge'), eq(syncAnomaly.eventId, atCounterTwo.eventId)));
    expect(anomaly).toBeTruthy();
    // Both event ids, which is what the acceptance criterion asks for.
    expect(anomaly?.relatedEventId).toBe(atReception.eventId);
    expect(anomaly?.detail).toMatchObject({
      survivingMemberId: (atReception.payload as { memberId: string }).memberId,
      discardedMemberId: (atCounterTwo.payload as { memberId: string }).memberId,
    });

    // And the surviving member is published so the second box can repoint.
    const [delta] = await ctx.db
      .select()
      .from(syncChange)
      .where(
        and(
          eq(syncChange.entityType, 'member'),
          eq(syncChange.entityId, (atReception.payload as { memberId: string }).memberId),
        ),
      )
      .orderBy(desc(syncChange.seq))
      .limit(1);
    expect(delta?.payload).toMatchObject({
      mergedFromMemberId: (atCounterTwo.payload as { memberId: string }).memberId,
    });
  });
});

describe('quarantine, from the Console', () => {
  it('lists without the payload, replays through the same door, and refuses a second replay', async () => {
    const b = await freshBox();
    await registerKey(b);
    /**
     * An event the cloud could not apply YET: the member's creation has not
     * arrived. That is the quarantine a replay is actually for — nothing is
     * wrong with the event, something was simply missing when it landed.
     */
    const memberId = newId();
    const update = mint(b, 'member.updated', { memberId, nickname: 'Renamed' });
    const pushed = await push(b, [update]);
    expect(pushed.body.results[0]).toMatchObject({ reason: 'apply_failed' });

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/ops/quarantine?status=open',
      headers: { cookie: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json().events as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.eventId === update.eventId);
    expect(row).toBeTruthy();
    // Nothing personal leaves here: the envelope stays in the table.
    expect(Object.keys(row!)).not.toContain('payload');

    // Now make the missing thing exist, and put the event back through.
    await ctx.db.insert(member).values({
      id: memberId,
      operatorId: b.operatorId,
      phone: uniquePhone(),
      nickname: 'Created late',
    });

    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/ops/quarantine/${row!.id}/replay`,
      headers: { cookie: adminCookie },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().result).toBe('applied');
    /**
     * And the row's new STATUS, which is the field the Console reads to decide
     * between "Filed" and "Refused again". While the route answered with
     * `result` alone, every successful replay reported itself as a refusal and
     * "Replay all" stopped after the first event believing it had failed.
     */
    expect(replay.json().status).toBe('replayed');
    expect(replay.json().eventId).toBe(update.eventId);
    expect(replay.json().errorMessage).toBeNull();
    const [after] = await ctx.db.select().from(member).where(eq(member.id, memberId));
    expect(after?.nickname).toBe('Renamed');

    // Once resolved, it stays resolved.
    const twice = await ctx.app.inject({
      method: 'POST',
      url: `/ops/quarantine/${row!.id}/replay`,
      headers: { cookie: adminCookie },
    });
    expect(twice.statusCode).toBe(409);
  });

  it('will not discard without a reason', async () => {
    const b = await freshBox();
    await registerKey(b);
    const poison = mint(b, 'member.created', { nothing: 'useful' });
    await push(b, [poison]);
    const [row] = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(eq(syncQuarantine.eventId, poison.eventId));

    const bare = await ctx.app.inject({
      method: 'POST',
      url: `/ops/quarantine/${row!.id}/discard`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(bare.statusCode).toBe(400);

    const withReason = await ctx.app.inject({
      method: 'POST',
      url: `/ops/quarantine/${row!.id}/discard`,
      headers: { cookie: adminCookie },
      payload: { note: 'A test control injected it; nothing was lost.' },
    });
    expect(withReason.statusCode).toBe(200);
    expect(withReason.json().status).toBe('discarded');
    const [closed] = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(eq(syncQuarantine.id, row!.id));
    expect(closed?.status).toBe('discarded');
    expect(closed?.resolutionNote).toContain('nothing was lost');
  });
});

/**
 * The other half of the Failures > Quarantine tab (S2-05).
 *
 * `apps/console/src/api/sync.ts` is the contract and these cases are written
 * from it, the way `ops-api.test.ts` is written from `observability.ts`: the
 * Console was built beside an API that did not yet serve `/ops/anomalies`, so
 * the panel rendered "not on this deployment" and the rows the cloud had
 * written about the park's money accumulated where nobody could read them. A
 * response that is merely plausible renders an empty panel, so every field the
 * page reads is asserted by name.
 */
describe('the anomaly record, from the Console', () => {
  /** Two boxes that cannot see each other, and one phone typed at both. */
  async function mergeAtTwoBoxes(): Promise<{
    phone: string;
    nickname: string;
    survivingMemberId: string;
    discardedMemberId: string;
    firstEventId: string;
    secondEventId: string;
    secondBoxId: string;
  }> {
    const one = await freshBox();
    const two = await freshBox();
    await registerKey(one);
    await registerKey(two);

    const phone = uniquePhone();
    const nickname = `Merged family ${slotCounter}`;
    const atReception = mint(one, 'member.created', { ...memberPayload(phone), nickname });
    const atCounterTwo = mint(two, 'member.created', { ...memberPayload(phone), nickname });

    expect((await push(one, [atReception])).body.applied).toBe(1);
    expect((await push(two, [atCounterTwo])).body.applied).toBe(1);

    return {
      phone,
      nickname,
      survivingMemberId: (atReception.payload as { memberId: string }).memberId,
      discardedMemberId: (atCounterTwo.payload as { memberId: string }).memberId,
      firstEventId: atReception.eventId,
      secondEventId: atCounterTwo.eventId,
      secondBoxId: two.boxId,
    };
  }

  const anomalies = (query = '', cookie = adminCookie) =>
    ctx.app.inject({ method: 'GET', url: `/ops/anomalies${query}`, headers: { cookie } });

  interface AnomalyBody {
    anomalies: Array<{
      id: string;
      boxId: string;
      boxName: string | null;
      kind: string;
      eventId: string | null;
      relatedEventId: string | null;
      detail: Record<string, unknown> | null;
      actionId: string | null;
      detectedAt: string;
    }>;
    nextCursor: string | null;
  }

  it('answers the shape the Console reads, naming both halves of a merge', async () => {
    const merged = await mergeAtTwoBoxes();

    const res = await anomalies('?limit=200');
    expect(res.statusCode).toBe(200);
    const body = res.json<AnomalyBody>();

    const row = body.anomalies.find((a) => a.eventId === merged.secondEventId);
    expect(row, 'the merge is on the page the Console reads').toBeTruthy();
    expect(row!.kind).toBe('merge');
    // The acceptance criterion: both events reachable from the one row.
    expect(row!.relatedEventId).toBe(merged.firstEventId);
    expect(row!.boxId).toBe(merged.secondBoxId);
    // A box id alone names nothing to a person on call.
    expect(row!.boxName).toBeTruthy();
    expect(typeof row!.actionId).toBe('string');
    expect(Number.isNaN(Date.parse(row!.detectedAt))).toBe(false);
    // The useful half of the detail, which is what the panel now draws.
    expect(row!.detail).toMatchObject({
      survivingMemberId: merged.survivingMemberId,
      discardedMemberId: merged.discardedMemberId,
    });

    // Newest first, because that is the order the page renders in.
    const times = body.anomalies.map((a) => Date.parse(a.detectedAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });

  /**
   * The rule the whole `/ops/*` family is held to, asserted on the RAW body
   * rather than the parsed one — the way `GET /ops/integrations` asserts it.
   * A merge is about a phone number existing at two counters, so this route is
   * the one with the most to leak: what comes back names the two member ids
   * and never the number, and never the nickname somebody typed either.
   */
  it('never hands back a phone number or a name, and a merge is about both', async () => {
    const merged = await mergeAtTwoBoxes();

    const res = await anomalies('?limit=200');
    expect(res.body).not.toContain(merged.phone);
    // The same number without its country code, which is how a box's own store
    // would have written it.
    expect(res.body).not.toContain(merged.phone.replace('+66', '0'));
    expect(res.body).not.toContain(merged.nickname);
    // And the ids that make it investigable are still there, so the case is
    // pinning redaction rather than an empty answer.
    expect(res.body).toContain(merged.survivingMemberId);
  });

  it('filters by kind and by box, and pages with a keyset cursor', async () => {
    const merged = await mergeAtTwoBoxes();

    const byKind = (await anomalies('?kind=merge&limit=200')).json<AnomalyBody>();
    expect(byKind.anomalies.length).toBeGreaterThan(0);
    expect(byKind.anomalies.every((a) => a.kind === 'merge')).toBe(true);

    const byBox = (await anomalies(`?boxId=${merged.secondBoxId}&limit=200`)).json<AnomalyBody>();
    expect(byBox.anomalies.length).toBeGreaterThan(0);
    expect(byBox.anomalies.every((a) => a.boxId === merged.secondBoxId)).toBe(true);

    // One at a time, following the cursor: no row served twice and none
    // skipped, which is the property a keyset page exists for.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const next: AnomalyBody = (
        await anomalies(`?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      ).json<AnomalyBody>();
      expect(next.anomalies).toHaveLength(1);
      seen.push(next.anomalies[0]!.id);
      cursor = next.nextCursor;
      expect(cursor).toBeTruthy();
    }
    expect(new Set(seen).size).toBe(seen.length);

    // The same rows the unpaged read gives, in the same order.
    const whole = (await anomalies('?limit=200')).json<AnomalyBody>();
    expect(whole.anomalies.slice(0, 3).map((a) => a.id)).toEqual(seen);
  });

  it('refuses a bad cursor rather than answering from the top', async () => {
    const res = await anomalies('?cursor=not-a-cursor');
    expect(res.statusCode).toBe(400);
  });

  it('is read by whoever is on call, and by nobody else', async () => {
    const reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    expect((await anomalies('', reception)).statusCode).toBe(403);
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/ops/anomalies' });
    expect(anonymous.statusCode).toBe(401);
  });
});

/**
 * The quarantine list's own contract, which the Console reads as a page rather
 * than as a bare array: `events`, a `nextCursor` and the count still open
 * across the whole table for the tab's badge.
 */
describe('the quarantine list, as the Console pages it', () => {
  interface QuarantineBody {
    events: Array<{
      id: string;
      eventId: string;
      boxId: string;
      boxName: string | null;
      journalEpoch: number;
      boxSeq: number;
      reason: string;
      status: string;
      receivedAt: string;
      resolutionNote?: string | null;
      payload?: unknown;
    }>;
    nextCursor: string | null;
    openCount: number | null;
  }

  const quarantine = (query: string, cookie = adminCookie) =>
    ctx.app.inject({ method: 'GET', url: `/ops/quarantine${query}`, headers: { cookie } });

  it('answers a page, filters by reason and box, and counts what is open overall', async () => {
    const b = await freshBox();
    await registerKey(b);
    const poison = mint(b, 'member.created', { nothing: 'useful' });
    await push(b, [poison]);

    const res = await quarantine('?status=open&limit=200');
    expect(res.statusCode).toBe(200);
    const body = res.json<QuarantineBody>();

    const row = body.events.find((e) => e.eventId === poison.eventId);
    expect(row, 'the refused event is on the page the Console reads').toBeTruthy();
    expect(row!.reason).toBe('poison');
    expect(row!.status).toBe('open');
    expect(row!.boxName).toBeTruthy();
    // Still true after the reshape: the envelope stays in the table.
    expect(res.body).not.toContain('"payload"');

    // The badge counts the whole table, not this page — the watchdog alerts on
    // the same number, and the two must not disagree.
    expect(body.openCount).toBeGreaterThanOrEqual(1);

    const byReason = (await quarantine('?reason=poison&limit=200')).json<QuarantineBody>();
    expect(byReason.events.every((e) => e.reason === 'poison')).toBe(true);
    expect(byReason.events.some((e) => e.eventId === poison.eventId)).toBe(true);

    const byBox = (await quarantine(`?boxId=${b.boxId}&limit=200`)).json<QuarantineBody>();
    expect(byBox.events.every((e) => e.boxId === b.boxId)).toBe(true);

    // One row at a time, following the cursor.
    const firstPage = (await quarantine('?limit=1')).json<QuarantineBody>();
    expect(firstPage.events).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = (
      await quarantine(`?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`)
    ).json<QuarantineBody>();
    expect(secondPage.events[0]!.id).not.toBe(firstPage.events[0]!.id);
    // The count is a property of the table, not of the page, so later pages do
    // not pay for it a second time.
    expect(secondPage.openCount).toBeNull();
  });

  it('sweeps a phone number out of the reason somebody typed for a discard', async () => {
    const b = await freshBox();
    await registerKey(b);
    const poison = mint(b, 'member.created', { nothing: 'useful' });
    await push(b, [poison]);
    const [filed] = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(eq(syncQuarantine.eventId, poison.eventId));

    const phone = uniquePhone();
    const discarded = await ctx.app.inject({
      method: 'POST',
      url: `/ops/quarantine/${filed!.id}/discard`,
      headers: { cookie: adminCookie },
      payload: { note: `Re-keyed at the till for ${phone}` },
    });
    expect(discarded.statusCode).toBe(200);

    // The note is the decision and it comes back; the number inside it does
    // not. Free text is exactly where a phone number ends up.
    const res = await quarantine('?status=discarded&limit=200');
    expect(res.body).not.toContain(phone);
    const row = res
      .json<QuarantineBody>()
      .events.find((e) => e.eventId === poison.eventId);
    expect(row!.resolutionNote).toContain('Re-keyed at the till');
    expect(row!.resolutionNote).toContain('[redacted:phone]');
  });
});

describe('the pull feed', () => {
  it('hands over the branch’s changes in order and moves the box’s cursor', async () => {
    const b = await freshBox();
    await registerKey(b);
    await push(b, [mint(b, 'member.created', memberPayload(uniquePhone()))]);

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/sync/pull?cursorSeq=0&limit=100&scopes=members',
      headers: headers(b),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { changes: Array<{ seq: number; scope: string }>; cursorSeq: number };
    expect(body.changes.length).toBeGreaterThan(0);
    expect(body.changes.every((c) => c.scope === 'members')).toBe(true);
    // Ascending, because a box applies them in order and resumes from the last.
    const seqs = body.changes.map((c) => c.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);

    const [cursor] = await ctx.db
      .select()
      .from(syncCursor)
      .where(and(eq(syncCursor.boxId, b.boxId), eq(syncCursor.journalEpoch, 1)));
    expect(cursor?.pullCursorSeq).toBe(body.cursorSeq);

    // Asking again from where it got to hands over nothing.
    const empty = await ctx.app.inject({
      method: 'GET',
      url: `/box/v1/sync/pull?cursorSeq=${body.cursorSeq}`,
      headers: headers(b),
    });
    expect(empty.json().changes).toEqual([]);
  });

  it('carries an archived member as a delete with no payload', async () => {
    const b = await freshBox();
    await registerKey(b);
    const phone = uniquePhone();
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      headers: { cookie: adminCookie },
      payload: { phone, nickname: 'To be archived' },
    });
    const memberId = created.json().member.id as string;
    await ctx.app.inject({
      method: 'DELETE',
      url: `/members/${memberId}`,
      headers: { cookie: adminCookie },
    });

    const [delta] = await ctx.db
      .select()
      .from(syncChange)
      .where(and(eq(syncChange.entityId, memberId), eq(syncChange.op, 'delete')));
    expect(delta).toBeTruthy();
    expect(delta?.payload).toBeNull();
  });
});

describe('the cache bundle', () => {
  it('carries what a counter needs with no internet, and nothing it has no use for', async () => {
    const b = await claim('virtual-1');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/cache',
      headers: headers(b),
    });
    expect(res.statusCode).toBe(200);
    const bundle = res.json() as {
      schemaVersion: number;
      bundleVersion: string;
      cursorSeq: number;
      scopes: Record<string, { items: unknown[] }>;
    };
    expect(bundle.schemaVersion).toBe(1);
    expect(Object.keys(bundle.scopes).sort()).toEqual([
      'bands',
      'bookings',
      // The published wheel, since S2-07a filled the scope. This box has a
      // booth, so a full bundle now carries one.
      'booth',
      'catalogue',
      'deny_list',
      'members',
      'receipt_series',
      'staff',
      'station_config',
    ]);

    const [first] = bundle.scopes.members!.items as Array<Record<string, unknown>>;
    expect(first).toBeTruthy();
    // What a till reads at the identify step, and no more. The staff notes,
    // the email and the tier evidence stay in the cloud.
    expect(Object.keys(first!).sort()).toEqual([
      'children',
      'id',
      'name',
      'nickname',
      'phone',
      'preferredChannel',
      'tierCode',
    ]);

    // Stations are this box's own; another box's counter is not in here.
    const stations = bundle.scopes.station_config!.items as Array<{ name: string }>;
    expect(stations.map((s) => s.name).sort()).toEqual(['Booth 1', 'Reception Till 1']);

    /**
     * The pull cursor the bundle was built at, so a box that applies it never
     * re-applies a delta the bundle already contains.
     */
    expect(typeof bundle.cursorSeq).toBe('number');
  });

  it('answers a second ask with 304 while nothing has moved', async () => {
    const b = await claim('virtual-1');
    const first = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/cache?scopes=station_config',
      headers: headers(b),
    });
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    const second = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/cache?scopes=station_config',
      headers: { ...headers(b), 'if-none-match': etag },
    });
    expect(second.statusCode).toBe(304);
  });

  it('refuses a bundle an older agent cannot read, and opens an alert about it', async () => {
    const b = await claim('virtual-1');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/cache?schemaVersion=0',
      headers: headers(b),
    });
    // A version below ours is the agent saying it cannot read what we build.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CACHE_SCHEMA_TOO_NEW');
  });

  it('never serves the staff list without the deny-list (S2-06)', async () => {
    const b = await claim('virtual-1');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/cache?scopes=staff',
      headers: headers(b),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { scopes: Record<string, { items: unknown[] }> };
    /**
     * A box that asked this way used to get a list of who may work at the
     * counter and nothing saying whose access had since been withdrawn — and
     * because a scope is only replaced by a pull that contains it, it stayed
     * that way. The two are one answer and travel together.
     */
    expect(Object.keys(body.scopes).sort()).toEqual(['deny_list', 'staff']);
    const deny = body.scopes.deny_list!.items[0] as {
      revokedAccountIds: string[];
      revokedTokenIds: string[];
    };
    expect(Array.isArray(deny.revokedAccountIds)).toBe(true);
    expect(Array.isArray(deny.revokedTokenIds)).toBe(true);

    // Asking for the deny-list alone is still exactly that: the pairing only
    // ever adds what makes the staff list safe to hold.
    const only = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/cache?scopes=deny_list',
      headers: headers(b),
    });
    expect(Object.keys((only.json() as { scopes: object }).scopes)).toEqual(['deny_list']);

    /**
     * Including with a cursor, which used to be the way round it.
     *
     * The pairing skipped anything carrying a cursor, on the reasoning that a
     * cursor continues a pull whose first page already had the deny-list —
     * never true of this scope, which mints no cursor at all, so any string
     * whatsoever bought a staff list served alone. The title of this test says
     * "never", so "never" is what it asks.
     */
    const withCursor = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/cache?scopes=staff&cursor=anything',
      headers: headers(b),
    });
    expect(withCursor.statusCode).toBe(200);
    const paired = withCursor.json() as {
      scopes: Record<string, { items: unknown[]; nextCursor: string | null }>;
    };
    expect(Object.keys(paired.scopes).sort()).toEqual(['deny_list', 'staff']);
    expect(paired.scopes.staff!.items.length).toBeGreaterThan(0);
    // And the reason the exemption was empty: this scope never issues one.
    expect(paired.scopes.staff!.nextCursor).toBeNull();
  });

  it('does not call a scope that fitted exactly a scope that was cut short (S2-06)', async () => {
    const b = await claim('virtual-1');
    /**
     * The catalogue is one composed item — a price list applied as a unit —
     * and is read with no LIMIT at all. Under the old test for truncation,
     * `items.length === limit`, asking for it with `limit=1` reported it cut
     * off at the limit, and the agent does not apply a truncated scope.
     *
     * The same arithmetic hit the deny-list, which is also exactly one item,
     * and that one has teeth: a box that does not apply the deny-list does not
     * apply the staff list either, which is offline unlock gone from that
     * counter.
     */
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/cache?scopes=catalogue&limit=1',
      headers: headers(b),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      scopes: Record<string, { items: unknown[]; nextCursor: string | null }>;
      truncated: string[];
    };
    expect(body.scopes.catalogue!.items).toHaveLength(1);
    expect(body.truncated).toEqual([]);
    expect(body.scopes.catalogue!.nextCursor).toBeNull();

    // And a scope that really was cut off still says so: `members` is read
    // with the limit, and the branch has more members than one.
    const cut = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/cache?scopes=members&limit=1',
      headers: headers(b),
    });
    const cutBody = cut.json() as { truncated: string[] };
    expect(cutBody.truncated).toEqual(['members']);
  });

  it('refuses a cursor when more than one scope is asked for', async () => {
    const b = await claim('virtual-1');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/cache?scopes=members,bands&cursor=x',
      headers: headers(b),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CACHE_CURSOR_AMBIGUOUS');
  });

  it('pages one scope, and the page is stable', async () => {
    const b = await claim('virtual-1');
    const page = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/cache?scopes=members&limit=2',
      headers: headers(b),
    });
    const body = page.json() as {
      scopes: Record<string, { items: Array<{ id: string }>; nextCursor: string | null }>;
      truncated: string[];
    };
    expect(body.scopes.members!.items).toHaveLength(2);
    expect(body.truncated).toContain('members');
    const cursor = body.scopes.members!.nextCursor;
    expect(cursor).toBeTruthy();

    const next = await ctx.app.inject({
      method: 'GET',
      url: `/box/v1/cache?scopes=members&limit=2&cursor=${cursor}`,
      headers: headers(b),
    });
    const second = next.json() as { scopes: Record<string, { items: Array<{ id: string }> }> };
    // Strictly after the cursor: no member appears on two pages.
    expect(second.scopes.members!.items.every((m) => m.id > cursor!)).toBe(true);
  });

  it('gives a box only the staff who may stand at its own counters', async () => {
    const b = await claim('virtual-1');
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/box/v1/cache?scopes=staff',
      headers: headers(b),
    });
    const staff = res.json().scopes.staff.items as Array<Record<string, unknown>>;
    /**
     * Both halves of the picker's rule, which this scope had only one of until
     * S2-06.
     *
     * A station is either `all_staff` — open to everybody at the branch — or
     * `selected_staff`, with a named list. This test used to assert that the
     * bundle held the administrator alone, because the administrator is the
     * only person the seed NAMES on a station; the branch's reception account,
     * who works Reception Till 1 all day, was cached by nobody. That is
     * invisible until the link drops and reception cannot unlock the till,
     * which is the whole purpose of the scope. So the rule now mirrors
     * `visibleToAccount` and both are here.
     */
    const [admin] = await ctx.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.phone, ADMIN.phone))
      .limit(1);
    const [reception] = await ctx.db
      .select({ id: account.id })
      .from(account)
      .where(eq(account.phone, RECEPTION.phone))
      .limit(1);
    expect(staff.map((s) => s.accountId).sort()).toEqual([admin!.id, reception!.id].sort());
    /**
     * What an offline unlock and a booth sign-in need, and nothing that
     * identifies the person to somebody holding the disk. `lastTokenAt` is
     * when THIS box last minted a shift token for them — the "seen here" half
     * of the 30-day offline sign-in, and a timestamp rather than a name
     * (S2-06). `pinHash` is argon2id over the booth PIN or null (S2-07b): a
     * booth verifies a PIN on the box, so the hash has to reach it, and it is
     * the same class of secret as the password hash beside it.
     *
     * A field added to this list is a field that lands on a Raspberry Pi in a
     * shopping mall, which is why the list is pinned and has to be edited on
     * purpose.
     */
    expect(Object.keys(staff[0]!).sort()).toEqual([
      'accountId',
      'lastTokenAt',
      'mustChangePassword',
      'passwordHash',
      'pinHash',
      'status',
    ]);
    // Null for everybody the seed gives no booth PIN, rather than absent.
    expect(staff.every((s) => 'pinHash' in s)).toBe(true);
  });
});

describe('what Health says about syncing', () => {
  it('reports the quarantine count and raises an alert the watchdog can close', async () => {
    const b = await freshBox();
    await registerKey(b);
    await push(b, [mint(b, 'member.created', { nothing: 'useful' })]);

    const health = await ctx.app.inject({
      method: 'GET',
      url: '/ops/health',
      headers: { cookie: adminCookie },
    });
    const boxes = health.json().boxes as Array<Record<string, unknown>>;
    const mine = boxes.find((x) => x.id === b.boxId);
    expect(mine?.quarantineOpen).toBeGreaterThan(0);
    expect(mine?.conditions).toContain(`sync.quarantine:${b.boxId}`);
  });

  it('reports station channels on /ready without ever failing on them', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const checks = res.json().checks as {
      stationChannels: { stations: number; connections: number; perStation: Record<string, number> };
    };
    // Zero because this file opens no channels, not because nothing can: the
    // counting is proved against a real stream in `station-session-api.test.ts`,
    // which listens on a port and watches the number go up and back down.
    expect(checks.stationChannels).toMatchObject({ stations: 0, connections: 0 });
    expect(checks.stationChannels.perStation).toEqual({});
  });
});

describe('the batch bounds', () => {
  it('refuses more events than one batch may carry', async () => {
    const b = await freshBox();
    await registerKey(b);
    const events = Array.from({ length: 201 }, () =>
      mint(b, 'member.created', memberPayload(uniquePhone())),
    );
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/sync/push',
      headers: headers(b),
      payload: { events },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('refuses an empty batch rather than recording a run for nothing', async () => {
    const b = await freshBox();
    await registerKey(b);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/sync/push',
      headers: headers(b),
      payload: { events: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('a box only ever speaks about itself', () => {
  it('cannot reach another box’s ledger, cursor or quarantine', async () => {
    const one = await freshBox();
    const two = await freshBox();
    await registerKey(one);
    await registerKey(two);

    await push(one, [mint(one, 'member.created', memberPayload(uniquePhone()))]);

    // Box two pushes an envelope whose journal position collides with box
    // one's. Nothing collides, because the journal key carries the box id.
    two.nextSeq = 1;
    const { body } = await push(two, [mint(two, 'member.created', memberPayload(uniquePhone()))]);
    expect(body).toMatchObject({ applied: 1, cursorSeq: 1 });

    const ofOne = await ctx.db.select().from(syncEvent).where(eq(syncEvent.boxId, one.boxId));
    const ofTwo = await ctx.db.select().from(syncEvent).where(eq(syncEvent.boxId, two.boxId));
    expect(ofOne.length).toBeGreaterThan(0);
    expect(ofTwo.length).toBeGreaterThan(0);
    expect(ofOne.every((r) => r.boxId === one.boxId)).toBe(true);

    // And the branch it recorded against is the box's own, from the credential.
    const [branchOfTwo] = await ctx.db.select().from(branch).where(eq(branch.id, two.branchId));
    expect(branchOfTwo).toBeTruthy();
    expect(ofTwo.every((r) => r.branchId === two.branchId)).toBe(true);
  });
});
