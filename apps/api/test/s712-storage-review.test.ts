import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoreMirror, MIRROR_NAME } from '../../../packages/box-agent/src/store-mirror';
import { alert, box, boxHeartbeat } from '@oto/db';
import { BoxHeartbeatRequestSchema, boxCredential, type BoxHeartbeatRequest } from '@oto/box-agent';
import { evaluateBox, fleetHealth, type BoxRuleSettings } from '../src/services/ops';
import { issueClaimCode } from '../src/services/box';
import { runWatchdog } from '../src/services/jobs';
import {
  ADMIN,
  boxBySlot,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/** SCRUM-712 adversarial review: thresholds, unknown readings, intake and recovery. */
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
function rules(storage?: Storage, status = 'online') {
  return evaluateBox(
    {
      id: '018f0000-0000-7000-8000-00000000b0c1',
      name: 'Counter',
      slot: 'test',
      role: 'counter',
      operatorId: 'operator',
      branchId: 'branch',
      status,
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
  rules(storage).find((c) => c.category === category)!;

describe('storage condition pins', () => {
  it('PIN for FINDING medium: ten-second precision; compare milliseconds before rounding heartbeat age', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oto-s712-review-'));
    try {
      const at = Date.now();
      const file = join(directory, MIRROR_NAME);
      await writeFile(file, 'timestamp only');
      await utimes(file, at / 1000, at / 1000);
      let copied = false;
      const mirror = new StoreMirror({
        database: join(directory, 'unused'),
        directory,
        now: () => at + 10_100,
        copy: async () => {
          copied = true;
        },
      });
      expect(await mirror.run(true)).toBe('mirrored');
      expect(copied).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each([{ readOnly: true }, { ioErrors: 1 }])(
    'a read-only mount or one IO error raises a drive failure: %j',
    (fault) => {
      expect(condition({ ...healthy, ...fault }, 'box.storage_failing')).toMatchObject({
        active: true,
        severity: 'critical',
      });
      expect(condition(healthy, 'box.storage_failing')).toMatchObject({
        active: false,
        clear: { reason: 'recovered' },
      });
    },
  );
  it.each([
    { freeBytes: 1_999_999_999, totalBytes: 10_000_000_000, active: true },
    { freeBytes: 2_000_000_000, totalBytes: 20_000_000_000, active: false },
    { freeBytes: 3_000_000_000, totalBytes: 40_000_000_000, active: true },
    { freeBytes: 4_000_000_000, totalBytes: 40_000_000_000, active: false },
  ])('space threshold is under 2GB OR under ten percent: %j', ({ active, ...space }) => {
    expect(condition({ ...healthy, ...space }, 'box.storage_low').active).toBe(active);
  });
  it('stale after ten minutes; missing is named honestly; no configured mirror clears without claiming a backup', () => {
    expect(condition({ ...healthy, mirrorAgeS: 600 }, 'box.mirror_stale').active).toBe(false);
    expect(condition({ ...healthy, mirrorAgeS: 601 }, 'box.mirror_stale').active).toBe(true);
    expect(condition({ ...healthy, mirrorAgeS: null }, 'box.mirror_stale').summary).toContain(
      'no completed',
    );
    expect(
      condition({ ...healthy, mirrorConfigured: false, mirrorAgeS: null }, 'box.mirror_stale'),
    ).toMatchObject({
      active: false,
      clear: { summary: expect.stringContaining('not configured') },
    });
  });
  it('old agents remain unknown, unreadable space does not invent zero, archived boxes clear conditions', () => {
    expect(
      rules().some(
        (c) => c.category.startsWith('box.storage_') || c.category === 'box.mirror_stale',
      ),
    ).toBe(false);
    expect(
      rules({ ...healthy, freeBytes: null }).some((c) => c.category === 'box.storage_low'),
    ).toBe(false);
    expect(
      rules(undefined, 'disabled').filter(
        (c) => c.category.startsWith('box.storage_') || c.category === 'box.mirror_stale',
      ),
    ).toHaveLength(3);
    expect(
      rules({ ...healthy, readOnly: true, freeBytes: 1, mirrorAgeS: 900 }, 'disabled').some(
        (c) => c.active && c.category.startsWith('box.storage_'),
      ),
    ).toBe(false);
  });
  it('a failed drive never promises newer unsent sales are already in an old mirror', () => {
    expect(
      condition({ ...healthy, readOnly: true, mirrorAgeS: 900 }, 'box.storage_failing').summary,
    ).toContain('newer sales may not be in it');
    expect(
      condition(
        { ...healthy, readOnly: true, mirrorConfigured: false, mirrorAgeS: null },
        'box.storage_failing',
      ).summary,
    ).toContain('no mirror directory');
  });
  it('schema is additive and rejects impossible negative readings', () => {
    expect(
      BoxHeartbeatRequestSchema.safeParse({
        reportedAt: new Date().toISOString(),
        agentVersion: '0.1.0',
      }).success,
    ).toBe(true);
    expect(
      BoxHeartbeatRequestSchema.safeParse({
        reportedAt: new Date().toISOString(),
        agentVersion: '0.1.0',
        storage: { ...healthy, ioErrors: -1 },
      }).success,
    ).toBe(false);
  });
});

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
}, 240_000);
afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

it('heartbeat intake persists each reading, Health raises all three, and the next healthy heartbeat clears the alerts', async () => {
  const row = await boxBySlot(ctx.db, 'virtual-1');
  const { code: claimCode } = await issueClaimCode(ctx.db, row.id);
  const registration = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/register',
    payload: { claimCode, agentVersion: '0.1.0', hostname: 'ZZ TEST storage box' },
  });
  expect(registration.statusCode).toBe(200);
  const registered = registration.json<{ boxId: string; secret: string }>();
  const authorization = `Bearer ${boxCredential(registered.boxId, registered.secret)}`;
  let tick = Date.now();
  const send = async (storage: Storage) => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/heartbeat',
      headers: { authorization },
      payload: { reportedAt: new Date(++tick).toISOString(), agentVersion: '0.1.0', storage },
    });
    expect(response.statusCode).toBe(200);
  };
  const failed = { ...healthy, readOnly: true, freeBytes: 1, mirrorAgeS: 900, mirrorErrors: 2 };
  await send(failed);
  const [saved] = await ctx.db.select().from(box).where(eq(box.id, row.id));
  expect((saved!.lastStatus as { storage: unknown }).storage).toEqual(failed);
  const [history] = await ctx.db.select().from(boxHeartbeat).where(eq(boxHeartbeat.boxId, row.id));
  expect((history!.payload as { storage: unknown }).storage).toEqual(failed);
  const watchdog = () =>
    runWatchdog({
      db: ctx.db,
      env: ctx.app.env,
      log: ctx.app.log,
      channels: [{ name: 'console', deliver: async () => ({ target: 'test' }) }],
    });
  await watchdog();
  const cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const response = await ctx.app.inject({ method: 'GET', url: '/ops/health', headers: { cookie } });
  expect(response.statusCode).toBe(200);
  const categories = ['box.storage_failing', 'box.storage_low', 'box.mirror_stale'];
  for (const category of categories)
    expect(response.json<{ alerts: Array<{ key: string }> }>().alerts.map((a) => a.key)).toContain(
      `${category}:${row.id}`,
    );
  await send(healthy);
  await watchdog();
  for (const category of categories) {
    const [closed] = await ctx.db
      .select()
      .from(alert)
      .where(eq(alert.key, `${category}:${row.id}`));
    expect(closed).toMatchObject({ status: 'resolved', resolvedReason: 'recovered' });
  }
  expect(
    (await fleetHealth({ db: ctx.db })).boxes.find((b) => b.id === row.id)!.conditions,
  ).not.toEqual(expect.arrayContaining(categories.map((c) => `${c}:${row.id}`)));
});
