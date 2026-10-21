import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog } from '@oto/db';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-653 — a person's theme and language, kept on their account. `GET /me`
 * carries them as `preferences`; `PUT /me/preferences` writes the caller's
 * own, either field alone, audited and replayable by key.
 */

let ctx: TestContext;
let reception: string;
let receptionId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: reception } });
  receptionId = me.json().account.id;
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const put = (cookie: string | undefined, payload: unknown, key?: string) =>
  ctx.app.inject({
    method: 'PUT',
    url: '/me/preferences',
    headers: { ...(cookie ? { cookie } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    payload: payload as object,
  });

const rowsFor = (accountId: string) =>
  ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'account.preferences'), eq(auditLog.entityId, accountId)));

describe('SCRUM-653 — preferences on the account', () => {
  it('GET /me carries the column defaults: follow the device, English', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: reception } });
    expect(res.statusCode).toBe(200);
    expect(res.json().preferences).toEqual({ theme: 'system', language: 'en' });
  });

  it('writes the theme alone, answers the whole of it, and /me reads it back', async () => {
    const res = await put(reception, { theme: 'dark' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ preferences: { theme: 'dark', language: 'en' } });

    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: reception } });
    expect(me.json().preferences).toEqual({ theme: 'dark', language: 'en' });
    const [row] = await ctx.db.select().from(account).where(eq(account.id, receptionId));
    expect([row!.uiTheme, row!.uiLanguage]).toEqual(['dark', 'en']);
  });

  it('writes the language alone without touching the theme', async () => {
    const res = await put(reception, { language: 'th' });
    expect(res.statusCode).toBe(200);
    expect(res.json().preferences).toEqual({ theme: 'dark', language: 'th' });
  });

  it('records each write with what it was and what it became', async () => {
    const rows = await rowsFor(receptionId);
    expect(rows).toHaveLength(2);
    const byAfter = rows.map((r) => ({ before: r.before, after: r.after, actor: r.actorAccountId, type: r.entityType }));
    expect(byAfter).toEqual(
      expect.arrayContaining([
        { before: { theme: 'system', language: 'en' }, after: { theme: 'dark', language: 'en' }, actor: receptionId, type: 'account' },
        { before: { theme: 'dark', language: 'en' }, after: { theme: 'dark', language: 'th' }, actor: receptionId, type: 'account' },
      ]),
    );
  });

  it("changes only the caller's own account", async () => {
    const admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: admin } });
    expect(me.json().preferences).toEqual({ theme: 'system', language: 'en' });
  });

  it('refuses an empty body, an unknown value and any other field', async () => {
    for (const body of [{}, { theme: 'blue' }, { language: 'fr' }, { theme: 'dark', accountId: receptionId }]) {
      const res = await put(reception, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION');
    }
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: reception } });
    expect(me.json().preferences).toEqual({ theme: 'dark', language: 'th' });
  });

  it('refuses a caller with no session', async () => {
    const res = await put(undefined, { theme: 'light' });
    expect(res.statusCode).toBe(401);
  });

  it('replays a retried write by its key: one change, one row, the same answer', async () => {
    const before = (await rowsFor(receptionId)).length;
    const first = await put(reception, { theme: 'system' }, 'prefs-replay-1');
    const second = await put(reception, { theme: 'system' }, 'prefs-replay-1');
    expect(first.statusCode).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect((await rowsFor(receptionId)).length).toBe(before + 1);

    const other = await put(reception, { theme: 'light' }, 'prefs-replay-1');
    expect([other.statusCode, other.json().error.code]).toEqual([409, 'IDEMPOTENCY_MISMATCH']);
  });
});
