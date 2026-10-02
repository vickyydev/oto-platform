import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@oto/db';
import { isCalendarDate } from '@oto/shared';
import {
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-15a round 1 — FOCUSED GATE RE-CHECK. The previous gate's REJECT 2 kept as
 * reproductions: an impossible calendar date on any End of Day input is a 400
 * in the counter's words, never a 500 from Postgres, and a real leap day still
 * reads. Nothing is written for a refused date.
 */

let ctx: TestContext;
let central: string;
let receptionCookie: string;
let managerCookie: string;

const WORDS = 'That date is not on the calendar.';

beforeAll(async () => {
  ctx = await createTestContext();
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  managerCookie = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('re-check: isCalendarDate', () => {
  it('accepts real days, leap days only in leap years, and refuses the rest', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2000-02-29')).toBe(true);
    expect(isCalendarDate('2026-12-31')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('1900-02-29')).toBe(false);
    expect(isCalendarDate('2026-04-31')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-00-10')).toBe(false);
    expect(isCalendarDate('2026-01-00')).toBe(false);
    expect(isCalendarDate('2026-1-01')).toBe(false);
    expect(isCalendarDate('2026-01-01T00:00')).toBe(false);
  });
});

describe('re-check: impossible dates are refused on every End of Day input', () => {
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-32']) {
    it(`GET end-of-day ?date=${date} is a 400 in the counter's words`, async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/branches/${central}/end-of-day?date=${date}`,
        headers: { cookie: receptionCookie },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toContain(WORDS);
    });

    it(`GET cash-movements ?date=${date} is a 400 in the counter's words`, async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/branches/${central}/cash-movements?date=${date}`,
        headers: { cookie: receptionCookie },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toContain(WORDS);
    });
  }

  it('POST close with an impossible date is a 400, writes no day and no audit row', async () => {
    const before = await ctx.db.select({ id: schema.auditLog.id }).from(schema.auditLog).where(eq(schema.auditLog.action, 'end_of_day.close'));
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${central}/end-of-day/close`,
      headers: { cookie: managerCookie, 'idempotency-key': 'recheck-impossible-close' },
      payload: { date: '2025-02-29', countedSatang: 600_000, floatLeftSatang: 600_000 },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain(WORDS);
    const after = await ctx.db.select({ id: schema.auditLog.id }).from(schema.auditLog).where(eq(schema.auditLog.action, 'end_of_day.close'));
    expect(after.length).toBe(before.length);
    const rows = await ctx.db.select({ id: schema.endOfDay.id }).from(schema.endOfDay).where(eq(schema.endOfDay.businessDate, '2025-03-01'));
    expect(rows, 'Feb 29 must not roll over to Mar 1').toHaveLength(0);
  });

  it('a real leap day reads (200), and a malformed date is still a 400, never a 500', async () => {
    const leap = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${central}/end-of-day?date=2024-02-29`,
      headers: { cookie: receptionCookie },
    });
    expect(leap.statusCode, leap.body).toBe(200);
    expect((leap.json() as { date: string }).date).toBe('2024-02-29');

    const bad = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${central}/end-of-day?date=29-02-2024`,
      headers: { cookie: receptionCookie },
    });
    expect(bad.statusCode, bad.body).toBe(400);
  });
});
