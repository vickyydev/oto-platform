import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { INBOX_ROLE_BUNDLES, INBOX_TEMPLATE_KEY_NAMES, newId } from '@oto/shared';
import { schema, type Db } from '../src/index';
import * as s from '../src/schema/index';
import { INBOX_TEMPLATE_KEYS } from '../src/schema/inbox';
import { seed, SECOND_OPERATOR_NAME } from '../src/seed/index';
import { syncInboxSetup } from '../src/seed/inbox';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-590 (Inbox AI, round A1, lane b) — migration `0080_inbox_ai` and what
 * platform-sync lays for the customer assistant.
 *
 * Plan: docs/progress/plans/inbox-ai-build/PLAN.md, "What Phase 2 changes in
 * the rails" R1, §A, §C.1, §D, §E. Against a real database, as `inbox-i1`,
 * because what is worth asserting is the database's own: the one-pending-turn
 * index, the tenant fence, the no-text rule on a turn, the de-identification
 * rule on an approved example.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const AI_TABLES = ['ai_example', 'ai_turn', 'kb_entry'];

let db: Db;
let url: string;
let pool: pg.Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
  const made = await createTestDatabase();
  url = made.url;
  drop = made.drop;
  pool = new pg.Pool({ connectionString: url });
  db = drizzle(pool, { schema }) as Db;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await drop?.();
  await stopTestServer();
});

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

async function expectPgError(run: () => Promise<unknown>, code: string, constraint?: string): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected a ${code} refusal`).toBeDefined();
  expect(pgCode(caught)).toBe(code);
  if (constraint) {
    const e = caught as { constraint?: string; cause?: { constraint?: string } };
    expect(e.constraint ?? e.cause?.constraint).toBe(constraint);
  }
}

const operatorByName = async (name: string) =>
  (await db.select({ id: s.operator.id }).from(s.operator).where(eq(s.operator.name, name)).limit(1))[0]!.id;

describe('0080_inbox_ai — structure', () => {
  it('adds the three assistant tables and writes no row in them', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'inbox' and table_name = any($1) order by 1`,
      [AI_TABLES],
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(AI_TABLES);
    for (const t of AI_TABLES) {
      const r = await pool.query<{ n: number }>(`select count(*)::int as n from inbox.${t}`);
      expect(r.rows[0]!.n, t).toBe(0);
    }
  });

  it('gives every channel account an assistant switch that defaults to off, and every thread a pause', async () => {
    const cols = await pool.query<{ table_name: string; column_name: string; column_default: string | null; is_nullable: string }>(
      `select table_name, column_name, column_default, is_nullable from information_schema.columns
        where table_schema = 'inbox' and column_name in ('ai_mode', 'ai_paused_at', 'ai_paused_by_account_id')
        order by 1, 2`,
    );
    expect(cols.rows.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      'channel_account.ai_mode',
      'conversation.ai_paused_at',
      'conversation.ai_paused_by_account_id',
    ]);
    const mode = cols.rows.find((c) => c.column_name === 'ai_mode')!;
    expect(mode.column_default).toBe(`'off'::text`);
    expect(mode.is_nullable).toBe('NO');
  });

  it('holds no free text on a turn: every text column is an enum or a single word, by CHECK', async () => {
    const cols = await pool.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'inbox' and table_name = 'ai_turn' order by ordinal_position`,
    );
    const textCols = cols.rows.filter((c) => c.data_type === 'text').map((c) => c.column_name);
    expect(textCols.sort()).toEqual(
      ['action', 'certainty', 'intent', 'kb_version', 'language', 'model', 'persona_version', 'reason', 'state'].sort(),
    );
    // Each of them is named by some CHECK on the table.
    const checks = await pool.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = 'inbox.ai_turn'::regclass and c.contype = 'c'`,
    );
    const all = checks.rows.map((r) => r.def).join('\n');
    for (const col of textCols) expect(all, col).toContain(col);
  });

  it('applies a second time as a clean no-op', () => {
    expect(() =>
      execFileSync('node', [join(PKG, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'migrate'], {
        cwd: PKG,
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('keeps the template key list said once: the database, @oto/db and @oto/shared agree', () => {
    expect([...INBOX_TEMPLATE_KEY_NAMES]).toEqual([...INBOX_TEMPLATE_KEYS]);
    expect(INBOX_TEMPLATE_KEYS).toContain('handover_general');
  });
});

describe('platform-sync for the assistant', () => {
  let oto: string;
  let second: string;

  beforeAll(async () => {
    await seed(db);
    oto = await operatorByName('OTO');
    second = await operatorByName(SECOND_OPERATOR_NAME);
  }, 300_000);

  it('lays handover_general in en, ru and th at every operator, each language in its own words', async () => {
    for (const operatorId of [oto, second]) {
      const rows = await db
        .select()
        .from(s.template)
        .where(and(eq(s.template.operatorId, operatorId), eq(s.template.key, 'handover_general')));
      expect(rows.map((r) => r.language).sort()).toEqual(['en', 'ru', 'th']);
      for (const r of rows) {
        expect(r.channel).toBeNull();
        expect(r.branchId).toBeNull();
        expect(r.active).toBe(true);
        expect(r.approvalStatus).toBe('not_required');
        // The test night (SCRUM-220) translated every line: nothing waits for a translator.
        expect(r.needsTranslation).toBe(false);
        expect(r.body.length).toBeGreaterThan(0);
      }
      expect(new Set(rows.map((r) => r.body)).size).toBe(3);
    }
  });

  it('leaves every channel account with the assistant off', async () => {
    const accounts = await db.select({ aiMode: s.channelAccount.aiMode }).from(s.channelAccount);
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.every((a) => a.aiMode === 'off')).toBe(true);
  });

  it('gives a newly laid inbox_admin the two assistant permissions, and no other inbox role', async () => {
    expect(INBOX_ROLE_BUNDLES.inbox_admin).toEqual(expect.arrayContaining(['inbox:kb:manage', 'inbox:ai:manage']));
    expect(INBOX_ROLE_BUNDLES.inbox_manager).not.toContain('inbox:kb:manage');
    expect(INBOX_ROLE_BUNDLES.inbox_manager).not.toContain('inbox:ai:manage');
    const [admin] = await db
      .select({ id: s.role.id })
      .from(s.role)
      .where(and(eq(s.role.operatorId, oto), eq(s.role.name, 'inbox_admin')));
    const perms = (
      await db.select({ p: s.rolePermission.permission }).from(s.rolePermission).where(eq(s.rolePermission.roleId, admin!.id))
    ).map((x) => x.p);
    expect(perms).toEqual(expect.arrayContaining(['inbox:kb:manage', 'inbox:ai:manage']));
    const [opAdmin] = await db
      .select({ id: s.role.id })
      .from(s.role)
      .where(and(eq(s.role.name, 'operator_admin'), isNull(s.role.operatorId)));
    const opPerms = (
      await db.select({ p: s.rolePermission.permission }).from(s.rolePermission).where(eq(s.rolePermission.roleId, opAdmin!.id))
    ).map((x) => x.p);
    expect(opPerms).toEqual(expect.arrayContaining(['inbox:kb:manage', 'inbox:ai:manage']));
  });

  it('an operator synced before the key existed gets its three rows on the next sync, once, and an archived row stays archived', async () => {
    // As staging stands before this deploy: the operator's inbox laid, with no handover_general.
    await db.delete(s.template).where(and(eq(s.template.operatorId, second), eq(s.template.key, 'handover_general')));
    const first = await syncInboxSetup(db);
    expect(first.templates).toBe(3);
    expect(first.operators).toBe(1);

    const [th] = await db
      .select()
      .from(s.template)
      .where(and(eq(s.template.operatorId, second), eq(s.template.key, 'handover_general'), eq(s.template.language, 'th')));
    await db.update(s.template).set({ archivedAt: new Date() }).where(eq(s.template.id, th!.id));

    const again = await syncInboxSetup(db);
    expect(again.templates).toBe(0);
    expect(again.operators).toBe(0);
    const rows = await db
      .select()
      .from(s.template)
      .where(and(eq(s.template.operatorId, second), eq(s.template.key, 'handover_general')));
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === th!.id)!.archivedAt).not.toBeNull();
  });

  it('heals an inbox_admin laid under the old list: exactly the two assistant permissions, once; a custom role is untouched (A3 grant step)', async () => {
    const [admin] = await db
      .select({ id: s.role.id })
      .from(s.role)
      .where(and(eq(s.role.operatorId, second), eq(s.role.name, 'inbox_admin')));
    const permsOf = async (roleId: string) =>
      (await db.select({ p: s.rolePermission.permission }).from(s.rolePermission).where(eq(s.rolePermission.roleId, roleId)))
        .map((x) => x.p)
        .sort();
    // As a deployed database stands: the role laid before SCRUM-590 joined the bundle.
    await db
      .delete(s.rolePermission)
      .where(
        and(
          eq(s.rolePermission.roleId, admin!.id),
          inArray(s.rolePermission.permission, ['inbox:kb:manage', 'inbox:ai:manage']),
        ),
      );
    // An operator's edit to the role (a permission taken out) is theirs to keep.
    await db
      .delete(s.rolePermission)
      .where(and(eq(s.rolePermission.roleId, admin!.id), eq(s.rolePermission.permission, 'inbox:routing:manage')));
    const oldList = await permsOf(admin!.id);
    // A custom role of the same operator, carrying none of the assistant permissions.
    const customId = newId();
    await db.insert(s.role).values({ id: customId, operatorId: second, name: 'marketing_custom', description: 'custom', isSystem: false });
    await db.insert(s.rolePermission).values({ id: newId(), roleId: customId, permission: 'inbox:conversation:read' });

    const first = await syncInboxSetup(db);
    expect(first.grants).toBe(2);
    const healed = await permsOf(admin!.id);
    expect(healed.filter((p) => !oldList.includes(p)).sort()).toEqual(['inbox:ai:manage', 'inbox:kb:manage']);
    expect(healed).not.toContain('inbox:routing:manage');
    expect(await permsOf(customId)).toEqual(['inbox:conversation:read']);

    const again = await syncInboxSetup(db);
    expect(again.grants).toBe(0);
    expect(await permsOf(admin!.id)).toEqual(healed);
  });

  it('a sync never switches an account on: a live account stays live, an off one stays off', async () => {
    const [one] = await db.select().from(s.channelAccount).where(eq(s.channelAccount.operatorId, oto)).limit(1);
    await db.update(s.channelAccount).set({ aiMode: 'shadow' }).where(eq(s.channelAccount.id, one!.id));
    await syncInboxSetup(db);
    const [after] = await db.select().from(s.channelAccount).where(eq(s.channelAccount.id, one!.id));
    expect(after!.aiMode).toBe('shadow');
    await db.update(s.channelAccount).set({ aiMode: 'off' }).where(eq(s.channelAccount.id, one!.id));
  });
});

describe('the database refuses what the assistant must never write', () => {
  /** A thread with one inbound customer message, in one operator. */
  async function thread(operatorId: string, tag: string) {
    const channelAccountId = newId();
    await db.insert(s.channelAccount).values({
      id: channelAccountId,
      operatorId,
      channel: 'whatsapp',
      provider: 'meta_cloud',
      externalId: `ai-${tag}-${channelAccountId}`,
      displayName: `AI ${tag}`,
    });
    const contactId = newId();
    await db.insert(s.contact).values({ id: contactId, operatorId, channel: 'whatsapp', externalHandle: `h-${contactId}` });
    const conversationId = newId();
    await db.insert(s.conversation).values({ id: conversationId, operatorId, contactId, channelAccountId });
    const messageId = newId();
    await db.insert(s.message).values({
      id: messageId,
      operatorId,
      conversationId,
      channelAccountId,
      direction: 'inbound',
      authorKind: 'customer',
      body: 'hi',
    });
    const accounts = await db.select({ id: s.account.id }).from(s.account).where(eq(s.account.operatorId, operatorId)).limit(2);
    return { operatorId, channelAccountId, conversationId, messageId, accounts: accounts.map((a) => a.id) };
  }

  let a: Awaited<ReturnType<typeof thread>>;
  let b: Awaited<ReturnType<typeof thread>>;

  const turn = (
    t: Awaited<ReturnType<typeof thread>>,
    over: Partial<typeof s.aiTurn.$inferInsert> = {},
  ): typeof s.aiTurn.$inferInsert => ({
    id: newId(),
    operatorId: t.operatorId,
    conversationId: t.conversationId,
    triggerMessageId: t.messageId,
    dueAt: new Date(Date.now() + 20_000),
    ...over,
  });

  beforeAll(async () => {
    a = await thread(await operatorByName('OTO'), 'a');
    b = await thread(await operatorByName(SECOND_OPERATOR_NAME), 'b');
  });

  describe('ai_turn', () => {
    it('holds one pending turn per thread; a finished one frees the place', async () => {
      const first = turn(a);
      await db.insert(s.aiTurn).values(first);
      await expectPgError(() => db.insert(s.aiTurn).values(turn(a)), '23505', 'ai_turn_pending_unique');
      // Another thread is another place.
      await db.insert(s.aiTurn).values(turn(b));
      // Claimed (deciding under a lease), the thread may hold a new pending turn.
      await db
        .update(s.aiTurn)
        .set({ state: 'deciding', attempts: 1, leaseUntil: new Date(Date.now() + 90_000) })
        .where(eq(s.aiTurn.id, first.id!));
      await db.insert(s.aiTurn).values(turn(a));
      const pending = await db
        .select()
        .from(s.aiTurn)
        .where(and(eq(s.aiTurn.conversationId, a.conversationId), eq(s.aiTurn.state, 'pending')));
      expect(pending).toHaveLength(1);
      // Clear the thread's pending turn for the cases below.
      await db.update(s.aiTurn).set({ state: 'cancelled', reason: 'STAFF_REPLY' }).where(eq(s.aiTurn.id, pending[0]!.id));
    });

    it('refuses a turn that reaches into another operator’s thread or message', async () => {
      await expectPgError(
        () => db.insert(s.aiTurn).values(turn(b, { conversationId: a.conversationId, state: 'silent' })),
        '23503',
        'ai_turn_conversation_fk',
      );
      await expectPgError(
        () => db.insert(s.aiTurn).values(turn(b, { triggerMessageId: a.messageId, state: 'silent' })),
        '23503',
        'ai_turn_trigger_message_fk',
      );
    });

    it('takes a reason, an intent and a model only as one word — never a sentence', async () => {
      await db.insert(s.aiTurn).values(
        turn(a, {
          state: 'silent',
          reason: 'GUARD_NUMBER',
          intent: 'ticket_prices',
          action: 'answer',
          certainty: 'sure',
          language: 'th',
          model: 'claude-opus-5-5',
          personaVersion: 'th-2026.10.20',
          kbVersion: 'kb:3f9a',
          inputTokens: 12000,
          outputTokens: 700,
          cacheReadTokens: 11000,
          latencyMs: 2300,
        }),
      );
      await expectPgError(
        () => db.insert(s.aiTurn).values(turn(a, { state: 'silent', reason: 'the customer asked for a refund' })),
        '23514',
        'ai_turn_reason_check',
      );
      await expectPgError(
        () => db.insert(s.aiTurn).values(turn(a, { state: 'silent', intent: 'wants 50% off' })),
        '23514',
        'ai_turn_intent_check',
      );
      await expectPgError(
        () => db.insert(s.aiTurn).values(turn(a, { state: 'silent', model: 'claude says hello' })),
        '23514',
        'ai_turn_version_words_check',
      );
      await expectPgError(
        () => db.insert(s.aiTurn).values(turn(a, { state: 'thinking' as never })),
        '23514',
        'ai_turn_state_check',
      );
      await expectPgError(
        () => db.insert(s.aiTurn).values(turn(a, { state: 'silent', inputTokens: -1 })),
        '23514',
        'ai_turn_counts_check',
      );
    });

    it('refuses a claimed turn with no lease', async () => {
      await expectPgError(
        () => db.insert(s.aiTurn).values(turn(a, { state: 'deciding', attempts: 1 })),
        '23514',
        'ai_turn_lease_check',
      );
    });
  });

  describe('the widened lists and the switches', () => {
    it('accepts a withdrawn AI line and the three assistant pills', async () => {
      await db.insert(s.message).values({
        id: newId(),
        operatorId: a.operatorId,
        conversationId: a.conversationId,
        channelAccountId: a.channelAccountId,
        direction: 'outbound',
        authorKind: 'ai',
        body: 'x',
        // The column's TypeScript type widens with the send path (round A2b);
        // the database takes `withdrawn` from 0080 on.
        providerStatus: 'withdrawn' as never,
      });
      for (const kind of ['ai_handover', 'ai_silent', 'ai_withdrawn'] as const) {
        await db.insert(s.inboxEvent).values({
          id: newId(),
          operatorId: a.operatorId,
          conversationId: a.conversationId,
          kind,
          actorKind: 'ai',
          payload: { reason: 'UNSURE' },
        });
      }
      const n = await db
        .select()
        .from(s.inboxEvent)
        .where(and(eq(s.inboxEvent.conversationId, a.conversationId), inArray(s.inboxEvent.kind, ['ai_handover', 'ai_silent', 'ai_withdrawn'])));
      expect(n).toHaveLength(3);
    });

    it('refuses an unknown assistant mode, and a pause that names a person but no time', async () => {
      await expectPgError(
        () => db.update(s.channelAccount).set({ aiMode: 'auto' as never }).where(eq(s.channelAccount.id, a.channelAccountId)),
        '23514',
        'channel_account_ai_mode_check',
      );
      await expectPgError(
        () =>
          db
            .update(s.conversation)
            .set({ aiPausedByAccountId: a.accounts[0]! })
            .where(eq(s.conversation.id, a.conversationId)),
        '23514',
        'conversation_ai_paused_check',
      );
      await db
        .update(s.conversation)
        .set({ aiPausedAt: new Date(), aiPausedByAccountId: a.accounts[0]! })
        .where(eq(s.conversation.id, a.conversationId));
    });
  });

  describe('kb_entry', () => {
    const entry = (over: Partial<typeof s.kbEntry.$inferInsert> = {}): typeof s.kbEntry.$inferInsert => ({
      id: newId(),
      operatorId: a.operatorId,
      topic: 'socks',
      key: 'socks.policy',
      language: 'en',
      question: 'Do I need socks?',
      body: 'Socks are required for everyone on the play floor.',
      ...over,
    });

    it('keeps one live entry per key, language and park; archiving frees the key', async () => {
      const first = entry();
      await db.insert(s.kbEntry).values(first);
      await expectPgError(() => db.insert(s.kbEntry).values(entry()), '23505', 'kb_entry_key_unique');
      // Another language, or the other operator, is another entry.
      await db.insert(s.kbEntry).values(entry({ language: 'th', needsTranslation: true }));
      await db.insert(s.kbEntry).values(entry({ operatorId: b.operatorId }));
      await db.update(s.kbEntry).set({ status: 'archived' }).where(eq(s.kbEntry.id, first.id!));
      await db.insert(s.kbEntry).values(entry());
    });

    it('refuses an approval that says nobody, a key that is not a slug, an unknown topic and an overlong body', async () => {
      await expectPgError(
        () => db.insert(s.kbEntry).values(entry({ key: 'faq.a', status: 'approved' })),
        '23514',
        'kb_entry_approved_check',
      );
      await db
        .insert(s.kbEntry)
        .values(entry({ key: 'faq.b', status: 'approved', approvedByAccountId: a.accounts[0]!, approvedAt: new Date() }));
      await expectPgError(() => db.insert(s.kbEntry).values(entry({ key: 'Socks Policy' })), '23514', 'kb_entry_key_check');
      await expectPgError(
        () => db.insert(s.kbEntry).values(entry({ key: 'faq.c', topic: 'refunds' as never })),
        '23514',
        'kb_entry_topic_check',
      );
      await expectPgError(
        () => db.insert(s.kbEntry).values(entry({ key: 'faq.d', body: 'x'.repeat(1201) })),
        '23514',
        'kb_entry_length_check',
      );
    });
  });

  describe('ai_example — the de-identification rule', () => {
    const example = (over: Partial<typeof s.aiExample.$inferInsert> = {}): typeof s.aiExample.$inferInsert => ({
      id: newId(),
      operatorId: a.operatorId,
      intent: 'socks',
      language: 'en',
      customerText: 'Do kids need socks?',
      goodReply: 'Yes, socks are needed on the play floor 😊',
      verdict: 'should_answer',
      proposedByAccountId: a.accounts[0]!,
      sourceMessageId: a.messageId,
      sourceConversationId: a.conversationId,
      ...over,
    });

    it('keeps its source links while proposed', async () => {
      await db.insert(s.aiExample).values(example());
    });

    it('cannot be approved without the confirmation, an approver, or while it still points at a thread', async () => {
      const approved = { status: 'approved' as const, approvedByAccountId: a.accounts[1] ?? a.accounts[0]!, approvedAt: new Date() };
      await expectPgError(
        () => db.insert(s.aiExample).values(example({ ...approved, sourceMessageId: null, sourceConversationId: null })),
        '23514',
        'ai_example_approved_check',
      );
      await expectPgError(
        () => db.insert(s.aiExample).values(example({ ...approved, deidentifiedConfirmed: true, sourceMessageId: null })),
        '23514',
        'ai_example_approved_check',
      );
      await expectPgError(
        () =>
          db.insert(s.aiExample).values(
            example({ status: 'approved', deidentifiedConfirmed: true, sourceMessageId: null, sourceConversationId: null }),
          ),
        '23514',
        'ai_example_approved_check',
      );
      await db
        .insert(s.aiExample)
        .values(example({ ...approved, deidentifiedConfirmed: true, sourceMessageId: null, sourceConversationId: null }));
    });

    it('refuses an answer verdict with no answer, and an intent that is a sentence', async () => {
      await expectPgError(
        () => db.insert(s.aiExample).values(example({ goodReply: null })),
        '23514',
        'ai_example_reply_check',
      );
      await db.insert(s.aiExample).values(example({ goodReply: null, verdict: 'should_handover' }));
      await expectPgError(
        () => db.insert(s.aiExample).values(example({ intent: 'asks about socks' })),
        '23514',
        'ai_example_intent_check',
      );
    });
  });
});
