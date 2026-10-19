import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema as s, type Db } from '@oto/db';
import {
  DEMO_CONVERSATIONS,
  DEMO_STAFF,
  InboxDemoRefusedError,
  seedInboxDemo,
} from '@oto/db/seed';
import { simulatorDemoDelivery } from '../src/services/inbox/simulator';
import { createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * S2-19 I1b (SCRUM-579) — the Inbox's demo conversations.
 *
 * `pnpm --filter @oto/db seed:inbox-demo` on top of the full seed: ten
 * fictional threads, six demo staff, the blank routing rules named — once,
 * whatever number of times it runs — and never on production. Moved here
 * from `packages/db/test` by I2d (SCRUM-583): the demo is now PLAYED through
 * the api's simulator and ingest (`simulatorDemoDelivery`), which the db
 * package cannot reach. The counts are I1b's, unchanged — they read the
 * tables, not the path that filled them.
 */

let ctx: TestContext;
let db: Db;
const deliver = () => simulatorDemoDelivery(ctx.app.inboxChannels);

beforeAll(async () => {
  ctx = await createTestContext({ env: { INBOX_SIMULATOR: 'on', INBOX_SIMULATOR_SECRET: 'i1b-demo-secret' } });
  db = ctx.db;
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

const operatorByName = async (name: string) =>
  (await db.select({ id: s.operator.id }).from(s.operator).where(eq(s.operator.name, name)).limit(1))[0]!.id;

describe('the demo conversations (I1b)', () => {
  it('is refused on production before it reads anything', async () => {
    await expect(seedInboxDemo(db, { env: { SEED_PROFILE: 'production' }, deliver: deliver() })).rejects.toBeInstanceOf(InboxDemoRefusedError);
    await expect(seedInboxDemo(db, { env: { DEPLOY_ENV: 'production' }, deliver: deliver() })).rejects.toBeInstanceOf(InboxDemoRefusedError);
  });

  it('writes ten conversations, six staff and names the blank rules — once', async () => {
    const oto = await operatorByName('OTO');
    const now = new Date('2026-10-20T08:00:00Z');
    const first = await seedInboxDemo(db, { now, env: {}, deliver: deliver() });
    expect(first.conversationsCreated).toBe(10);
    expect(first.staffCreated).toBe(6);
    expect(first.rulesNamed).toBe(4);
    expect(first.channelAccountsCreated).toBe(4);

    const second = await seedInboxDemo(db, { now, env: {}, deliver: deliver() });
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
    const payloads = await ctx.app.db.execute<{ p: string }>(sql`select payload::text as p from inbox.event`);
    const bodies = DEMO_CONVERSATIONS.flatMap((c) => c.messages.map((m) => m.text));
    for (const { p } of payloads.rows) {
      for (const body of bodies) expect(p.includes(body)).toBe(false);
    }
    expect(payloads.rows.length).toBeGreaterThan(20);
  });
});
