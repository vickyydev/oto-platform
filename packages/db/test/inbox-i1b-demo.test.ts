import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { schema, type Db } from '../src/index';
import * as s from '../src/schema/index';
import { seed } from '../src/seed/index';
import { InboxDemoRefusedError, seedInboxDemo } from '../src/seed/inbox-demo';
import { DEMO_CONVERSATIONS, DEMO_STAFF } from '../src/seed/inbox-demo-fixtures';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-19 I1b (SCRUM-579) — the Inbox's demo conversations.
 *
 * `pnpm --filter @oto/db seed:inbox-demo` on top of the full seed: ten
 * fictional threads, six demo staff, the blank routing rules named — once,
 * whatever number of times it runs — and never on production. Until I2's
 * ingest lands the script inserts directly (the marked simulator seam in
 * `src/seed/inbox-demo.ts`); these cases hold either way, because they read
 * the tables, not the path that filled them.
 */

let db: Db;
let pool: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  const made = await createTestDatabase();
  drop = made.drop;
  pool = new pg.Pool({ connectionString: made.url });
  db = drizzle(pool, { schema }) as Db;
  await seed(db);
}, 300_000);

afterAll(async () => {
  await pool?.end();
  await drop?.();
  await stopTestServer();
});

const operatorByName = async (name: string) =>
  (await db.select({ id: s.operator.id }).from(s.operator).where(eq(s.operator.name, name)).limit(1))[0]!.id;

describe('the demo conversations (I1b)', () => {
  it('is refused on production before it reads anything', async () => {
    await expect(seedInboxDemo(db, { env: { SEED_PROFILE: 'production' } })).rejects.toBeInstanceOf(InboxDemoRefusedError);
    await expect(seedInboxDemo(db, { env: { DEPLOY_ENV: 'production' } })).rejects.toBeInstanceOf(InboxDemoRefusedError);
  });

  it('writes ten conversations, six staff and names the blank rules — once', async () => {
    const oto = await operatorByName('OTO');
    const now = new Date('2026-10-20T08:00:00Z');
    const first = await seedInboxDemo(db, { now, env: {} });
    expect(first.conversationsCreated).toBe(10);
    expect(first.staffCreated).toBe(6);
    expect(first.rulesNamed).toBe(4);
    expect(first.channelAccountsCreated).toBe(4);

    const second = await seedInboxDemo(db, { now, env: {} });
    expect(second).toMatchObject({
      conversationsCreated: 0,
      conversationsAlreadyThere: 10,
      staffCreated: 0,
      rulesNamed: 0,
      channelAccountsCreated: 0,
      messages: 0,
    });

    const sim = await db
      .select({ id: s.channelAccount.id })
      .from(s.channelAccount)
      .where(and(eq(s.channelAccount.operatorId, oto), eq(s.channelAccount.provider, 'simulator')));
    const convs = await db
      .select()
      .from(s.conversation)
      .where(inArray(s.conversation.channelAccountId, sim.map((x) => x.id)));
    expect(convs).toHaveLength(10);
    const tally = (k: keyof (typeof convs)[number]) =>
      convs.reduce<Record<string, number>>((acc, c) => ({ ...acc, [String(c[k])]: (acc[String(c[k])] ?? 0) + 1 }), {});
    expect(tally('category')).toEqual({ birthdays: 4, general: 4, marketing: 2 });
    expect(tally('language')).toEqual({ en: 5, ru: 2, th: 3 });
    expect(tally('status')).toEqual({ active: 7, handled: 3 });

    // Every thread has exactly one active primary.
    const primaries = await db
      .select()
      .from(s.assignment)
      .where(
        and(
          inArray(s.assignment.conversationId, convs.map((c) => c.id)),
          eq(s.assignment.slot, 'primary'),
          isNull(s.assignment.releasedAt),
        ),
      );
    expect(primaries).toHaveLength(10);

    // The demo people are on the rules and in their teams.
    const named = await db
      .select()
      .from(s.routingRule)
      .where(and(eq(s.routingRule.operatorId, oto), eq(s.routingRule.primaryKind, 'account')));
    expect(named).toHaveLength(4);
    const phones = Object.values(DEMO_STAFF).map((p) => p.phone);
    const staffAccounts = await db
      .select({ id: s.account.id })
      .from(s.account)
      .where(and(eq(s.account.operatorId, oto), inArray(s.account.phone, phones)));
    expect(staffAccounts).toHaveLength(6);
    const grants = await db
      .select({ scopeType: s.roleAssignment.scopeType })
      .from(s.roleAssignment)
      .where(inArray(s.roleAssignment.accountId, staffAccounts.map((x) => x.id)));
    expect(grants.filter((g) => g.scopeType === 'department')).toHaveLength(5);
    expect(grants.filter((g) => g.scopeType === 'operator')).toHaveLength(1);
  });

  it('never copies a message body into the timeline', async () => {
    const payloads = await pool.query<{ p: string }>(`select payload::text as p from inbox.event`);
    const bodies = DEMO_CONVERSATIONS.flatMap((c) => c.messages.map((m) => m.text));
    for (const { p } of payloads.rows) {
      for (const body of bodies) expect(p.includes(body)).toBe(false);
    }
    expect(payloads.rows.length).toBeGreaterThan(20);
  });
});
