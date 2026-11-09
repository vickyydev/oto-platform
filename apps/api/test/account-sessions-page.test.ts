// SCRUM-793 — "Sessions on this account" a page at a time, newest sign-in
// first, with the total; each row says what it is NOW, so a session whose end
// passed two days ago reads 'ended' rather than 'active', and the row stays.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, session } from '@oto/db';
import { newId } from '@oto/shared';
import { SESSION_COOKIE, hashToken, newSessionToken } from '../src/plugins/session';
import { sessionEndedAt, sessionStatus } from '../src/services/account-sessions';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

const HOUR = 3600_000;

let ctx: TestContext;
let admin: string;
let target: string;
/** The 23 seeded rows, newest sign-in first: what every page is read against. */
let newestFirst: string[];
/** Rows with a known end, by role. */
const ids = {
  expiredTwoDaysAgo: newId(),
  locked: newId(),
  lockedThenExpired: newId(),
  signedOut: newId(),
  expiredThenRevoked: newId(),
};
const expiredToken = newSessionToken();
let now: number;

type Row = {
  id: string;
  status: 'active' | 'locked' | 'ended';
  endedAt: string | null;
  expiresAt: string;
  createdAt: string;
  lockedAt: string | null;
  current: boolean;
};

async function page(query: string, cookie = admin, accountId = target) {
  return ctx.app.inject({ method: 'GET', url: `/accounts/${accountId}/sessions${query}`, headers: { cookie } });
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [owner] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone));
  target = newId();
  await ctx.db.insert(account).values({
    id: target, operatorId: owner!.operatorId, phone: '+66999079301', status: 'active',
  });
  now = Date.now();
  // Signed in once an hour for the last 23 hours: index 0 is the oldest.
  const special = new Map<number, Partial<typeof session.$inferInsert>>([
    // The owner's case: an end that passed on the 7th, read on the 9th.
    [2, { id: ids.expiredTwoDaysAgo, tokenHash: hashToken(expiredToken), expiresAt: new Date(now - 48 * HOUR) }],
    [5, { id: ids.locked, lockedAt: new Date(now - 17 * HOUR) }],
    [8, { id: ids.lockedThenExpired, lockedAt: new Date(now - 14 * HOUR), expiresAt: new Date(now - 3 * HOUR) }],
    [12, { id: ids.signedOut, revokedAt: new Date(now - 10 * HOUR), revokedReason: 'sign_out' }],
    // "Sign out everywhere" found it already over: it ended at its expiry.
    [15, { id: ids.expiredThenRevoked, expiresAt: new Date(now - 6 * HOUR), revokedAt: new Date(now - HOUR), revokedReason: 'force_sign_out' }],
  ]);
  const rows = Array.from({ length: 23 }, (_, i) => {
    const createdAt = new Date(now - (23 - i) * HOUR);
    return {
      id: newId(),
      accountId: target,
      tokenHash: hashToken(newSessionToken()),
      createdAt,
      lastSeenAt: createdAt,
      expiresAt: new Date(now + 12 * HOUR),
      ...special.get(i),
    };
  });
  await ctx.db.insert(session).values(rows);
  newestFirst = rows.map((r) => r.id!).reverse();
}, 180_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('GET /accounts/:id/sessions — a page at a time (SCRUM-793)', () => {
  it('answers the newest ten by default, with the total and the page it is', async () => {
    const res = await page('');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ total: 23, limit: 10, offset: 0 });
    expect(body.sessions.map((s: Row) => s.id)).toEqual(newestFirst.slice(0, 10));
    const created = body.sessions.map((s: Row) => Date.parse(s.createdAt));
    expect(created).toEqual([...created].sort((a, b) => b - a));
  });

  it('walks every row exactly once across the pages, still newest first', async () => {
    const seen: string[] = [];
    for (const offset of [0, 10, 20]) {
      const res = await page(`?limit=10&offset=${offset}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ total: 23, limit: 10, offset });
      seen.push(...res.json().sessions.map((s: Row) => s.id));
    }
    expect(seen).toEqual(newestFirst);
    const past = await page('?offset=30');
    expect(past.json()).toMatchObject({ total: 23, offset: 30, sessions: [] });
  });

  it('takes a page size up to 50 and refuses one outside 1–50 or a negative offset', async () => {
    const all = await page('?limit=50');
    expect(all.statusCode).toBe(200);
    expect(all.json().sessions).toHaveLength(23);
    for (const query of ['?limit=51', '?limit=0', '?offset=-1', '?limit=ten']) {
      expect((await page(query)).statusCode, query).toBe(400);
    }
  });

  it("reads a session past its end as ended, with when — and the row stays", async () => {
    const rows: Row[] = (await page('?limit=50')).json().sessions;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const at = (id: string) => byId.get(id)!;

    expect(at(ids.expiredTwoDaysAgo).status).toBe('ended');
    expect(at(ids.expiredTwoDaysAgo).endedAt).toBe(at(ids.expiredTwoDaysAgo).expiresAt);
    expect(at(ids.locked)).toMatchObject({ status: 'locked', endedAt: null });
    // Locked, then its end passed: over, not waiting for a password.
    expect(at(ids.lockedThenExpired).status).toBe('ended');
    expect(at(ids.lockedThenExpired).lockedAt).not.toBeNull();
    expect(at(ids.signedOut).status).toBe('ended');
    expect(Date.parse(at(ids.signedOut).endedAt!)).toBe(now - 10 * HOUR);
    expect(at(ids.expiredThenRevoked).endedAt).toBe(at(ids.expiredThenRevoked).expiresAt);

    const special = new Set(Object.values(ids));
    const rest = rows.filter((r) => !special.has(r.id));
    expect(rest).toHaveLength(18);
    for (const r of rest) expect(r, r.id).toMatchObject({ status: 'active', endedAt: null, current: false });
    expect(rows.filter((r) => r.status === 'ended')).toHaveLength(4);
  });

  it('says ended for exactly the session the door refuses as expired', async () => {
    const refused = await ctx.app.inject({
      method: 'GET', url: '/me', headers: { cookie: `${SESSION_COOKIE}=${expiredToken}` },
    });
    expect(refused.statusCode).toBe(401);
    const rows: Row[] = (await page('?limit=50')).json().sessions;
    expect(rows.find((r) => r.id === ids.expiredTwoDaysAgo)!.status).toBe('ended');
    expect(rows).toHaveLength(23);
  });

  it("marks the caller's own session as this device, and only that one", async () => {
    const second = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const [owner] = await ctx.db.select().from(account).where(eq(account.phone, ADMIN.phone));
    const idOf = async (cookie: string) => {
      const token = cookie.slice(cookie.indexOf('=') + 1);
      const [row] = await ctx.db.select({ id: session.id }).from(session).where(eq(session.tokenHash, hashToken(token)));
      return row!.id;
    };
    const first = await idOf(admin), other = await idOf(second);
    for (const [cookie, mine] of [[admin, first], [second, other]] as const) {
      const rows: Row[] = (await page('?limit=50', cookie, owner!.id)).json().sessions;
      expect(rows.filter((r) => r.current).map((r) => r.id)).toEqual([mine]);
      expect(rows.find((r) => r.id === mine)!.status).toBe('active');
    }
    // Reading somebody else's sessions marks none of theirs.
    const theirs: Row[] = (await page('?limit=50')).json().sessions;
    expect(theirs.some((r) => r.current)).toBe(false);
  });

  it('keeps the fields other callers already read', async () => {
    const [row] = (await page('?limit=1')).json().sessions;
    for (const key of ['id', 'branchId', 'stationId', 'lockedAt', 'lastSeenAt', 'expiresAt', 'createdAt']) {
      expect(row, key).toHaveProperty(key);
    }
  });
});

describe('the status words, against the clock (SCRUM-793)', () => {
  const at = new Date('2026-11-09T05:00:00Z');
  const base = { expiresAt: new Date('2026-11-09T12:00:00Z'), revokedAt: null, lockedAt: null };

  it('active until the end, ended from the end itself', () => {
    expect(sessionStatus(base, at)).toBe('active');
    expect(sessionStatus({ ...base, expiresAt: at }, at)).toBe('ended');
    expect(sessionEndedAt({ ...base, expiresAt: at }, at)).toEqual(at);
  });

  it('locked while in time, ended once past it', () => {
    const locked = { ...base, lockedAt: new Date('2026-11-09T04:00:00Z') };
    expect(sessionStatus(locked, at)).toBe('locked');
    expect(sessionStatus({ ...locked, expiresAt: new Date('2026-11-07T10:00:00Z') }, at)).toBe('ended');
  });

  it('a sign-out ends it at the sign-out, unless the expiry came first', () => {
    const out = new Date('2026-11-09T03:00:00Z');
    expect(sessionEndedAt({ ...base, revokedAt: out }, at)).toEqual(out);
    const expired = new Date('2026-11-07T10:00:00Z');
    expect(sessionEndedAt({ ...base, expiresAt: expired, revokedAt: out }, at)).toEqual(expired);
  });
});
