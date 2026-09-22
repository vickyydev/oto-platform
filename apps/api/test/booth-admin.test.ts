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
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
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
     * **`syncCache()` is called by hand here because nothing else ever calls
     * it.** `@oto/box-agent` calls it once, from `start()`, and from no timer
     * and no command; the booth's own minute timer calls `refresh()`, which
     * re-reads the box's cached bundle rather than fetching a new one. So
     * this line is not standing in for a timer — it is standing in for an
     * agent restart, which on this build is the only thing that brings a
     * published wheel to a running booth. Measured on a live stack: a wheel
     * published in the Console was still not on the box sixty seconds later,
     * and arrived the moment the agent was restarted from the Devices drawer.
     * The next test pins the reading that tells a manager which of the two
     * they are looking at.
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
   * wheel a child is playing — the box runs what it last pulled, and on this
   * build nothing on a running box pulls again (see the note in the test
   * above). So the Console must never say "published" and leave it there:
   * `GET /booths/:id/status` answers with BOTH numbers, and the Booths page
   * goes amber and names them whenever they differ.
   *
   * Without this, the ordinary failure is silent and expensive: a manager
   * changes the odds on a Friday, sees a success banner, and the booth gives
   * away the old wheel all weekend with nothing on any screen saying so.
   *
   * `runningVersion` is read off the box's last heartbeat, so each reading
   * here is taken after one — this agent's timers are never started.
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
  const PIN = '1357';

  it('sets a PIN nobody can read back, and the booth then lets that person in', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/booths/${boothId}/staff/${receptionAccountId}/pin`,
      headers: { cookie: adminCookie, 'idempotency-key': newId() },
      payload: { pin: PIN },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ accountId: receptionAccountId, hasPin: true });

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
     * Where the four digits must NOT be, each checked rather than asserted in
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

    // The idempotency store keeps a request hash for a day, and four digits
    // behind a plain SHA-256 is ten thousand guesses. The route declares
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
