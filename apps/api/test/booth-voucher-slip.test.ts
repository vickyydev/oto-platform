import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq, sql } from 'drizzle-orm';
import { auditLog, boothPrize, boothSettings, station, voucherDefinition, type Db } from '@oto/db';
import {
  ADMIN,
  BRANCH_MANAGER,
  CHALONG_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { boothCacheItems } from '../src/services/sync-booth';
import type { BoxAuth } from '../src/services/box';

/**
 * SCRUM-471 — the booth's own voucher slip, through the api.
 *
 * What the Console's "Voucher slip" card relies on: the five choices save
 * through the settings route and come back in the draft; over-long text is
 * refused with the field named; an untouched booth's draft is still the wheel
 * it published (the round's first invariant, seen as the hash); a publish
 * carries the choices in the bundle the box pulls; and the live preview draws
 * a sample slip for somebody who may read the booth and nobody else.
 */

let ctx: TestContext;
let db: Db;
let adminCookie: string;
let boothId: string;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Height of a PNG, read off its IHDR — enough to see a row come and go. */
function pngHeight(body: Buffer): number {
  return body.readUInt32BE(20);
}

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [seeded] = await db.select().from(station).where(eq(station.name, 'Booth 1')).limit(1);
  boothId = seeded!.id;
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

afterEach(async () => {
  await db
    .update(boothSettings)
    .set({
      voucherShowLogo: true,
      voucherHeaderText: null,
      voucherFooterText: null,
      voucherShowStaff: true,
      voucherShowTerms: true,
    })
    .where(eq(boothSettings.stationId, boothId));
});

async function patchSettings(payload: Record<string, unknown>, cookie = adminCookie) {
  return ctx.app.inject({
    method: 'PATCH',
    url: `/booths/${boothId}/settings`,
    headers: { cookie },
    payload,
  });
}

async function draft(): Promise<{
  settings: Record<string, unknown>;
  bundle: { settings: Record<string, unknown>; voucherDefinitions?: Array<{ id: string; legacyQrPayload?: string }> };
  bundleHash: string;
  changed: boolean;
  publishedBundle: { settings: Record<string, unknown> } | null;
}> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/booths/${boothId}/draft`,
    headers: { cookie: adminCookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

it('publishes a prize QR exactly and clearing it changes the next draft', async () => {
  const [prize] = await db.select().from(boothPrize).where(eq(boothPrize.stationId, boothId)).limit(1);
  const id = prize!.voucherDefinitionId!;
  const legacyQrPayload = 'https://example.invalid/Claim?Prize=100&Code=Ab%2Bc';
  await db.update(voucherDefinition).set({ legacyQrPayload }).where(eq(voucherDefinition.id, id));
  try {
    const configured = await draft();
    expect(configured.bundle.voucherDefinitions?.find((d) => d.id === id)?.legacyQrPayload).toBe(legacyQrPayload);
    await db.update(voucherDefinition).set({ legacyQrPayload: null }).where(eq(voucherDefinition.id, id));
    const cleared = await draft();
    expect(cleared.bundleHash).not.toBe(configured.bundleHash);
    expect(cleared.bundle.voucherDefinitions?.find((d) => d.id === id)?.legacyQrPayload).toBeUndefined();
  } finally {
    await db.update(voucherDefinition).set({ legacyQrPayload: null }).where(eq(voucherDefinition.id, id));
  }
});

async function preview(payload: Record<string, unknown>, cookie: string | null = adminCookie) {
  return ctx.app.inject({
    method: 'POST',
    url: `/booths/${boothId}/voucher-preview.png`,
    headers: cookie ? { cookie } : {},
    payload,
  });
}

describe('the voucher slip on the booth settings (SCRUM-471)', () => {
  it('shows today’s slip on an untouched booth, and publishes nothing new for it', async () => {
    const before = await draft();
    expect(before.settings).toMatchObject({
      voucherShowLogo: true,
      voucherHeaderText: null,
      voucherFooterText: null,
      voucherShowStaff: true,
      voucherShowTerms: true,
    });
    for (const key of Object.keys(before.bundle.settings)) {
      expect(key.startsWith('voucher'), `the bundle carries ${key} for an untouched booth`).toBe(false);
    }
    // The seeded wheel is the published one, and the new columns did not move its hash.
    expect(before.changed).toBe(false);
  });

  it('saves the five choices, returns them, and puts only the changed ones in the bundle', async () => {
    const res = await patchSettings({
      voucherShowLogo: false,
      voucherHeaderText: '  Lucky Wheel · spin to win  ',
      voucherFooterText: 'Thank you for playing!',
      voucherShowStaff: false,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().settings).toMatchObject({
      voucherShowLogo: false,
      voucherHeaderText: 'Lucky Wheel · spin to win',
      voucherFooterText: 'Thank you for playing!',
      voucherShowStaff: false,
      voucherShowTerms: true,
    });

    const after = await draft();
    expect(after.settings).toMatchObject({
      voucherShowLogo: false,
      voucherHeaderText: 'Lucky Wheel · spin to win',
      voucherFooterText: 'Thank you for playing!',
      voucherShowStaff: false,
      voucherShowTerms: true,
    });
    expect(after.bundle.settings).toMatchObject({
      voucherShowLogo: false,
      voucherHeaderText: 'Lucky Wheel · spin to win',
      voucherFooterText: 'Thank you for playing!',
      voucherShowStaff: false,
    });
    expect(after.bundle.settings).not.toHaveProperty('voucherShowTerms');
    expect(after.changed, 'a slip change is a change to publish').toBe(true);

    const [row] = await db
      .select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(eq(auditLog.action, 'booth_settings.update'))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(row?.after).toMatchObject({ voucherShowLogo: false, voucherFooterText: 'Thank you for playing!' });
    expect(row?.before).toMatchObject({ voucherShowLogo: true, voucherFooterText: null });
  });

  it('saves blank text as no line, which takes it back out of the bundle', async () => {
    expect((await patchSettings({ voucherFooterText: 'Bye' })).statusCode).toBe(200);
    const res = await patchSettings({ voucherFooterText: '   ', voucherHeaderText: '' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().settings.voucherFooterText).toBeNull();
    expect(res.json().settings.voucherHeaderText).toBeNull();
    const after = await draft();
    expect(after.bundle.settings).not.toHaveProperty('voucherFooterText');
    expect(after.changed).toBe(false);
  });

  it('refuses a header over 200 characters and a footer over 400, and saves neither', async () => {
    const header = await patchSettings({ voucherHeaderText: 'h'.repeat(201) });
    expect(header.statusCode).toBe(400);
    expect(header.json().error.code).toBe('VALIDATION');
    expect(header.body).toContain('voucherHeaderText');

    const footer = await patchSettings({ voucherFooterText: 'f'.repeat(401) });
    expect(footer.statusCode).toBe(400);
    expect(footer.body).toContain('voucherFooterText');

    // At the limit is fine.
    const atLimit = await patchSettings({ voucherHeaderText: 'h'.repeat(200), voucherFooterText: 'f'.repeat(400) });
    expect(atLimit.statusCode, atLimit.body).toBe(200);

    const refusedOnly = await patchSettings({ voucherShowLogo: 'no' });
    expect(refusedOnly.statusCode).toBe(400);
  });

  it('refuses the slip to somebody who may only read the booth', async () => {
    const managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
    const res = await patchSettings({ voucherShowLogo: false }, managerCookie);
    expect(res.statusCode).toBe(403);
    expect((await draft()).settings.voucherShowLogo).toBe(true);
  });

  it('reaches the box only with a publish, in the bundle the box pulls', async () => {
    expect((await patchSettings({ voucherFooterText: 'See you at the park!', voucherShowTerms: false })).statusCode).toBe(200);
    const unpublished = await draft();
    expect(unpublished.publishedBundle?.settings).not.toHaveProperty('voucherFooterText');

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/booths/${boothId}/publish`,
      headers: { cookie: adminCookie },
      payload: { expectedBundleHash: unpublished.bundleHash },
    });
    expect(published.statusCode, published.body).toBe(200);

    const after = await draft();
    expect(after.publishedBundle?.settings).toMatchObject({
      voucherFooterText: 'See you at the park!',
      voucherShowTerms: false,
    });

    // And the box's cache scope serves it as published.
    const [boothRow] = await db.select().from(station).where(eq(station.id, boothId)).limit(1);
    expect(boothRow?.boxId, 'the seeded booth has a box').toBeTruthy();
    const items = await boothCacheItems(db, {
      boxId: boothRow!.boxId!,
      operatorId: boothRow!.operatorId,
    } as BoxAuth);
    const mine = items.find((i) => i.stationId === boothId);
    expect((mine?.bundle as { settings: Record<string, unknown> }).settings).toMatchObject({
      voucherFooterText: 'See you at the park!',
      voucherShowTerms: false,
    });
  });
});

describe('the voucher slip’s live preview (SCRUM-471)', () => {
  it('draws a sample slip from the draft values, as a PNG nobody may cache', async () => {
    const res = await preview({ voucherHeaderText: 'Draft header', voucherShowLogo: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-oto-preview-width-dots']).toBe('576');
    expect(res.rawPayload.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(res.rawPayload.readUInt32BE(16), 'drawn at the 80 mm width').toBe(576);
  });

  it('follows the draft: each row it leaves off makes the slip shorter', async () => {
    const full = pngHeight((await preview({})).rawPayload);
    for (const off of [{ voucherShowLogo: false }, { voucherShowStaff: false }, { voucherShowTerms: false }]) {
      const res = await preview(off);
      expect(res.statusCode, res.body).toBe(200);
      expect(pngHeight(res.rawPayload), JSON.stringify(off)).toBeLessThan(full);
    }
    const withLines = await preview({ voucherHeaderText: 'Header', voucherFooterText: 'Footer' });
    expect(pngHeight(withLines.rawPayload)).toBeGreaterThan(full);
  });

  it('saves nothing', async () => {
    await preview({ voucherShowLogo: false, voucherFooterText: 'Not saved' });
    expect((await draft()).settings).toMatchObject({ voucherShowLogo: true, voucherFooterText: null });
  });

  it('refuses over-long draft text like the settings route does', async () => {
    const res = await preview({ voucherFooterText: 'f'.repeat(401) });
    expect(res.statusCode).toBe(400);
  });

  it('is refused to a stranger: no session, the counter, and another park’s manager', async () => {
    expect((await preview({}, null)).statusCode).toBe(401);
    const receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    expect((await preview({}, receptionCookie)).statusCode).toBe(403);
    const chalongCookie = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    expect((await preview({}, chalongCookie)).statusCode).toBe(403);
  });
});

/**
 * The gate's reproductions (SCRUM-471), kept: the round's claims about the
 * box cache, a PATCH that names only some fields, and the preview route's
 * edges — plus the lost update two forms on one row made likelier.
 */
describe('the voucher slip, as the gate checked it (SCRUM-471)', () => {
  async function cachedSettings(): Promise<Record<string, unknown>> {
    const [boothRow] = await db.select().from(station).where(eq(station.id, boothId)).limit(1);
    const items = await boothCacheItems(db, {
      boxId: boothRow!.boxId!,
      operatorId: boothRow!.operatorId,
    } as BoxAuth);
    const mine = items.find((i) => i.stationId === boothId);
    return (mine!.bundle as { settings: Record<string, unknown> }).settings;
  }

  async function storedSpinCap(): Promise<number | null> {
    const [row] = await db
      .select({ cap: boothSettings.dailySpinCap })
      .from(boothSettings)
      .where(eq(boothSettings.stationId, boothId))
      .limit(1);
    return row?.cap ?? null;
  }

  it('keeps a saved slip out of the box cache until a publish, through other PATCHes and a cleared header', async () => {
    const capBefore = await storedSpinCap();
    try {
      const cached = JSON.stringify(await cachedSettings());
      const saved = await patchSettings({
        voucherShowLogo: false,
        voucherHeaderText: 'H',
        voucherFooterText: 'F',
        voucherShowStaff: false,
        voucherShowTerms: false,
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(JSON.stringify(await cachedSettings()), 'the box pulls the PUBLISHED wheel only').toBe(cached);

      // A PATCH that names only another setting keeps the slip.
      const other = await patchSettings({ dailySpinCap: 50 });
      expect(other.statusCode, other.body).toBe(200);
      expect(other.json().settings).toMatchObject({
        voucherShowLogo: false,
        voucherHeaderText: 'H',
        voucherFooterText: 'F',
        voucherShowStaff: false,
        voucherShowTerms: false,
        dailySpinCap: 50,
      });

      // An explicit null clears the header, and nothing else.
      const cleared = await patchSettings({ voucherHeaderText: null });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json().settings).toMatchObject({ voucherHeaderText: null, voucherFooterText: 'F' });
      expect(JSON.stringify(await cachedSettings())).toBe(cached);
    } finally {
      await db.update(boothSettings).set({ dailySpinCap: capBefore }).where(eq(boothSettings.stationId, boothId));
    }
  });

  it('draws the preview for a branch manager, who may read the booth; 404 for no booth; 400 for a wrong-typed body', async () => {
    const managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
    const allowed = await preview({}, managerCookie);
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.headers['content-type']).toBe('image/png');

    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/booths/018f1d2c-0000-7000-8000-000000000000/voucher-preview.png',
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(unknown.statusCode, unknown.body).toBe(404);

    expect((await preview({ voucherShowLogo: 'yes' })).statusCode).toBe(400);
  });

  /**
   * Two people save the one row at once: one from the Voucher slip card, one
   * from the settings drawer. The row is held by a third transaction until
   * BOTH saves are queued on it, then let go. Each save must land on the
   * other's committed change.
   *
   * Read `before` without FOR UPDATE and both saves read the row as it was;
   * the second to write puts the first's field back — this goes red.
   */
  it('two saves of the one settings row at the same moment: neither loses the other’s change', async () => {
    const capBefore = await storedSpinCap();
    let letGo!: () => void;
    const mayLetGo = new Promise<void>((resolve) => (letGo = resolve));
    let held!: () => void;
    const isHeld = new Promise<void>((resolve) => (held = resolve));
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: boothSettings.stationId })
        .from(boothSettings)
        .where(eq(boothSettings.stationId, boothId))
        .for('update');
      held();
      await mayLetGo;
    });
    try {
      await isHeld;
      const slipSave = patchSettings({ voucherFooterText: 'From the slip card' });
      const drawerSave = patchSettings({ dailySpinCap: 77 });

      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await db.execute(
          sql`select count(*)::int as n from pg_stat_activity
               where datname = current_database() and wait_event_type = 'Lock'
                 and query ilike '%booth_settings%'`,
        );
        if (Number((waiting.rows[0] as { n: number }).n) >= 2) break;
        if (Date.now() > deadline) throw new Error('the two saves never queued on the settings row');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      letGo();
      await holder;

      const [a, b] = await Promise.all([slipSave, drawerSave]);
      expect(a.statusCode, a.body).toBe(200);
      expect(b.statusCode, b.body).toBe(200);
      const [row] = await db
        .select({ footer: boothSettings.voucherFooterText, cap: boothSettings.dailySpinCap })
        .from(boothSettings)
        .where(eq(boothSettings.stationId, boothId))
        .limit(1);
      expect(row, 'both saves are on the row').toEqual({ footer: 'From the slip card', cap: 77 });
    } finally {
      letGo();
      await holder.catch(() => undefined);
      await db.update(boothSettings).set({ dailySpinCap: capBefore }).where(eq(boothSettings.stationId, boothId));
    }
  });
});
