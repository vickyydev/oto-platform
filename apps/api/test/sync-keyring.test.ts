import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, box, boxCommand, boxSyncKey, member, syncQuarantine } from '@oto/db';
import { newId, type SyncPushResponse } from '@oto/shared';
import {
  SqlBoxStore,
  boxCredential,
  canonicalSyncBytes,
  createOutbox,
  generateSyncKeyPair,
  postgresBoxDriver,
  sealEnvelope,
  verifyCanonical,
  type BoxStore,
  type Outbox,
  type OutboxRecord,
  type PgPoolLike,
  type SyncEventEnvelope,
} from '@oto/box-agent';
import { createTestContext, teardownAll, type TestContext } from './helpers';
import { issueClaimCode } from '../src/services/box';

/**
 * S2-07a — a box that restarts with a different signing key (SCRUM-199).
 *
 * The fault this file exists for is not theoretical and does not need an
 * attacker: the cloud virtual box holds its keypair in memory, so every boot
 * presents a new public half, and until now the cloud kept one key per box. A
 * box that queued three vouchers, lost its link and was restarted came back
 * holding three events signed by a key that had already been overwritten. All
 * three were quarantined as `signature_invalid`. The park's screen said
 * nothing had synced while three families walked around with printed vouchers
 * the platform had never heard of — and the booth's own acceptance criterion
 * restarts a box on purpose, holding exactly that.
 *
 * **Why the events here are sealed by `@oto/box-agent` and pushed at the real
 * route.** A test that mints an envelope by hand proves that this api agrees
 * with that test, which is a thing three S2-05 tests proved while no Pi could
 * have synced a single event. The signature is the whole subject here, so
 * every fact below is sealed by the agent's own `sealEnvelope`, over the
 * agent's own canonical bytes, with a key the agent generated, and travels
 * through `POST /box/v1/sync/push`. Where a signature is asserted NOT to
 * verify, that is measured with the agent's verifier rather than assumed.
 */

let ctx: TestContext;
let pool: pg.Pool;

beforeAll(async () => {
  ctx = await createTestContext();
  // The box's own pool, as `sync-ledger.test.ts` keeps one: the api's handle
  // belongs to the api, and a component that closes a handle it was lent is
  // how a redeploy turns into an outage.
  pool = new pg.Pool({ connectionString: ctx.app.env.DATABASE_URL });
});

afterAll(async () => {
  await pool.end();
  await ctx.close();
  await teardownAll();
});

/** A registered box: its store, its outbox, and the key this boot signs with. */
interface RunningBox {
  boxId: string;
  branchId: string;
  operatorId: string;
  store: BoxStore;
  credential: string;
  privateKeyPem: string;
  publicKeyPem: string;
  outbox: Outbox;
  /** The Console's offline toggle, as the box experiences it. */
  setOffline(value: boolean): void;
}

let slotCounter = 0;
let phoneCounter = 0;
const uniquePhone = (): string => `+6690333${String(1000 + (phoneCounter += 1)).slice(-4)}`;

const memberFact = (phone: string, nickname = 'Keyring family') => ({
  type: 'member.created',
  payload: { memberId: newId(), phone, nickname, createdVia: 'pos' as const },
});

/** The fingerprint the ring stores, computed here rather than read from the service. */
const fingerprintOf = (pem: string): string =>
  createHash('sha256').update(pem, 'utf8').digest('hex');

/**
 * One boot of a box: mint a keypair, take a claim code, register, bind an
 * outbox over the store that was already there.
 *
 * This is what the virtual box does on Render every single deploy — its
 * credential store is `memoryCredentialStore`, so nothing survives the process
 * but the `core.box` row and, because its store IS this database, its queue.
 */
async function boot(base: {
  boxId: string;
  branchId: string;
  operatorId: string;
  store: BoxStore;
  offline?: boolean;
}): Promise<RunningBox> {
  const keys = generateSyncKeyPair();
  const { code: claimCode } = await issueClaimCode(ctx.db, base.boxId);
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/register',
    payload: {
      claimCode,
      agentVersion: '0.1.0',
      hostname: `keyring-${base.boxId.slice(0, 8)}`,
      syncPublicKey: keys.publicKeyPem,
      syncKeyAlgorithm: 'ed25519',
    },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { boxId: string; secret: string };

  const flag = { offline: base.offline ?? false };
  const running: RunningBox = {
    ...base,
    credential: boxCredential(body.boxId, body.secret),
    privateKeyPem: keys.privateKeyPem,
    publicKeyPem: keys.publicKeyPem,
    setOffline: (value: boolean) => {
      flag.offline = value;
    },
    outbox: createOutbox({
      store: base.store,
      boxId: base.boxId,
      privateKey: () => keys.privateKeyPem,
      isOffline: async () => flag.offline,
      push: async (request) => {
        const pushed = await ctx.app.inject({
          method: 'POST',
          url: '/box/v1/sync/push',
          headers: { authorization: `Bearer ${running.credential}` },
          payload: request,
        });
        return {
          status: pushed.statusCode,
          body: pushed.statusCode === 200 ? (pushed.json() as SyncPushResponse) : null,
        };
      },
    }),
  };
  return running;
}

async function startBox(): Promise<RunningBox> {
  const [seeded] = await ctx.db.select().from(box).where(eq(box.slot, 'virtual-1')).limit(1);
  if (!seeded) throw new Error('the seed did not create a virtual box');

  const boxId = newId();
  const slot = `keyring-${(slotCounter += 1)}`;
  await ctx.db.insert(box).values({
    id: boxId,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    name: `Keyring box ${slotCounter}`,
    slot,
    role: 'virtual',
    status: 'unclaimed',
  });

  const store = new SqlBoxStore({ driver: postgresBoxDriver(pool as unknown as PgPoolLike) });
  await store.init(boxId);
  return boot({ boxId, branchId: seeded.branchId, operatorId: seeded.operatorId, store });
}

/** The same box, come back up: same row, same store, same queue — new key. */
const reboot = (b: RunningBox): Promise<RunningBox> =>
  boot({ boxId: b.boxId, branchId: b.branchId, operatorId: b.operatorId, store: b.store });

/** Push a body the box itself did not assemble — for events sealed by hand. */
async function pushRaw(
  b: RunningBox,
  events: unknown[],
): Promise<SyncPushResponse & { error?: { code: string; message: string } }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/sync/push',
    headers: { authorization: `Bearer ${b.credential}` },
    payload: { events },
  });
  return res.json();
}

/** One fact, sealed by the agent under whatever key is handed in. */
const sealWith = (
  b: RunningBox,
  privateKeyPem: string,
  over: { journalEpoch?: number; boxSeq?: number } = {},
): SyncEventEnvelope =>
  sealEnvelope(
    {
      eventId: newId(),
      journalEpoch: over.journalEpoch ?? 1,
      boxSeq: over.boxSeq ?? 1,
      type: 'member.created',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      clockTrust: 'trusted',
      stationId: null,
      actorKind: 'system',
      actorAccountId: null,
      actorCredentialId: null,
      actionId: `keyring-${over.boxSeq ?? 1}`,
      payload: { memberId: newId(), phone: uniquePhone(), nickname: 'Sealed', createdVia: 'pos' },
    },
    b.boxId,
    privateKeyPem,
  );

const ringOf = (b: RunningBox) =>
  ctx.db.select().from(boxSyncKey).where(eq(boxSyncKey.boxId, b.boxId));

const openQuarantine = (b: RunningBox) =>
  ctx.db
    .select()
    .from(syncQuarantine)
    .where(and(eq(syncQuarantine.boxId, b.boxId), eq(syncQuarantine.status, 'open')));

const memberRows = (phone: string) => ctx.db.select().from(member).where(eq(member.phone, phone));

/** Run a `reset_store` the way the box does: poll for it, report it succeeded. */
async function resetStore(b: RunningBox): Promise<void> {
  const commandId = newId();
  await ctx.db.insert(boxCommand).values({ id: commandId, boxId: b.boxId, kind: 'reset_store' });
  const polled = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/commands/poll',
    headers: { authorization: `Bearer ${b.credential}` },
    payload: { max: 5 },
  });
  expect(polled.statusCode).toBe(200);
  const done = await ctx.app.inject({
    method: 'POST',
    url: `/box/v1/commands/${commandId}/result`,
    headers: { authorization: `Bearer ${b.credential}` },
    payload: { state: 'succeeded', result: { cleared: true } },
  });
  expect(done.statusCode).toBe(200);
}

// ---------------------------------------------------------------------------

describe('a box that comes back from a restart with a different key', () => {
  it('syncs the three facts it queued before the restart', async () => {
    const before = await startBox();
    const firstPublicKey = before.publicKeyPem;

    // The link goes. Three vouchers' worth of facts are minted and sealed with
    // the key this boot holds, and the flush tells the truth about why nothing
    // left the box.
    before.setOffline(true);
    const phones = [uniquePhone(), uniquePhone(), uniquePhone()];
    const queued: OutboxRecord[] = [];
    for (const phone of phones) queued.push(await before.outbox.queue(memberFact(phone)));
    expect((await before.outbox.depth()).queued).toBe(3);
    expect(await before.outbox.flush()).toEqual({ state: 'offline' });

    /**
     * The restart. The api is thrown away and rebuilt on the same database —
     * what a Render deploy does — and the box comes up with a new secret and a
     * new keypair, because it had nowhere to keep either.
     */
    await ctx.restart();
    const after = await reboot(before);
    expect(after.publicKeyPem).not.toBe(firstPublicKey);
    const [row] = await ctx.db.select().from(box).where(eq(box.id, after.boxId)).limit(1);
    expect(row?.syncPublicKey).toBe(after.publicKeyPem);

    /**
     * Measured, not assumed: the bytes still sitting in the queue do not
     * verify against the key this box is now registered with, and do verify
     * against the one it has lost. That is the exact condition that used to
     * quarantine all three, checked with the agent's own verifier so it cannot
     * be an artefact of how this test seals things.
     */
    const orphan = queued[0]?.envelope;
    if (!orphan) throw new Error('nothing was queued');
    const canonical = canonicalSyncBytes({ ...orphan, boxId: after.boxId });
    expect(verifyCanonical(canonical, orphan.sig, after.publicKeyPem)).toBe(false);
    expect(verifyCanonical(canonical, orphan.sig, firstPublicKey)).toBe(true);

    after.setOffline(false);
    const outcome = await after.outbox.flush();
    expect(outcome).toMatchObject({ state: 'pushed', applied: 3, quarantined: 0, cursorSeq: 3 });

    for (const phone of phones) expect(await memberRows(phone)).toHaveLength(1);
    expect(await openQuarantine(after)).toEqual([]);
    expect((await after.outbox.depth()).queued).toBe(0);

    // Both keys are on the ring, and the old one carries the stamp of having
    // just verified something — which is what makes a key nothing signs with
    // any more visible as one.
    const ring = await ringOf(after);
    expect(ring.map((k) => k.fingerprint).sort()).toEqual(
      [fingerprintOf(firstPublicKey), fingerprintOf(after.publicKeyPem)].sort(),
    );
    const previous = ring.find((k) => k.fingerprint === fingerprintOf(firstPublicKey));
    expect(previous?.retiredAt).toBeNull();
    expect(previous?.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it('applies one batch that two different keys signed halves of', async () => {
    const before = await startBox();
    before.setOffline(true);
    const older = [uniquePhone(), uniquePhone()];
    for (const phone of older) await before.outbox.queue(memberFact(phone, 'Before'));

    const after = await reboot(before);
    // Still offline, so these join the same queue rather than a second batch.
    after.setOffline(true);
    const newer = [uniquePhone(), uniquePhone()];
    for (const phone of newer) await after.outbox.queue(memberFact(phone, 'After'));

    after.setOffline(false);
    const outcome = await after.outbox.flush();
    // One push, four events, two signing keys: the key is chosen per event and
    // not per batch, which is the difference between this and "the newest key
    // wins".
    expect(outcome).toMatchObject({ state: 'pushed', events: 4, applied: 4, quarantined: 0 });
    for (const phone of [...older, ...newer]) expect(await memberRows(phone)).toHaveLength(1);
  });

  it('still refuses a fact signed by a keypair that was never this box’s', async () => {
    const before = await startBox();
    const after = await reboot(before);
    const impostor = generateSyncKeyPair();

    const body = await pushRaw(after, [sealWith(after, impostor.privateKeyPem)]);
    expect(body.results[0]).toMatchObject({
      result: 'quarantined',
      reason: 'signature_invalid',
    });
    // Two live keys on the ring, and neither of them is the one that signed it.
    expect((await ringOf(after)).filter((k) => !k.retiredAt)).toHaveLength(2);
  });
});

describe('the ring itself', () => {
  it('holds one row per distinct key however many times a box presents it', async () => {
    const b = await startBox();
    const beat = async (publicKey: string): Promise<void> => {
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/box/v1/heartbeat',
        headers: { authorization: `Bearer ${b.credential}` },
        payload: {
          reportedAt: new Date().toISOString(),
          agentVersion: '0.1.0',
          syncPublicKey: publicKey,
        },
      });
      expect(res.statusCode).toBe(200);
    };

    // The agent offers its key on every beat, which is several times a minute
    // for as long as the box is up.
    await beat(b.publicKeyPem);
    await beat(b.publicKeyPem);
    expect(await ringOf(b)).toHaveLength(1);

    // A key the cloud has not seen is the other thing a heartbeat can carry —
    // the only door left to a box that registered before the sync core.
    const minted = generateSyncKeyPair();
    await beat(minted.publicKeyPem);
    await beat(minted.publicKeyPem);
    const ring = await ringOf(b);
    expect(ring).toHaveLength(2);
    expect(ring.map((k) => k.fingerprint).sort()).toEqual(
      [fingerprintOf(b.publicKeyPem), fingerprintOf(minted.publicKeyPem)].sort(),
    );
  });

  it('is retired by a store reset, except the key the box is still signing with', async () => {
    const before = await startBox();
    const firstPublicKey = before.publicKeyPem;
    const after = await reboot(before);
    expect(await ringOf(after)).toHaveLength(2);

    await resetStore(after);

    const ring = await ringOf(after);
    const previous = ring.find((k) => k.fingerprint === fingerprintOf(firstPublicKey));
    const current = ring.find((k) => k.fingerprint === fingerprintOf(after.publicKeyPem));
    expect(previous?.retiredAt).toBeInstanceOf(Date);
    expect(previous?.retiredReason).toBe('store_reset');
    /**
     * The one that stays. A Pi keeps its keypair across a store reset — the
     * reset clears the store, not the credential — so retiring the key it is
     * about to sign with would refuse its next push rather than its last one.
     */
    expect(current?.retiredAt).toBeNull();

    const [audited] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, after.boxId), eq(auditLog.action, 'box.epoch_reset')))
      .limit(1);
    expect(audited?.after).toMatchObject({ retiredKeys: 1 });

    /**
     * And retirement bites. This event is stamped with the epoch the reset
     * minted, so it is not the epoch fence refusing it — it is sealed with the
     * key that reset retired, and that key is no longer one this box may have
     * signed with.
     */
    const [boxRow] = await ctx.db.select().from(box).where(eq(box.id, after.boxId)).limit(1);
    const body = await pushRaw(after, [
      sealWith(after, before.privateKeyPem, { journalEpoch: boxRow?.currentEpoch, boxSeq: 1 }),
    ]);
    expect(body.results[0]).toMatchObject({
      result: 'quarantined',
      reason: 'signature_invalid',
    });

    // The key it IS registered with still works, on the same epoch.
    const good = await pushRaw(after, [
      sealWith(after, after.privateKeyPem, { journalEpoch: boxRow?.currentEpoch, boxSeq: 2 }),
    ]);
    expect(good.results[0]).toMatchObject({ result: 'applied' });
  });

  it('refuses the whole batch, and files nothing, when a box has no key at all', async () => {
    const b = await startBox();
    // What the ring cannot paper over: nothing to verify against. Both halves
    // are cleared, because either one alone would still leave a usable key.
    await ctx.db.update(box).set({ syncPublicKey: null }).where(eq(box.id, b.boxId));
    await ctx.db
      .update(boxSyncKey)
      .set({ retiredAt: new Date(), retiredReason: 'compromised' })
      .where(eq(boxSyncKey.boxId, b.boxId));

    const body = await pushRaw(b, [sealWith(b, b.privateKeyPem)]);
    expect(body.error?.code).toBe('SYNC_KEY_UNKNOWN');
    expect(await openQuarantine(b)).toEqual([]);
  });

  it('will not verify against a key a person has retired, even the current one', async () => {
    const b = await startBox();
    // The Console gesture this stands in for is "that key is compromised": the
    // box is still registered with it, and that must stop being enough.
    await ctx.db
      .update(boxSyncKey)
      .set({ retiredAt: new Date(), retiredReason: 'compromised' })
      .where(eq(boxSyncKey.boxId, b.boxId));

    const body = await pushRaw(b, [sealWith(b, b.privateKeyPem)]);
    expect(body.error?.code).toBe('SYNC_KEY_UNKNOWN');
    // And the refusal says which of the two states this is, because presenting
    // the same key again would not lift it — a retired row is not revived.
    expect(body.error?.message).toContain('retired');
  });
});
