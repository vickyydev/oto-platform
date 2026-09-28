import { randomInt } from 'node:crypto';
import { verify as verifyArgon2 } from '@node-rs/argon2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  account,
  auditLog,
  boothConfigVersion,
  boothPrize,
  boothSettings,
  boothStaffAssignment,
  boxCommand,
  branch,
  credential,
  idempotencyKey,
  operator,
  station,
  type Db,
} from '@oto/db';
import { newId } from '@oto/shared';
import {
  createBoxAgent,
  memoryCredentialStore,
  postgresBoxDriver,
  SqlBoxStore,
  type AgentFetch,
  type Booth,
  type BoxAgent,
  type PgPoolLike,
} from '@oto/box-agent';
import {
  ADMIN,
  BRANCH_MANAGER,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { listBooths } from '../src/services/booth-admin';
import { provisionVirtualBox } from '../src/services/box';

/**
 * S2-07b — the booth admin control panel, and the booth that then runs what it
 * published.
 *
 * **The point of this file is the seam.** A published version is worth nothing
 * until a box runs it, and a test that asserts a row landed in
 * `booth_config_version` proves only that an INSERT works. So the publish here
 * goes through the real route, with a real session and a real permission
 * check, and then the REAL box agent pulls its cache, adopts the version and
 * draws from it — the same agent, store and booth module a Raspberry Pi runs,
 * with `app.inject` standing in for the wire and the printer simulator for a
 * printer. When a weight is set to 100 % and published, the next press has to
 * land on that prize; nothing short of that shows the two halves are connected.
 *
 * The refusals are tested through the route for the same reason: a manager
 * publishing a wheel whose weights add to 99 must be stopped by the thing they
 * actually press, and told which field to fix.
 */

let ctx: TestContext;
let db: Db;
let agent: BoxAgent;
let booth: Booth;
let adminCookie: string;
let receptionCookie: string;
let boothId: string;
let receptionAccountId: string;

/** The seeded prize list, to put back between tests. */
let seededPrizes: Array<typeof boothPrize.$inferSelect>;

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

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  const [seededBooth] = await db.select().from(station).where(eq(station.name, 'Booth 1')).limit(1);
  boothId = seededBooth!.id;

  const [reception] = await db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.phone, RECEPTION.phone))
    .limit(1);
  receptionAccountId = reception!.id;

  seededPrizes = await db.select().from(boothPrize).where(eq(boothPrize.stationId, boothId));

  /**
   * One box, its timers never started, exactly as `booth-sync.test.ts` builds
   * one: a second agent against the same box would rotate its signing key, and
   * each step here is called by hand so that what a single pull did can be
   * asserted.
   *
   * `verifySecret` is what the api passes its own virtual box
   * (`startVirtualBox`), so the PIN test below exercises the same verification
   * path a deployment does rather than one invented for the test.
   */
  const pool = (db as unknown as { $client: PgPoolLike }).$client;
  agent = createBoxAgent({
    apiBaseUrl: 'http://booth-admin.test',
    credentials: memoryCredentialStore(),
    hostname: 'booth-admin-test',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(db, ctx.app.log))?.claimCode ?? null,
    store: new SqlBoxStore({ driver: postgresBoxDriver(pool) }),
    booth: {
      randomIndex: (max) => randomInt(max),
      verifySecret: (hash, secret) => verifyArgon2(hash, secret),
    },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  await agent.syncCache();
  const built = agent.booth();
  if (!built) throw new Error('the agent built no booth module — no spin can be taken on this box');
  booth = built;
  await booth.start();
  if (!booth.config()) throw new Error('the booth adopted no wheel: the cache scope reached it empty');
});

afterAll(async () => {
  booth?.stop();
  agent?.stop();
  await ctx.close();
  await teardownAll();
});

/**
 * Put the draft back to the seeded wheel.
 *
 * Written straight to the rows rather than through the routes: this is not the
 * behaviour under test, and a restore that itself went through the editor
 * would fail for the reason the test just proved.
 */
afterEach(async () => {
  for (const prize of seededPrizes) {
    await db
      .update(boothPrize)
      .set({
        weightBp: prize.weightBp,
        active: prize.active,
        voucherDefinitionId: prize.voucherDefinitionId,
        expiryDays: prize.expiryDays,
        dailyCap: prize.dailyCap,
        sortOrder: prize.sortOrder,
        archivedAt: prize.archivedAt,
      })
      .where(eq(boothPrize.id, prize.id));
  }
  await db.update(boothSettings).set({ eligibility: 'none' }).where(eq(boothSettings.stationId, boothId));
});

const asAdmin = (extra: Record<string, string> = {}): Record<string, string> => ({
  cookie: adminCookie,
  ...extra,
});

/** Every live prize of the booth, in slice order, as the editor shows them. */
async function livePrizes(): Promise<Array<typeof boothPrize.$inferSelect>> {
  return db
    .select()
    .from(boothPrize)
    .where(and(eq(boothPrize.stationId, boothId), isNull(boothPrize.archivedAt)))
    .orderBy(boothPrize.sortOrder);
}

/** One prize carries the whole wheel; the rest are switched off. */
async function forceOnePrize(prizeId: string): Promise<void> {
  for (const prize of await livePrizes()) {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/prizes/${prize.id}`,
      headers: asAdmin(),
      payload: prize.id === prizeId ? { weightBp: 10_000, active: true } : { active: false },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
}

/**
 * The publish route's answer as a test reads it: the minted version, or the
 * refusal and its blockers. Either half is absent, which is what the `!`s
 * below are saying — the status code above each one has already settled which
 * of the two arrived.
 */
interface PublishAnswer {
  version?: { version: number; bundleHash: string; publishedByAccountId: string | null };
  prizes?: number;
  activePrizes?: number;
  error?: {
    code: string;
    message: string;
    details?: {
      blockers?: Array<{ field: string; code: string; message: string }>;
      bundleHash?: string;
      version?: number;
    };
  };
}

async function publish(
  payload: Record<string, unknown> = {},
  cookie = adminCookie,
): Promise<{ statusCode: number; body: PublishAnswer }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/booths/${boothId}/publish`,
    headers: { cookie },
    payload,
  });
  return { statusCode: res.statusCode, body: res.json() };
}

describe('the draft, and what a second manager sees (S2-07b)', () => {
  it('shows the bundle that would be published, its hash, and that nothing has changed', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/booths/${boothId}/draft`,
      headers: asAdmin(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const draft = res.json();

    expect(draft.blockers, 'the seeded wheel should be publishable as it stands').toEqual([]);
    expect(draft.bundle.prizes).toHaveLength(6);
    expect(
      draft.bundle.prizes.filter((p: { active: boolean }) => p.active).reduce(
        (sum: number, p: { weightBp: number }) => sum + p.weightBp,
        0,
      ),
    ).toBe(10_000);
    // Version 1 is the seed's, and the draft matches it — so there is nothing
    // to publish, which is what `changed: false` has to mean.
    expect(draft.published.version).toBe(1);
    expect(draft.bundleHash).toBe(draft.published.bundleHash);
    expect(draft.changed).toBe(false);

    /**
     * The published document beside the draft, so the Console can say WHAT
     * changed rather than only that something did. With only the two hashes,
     * "the ฿200 voucher went from 14.5 % to 20 %" cannot be computed
     * anywhere.
     */
    expect(draft.publishedBundle.prizes.map((p: { id: string }) => p.id)).toEqual(
      draft.bundle.prizes.map((p: { id: string }) => p.id),
    );
  });

  it('shows a colleague’s edit as part of the draft, because there is only one', async () => {
    const [first] = await livePrizes();
    const edit = await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/prizes/${first!.id}`,
      headers: { cookie: adminCookie },
      payload: { wheelLabel: '100 ฿ !' },
    });
    expect(edit.statusCode, edit.body).toBe(200);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/booths/${boothId}/draft`,
      headers: asAdmin(),
    });
    const draft = res.json();
    expect(draft.changed, 'an edit nobody has published should show as a change').toBe(true);
    expect(draft.bundleHash).not.toBe(draft.published.bundleHash);
    expect(draft.lastEditedAt).toBeTruthy();
    // Restore, since `wheelLabel` is not in the afterEach's list.
    await db.update(boothPrize).set({ wheelLabel: first!.wheelLabel }).where(eq(boothPrize.id, first!.id));
  });
});

describe('a wheel that would be wrong is refused before it is published (S2-07b)', () => {
  it('names the field when the active weights do not add up to 10000', async () => {
    const [first] = await livePrizes();
    await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/prizes/${first!.id}`,
      headers: asAdmin(),
      // 2350 → 2250 leaves the active list at 9900 basis points: 99 %.
      payload: { weightBp: 2250 },
    });

    const { statusCode, body } = await publish();
    expect(statusCode).toBe(400);
    expect(body.error!.code).toBe('BOOTH_PUBLISH_INVALID');
    const blockers = body.error!.details!.blockers as Array<{ field: string; code: string; message: string }>;
    const weights = blockers.find((b) => b.code === 'BOOTH_WEIGHTS_NOT_WHOLE');
    expect(weights, `no weight blocker in ${JSON.stringify(blockers)}`).toBeTruthy();
    expect(weights!.field).toBe('prizes[].weightBp');
    expect(weights!.message).toContain('9900');
    expect(weights!.message).toContain('99%');

    // And nothing was minted: a refused publish does not spend a version.
    const [top] = await db
      .select({ version: boothConfigVersion.version })
      .from(boothConfigVersion)
      .where(eq(boothConfigVersion.stationId, boothId))
      .orderBy(desc(boothConfigVersion.version))
      .limit(1);
    expect(top!.version).toBe(1);
  });

  it('refuses 101 % as readily as 99 %', async () => {
    const [first] = await livePrizes();
    await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/prizes/${first!.id}`,
      headers: asAdmin(),
      payload: { weightBp: 2450 },
    });
    const { statusCode, body } = await publish();
    expect(statusCode).toBe(400);
    expect(
      (body.error!.details!.blockers as Array<{ message: string }>).map((b) => b.message).join(' '),
    ).toContain('10100');
  });

  it('refuses a wheel with every prize switched off — the box would refuse the press', async () => {
    for (const prize of await livePrizes()) {
      await ctx.app.inject({
        method: 'PATCH',
        url: `/booths/${boothId}/prizes/${prize.id}`,
        headers: asAdmin(),
        payload: { active: false },
      });
    }
    const { statusCode, body } = await publish();
    expect(statusCode).toBe(400);
    const codes = (body.error!.details!.blockers as Array<{ code: string }>).map((b) => b.code);
    expect(codes).toContain('BOOTH_NO_ACTIVE_PRIZE');
  });

  it('refuses an active prize with no voucher definition, and names the prize', async () => {
    const [first] = await livePrizes();
    await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/prizes/${first!.id}`,
      headers: asAdmin(),
      payload: { voucherDefinitionId: null },
    });
    const { statusCode, body } = await publish();
    expect(statusCode).toBe(400);
    const blocker = (body.error!.details!.blockers as Array<{ field: string; code: string }>).find(
      (b) => b.code === 'BOOTH_PRIZE_NO_DEFINITION',
    );
    expect(blocker).toBeTruthy();
    expect(blocker!.field).toBe(`prizes[${first!.nameEn}].voucherDefinitionId`);
  });

  it('refuses spin eligibility band with the message the ticket asks for', async () => {
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/settings`,
      headers: asAdmin(),
      payload: { eligibility: 'band' },
    });
    // It can be SAVED — the mode is built, it is publishing it that is refused.
    expect(patched.statusCode, patched.body).toBe(200);

    const { statusCode, body } = await publish();
    expect(statusCode).toBe(400);
    const blocker = (body.error!.details!.blockers as Array<{ field: string; message: string }>).find(
      (b) => b.field === 'eligibility',
    );
    expect(blocker).toBeTruthy();
    expect(blocker!.message).toContain('not available until the park booth exists');
  });

  it('refuses Enter as the button key, because the badge scanner types it', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/settings`,
      headers: asAdmin(),
      payload: { buttonKey: 'Enter' },
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * H2 (closing audit of 25 September 2026) — the booth's own station rather
   * than its wheel. A booth whose prefix is empty or not two letters or digits
   * (`null`, `PI1`) cannot mint a voucher code, so its box refuses every
   * press; a lower-case one (`b1`) would print, but is refused too, for the
   * reason in the note on `BOOTH_CODE_PREFIX` in services/booth-admin.ts.
   * Neither may publish as though the booth were ready.
   *
   * The prefix is written straight to the row, as on a booth saved before the
   * station write refused such a prefix (`fleet-api.test.ts` covers that
   * refusal), and put back whatever happens.
   */
  it('refuses a booth whose station has no valid code prefix, and names the field', async () => {
    try {
      for (const codePrefix of [null, 'PI1', 'b1']) {
        await db.update(station).set({ codePrefix }).where(eq(station.id, boothId));

        const res = await ctx.app.inject({
          method: 'GET',
          url: `/booths/${boothId}/draft`,
          headers: asAdmin(),
        });
        expect(res.statusCode, res.body).toBe(200);
        const blockers = res.json().blockers as Array<{ field: string; code: string; message: string }>;
        // The seeded wheel has nothing else to fix, so this is the only blocker.
        expect(blockers.map((b) => b.code), String(codePrefix)).toEqual(['BOOTH_CODE_PREFIX_INVALID']);
        expect(blockers[0]!.field).toBe('codePrefix');
        expect(blockers[0]!.message).toContain('must be exactly 2 capital letters or digits');

        const { statusCode, body } = await publish();
        expect(statusCode, String(codePrefix)).toBe(400);
        expect(body.error!.code).toBe('BOOTH_PUBLISH_INVALID');
        expect(body.error!.details!.blockers!.map((b) => b.code)).toEqual(['BOOTH_CODE_PREFIX_INVALID']);
      }
    } finally {
      await db.update(station).set({ codePrefix: 'B1' }).where(eq(station.id, boothId));
    }

    // Nothing was minted, and with the prefix back the draft has nothing to fix.
    const [top] = await db
      .select({ version: boothConfigVersion.version })
      .from(boothConfigVersion)
      .where(eq(boothConfigVersion.stationId, boothId))
      .orderBy(desc(boothConfigVersion.version))
      .limit(1);
    expect(top!.version).toBe(1);
    const restored = await ctx.app.inject({
      method: 'GET',
      url: `/booths/${boothId}/draft`,
      headers: asAdmin(),
    });
    expect(restored.json().blockers).toEqual([]);
  });
});

describe('publishing, and the box that then runs it (S2-07b)', () => {
  it('mints version 2 and the real box draws the forced prize from it', async () => {
    const prizes = await livePrizes();
    const forced = prizes[3]!; // the 200 THB voucher — 14.5 % on the seeded wheel
    await forceOnePrize(forced.id);

    const before = booth.config();
    expect(before!.version).toBe(1);

    const { statusCode, body } = await publish({ note: 'Forcing the 200 for the demo' });
    expect(statusCode, JSON.stringify(body)).toBe(200);
    expect(body.version!.version).toBe(2);
    expect(body.version!.publishedByAccountId).toBeTruthy();
    expect(body.activePrizes).toBe(1);

    /**
     * The seam. Everything above this line is the cloud talking to itself.
     *
     * The agent pulls its cache and the booth adopts the newer version whole.
     *
     * **`syncCache()` is called by hand here because this agent's timers are
     * never started.** On a running box the same call happens on the cache
     * refresh timer (once a minute, a 304 when nothing moved) and on the
     * `config_apply` command; the booth's own minute timer calls `refresh()`,
     * which re-reads the box's cached bundle rather than fetching a new one.
     * Until SCRUM-275 there was no such timer and no such command, and this
     * line stood in for an agent restart — measured on a live stack: a wheel
     * published in the Console was still not on the box sixty seconds later,
     * and arrived the moment the agent was restarted. The next two tests pin
     * the reading a manager decides on, and the command that carries it.
     */
    await agent.syncCache();
    /**
     * A second refresh, which must be a no-op.
     *
     * `syncCache` applies the scope and the agent hands the booth its new
     * wheel as part of that, so the booth is already on version 2 here — and
     * the timer the booth runs (about once a minute, only between spins)
     * calls exactly this. It returning false is the assertion: a version
     * already adopted is not adopted twice, and nothing goes backwards.
     */
    expect(await booth.refresh()).toBe(false);

    const running = booth.config();
    expect(running!.version, 'the box is not running the version that was just published').toBe(2);
    expect(running!.bundle.prizes).toHaveLength(6);
    expect(running!.bundle.prizes.filter((p) => p.active)).toHaveLength(1);

    const spun = await booth.spin({ idempotencyKey: newId() });
    expect(spun.configVersion, 'the box drew under a version other than the published one').toBe(2);
    expect(spun.prizeId, 'the forced prize is not what the wheel gave').toBe(forced.id);
    // The page asserts this before it animates: the slot it stops on must be
    // the prize the box drew (`SpinResponse`).
    expect(running!.bundle.prizes[spun.prizeIndex]!.id).toBe(forced.id);
    expect(spun.voucherCode, 'a prize was drawn and no code was minted').toBeTruthy();

    // And the spin is filed against the version it drew under, which is what
    // makes "what were the odds when my daughter won" answerable.
    await agent.outbox()!.flush();
    const [row] = await db
      .select({ configVersionId: boothConfigVersion.id, version: boothConfigVersion.version })
      .from(boothConfigVersion)
      .where(and(eq(boothConfigVersion.stationId, boothId), eq(boothConfigVersion.version, 2)))
      .limit(1);
    expect(row).toBeTruthy();

    const [entry] = await db
      .select({ action: auditLog.action, after: auditLog.after })
      .from(auditLog)
      .where(eq(auditLog.action, 'booth_config.publish'))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(entry, 'a publish was filed with no audit row').toBeTruthy();
    expect((entry!.after as { version: number }).version).toBe(2);
  });

  /**
   * The reading a manager decides on, pinned.
   *
   * Publishing writes a row in the cloud. It does not, by itself, change the
   * wheel a child is playing — the box runs what it last pulled, and until
   * its next pull (a minute at most on a running box; never, on a box whose
   * link is down) the two differ. So the Console must never say "published"
   * and leave it there: `GET /booths/:id/status` answers with BOTH numbers,
   * and the Booths page goes amber and names them whenever they differ.
   *
   * Without this, the ordinary failure is silent and expensive: a manager
   * changes the odds on a Friday, sees a success banner, and the booth gives
   * away the old wheel all weekend with nothing on any screen saying so.
   *
   * `runningVersion` is read off the box's last heartbeat, so each reading
   * here is taken after one — this agent's timers are never started, which
   * is what holds the box behind long enough to read it.
   */
  it('reports the booth as behind while a published version has not reached it', async () => {
    await agent.heartbeat();
    const runningBefore = booth.config()!.version;

    const [first] = await livePrizes();
    await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/prizes/${first!.id}`,
      headers: asAdmin(),
      payload: { wheelLabel: 'not pulled yet' },
    });
    const minted = await publish({ note: 'a version the box has not been given' });
    expect(minted.statusCode, JSON.stringify(minted.body)).toBe(200);
    const publishedVersion = minted.body.version!.version;
    expect(publishedVersion).toBeGreaterThan(runningBefore);

    // Nothing pulled the cache, so the box is still on the older wheel.
    await agent.heartbeat();
    expect(booth.config()!.version, 'a publish alone moved the box').toBe(runningBefore);

    const behind = await ctx.app.inject({
      method: 'GET',
      url: `/booths/${boothId}/status`,
      headers: asAdmin(),
    });
    expect(behind.statusCode, behind.body).toBe(200);
    const seen = behind.json();
    expect(seen.config.publishedVersion).toBe(publishedVersion);
    expect(
      seen.config.runningVersion,
      'the status route claimed the booth was running a version it has never been given',
    ).toBe(runningBefore);

    // And it catches up only once the cache is pulled — which is what an
    // agent restart does, and what the Devices drawer's Restart agent causes.
    await agent.syncCache();
    await agent.heartbeat();
    expect(booth.config()!.version).toBe(publishedVersion);
    const caught = await ctx.app.inject({
      method: 'GET',
      url: `/booths/${boothId}/status`,
      headers: asAdmin(),
    });
    expect(caught.json().config.runningVersion).toBe(publishedVersion);

    await db.update(boothPrize).set({ wheelLabel: first!.wheelLabel }).where(eq(boothPrize.id, first!.id));
  });

  /**
   * The seam SCRUM-275 closes, from the Console's side.
   *
   * Measured before the fix: "Apply config" in the Devices drawer reported
   * success and the box stayed on the old wheel, because `config_apply` pulled
   * the config bundle (stations, devices) and the wheel travels in the cache.
   * Only "Restart agent" carried it. Now the command pulls both — the same
   * two calls the refresh timer makes — so the button means what it says.
   *
   * The second half pins the cost of the timer: a pull with nothing new is a
   * 304, applies no scope, and leaves the wheel exactly where it was.
   */
  it('the Apply config command carries a published wheel to the box, and a pull with nothing new is a 304', async () => {
    const boxId = agent.state.boxId!;
    const runningBefore = booth.config()!.version;

    const [first] = await livePrizes();
    await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/prizes/${first!.id}`,
      headers: asAdmin(),
      payload: { wheelLabel: 'carried by the command' },
    });
    const minted = await publish({ note: 'to be applied from the Devices drawer' });
    expect(minted.statusCode, JSON.stringify(minted.body)).toBe(200);
    const publishedVersion = minted.body.version!.version;
    expect(publishedVersion).toBeGreaterThan(runningBefore);
    expect(booth.config()!.version, 'a publish alone moved the box').toBe(runningBefore);

    const queued = await ctx.app.inject({
      method: 'POST',
      url: `/boxes/${boxId}/commands`,
      headers: asAdmin({ 'x-oto-action-id': `apply-config-v${publishedVersion}` }),
      payload: { kind: 'config_apply', payload: {} },
    });
    expect(queued.statusCode, queued.body).toBe(200);
    const actionId = queued.json().actionId as string;

    // The box's own poll, called by hand because its timers are not running.
    expect(await agent.runPendingCommands()).toBe(1);
    expect(
      booth.config()!.version,
      'Apply config succeeded and the box is still on the old wheel',
    ).toBe(publishedVersion);

    const history = await ctx.app.inject({
      method: 'GET',
      url: `/boxes/${boxId}/commands`,
      headers: asAdmin(),
    });
    const ran = (history.json().commands as Array<Record<string, unknown>>).find(
      (c) => c.actionId === actionId,
    );
    expect(ran).toMatchObject({ kind: 'config_apply', state: 'succeeded' });
    expect((ran!.result as { cacheScopes: string[] }).cacheScopes).toContain('booth');

    // Nothing has changed since: the next tick is a 304 and applies nothing.
    expect(await agent.syncCache()).toEqual([]);
    expect(booth.config()!.version).toBe(publishedVersion);

    await db.update(boothPrize).set({ wheelLabel: first!.wheelLabel }).where(eq(boothPrize.id, first!.id));
  });

  it('never edits a version: version 1 is what it always was', async () => {
    const [v1] = await db
      .select()
      .from(boothConfigVersion)
      .where(and(eq(boothConfigVersion.stationId, boothId), eq(boothConfigVersion.version, 1)))
      .limit(1);
    const bundle = v1!.bundle as { prizes: Array<{ active: boolean; weightBp: number }> };
    // The publish above switched five prizes off in the DRAFT. Version 1 still
    // has its six live slices and its original odds.
    expect(bundle.prizes.filter((p) => p.active)).toHaveLength(6);
    expect(bundle.prizes.reduce((sum, p) => sum + p.weightBp, 0)).toBe(10_000);
  });

  it('refuses a second publish that would change nothing', async () => {
    const [first] = await livePrizes();
    await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/prizes/${first!.id}`,
      headers: asAdmin(),
      payload: { wheelLabel: '100 baht' },
    });
    const minted = await publish({ note: 'renamed a slice' });
    expect(minted.statusCode, JSON.stringify(minted.body)).toBe(200);

    // Pressing Publish twice is the ordinary accident, and a version spent on
    // nothing is a booth told to re-apply a wheel it is already running.
    const again = await publish({ note: 'again' });
    expect(again.statusCode).toBe(409);
    expect(again.body.error!.code).toBe('BOOTH_PUBLISH_UNCHANGED');

    await db.update(boothPrize).set({ wheelLabel: first!.wheelLabel }).where(eq(boothPrize.id, first!.id));
  });

  it('refuses a publish whose draft has moved since the manager looked at it', async () => {
    const [first] = await livePrizes();
    await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/prizes/${first!.id}`,
      headers: asAdmin(),
      payload: { costSatang: 12_345 },
    });
    const stale = 'a'.repeat(64);
    const { statusCode, body } = await publish({ expectedBundleHash: stale });
    expect(statusCode).toBe(409);
    expect(body.error!.code).toBe('BOOTH_PUBLISH_STALE');
    expect(body.error!.details!.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    await db.update(boothPrize).set({ costSatang: first!.costSatang }).where(eq(boothPrize.id, first!.id));
  });

  it('refuses a publish from somebody who may only work the counter', async () => {
    const [first] = await livePrizes();
    const edit = await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/prizes/${first!.id}`,
      headers: { cookie: receptionCookie },
      payload: { weightBp: 1 },
    });
    expect(edit.statusCode, 'reception edited a prize list').toBe(403);
    const { statusCode } = await publish({}, receptionCookie);
    expect(statusCode, 'reception published a wheel').toBe(403);
  });
});

describe('spins per day, from the Console to the red button (SCRUM-257)', () => {
  /** Change the booth itself, as the settings panel does. */
  async function setSpinCap(dailySpinCap: number | null): Promise<void> {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/settings`,
      headers: asAdmin(),
      payload: { dailySpinCap },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().settings.dailySpinCap).toBe(dailySpinCap);
  }

  const consoleStatus = async (): Promise<{
    today: { spins: number; spinCap: number | null; businessDate: string };
  }> => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/booths/${boothId}/status`,
      headers: asAdmin(),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };

  /**
   * The whole of the ticket in one test, because the ticket is a seam: a
   * manager sets a number in the Console, and the box under a television in a
   * mall has to refuse the button when that number is reached.
   *
   * **The cap is set relative to what this booth has already given away
   * today.** The tests above spin, the box counts its own spins per trading
   * day, and a cap of 2 in a file whose earlier tests already pressed the
   * button three times would be reached before this test began. So the day's
   * count is read first and the cap set two above it, which is what makes the
   * refusal below a statement about the cap rather than about test order.
   */
  it('a cap set in the Console refuses the press on the box once it is reached', async () => {
    // Everything the box has drawn so far, filed. `today.spins` counts rows
    // that have ARRIVED, and the box refuses on its own count — a flush is
    // what makes the two the same number.
    await agent.outbox()!.flush();
    const start = (await consoleStatus()).today.spins;

    await setSpinCap(start + 2);
    const minted = await publish({ note: 'two spins a day' });
    expect(minted.statusCode, JSON.stringify(minted.body)).toBe(200);
    await agent.syncCache();
    expect(booth.config()!.bundle.settings.dailySpinCap).toBe(start + 2);

    // The two the booth is still owed.
    const first = await booth.spin({ idempotencyKey: newId() });
    expect(first.voucherCode, 'the first press drew nothing').toBeTruthy();
    const second = await booth.spin({ idempotencyKey: newId() });
    expect(second.voucherCode).toBeTruthy();

    /**
     * And the one after it is refused — with a code of its own, because the
     * television says "come back tomorrow" to this and "please call staff" to
     * everything else, and only one of those is worth a family's evening.
     */
    await expect(booth.spin({ idempotencyKey: newId() })).rejects.toMatchObject({
      code: 'daily_spin_cap_reached',
    });

    // Nothing was minted by the refusal: two spins and two vouchers reach the
    // cloud, not three.
    await agent.outbox()!.flush();
    const after = await consoleStatus();
    expect(after.today.spins).toBe(start + 2);
    // The Console reads the day against the cap rather than on its own, which
    // is the difference between "38 spins" and "38 of 40, no more today".
    expect(after.today.spinCap).toBe(start + 2);
  });

  /**
   * And the cap taken off again, which is the state nearly every booth runs
   * in. It also puts this file back: the published wheel keeps its cap until
   * somebody publishes one without it, so the restore has to be a publish.
   */
  it('a null cap is no limit, and the booth plays on once it is published', async () => {
    await setSpinCap(null);
    const minted = await publish({ note: 'no daily limit' });
    expect(minted.statusCode, JSON.stringify(minted.body)).toBe(200);
    await agent.syncCache();
    expect(booth.config()!.bundle.settings.dailySpinCap).toBeNull();

    const spun = await booth.spin({ idempotencyKey: newId() });
    expect(spun.voucherCode, 'the booth is still refusing after the cap was removed').toBeTruthy();

    await agent.outbox()!.flush();
    expect((await consoleStatus()).today.spinCap).toBeNull();
  });
});

describe('the prize order is the wheel (S2-07b)', () => {
  it('takes the whole list and refuses a partial one', async () => {
    const prizes = await livePrizes();
    const reversed = [...prizes].reverse().map((p) => p.id);

    const partial = await ctx.app.inject({
      method: 'PUT',
      url: `/booths/${boothId}/prize-order`,
      headers: asAdmin(),
      payload: { prizeIds: reversed.slice(0, 3) },
    });
    expect(partial.statusCode).toBe(400);
    expect(partial.json().error.code).toBe('BOOTH_ORDER_INCOMPLETE');

    const whole = await ctx.app.inject({
      method: 'PUT',
      url: `/booths/${boothId}/prize-order`,
      headers: asAdmin(),
      payload: { prizeIds: reversed },
    });
    expect(whole.statusCode, whole.body).toBe(200);
    expect((await livePrizes()).map((p) => p.id)).toEqual(reversed);
  });
});

describe('taking a slice off the wheel (S2-07b)', () => {
  /**
   * The console sends this DELETE without an idempotency key — `api.delete`
   * takes no options — so a double press or a retry after a dropped response
   * arrives at a row that is already archived. It must not be reported as a
   * failure: the manager pressed Archive once and it worked.
   */
  it('answers a second archive with the same slice, and records the archive once', async () => {
    const victim = (await livePrizes())[0]!;

    const first = await ctx.app.inject({
      method: 'DELETE',
      url: `/booths/${boothId}/prizes/${victim.id}`,
      headers: asAdmin(),
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().prize.archivedAt).not.toBeNull();

    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/booths/${boothId}/prizes/${victim.id}`,
      headers: asAdmin(),
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().prize.id).toBe(victim.id);
    // The same answer, not a second archive with a later timestamp.
    expect(again.json().prize.archivedAt).toBe(first.json().prize.archivedAt);

    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'booth_prize.archive'), eq(auditLog.entityId, victim.id)));
    expect(rows).toHaveLength(1);

    expect((await livePrizes()).map((p) => p.id)).not.toContain(victim.id);
  });

  /** Editing one that is off the wheel is still refused — only DELETE relents. */
  it('still refuses to edit an archived slice', async () => {
    const victim = (await livePrizes())[0]!;
    await ctx.app.inject({
      method: 'DELETE',
      url: `/booths/${boothId}/prizes/${victim.id}`,
      headers: asAdmin(),
    });

    const edit = await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/prizes/${victim.id}`,
      headers: asAdmin(),
      payload: { weightBp: 5000 },
    });
    expect(edit.statusCode).toBe(404);
    expect(edit.json().error.code).toBe('BOOTH_PRIZE_NOT_FOUND');
  });

  it('still 404s an id that was never a prize of this booth', async () => {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/booths/${boothId}/prizes/${newId()}`,
      headers: asAdmin(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('BOOTH_PRIZE_NOT_FOUND');
  });
});

describe('voucher definitions (S2-07b)', () => {
  it('refuses a definition whose value is not filled in, and accepts a complete one', async () => {
    const incomplete = await ctx.app.inject({
      method: 'POST',
      url: '/voucher-definitions',
      headers: asAdmin(),
      payload: { code: 'spin-test-amount', nameEn: 'Test amount', kind: 'discount', valueType: 'amount' },
    });
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json().error.code).toBe('VOUCHER_VALUE_MISSING');

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/voucher-definitions',
      headers: asAdmin(),
      payload: {
        code: 'spin-test-amount',
        nameEn: 'Test amount',
        kind: 'discount',
        valueType: 'amount',
        valueSatang: 5_000,
        expiryDays: 14,
        costSatang: 5_000,
        termsEn: 'One use only.',
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    const duplicate = await ctx.app.inject({
      method: 'POST',
      url: '/voucher-definitions',
      headers: asAdmin(),
      payload: {
        code: 'spin-test-amount',
        nameEn: 'Another',
        kind: 'discount',
        valueType: 'amount',
        valueSatang: 100,
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('VOUCHER_DEFINITION_CODE_TAKEN');
  });

  it('refuses to publish a prize pointing at a definition somebody switched off', async () => {
    const prizes = await livePrizes();
    const prize = prizes[0]!;
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/voucher-definitions/${prize.voucherDefinitionId}`,
      headers: asAdmin(),
      payload: { active: false },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const { statusCode, body } = await publish();
    expect(statusCode).toBe(400);
    expect(
      (body.error!.details!.blockers as Array<{ code: string }>).map((b) => b.code),
    ).toContain('BOOTH_PRIZE_DEFINITION_INACTIVE');

    await ctx.app.inject({
      method: 'PATCH',
      url: `/voucher-definitions/${prize.voucherDefinitionId}`,
      headers: asAdmin(),
      payload: { active: true },
    });
  });
});

/**
 * The PIN, end to end and by the same rule as the publish above: setting one
 * is worth nothing until somebody can sign in at a booth with it.
 *
 * Run last, and in this order on purpose — the box's sign-in throttle counts
 * failures per booth, so the refusal goes after the success rather than
 * locking it out.
 */
describe('the booth PIN (S2-07b)', () => {
  const PIN = '13570';

  it('sets a PIN nobody can read back, and the booth then lets that person in', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/booths/${boothId}/staff/${receptionAccountId}/pin`,
      headers: { cookie: adminCookie, 'idempotency-key': newId() },
      payload: { pin: PIN },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ accountId: receptionAccountId, hasPin: true, pinExpiresAt: null });

    const [row] = await db
      .select()
      .from(credential)
      .where(
        and(
          eq(credential.accountId, receptionAccountId),
          eq(credential.kind, 'pin'),
          eq(credential.active, true),
        ),
      )
      .limit(1);
    expect(row, 'no live PIN credential was written').toBeTruthy();
    expect(row!.secretHash.startsWith('$argon2'), 'the PIN was not hashed with argon2id').toBe(true);
    expect(await verifyArgon2(row!.secretHash, PIN)).toBe(true);

    /**
     * Where the five digits must NOT be, each checked rather than asserted in
     * a comment.
     */
    const [entry] = await db
      .select({ after: auditLog.after, before: auditLog.before })
      .from(auditLog)
      .where(eq(auditLog.action, 'booth_pin.set'))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(entry, 'a PIN was set with no audit row').toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain(PIN);
    expect(JSON.stringify(entry)).not.toContain(row!.secretHash);

    // The idempotency store keeps a request hash for a day, and five digits
    // behind a plain SHA-256 is one hundred thousand guesses. The route declares
    // `secretResponse`, so no key is claimed at all.
    const keys = await db.select().from(idempotencyKey);
    const pinKeys = keys.filter((k) => k.requestHash && k.responseBody !== null && JSON.stringify(k).includes('/pin'));
    expect(pinKeys, 'the PIN request entered the idempotency store').toEqual([]);

    // And never on the box command queue, whose payloads are stored and shown
    // on a Console screen.
    const commands = await db.select().from(boxCommand);
    expect(JSON.stringify(commands)).not.toContain(PIN);

    // The seam: the hash reaches the box on the staff cache scope, and the
    // booth verifies the typed digits against it.
    await agent.syncCache();
    const signedIn = await booth.signIn({ pin: PIN });
    expect(signedIn.ok, 'the booth refused a PIN the Console had just set').toBe(true);
    expect(signedIn.accountId).toBe(receptionAccountId);
  });

  it('attributes the spin that follows to the person who signed in', async () => {
    const spun = await booth.spin({ idempotencyKey: newId() });
    expect(spun.staffAccountId, 'the spin was recorded unattributed').toBe(receptionAccountId);
  });

  it('refuses the same PIN once it is withdrawn and the box has pulled', async () => {
    await booth.signOut();
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/booths/${boothId}/staff/${receptionAccountId}/pin?reason=left%20the%20booth`,
      headers: asAdmin(),
    });
    expect(res.statusCode, res.body).toBe(200);

    const [row] = await db
      .select()
      .from(credential)
      .where(and(eq(credential.accountId, receptionAccountId), eq(credential.kind, 'pin')))
      .orderBy(desc(credential.createdAt))
      .limit(1);
    // Revoked with a reason, never deleted: "whose PIN was withdrawn, and
    // when" has to stay answerable.
    expect(row!.active).toBe(false);
    expect(row!.revokedAt).toBeTruthy();
    expect(row!.revokedReason).toBe('left the booth');

    await agent.syncCache();
    const refused = await booth.signIn({ pin: PIN });
    expect(refused.ok, 'a withdrawn PIN still opened the booth after a pull').toBe(false);
  });
});

/**
 * SCRUM-267 — the booth list is the one `/branches/:branchId/…` route that took
 * the branch id on trust.
 *
 * Its twelve siblings refuse another operator's branch id with a 404 and this
 * one answered 200 with that operator's booth, to the administrator of a park
 * that does not own it. The guard cannot catch it: an operator-scoped grant
 * matches on the operator alone and has no way to know which operator a branch
 * id belongs to, so the branch has to be LOADED. Driven as the operator
 * administrator, because they are the caller the guard lets through — a branch
 * manager was already refused by scope and proves nothing about this.
 */
describe('the booth list stops at the operator (SCRUM-267)', () => {
  let ownBranchId: string;
  let rivalBranchId: string;
  let rivalBoothId: string;

  beforeAll(async () => {
    const [own] = await db
      .select({ branchId: station.branchId })
      .from(station)
      .where(eq(station.id, boothId))
      .limit(1);
    ownBranchId = own!.branchId;

    // A park belonging to somebody else entirely, with a booth of its own —
    // written straight in, because no route of this operator's could make it.
    const [rivalOperator] = await db
      .insert(operator)
      .values({ id: newId(), name: 'Rival Park Co' })
      .returning();
    const [rivalBranch] = await db
      .insert(branch)
      .values({
        id: newId(),
        operatorId: rivalOperator!.id,
        name: 'Rival Park, Patong',
        code: 'rival-patong',
      })
      .returning();
    rivalBranchId = rivalBranch!.id;
    const [rivalBooth] = await db
      .insert(station)
      .values({
        id: newId(),
        operatorId: rivalOperator!.id,
        branchId: rivalBranchId,
        name: 'Rival Booth',
        kind: 'booth',
      })
      .returning();
    rivalBoothId = rivalBooth!.id;
  });

  it('lists the booths of a branch the caller does own', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${ownBranchId}/booths`,
      headers: asAdmin(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().booths.map((b: { id: string }) => b.id)).toContain(boothId);
  });

  it("refuses another operator's branch id, and hands back none of its booths", async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${rivalBranchId}/booths`,
      headers: asAdmin(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('BRANCH_NOT_FOUND');
    expect(res.body).not.toContain(rivalBoothId);
    expect(res.body).not.toContain('Rival Booth');
  });

  /**
   * The second fence, asked of the service directly: the route's load is what
   * refuses today, and this is what a future caller that forgets one gets.
   */
  it('answers a caller who asks the service for that branch under the wrong operator', async () => {
    const [ownOperator] = await db
      .select({ operatorId: station.operatorId })
      .from(station)
      .where(eq(station.id, boothId))
      .limit(1);
    const mine = await listBooths(db, ownOperator!.operatorId, ownBranchId);
    expect(mine.booths.map((b) => b.id)).toContain(boothId);

    const theirs = await listBooths(db, ownOperator!.operatorId, rivalBranchId);
    expect(theirs.booths).toEqual([]);
  });
});

/**
 * M9 (closing audit of 25 September 2026) — who a branch manager may put on
 * his booth, and whose booth PIN he may set or withdraw.
 *
 * A PIN is the person's and signs them in at every booth they are on, so each
 * check is about the PERSON: they work at the booth's branch, the caller holds
 * every role they hold, and a PIN is withdrawn only through a booth whose list
 * names them. Driven as Central Floresta's manager, who holds
 * `admin:booth:staff_assign` there and nowhere else: the operator
 * administrator holds every permission, so only a manager can meet the
 * ROLE_NOT_DOMINATED refusal. The person's branch and the booth's list
 * refuse the administrator too — the first test has the branch rule refuse
 * both callers.
 *
 * Last in the file on purpose. It changes who is on Booth 1 and reception's
 * PIN, and nothing after it reads either. It never signs in at the box.
 */
describe('booth staff and PINs stop at the person’s branch and role (M9)', () => {
  let managerCookie: string;
  let chalongCookie: string;
  let adminId: string;
  let managerId: string;
  let chalongManagerId: string;
  let chalongBoothId: string;
  /** The PIN Chalong's manager gives himself at his own booth, drawn for this run. */
  let chalongPin: string;

  /** Four digits drawn at run time, so no PIN is written into this file. */
  const freshPin = (): string => String(randomInt(10_000, 100_000));

  const accountIdOf = async (phone: string): Promise<string> => {
    const [row] = await db.select({ id: account.id }).from(account).where(eq(account.phone, phone)).limit(1);
    return row!.id;
  };

  const put = (url: string, cookie: string, payload?: Record<string, unknown>) =>
    ctx.app.inject({ method: 'PUT', url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const del = (url: string, cookie: string) => ctx.app.inject({ method: 'DELETE', url, headers: { cookie } });

  /** The person's live PIN credential, or undefined. */
  async function livePin(accountId: string): Promise<typeof credential.$inferSelect | undefined> {
    const [row] = await db
      .select()
      .from(credential)
      .where(and(eq(credential.accountId, accountId), eq(credential.kind, 'pin'), eq(credential.active, true)))
      .limit(1);
    return row;
  }

  async function onBooth(stationId: string, accountId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: boothStaffAssignment.id })
      .from(boothStaffAssignment)
      .where(and(eq(boothStaffAssignment.stationId, stationId), eq(boothStaffAssignment.accountId, accountId)))
      .limit(1);
    return row !== undefined;
  }

  beforeAll(async () => {
    managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
    chalongCookie = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    adminId = await accountIdOf(ADMIN.phone);
    managerId = await accountIdOf(BRANCH_MANAGER.phone);
    chalongManagerId = await accountIdOf(CHALONG_MANAGER.phone);

    /**
     * A booth at Robinson Chalong, with no box. Like `booth-pairing.test.ts`'s
     * second booth, it is passed over by the in-process booth this file runs.
     */
    const [booth1] = await db.select().from(station).where(eq(station.id, boothId)).limit(1);
    chalongBoothId = newId();
    await db.insert(station).values({
      id: chalongBoothId,
      operatorId: booth1!.operatorId,
      branchId: await branchIdByCode(db, CHALONG_BRANCH_CODE),
      name: 'Chalong Booth',
      kind: 'booth',
      codePrefix: 'C1',
      accessScope: 'selected_staff',
    });

    // Chalong's manager puts himself on his own booth, with a PIN of his own.
    const added = await put(`/booths/${chalongBoothId}/staff/${chalongManagerId}`, chalongCookie);
    expect(added.statusCode, added.body).toBe(200);
    chalongPin = freshPin();
    const pinned = await put(`/booths/${chalongBoothId}/staff/${chalongManagerId}/pin`, chalongCookie, {
      pin: chalongPin,
    });
    expect(pinned.statusCode, pinned.body).toBe(200);
  });

  it('refuses to add somebody from another park with STAFF_NOT_AT_BRANCH, and still adds the operator administrator', async () => {
    for (const cookie of [managerCookie, adminCookie]) {
      const res = await put(`/booths/${boothId}/staff/${chalongManagerId}`, cookie);
      // The rule is the person's branch, so the administrator is refused too.
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe('STAFF_NOT_AT_BRANCH');
    }
    expect(await onBooth(boothId, chalongManagerId), 'somebody from another park is on Booth 1').toBe(false);
    const added = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(eq(auditLog.action, 'booth_staff.add'));
    expect(
      added
        .map((r) => r.after as { stationId: string; accountId: string })
        .filter((a) => a.stationId === boothId && a.accountId === chalongManagerId),
      'a refused addition left an audit row',
    ).toEqual([]);

    // An operator-wide administrator is staff of every branch (the owner's
    // ruling in `lib/staff-scope.ts`), so the manager may still add them.
    const admin = await put(`/booths/${boothId}/staff/${adminId}`, managerCookie);
    expect(admin.statusCode, admin.body).toBe(200);
    expect(await onBooth(boothId, adminId)).toBe(true);
  });

  it('refuses to set or withdraw the PIN of somebody above the caller with 403 ROLE_NOT_DOMINATED', async () => {
    const set = await put(`/booths/${boothId}/staff/${adminId}/pin`, managerCookie, { pin: freshPin() });
    expect(set.statusCode, set.body).toBe(403);
    expect(set.json().error.code).toBe('ROLE_NOT_DOMINATED');
    expect(await livePin(adminId), 'the manager gave the administrator a PIN').toBeUndefined();

    // Refused before the "no PIN to withdraw" answer, so it says nothing about
    // whether the administrator has one.
    const withdrawn = await del(`/booths/${boothId}/staff/${adminId}/pin`, managerCookie);
    expect(withdrawn.statusCode, withdrawn.body).toBe(403);
    expect(withdrawn.json().error.code).toBe('ROLE_NOT_DOMINATED');

    const removed = await del(`/booths/${boothId}/staff/${adminId}`, managerCookie);
    expect(removed.statusCode, removed.body).toBe(200);
  });

  it('refuses to set or withdraw the PIN of somebody at another park with 403, and leaves their PIN alone', async () => {
    const before = await livePin(chalongManagerId);
    expect(before, 'the Chalong manager set no PIN of his own').toBeTruthy();

    /**
     * On Booth 1's list by a row written before the rule, so the booth-list
     * check is met and only the person's branch can refuse. Without that row
     * the withdrawal must be refused as well: the audit's probe withdrew the
     * PIN of a colleague who was on no booth of the caller's.
     */
    const planted = newId();
    await db.insert(boothStaffAssignment).values({
      id: planted,
      stationId: boothId,
      accountId: chalongManagerId,
      addedBy: adminId,
    });
    try {
      const set = await put(`/booths/${boothId}/staff/${chalongManagerId}/pin`, managerCookie, {
        pin: freshPin(),
      });
      expect(set.statusCode, set.body).toBe(403);
      expect(set.json().error.code).toBe('OUT_OF_BRANCH_SCOPE');

      const withdrawn = await del(`/booths/${boothId}/staff/${chalongManagerId}/pin`, managerCookie);
      expect(withdrawn.statusCode, withdrawn.body).toBe(403);
      expect(withdrawn.json().error.code).toBe('OUT_OF_BRANCH_SCOPE');
    } finally {
      await db.delete(boothStaffAssignment).where(eq(boothStaffAssignment.id, planted));
    }

    const offList = await del(`/booths/${boothId}/staff/${chalongManagerId}/pin`, managerCookie);
    expect(offList.statusCode, offList.body).toBe(403);
    expect(offList.json().error.code).toBe('OUT_OF_BRANCH_SCOPE');

    // The same credential, still live, still the digits he chose.
    const after = await livePin(chalongManagerId);
    expect(after?.id).toBe(before!.id);
    expect(await verifyArgon2(after!.secretHash, chalongPin)).toBe(true);
    const byManager = await db
      .select({ action: auditLog.action, after: auditLog.after })
      .from(auditLog)
      .where(eq(auditLog.actorAccountId, managerId));
    expect(
      byManager.filter(
        (r) =>
          r.action.startsWith('booth_pin.') &&
          (r.after as { accountId?: string } | null)?.accountId === chalongManagerId,
      ),
      'a refused PIN write left an audit row',
    ).toEqual([]);
  });

  it('refuses to withdraw the PIN of somebody not on this booth, and withdraws it once they are back on', async () => {
    // The ordinary case still works: the manager sets his own reception's PIN.
    const set = await put(`/booths/${boothId}/staff/${receptionAccountId}/pin`, managerCookie, {
      pin: freshPin(),
    });
    expect(set.statusCode, set.body).toBe(200);
    const pin = await livePin(receptionAccountId);
    expect(pin, 'no PIN was set').toBeTruthy();

    const off = await del(`/booths/${boothId}/staff/${receptionAccountId}`, managerCookie);
    expect(off.statusCode, off.body).toBe(200);

    const refused = await del(`/booths/${boothId}/staff/${receptionAccountId}/pin`, managerCookie);
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json().error.code).toBe('BOOTH_STAFF_NOT_FOUND');
    expect((await livePin(receptionAccountId))?.id, 'a refused withdrawal revoked the PIN').toBe(pin!.id);

    // Back on the booth, the same withdrawal goes through.
    const back = await put(`/booths/${boothId}/staff/${receptionAccountId}`, managerCookie);
    expect(back.statusCode, back.body).toBe(200);
    const withdrawn = await del(`/booths/${boothId}/staff/${receptionAccountId}/pin`, managerCookie);
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(await livePin(receptionAccountId)).toBeUndefined();
  });
});
