import { and, eq, ne } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { box, branch } from '@oto/db';
import { newId } from '@oto/shared';
import type { Env } from '../src/env';
import { inProcessBox, startVirtualBox, stopVirtualBox, virtualBoxAgent } from '../src/services/box';
import { boxBySlot, createTestContext, teardownAll, type TestContext } from './helpers';

let ctx: TestContext, port: number;
let primary: Awaited<ReturnType<typeof boxBySlot>>;
const testBoxId = newId();
const otherBranchBoxId = newId(), otherParkBoxId = newId();
const slot = 'zz-test-s717';
const name = 'ZZ TEST SCRUM-717 virtual host';

beforeAll(async () => {
  ctx = await createTestContext();
  primary = await boxBySlot(ctx.db, 'virtual-1');
  await ctx.db.insert(box).values({ id: testBoxId, operatorId: primary.operatorId,
    branchId: primary.branchId, role: 'virtual', slot, name });
  const [otherBranch] = await ctx.db.select().from(branch)
    .where(and(eq(branch.operatorId, primary.operatorId), ne(branch.id, primary.branchId))).limit(1);
  const [otherPark] = await ctx.db.select().from(branch).where(ne(branch.operatorId, primary.operatorId)).limit(1);
  expect(otherBranch?.id).toBeTruthy(); expect(otherPark?.id).toBeTruthy();
  await ctx.db.insert(box).values([
    { id: otherBranchBoxId, operatorId: primary.operatorId, branchId: otherBranch!.id, role: 'virtual', slot, name },
    { id: otherParkBoxId, operatorId: otherPark!.operatorId, branchId: otherPark!.id, role: 'virtual', slot, name },
  ]);
  port = Number(new URL(await ctx.app.listen({ port: 0, host: '127.0.0.1' })).port);
});
beforeEach(async () => {
  vi.stubEnv('BOX_AGENT_SLOT', 'virtual-1');
  vi.stubEnv('BOX_AGENT_BRANCH_CODE', 'hkt-central');
  vi.stubEnv('BOX_AGENT_API_URL', '');
  vi.stubEnv('BOX_AGENT_TEST_SLOT', slot);
  await ctx.db.update(box).set({ operatorId: primary.operatorId, branchId: primary.branchId,
    role: 'virtual', name, slot, status: 'unclaimed', archivedAt: null }).where(eq(box.id, testBoxId));
});
afterEach(() => { stopVirtualBox(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => { stopVirtualBox(); await ctx.close(); await teardownAll(); });

const start = (overrides: Partial<Env> = {}) => startVirtualBox({ db: ctx.db, log: ctx.app.log, port,
  env: { ...ctx.app.env, PROCESS_ROLES: 'api,edge', DEPLOY_ENV: 'staging', OPS_TEST_CONTROLS: true, ...overrides } });

describe('SCRUM-717: one optional staging rehearsal agent under the existing lease', () => {
  it('HIGH pin: starts both identities without replacing the primary, and stops both on lease loss', async () => {
    const agent = await start();
    expect(agent?.state.boxId).toBe(primary.id);
    expect(virtualBoxAgent()).toBe(agent);
    expect(inProcessBox(primary.id)).toBe(agent);
    const extra = inProcessBox(testBoxId);
    expect(extra?.state.boxId).toBe(testBoxId);
    expect(extra?.sales()).toBeTruthy();
    expect(extra).not.toBe(agent);
    stopVirtualBox();
    expect(virtualBoxAgent()).toBeNull();
    expect(inProcessBox(primary.id)).toBeNull();
    expect(inProcessBox(testBoxId)).toBeNull();
  });

  it.each([
    ['production', { DEPLOY_ENV: 'production' }],
    ['local', { DEPLOY_ENV: 'local' }],
    ['test controls off', { OPS_TEST_CONTROLS: false }],
  ] as const)('HIGH pin: %s never enables the optional test agent', async (_label, env) => {
    expect((await start(env))?.state.boxId).toBe(primary.id);
    expect(inProcessBox(testBoxId)).toBeNull();
  });

  it.each(['', 'virtual-1', 'a-real-slot'])('HIGH pin: absent or non-test slot %j leaves the primary alone', async value => {
    vi.stubEnv('BOX_AGENT_TEST_SLOT', value);
    expect((await start())?.state.boxId).toBe(primary.id);
    expect(inProcessBox(testBoxId)).toBeNull();
  });

  it.each([
    ['a real box', { role: 'counter' as const }],
    ['an ordinary name', { name: 'Reception box' }],
    ['disabled', { status: 'disabled' as const }],
    ['archived', { archivedAt: new Date() }],
  ])('HIGH pin: %s is never claimed by the rehearsal option', async (_label, patch) => {
    await ctx.db.update(box).set(patch).where(eq(box.id, testBoxId));
    const [before] = await ctx.db.select({ hash: box.claimCodeHash }).from(box).where(eq(box.id, testBoxId));
    expect((await start())?.state.boxId).toBe(primary.id);
    const [after] = await ctx.db.select({ hash: box.claimCodeHash }).from(box).where(eq(box.id, testBoxId));
    expect(before!.hash === after!.hash).toBe(true);
    expect(inProcessBox(testBoxId)).toBeNull();
  });

  it('HIGH pin: identical test slots on another branch or park are never claimed', async () => {
    await ctx.db.update(box).set({ archivedAt: new Date() }).where(eq(box.id, testBoxId));
    expect((await start())?.state.boxId).toBe(primary.id);
    expect(inProcessBox(testBoxId)).toBeNull();
    expect(inProcessBox(otherBranchBoxId)).toBeNull();
    expect(inProcessBox(otherParkBoxId)).toBeNull();
  });

  it('HIGH pin: losing the lease while registration is in flight cannot reattach either agent', async () => {
    const realFetch = globalThis.fetch;
    let observed!: () => void, release!: () => void;
    const seen = new Promise<void>(resolve => { observed = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
      const response = await realFetch(...args);
      if (String(args[0]).endsWith('/box/v1/register')) { observed(); await held; }
      return response;
    });
    const pending = start();
    try { await seen; stopVirtualBox(); } finally { release(); }
    expect(await pending).toBeNull();
    expect(virtualBoxAgent()).toBeNull();
    expect(inProcessBox(primary.id)).toBeNull();
    expect(inProcessBox(testBoxId)).toBeNull();
  });
});
