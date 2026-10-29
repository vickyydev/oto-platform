import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { account, auditLog, branch, handoffToken, session } from '@oto/db';
import { newId } from '@oto/shared';
import { audit } from '../src/services/audit';
import { hashToken } from '../src/plugins/session';
import { handoffConfig, issueHandoff, verifyToken, type HandoffApp } from '../src/services/handoff';
import { createTestContext, teardownAll, type TestContext } from './helpers';

const seam = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock('../src/services/oto-app-users', async (original) => ({
  ...await original<typeof import('../src/services/oto-app-users')>(),
  reconcileOtoAppRole: seam.reconcile,
}));

const origins = {
  oto_app: 'https://oto-app.s629.test', pos: 'https://pos.s629.test', booth: 'https://booth.s629.test',
};
const signingKey = randomBytes(32).toString('hex');
const settings = {
  signingKey: `s629:${signingKey}`,
  appOrigins: Object.entries(origins).map(([key, origin]) => `${key}=${origin}`).join(','),
  ttlSeconds: 60,
};
let ctx: TestContext;
let accountId: string;
let operatorId: string;
let sessionId: string;
let sessionToken: string;
const mapped = {
  platformRolesEnabled: true as const, userId: newId(), operatorId: newId(), tenantId: newId(),
  role: 'manager' as const, permissions: { 'hr:salary:view': false },
};

beforeAll(async () => {
  ctx = await createTestContext({ env: {
    HANDOFF_SIGNING_KEY: settings.signingKey,
    HANDOFF_APP_ORIGINS: settings.appOrigins,
    ALLOWED_ORIGINS: Object.values(origins).join(','),
  } });
  const [park] = await ctx.db.select().from(branch).limit(1);
  operatorId = park!.operatorId;
  accountId = newId(); sessionId = newId(); sessionToken = randomBytes(32).toString('hex');
  await ctx.db.insert(account).values({ id: accountId, operatorId, phone: `ZZ TEST ${newId()}`, status: 'active' });
  await ctx.db.insert(session).values({ id: sessionId, accountId, branchId: park!.id,
    tokenHash: hashToken(sessionToken), expiresAt: new Date(Date.now() + 3_600_000) });
});
beforeEach(() => { seam.reconcile.mockReset().mockResolvedValue(null); });
afterAll(async () => { await ctx?.close(); await teardownAll(); });

const mint = (audience: HandoffApp = 'oto_app') => issueHandoff(ctx.db, handoffConfig(settings), {
  sessionId, accountId, sessionToken, audience,
});
const exchange = (token: string, audience: keyof typeof origins = 'oto_app') => ctx.app.inject({
  method: 'POST', url: '/auth/handoff/exchange', headers: { origin: origins[audience] }, payload: { token },
});

describe('SCRUM-629 handoff role integration', () => {
  it('R1 [high] resolves the current OTO mapping after mint and returns the complete typed claim; fix: resolve through the identity seam during exchange', async () => {
    const issued = await mint();
    expect(seam.reconcile).not.toHaveBeenCalled();
    expect(Object.keys(verifyToken(handoffConfig(settings).keys, issued.token)!).sort())
      .toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'sid', 'sub']);
    seam.reconcile.mockResolvedValue(mapped);
    const response = await exchange(issued.token);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accountId, audience: 'oto_app', mustChangePassword: false,
      sessionLocked: false, otoApp: mapped });
    expect(seam.reconcile).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      operatorId, accountId, actorAccountId: accountId, requestId: expect.any(String),
    });
    expect(response.headers['set-cookie']).toBeDefined();
  });

  it('R2 [high] keeps flag-off exchanges and every other audience unchanged; fix: omit the optional OTO member instead of replacing legacy roles', async () => {
    const off = await exchange((await mint()).token);
    expect(off.statusCode).toBe(200);
    expect(Object.keys(off.json()).sort()).toEqual(['accountId', 'audience', 'mustChangePassword', 'sessionLocked']);
    seam.reconcile.mockClear().mockResolvedValue(mapped);
    const pos = await exchange((await mint('pos')).token, 'pos');
    expect(pos.statusCode).toBe(200);
    expect(pos.json()).not.toHaveProperty('otoApp');
    // The Lucky Wheel takes no sign-on (SCRUM-694): nothing is minted for it,
    // so nothing reaches the identity seam.
    await expect(mint('booth')).rejects.toMatchObject({ statusCode: 410, code: 'HANDOFF_APP_RETIRED' });
    expect(seam.reconcile).not.toHaveBeenCalled();
  });

  it('R3 [critical] never reconciles twice for a spent token or for the wrong origin; fix: preserve the committed claim before new role work', async () => {
    seam.reconcile.mockResolvedValue(mapped);
    const issued = await mint();
    expect((await exchange(issued.token)).statusCode).toBe(200);
    const replay = await exchange(issued.token);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.details.reason).toBe('replayed');
    expect(seam.reconcile).toHaveBeenCalledTimes(1);
    seam.reconcile.mockClear();
    const wrong = await mint();
    const refused = await exchange(wrong.token, 'pos');
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.details.reason).toBe('origin');
    expect(seam.reconcile).not.toHaveBeenCalled();
    expect((await exchange(wrong.token)).json().error.details.reason).toBe('replayed');
  });

  it('R4 [critical] rolls back role-side work on failure while the handoff stays consumed and its secret erased; fix: use a separate atomic reconciliation transaction', async () => {
    const marker = newId();
    seam.reconcile.mockImplementation(async (tx) => {
      await audit.record(tx, { actorAccountId: accountId, operatorId, action: 'ZZ TEST s629.rollback',
        entityType: 'account', entityId: marker });
      throw new Error('ZZ TEST identity reconciliation failed');
    });
    const issued = await mint();
    expect((await exchange(issued.token)).statusCode).toBe(500);
    const [spent] = await ctx.db.select().from(handoffToken).where(eq(handoffToken.jti, issued.jti));
    expect(spent!.consumedAt).not.toBeNull();
    expect(spent!.sessionSecret).toBeNull();
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, marker),
      eq(auditLog.action, 'ZZ TEST s629.rollback')))).toHaveLength(0);
    expect((await exchange(issued.token)).json().error.details.reason).toBe('replayed');
  });
});
