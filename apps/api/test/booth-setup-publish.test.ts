import { randomInt } from 'node:crypto';
import { verify as verifyArgon2 } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  account,
  auditLog,
  boothPrize,
  boxPrintJob,
  branch,
  product,
  station,
  voucherDefinition,
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
import { renderJob } from '@oto/print';
import { PROFILES } from '@oto/print/fixtures';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { provisionVirtualBox } from '../src/services/box';

/**
 * SCRUM-400 — what the Console now sets up for a booth, carried all the way to
 * the paper: the staff session length, the park's wording for a prize, and a
 * prize that never expires.
 *
 * Built the way `booth-admin.test.ts` is, and for its reason: a setting in a
 * published bundle is worth nothing until a box runs it. So the settings go in
 * through the routes, the publish goes through the route, and then the REAL
 * box agent — the store, the booth module and the print queue a Raspberry Pi
 * runs — pulls the wheel, signs somebody in, draws, and queues the slip, which
 * is rendered by `@oto/print` to prove the words and "No expiry" are on it.
 *
 * The last block is about WHEN the words reach paper, which follows the
 * version the box is running: a type that version carries words for prints
 * its frozen title, instruction and terms, so an edit waits for the next
 * publish, while a type it carries none for — here one nobody has worded —
 * prints its terms from the cache scope, which change at the box's next
 * pull, as they always did.
 */

let ctx: TestContext;
let db: Db;
let agent: BoxAgent;
let booth: Booth;
let adminCookie: string;
let boothId: string;
let receptionAccountId: string;
let pizzaId: string;

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

  const [seededBooth] = await db.select().from(station).where(eq(station.name, 'Booth 1')).limit(1);
  boothId = seededBooth!.id;
  const [reception] = await db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.phone, RECEPTION.phone))
    .limit(1);
  receptionAccountId = reception!.id;
  const [pizza] = await db
    .select({ id: product.id })
    .from(product)
    .innerJoin(branch, eq(branch.id, product.branchId))
    .where(and(eq(product.code, 'FB-PIZZA'), eq(branch.id, seededBooth!.branchId)))
    .limit(1);
  pizzaId = pizza!.id;

  /**
   * One box, its timers never started, as `booth-admin.test.ts` builds one:
   * each pull and each press below is made by hand so what it did can be
   * asserted. `verifySecret` is the argon2 check a deployment passes.
   */
  const pool = (db as unknown as { $client: PgPoolLike }).$client;
  agent = createBoxAgent({
    apiBaseUrl: 'http://booth-setup.test',
    credentials: memoryCredentialStore(),
    hostname: 'booth-setup-test',
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
  if (!built) throw new Error('the agent built no booth module');
  booth = built;
  await booth.start();
  if (!booth.config()) throw new Error('the booth adopted no wheel');
});

afterAll(async () => {
  booth?.stop();
  agent?.stop();
  await ctx.close();
  await teardownAll();
});

async function draft(): Promise<{
  settings: { staffSessionMinutes: number | null };
  bundle: {
    settings: Record<string, unknown>;
    voucherDefinitions?: Array<Record<string, unknown>>;
  };
  publishedBundle: { settings: Record<string, unknown>; voucherDefinitions?: unknown[] } | null;
  changed: boolean;
  blockers: Array<{ code: string }>;
}> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/booths/${boothId}/draft`,
    headers: { cookie: adminCookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function settings(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/booths/${boothId}/settings`,
    headers: { cookie: adminCookie, 'idempotency-key': newId() },
    payload,
  });
}

/** Publish the draft as it stands; answers the new version number. */
async function publishNow(note: string): Promise<number> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/booths/${boothId}/publish`,
    headers: { cookie: adminCookie, 'idempotency-key': newId() },
    payload: { note },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().version.version;
}

/** Edit one voucher type through the Console's route. */
async function editType(code: string, payload: Record<string, unknown>): Promise<void> {
  const [row] = await db
    .select({ id: voucherDefinition.id })
    .from(voucherDefinition)
    .where(eq(voucherDefinition.code, code))
    .limit(1);
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/voucher-definitions/${row!.id}`,
    headers: { cookie: adminCookie, 'idempotency-key': newId() },
    payload,
  });
  expect(res.statusCode, res.body).toBe(200);
}

/** Only this prize on the wheel, with the whole of the odds; every other one switched off. */
async function wheelOf(prizeName: string): Promise<string> {
  const prizes = await db
    .select()
    .from(boothPrize)
    .where(and(eq(boothPrize.stationId, boothId), isNull(boothPrize.archivedAt)));
  const only = prizes.find((p) => p.nameEn === prizeName);
  expect(only, `the seeded wheel has no ${prizeName}`).toBeTruthy();
  for (const p of prizes) {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/booths/${boothId}/prizes/${p.id}`,
      headers: { cookie: adminCookie, 'idempotency-key': newId() },
      payload: p.id === only!.id ? { weightBp: 10_000, active: true } : { active: false },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  return only!.id;
}

/** Spin once at the box and read back the slip it queued, as the renderer receives it. */
async function spinForSlip(): Promise<{ prizeId: string; prizeLine: string; terms: string[] }> {
  const spun = await booth.spin({ idempotencyKey: newId() });
  const jobs = await db
    .select({ job: boxPrintJob.job })
    .from(boxPrintJob)
    .where(eq(boxPrintJob.boxId, agent.state.boxId!))
    .orderBy(desc(boxPrintJob.queuedAt))
    .limit(10);
  const slip = jobs
    .map((j) => j.job as { data: { voucherCode: string; prizeLine: string; terms: string[] } })
    .find((j) => j.data.voucherCode === spun.voucherCode);
  expect(slip, 'the spin queued no slip').toBeTruthy();
  return { prizeId: spun.prizeId!, prizeLine: slip!.data.prizeLine, terms: slip!.data.terms };
}

describe('a booth nobody has set up publishes what it always did (SCRUM-400)', () => {
  it('adds no session length and no wording to the bundle, so the seeded wheel is unchanged', async () => {
    const d = await draft();
    expect(d.settings.staffSessionMinutes).toBeNull();
    expect('staffSessionMinutes' in d.bundle.settings).toBe(false);
    expect('voucherDefinitions' in d.bundle).toBe(false);
    expect(d.changed, 'the seeded wheel should still match version 1 byte for byte').toBe(false);
  });
});

describe('the session length, from the Console to the box (SCRUM-400)', () => {
  it('saves ten hours on the booth, audits it, and puts it in the draft bundle', async () => {
    const res = await settings({ staffSessionMinutes: 600 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().settings.staffSessionMinutes).toBe(600);

    const d = await draft();
    expect(d.settings.staffSessionMinutes).toBe(600);
    expect(d.bundle.settings.staffSessionMinutes).toBe(600);
    expect(d.changed).toBe(true);

    const [entry] = await db
      .select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'booth_settings.update'), eq(auditLog.entityId, boothId)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(entry, 'a settings change with no audit row').toBeTruthy();
    expect(entry!.before).toMatchObject({ staffSessionMinutes: null });
    expect(entry!.after).toMatchObject({ staffSessionMinutes: 600 });
  });

  it('refuses nothing and more than a day', async () => {
    for (const minutes of [0, -60, 1_441, 90.5]) {
      const res = await settings({ staffSessionMinutes: minutes });
      expect(res.statusCode, `${minutes}: ${res.body}`).toBe(400);
    }
    expect((await draft()).settings.staffSessionMinutes, 'a refusal changed the booth').toBe(600);
  });
});

describe('a prize that never expires, worded by the park, published and printed (SCRUM-400)', () => {
  let pizzaPrizeId: string;

  it('publishes a wheel whose prize never expires, with the words in the bundle', async () => {
    const [definition] = await db
      .select()
      .from(voucherDefinition)
      .where(eq(voucherDefinition.code, 'spin-kids-pizza'))
      .limit(1);
    const saved = await ctx.app.inject({
      method: 'PATCH',
      url: `/voucher-definitions/${definition!.id}`,
      headers: { cookie: adminCookie, 'idempotency-key': newId() },
      payload: {
        productId: pizzaId,
        titleEn: 'FREE KIDS PIZZA',
        titleTh: 'พิซซ่าเด็กฟรี',
        instructionEn: 'Show this slip at the OTO restaurant for one free kids pizza.',
        instructionTh: 'แสดงสลิปนี้ที่ร้านอาหาร OTO รับพิซซ่าเด็กฟรี 1 ถาด',
        termsEn: 'Valid at any Oto Play Park. One use only.',
        expiryDays: null,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    // Kids Pizza carries the whole wheel, so the press below is known; its own
    // expiry stays empty, so the definition's "never" is what it takes.
    const prizes = await db
      .select()
      .from(boothPrize)
      .where(and(eq(boothPrize.stationId, boothId), isNull(boothPrize.archivedAt)));
    const pizzaPrize = prizes.find((p) => p.nameEn === 'Kids Pizza');
    expect(pizzaPrize, 'the seeded wheel has no Kids Pizza').toBeTruthy();
    expect(pizzaPrize!.expiryDays).toBeNull();
    pizzaPrizeId = pizzaPrize!.id;
    for (const p of prizes) {
      const res = await ctx.app.inject({
        method: 'PATCH',
        url: `/booths/${boothId}/prizes/${p.id}`,
        headers: { cookie: adminCookie, 'idempotency-key': newId() },
        payload: p.id === pizzaPrizeId ? { weightBp: 10_000, active: true } : { active: false },
      });
      expect(res.statusCode, res.body).toBe(200);
    }

    const d = await draft();
    expect(d.blockers, 'a prize that never expires must not block the publish').toEqual([]);
    // The terms travel with the title and the instruction: the box prints the
    // published ones, so an edit to them waits for the next publish (below).
    expect(d.bundle.voucherDefinitions).toEqual([
      {
        id: definition!.id,
        titleEn: 'FREE KIDS PIZZA',
        titleTh: 'พิซซ่าเด็กฟรี',
        instructionEn: 'Show this slip at the OTO restaurant for one free kids pizza.',
        instructionTh: 'แสดงสลิปนี้ที่ร้านอาหาร OTO รับพิซซ่าเด็กฟรี 1 ถาด',
        termsEn: 'Valid at any Oto Play Park. One use only.',
        termsTh: definition!.termsTh,
      },
    ]);

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/booths/${boothId}/publish`,
      headers: { cookie: adminCookie, 'idempotency-key': newId() },
      payload: { note: 'SCRUM-400: wording, never, ten hours' },
    });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json().version.version).toBe(2);

    const after = await draft();
    expect(after.changed).toBe(false);
    expect(after.publishedBundle!.settings.staffSessionMinutes).toBe(600);
    expect(after.publishedBundle!.voucherDefinitions).toHaveLength(1);
  });

  it('the box runs it: a PIN sign-in lasts ten hours, and the slip carries the words and no expiry', async () => {
    await agent.syncCache();
    const running = booth.config();
    expect(running!.version, 'the box is not on the version just published').toBe(2);
    expect(running!.bundle.settings.staffSessionMinutes).toBe(600);

    // A PIN of this test's own, set through the Console's route and hashed
    // there; the box verifies the typed digits against that hash.
    const pin = await ctx.app.inject({
      method: 'PUT',
      url: `/booths/${boothId}/staff/${receptionAccountId}/pin`,
      headers: { cookie: adminCookie },
      payload: { pin: '48260' },
    });
    expect(pin.statusCode, pin.body).toBe(200);
    await agent.syncCache();
    const signedIn = await booth.signIn({ pin: '48260' });
    expect(signedIn.ok, 'the booth refused the PIN the Console set').toBe(true);
    const session = await booth.staffSession();
    expect(Date.parse(session!.expiresAt!) - Date.parse(session!.signedInAt)).toBe(600 * 60_000);

    const spun = await booth.spin({ idempotencyKey: newId() });
    expect(spun.prizeId).toBe(pizzaPrizeId);
    expect(spun.expiresAt, 'a prize that never expires was given an expiry').toBeNull();

    const [job] = await db
      .select()
      .from(boxPrintJob)
      .where(eq(boxPrintJob.boxId, agent.state.boxId!))
      .orderBy(desc(boxPrintJob.queuedAt))
      .limit(1);
    const paper = job!.job as {
      kind: 'booth_voucher';
      data: {
        voucherCode: string;
        prizeLine: string;
        prizeLineThai: string | null;
        redemptionLine: string;
        expiresAt: string | null;
        terms: string[];
      };
    };
    expect(paper.data.voucherCode).toBe(spun.voucherCode);
    expect(paper.data.prizeLine).toBe('FREE KIDS PIZZA');
    expect(paper.data.prizeLineThai).toBe('พิซซ่าเด็กฟรี');
    expect(paper.data.redemptionLine).toBe(
      'Show this slip at the OTO restaurant for one free kids pizza.\nแสดงสลิปนี้ที่ร้านอาหาร OTO รับพิซซ่าเด็กฟรี 1 ถาด',
    );
    expect(paper.data.expiresAt).toBeNull();
    expect(paper.data.terms).toContain('Valid at any Oto Play Park. One use only.');

    // And the renderer, which is what puts dots on paper, says "No expiry".
    const rendered = renderJob(paper as never, { device: PROFILES.escpos576! });
    const words = JSON.stringify(rendered.document);
    expect(words).toContain('No expiry');
    expect(words).toContain('FREE KIDS PIZZA');
    expect(words).toContain('รับพิซซ่าเด็กฟรี 1 ถาด');
    expect(rendered.overflow, rendered.overflow.join('; ')).toEqual([]);

    await booth.signOut();
  });
});

describe('when the slip’s words reach paper (SCRUM-400)', () => {
  const published = 'Valid at any Oto Play Park. One use only.';
  const edited = 'Valid at any Oto Play Park. Not with any other offer.';

  it('an edit to a worded type’s terms alone waits for the next publish: until then the box prints the published terms', async () => {
    await editType('spin-kids-pizza', { termsEn: edited });

    // The terms are in the wheel, so the booth now has something to publish.
    const pending = await draft();
    expect(pending.changed, 'a terms edit on a worded type is an edit to the wheel').toBe(true);
    expect(pending.bundle.voucherDefinitions?.[0]).toMatchObject({ termsEn: edited });
    expect(pending.publishedBundle!.voucherDefinitions?.[0]).toMatchObject({ termsEn: published });

    // The box pulls — the cache scope beside the wheel already carries the
    // edit — and is still on version 2, whose terms are the ones it prints.
    await agent.syncCache();
    expect(booth.config()!.version).toBe(2);
    const before = await spinForSlip();
    expect(before.prizeLine).toBe('FREE KIDS PIZZA');
    expect(before.terms).toContain(published);
    expect(before.terms, 'an unpublished edit reached paper').not.toContain(edited);

    // Published, the edit is on the next slip.
    expect(await publishNow('SCRUM-400: the terms edit')).toBe(3);
    await agent.syncCache();
    expect(booth.config()!.version).toBe(3);
    const after = await spinForSlip();
    expect(after.terms).toContain(edited);
    expect(after.terms).not.toContain(published);
  });

  it('a type nobody has worded is not in the wheel: its terms change at the box’s next pull, with no publish, as before', async () => {
    const hundredId = await wheelOf('100 THB Voucher');
    expect(await publishNow('SCRUM-400: the 100 THB voucher alone')).toBe(4);
    await agent.syncCache();
    expect(booth.config()!.version).toBe(4);

    const seeded = await spinForSlip();
    expect(seeded.prizeId).toBe(hundredId);
    expect(seeded.prizeLine, 'no wording: the prize’s own name').toBe('100 THB Voucher');
    expect(seeded.terms[0]).toBe('Valid at Oto Play Park, Central Floresta. One use only. No cash value.');

    const unworded = 'Edited on the voucher type, never published.';
    await editType('spin-voucher-100', { termsEn: unworded });
    expect((await draft()).changed, 'a type with no wording is not part of the wheel').toBe(false);

    await agent.syncCache();
    expect(booth.config()!.version).toBe(4);
    const pulled = await spinForSlip();
    expect(pulled.prizeId).toBe(hundredId);
    expect(pulled.terms[0]).toBe(unworded);
  });
});
