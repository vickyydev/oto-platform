import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import {
  ASSISTANT_ASK_STATES,
  ASSISTANT_ERROR_CODE,
  ASSISTANT_REASON_WORD,
  ASSISTANT_ROUTE_TEMPLATE,
  ASSISTANT_TOOL_NAME,
  ASSISTANT_VERSION_WORD,
  INBOX_ROLE_BUNDLES,
  INBOX_ROLES,
  newId,
} from '@oto/shared';
import { schema, type Db } from '../src/index';
import * as s from '../src/schema/index';
import { OWNED_SCHEMAS } from '../src/schema/helpers';
import { seed, SECOND_OPERATOR_NAME } from '../src/seed/index';
import { syncInboxSetup } from '../src/seed/inbox';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-591 (internal assistant, round I1, lane b) — migration
 * `0081_assistant` and the two permissions platform-sync lays.
 *
 * Plan: docs/progress/plans/internal-assistant-build/PLAN.md §D.3 (the
 * ask-log), §E.1 (text lives only in the ask-log), §E.2 and R5 (the
 * permissions). Against a real database, as `inbox-ai-a1b`, because what is
 * worth asserting is the database's own: the tenant fence, the GET-only route
 * template, the no-text rule on a tool call, the cascade the purge leans on.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TABLES = ['ask', 'tool_call'];

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

describe('0081_assistant — structure', () => {
  it('creates the assistant schema with its two tables and writes no row', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'assistant' and table_type = 'BASE TABLE' order by 1`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(TABLES);
    for (const t of TABLES) {
      const r = await pool.query<{ n: number }>(`select count(*)::int as n from assistant.${t}`);
      expect(r.rows[0]!.n, t).toBe(0);
    }
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

  it('is a schema this package owns: OWNED_SCHEMAS and the drizzle schemaFilter both name it', () => {
    expect(OWNED_SCHEMAS).toContain('assistant');
    const config = readFileSync(join(PKG, 'drizzle.config.ts'), 'utf8');
    const filter = /schemaFilter:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '';
    const listed = [...filter.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...OWNED_SCHEMAS].sort());
  });

  it('indexes every foreign key in the assistant schema', async () => {
    const fks = await pool.query<{ table: string; name: string; cols: string[] }>(`
      select c.conrelid::regclass::text as table, c.conname as name,
             array_agg(a.attname::text order by k.ord) as cols
      from pg_constraint c
      join pg_namespace n on n.oid = c.connamespace
      cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype = 'f' and n.nspname = 'assistant'
      group by c.conrelid, c.conname`);
    const idx = await pool.query<{ table: string; cols: string[] }>(`
      select i.indrelid::regclass::text as table,
             array(select a.attname::text from unnest(i.indkey) with ordinality as k(attnum, ord)
                   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                   order by k.ord) as cols
      from pg_index i join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'assistant'`);
    const unindexed = fks.rows.filter((fk) => {
      const want = new Set(fk.cols);
      return !idx.rows.some(
        (i) => i.table === fk.table && i.cols.length >= want.size && i.cols.slice(0, want.size).every((c) => want.has(c)),
      );
    });
    expect(unindexed.map((f) => `${f.table}.${f.name}`)).toEqual([]);
    expect(fks.rows.length).toBe(5);
  });

  async function textColumnsAndChecks(table: string) {
    const cols = await pool.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_schema = 'assistant' and table_name = $1 order by ordinal_position`,
      [table],
    );
    const checks = await pool.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = $1::regclass and c.contype = 'c'`,
      [`assistant.${table}`],
    );
    return {
      text: cols.rows.filter((c) => c.data_type === 'text').map((c) => c.column_name),
      checks: checks.rows.map((r) => r.def).join('\n'),
    };
  }

  it('holds no free text on a tool call: every text column is an enum or a single word, by CHECK, and no body column exists', async () => {
    const { text, checks } = await textColumnsAndChecks('tool_call');
    expect(text.sort()).toEqual(['code', 'route', 'system', 'tool']);
    for (const col of text) expect(checks, col).toContain(col);
    const all = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_schema = 'assistant' and table_name = 'tool_call'`,
    );
    expect(all.rows.map((c) => c.column_name)).not.toEqual(expect.arrayContaining(['body']));
    expect(all.rows.map((c) => c.column_name).some((c) => /body|response|result/.test(c))).toBe(false);
  });

  it('holds free text on an ask only in the question, the answer and the correction (§E.1)', async () => {
    const { text, checks } = await textColumnsAndChecks('ask');
    const free = ['answer', 'correction', 'question'];
    expect(text.filter((c) => !free.includes(c)).sort()).toEqual(['feedback', 'model', 'persona_version', 'reason', 'state']);
    for (const col of text) expect(checks, col).toContain(col);
  });

  it('keeps the word shapes said once: the database CHECKs and @oto/shared agree', async () => {
    const all = (await textColumnsAndChecks('tool_call')).checks + (await textColumnsAndChecks('ask')).checks;
    for (const re of [ASSISTANT_REASON_WORD, ASSISTANT_VERSION_WORD, ASSISTANT_TOOL_NAME, ASSISTANT_ROUTE_TEMPLATE, ASSISTANT_ERROR_CODE]) {
      // `RegExp.source` writes a slash as `\/`; the database spells it plainly.
      expect(all, String(re)).toContain(`'${re.source.replaceAll('\\/', '/')}'`);
    }
    for (const state of ASSISTANT_ASK_STATES) expect(all).toContain(`'${state}'`);
  });
});

describe('platform-sync lays the two permissions', () => {
  let oto: string;
  let second: string;

  beforeAll(async () => {
    await seed(db);
    oto = await operatorByName('OTO');
    second = await operatorByName(SECOND_OPERATOR_NAME);
  }, 300_000);

  const permsOf = async (roleId: string) =>
    (await db.select({ p: s.rolePermission.permission }).from(s.rolePermission).where(eq(s.rolePermission.roleId, roleId)))
      .map((x) => x.p)
      .sort();

  const systemRole = async (name: string) =>
    (await db.select({ id: s.role.id }).from(s.role).where(and(eq(s.role.name, name), isNull(s.role.operatorId))))[0]!.id;

  it('gives the ask to every system role, and the log review to the two administrators only', async () => {
    for (const name of ['platform_admin', 'operator_admin', 'branch_manager', 'reception', 'staff']) {
      const perms = await permsOf(await systemRole(name));
      expect(perms, name).toContain('assistant:ask:use');
      expect(perms.includes('assistant:log:review'), name).toBe(name === 'platform_admin' || name === 'operator_admin');
    }
  });

  it('gives the ask to every inbox role laid fresh, at every operator', async () => {
    for (const operatorId of [oto, second]) {
      const roles = await db
        .select({ id: s.role.id, name: s.role.name })
        .from(s.role)
        .where(and(eq(s.role.operatorId, operatorId), inArray(s.role.name, [...INBOX_ROLES])));
      expect(roles).toHaveLength(3);
      for (const r of roles) {
        const perms = await permsOf(r.id);
        expect(perms, r.name).toContain('assistant:ask:use');
        expect(perms).toEqual([...INBOX_ROLE_BUNDLES[r.name as (typeof INBOX_ROLES)[number]]].sort());
      }
    }
  });

  it('heals inbox roles laid before the assistant: the ask added once to each, nothing removed, a custom role untouched', async () => {
    const roles = await db
      .select({ id: s.role.id, name: s.role.name })
      .from(s.role)
      .where(and(eq(s.role.operatorId, second), inArray(s.role.name, [...INBOX_ROLES])));
    // As a deployed database stands: the roles laid before SCRUM-591 joined the bundles.
    await db
      .delete(s.rolePermission)
      .where(
        and(
          inArray(
            s.rolePermission.roleId,
            roles.map((r) => r.id),
          ),
          eq(s.rolePermission.permission, 'assistant:ask:use'),
        ),
      );
    // An operator's edit to a role (a permission taken out) is theirs to keep.
    const agent = roles.find((r) => r.name === 'inbox_agent')!;
    await db
      .delete(s.rolePermission)
      .where(and(eq(s.rolePermission.roleId, agent.id), eq(s.rolePermission.permission, 'inbox:dashboard:read')));
    const before = new Map(await Promise.all(roles.map(async (r) => [r.id, await permsOf(r.id)] as const)));
    // A custom role of the same operator, with no assistant permission.
    const customId = newId();
    await db.insert(s.role).values({ id: customId, operatorId: second, name: 'front_desk_custom', description: 'custom', isSystem: false });
    await db.insert(s.rolePermission).values({ id: newId(), roleId: customId, permission: 'pos:member:read' });

    const first = await syncInboxSetup(db);
    expect(first.grants).toBe(3);
    for (const r of roles) {
      const healed = await permsOf(r.id);
      expect(healed.filter((p) => !before.get(r.id)!.includes(p)), r.name).toEqual(['assistant:ask:use']);
    }
    expect(await permsOf(agent.id)).not.toContain('inbox:dashboard:read');
    expect(await permsOf(customId)).toEqual(['pos:member:read']);

    const again = await syncInboxSetup(db);
    expect(again.grants).toBe(0);
  });
});

describe('the database refuses what the ask-log must never hold', () => {
  let a: { operatorId: string; accountId: string; branchId: string };
  let b: { operatorId: string; accountId: string };

  const ask = (
    who: { operatorId: string; accountId: string },
    over: Partial<typeof s.ask.$inferInsert> = {},
  ): typeof s.ask.$inferInsert => ({
    id: newId(),
    operatorId: who.operatorId,
    accountId: who.accountId,
    sessionId: newId(),
    question: "Anan's attendance this month",
    ...over,
  });

  const call = (
    operatorId: string,
    askId: string,
    over: Partial<typeof s.toolCall.$inferInsert> = {},
  ): typeof s.toolCall.$inferInsert => ({
    id: newId(),
    operatorId,
    askId,
    seq: 1,
    tool: 'members.lookup',
    system: 'platform',
    route: 'GET /members/lookup',
    args: { phone: '+66812345678' },
    ...over,
  });

  beforeAll(async () => {
    const oto = await operatorByName('OTO');
    const other = await operatorByName(SECOND_OPERATOR_NAME);
    const [accA] = await db.select({ id: s.account.id }).from(s.account).where(eq(s.account.operatorId, oto)).limit(1);
    const [br] = await db.select({ id: s.branch.id }).from(s.branch).where(eq(s.branch.operatorId, oto)).limit(1);
    const [accB] = await db.select({ id: s.account.id }).from(s.account).where(eq(s.account.operatorId, other)).limit(1);
    a = { operatorId: oto, accountId: accA!.id, branchId: br!.id };
    b = { operatorId: other, accountId: accB!.id };
  });

  it('writes an ask first in `asking`, with 90 days to live and nothing answered yet', async () => {
    const row = ask(a, { branchId: a.branchId });
    await db.insert(s.ask).values(row);
    const [stored] = await db.select().from(s.ask).where(eq(s.ask.id, row.id!));
    expect(stored).toMatchObject({ state: 'asking', answer: null, links: [], refusals: [], feedback: null });
    const days = (stored!.purgeAfter.getTime() - stored!.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
    // It ends: answered, with its words, tokens, links and refusal lines.
    await db
      .update(s.ask)
      .set({
        state: 'answered',
        answer: 'Anan worked 14 days, 112 hours, late twice.',
        links: [{ key: 'oto.timekeeping.employee', params: { employeeId: 'e1' } }],
        refusals: [{ tool: 'oto.payroll_summary', system: 'oto_app', status: 403, code: null, message: 'Payroll is for payroll roles only (hr.view_salary required).' }],
        model: 'claude-opus-5-5',
        personaVersion: 'internal-2026.10.20',
        inputTokens: 8000,
        outputTokens: 600,
        cacheReadTokens: 6000,
        latencyMs: 4200,
        feedback: 'wrong',
        correction: 'He was late three times.',
      })
      .where(eq(s.ask.id, row.id!));
  });

  it('refuses an unknown state, a sentence for a reason or a model, and negative counts', async () => {
    await expectPgError(() => db.insert(s.ask).values(ask(a, { state: 'thinking' as never })), '23514', 'ask_state_check');
    await expectPgError(
      () => db.insert(s.ask).values(ask(a, { state: 'failed', reason: 'the provider timed out' })),
      '23514',
      'ask_reason_check',
    );
    await expectPgError(
      () => db.insert(s.ask).values(ask(a, { state: 'failed', model: 'claude says hi' })),
      '23514',
      'ask_version_words_check',
    );
    await expectPgError(() => db.insert(s.ask).values(ask(a, { inputTokens: -1 })), '23514', 'ask_counts_check');
    await db.insert(s.ask).values(ask(a, { state: 'link_only', reason: 'GUARD_NUMBER' }));
  });

  it('holds the question, the answer and the correction to their lengths, and links to three', async () => {
    await expectPgError(() => db.insert(s.ask).values(ask(a, { question: '' })), '23514', 'ask_length_check');
    await expectPgError(() => db.insert(s.ask).values(ask(a, { question: 'x'.repeat(2001) })), '23514', 'ask_length_check');
    await db.insert(s.ask).values(ask(a, { question: 'x'.repeat(2000) }));
    await expectPgError(
      () => db.insert(s.ask).values(ask(a, { state: 'answered', answer: 'x'.repeat(4001) })),
      '23514',
      'ask_length_check',
    );
    const link = { key: 'console.health', params: {} };
    await expectPgError(
      () => db.insert(s.ask).values(ask(a, { state: 'answered', links: [link, link, link, link] })),
      '23514',
      'ask_shapes_check',
    );
  });

  it('takes a correction only with a `wrong` verdict, and no verdict while still asking', async () => {
    await expectPgError(
      () => db.insert(s.ask).values(ask(a, { state: 'answered', feedback: 'good', correction: 'nope' })),
      '23514',
      'ask_correction_check',
    );
    await expectPgError(
      () => db.insert(s.ask).values(ask(a, { state: 'answered', correction: 'nope' })),
      '23514',
      'ask_correction_check',
    );
    await expectPgError(
      () => db.insert(s.ask).values(ask(a, { feedback: 'meh' as never, state: 'answered' })),
      '23514',
      'ask_feedback_check',
    );
    await expectPgError(() => db.insert(s.ask).values(ask(a, { feedback: 'good' })), '23514', 'ask_asking_check');
    await expectPgError(() => db.insert(s.ask).values(ask(a, { answer: 'early' })), '23514', 'ask_asking_check');
  });

  it("refuses a tool call that reaches into another operator's ask", async () => {
    const mine = ask(a);
    await db.insert(s.ask).values(mine);
    await expectPgError(() => db.insert(s.toolCall).values(call(b.operatorId, mine.id!)), '23503', 'tool_call_ask_fk');
  });

  it('records a tool call as words and numbers: GET templates only, one word for a code, never a URL with values', async () => {
    const mine = ask(a);
    await db.insert(s.ask).values(mine);
    await db.insert(s.toolCall).values(
      call(a.operatorId, mine.id!, { status: 403, code: 'FORBIDDEN', rows: 0, bytes: 120, latencyMs: 35 }),
    );
    await db.insert(s.toolCall).values(
      call(a.operatorId, mine.id!, {
        seq: 2,
        tool: 'oto.attendance',
        system: 'oto_app',
        route: 'GET /api/timekeeping/employee/:employeeId',
        status: 404,
        code: 'not_provisioned',
        truncated: true,
      }),
    );
    // The same place twice in one ask.
    await expectPgError(() => db.insert(s.toolCall).values(call(a.operatorId, mine.id!)), '23505', 'tool_call_seq_unique');
    for (const [over, constraint] of [
      [{ route: 'POST /members' }, 'tool_call_route_check'],
      [{ route: 'GET /members/lookup?phone=0812345678' }, 'tool_call_route_check'],
      [{ route: 'GET https://evil.example/x' }, 'tool_call_route_check'],
      [{ tool: 'Look up the member' }, 'tool_call_tool_check'],
      [{ system: 'radar' as never }, 'tool_call_system_check'],
      [{ code: 'You hold pos:checkin:read, but not at Chalong' }, 'tool_call_code_check'],
      [{ args: [] as never }, 'tool_call_args_check'],
      [{ status: 99 }, 'tool_call_counts_check'],
      [{ seq: 0 }, 'tool_call_counts_check'],
    ] as const) {
      await expectPgError(
        () => db.insert(s.toolCall).values(call(a.operatorId, mine.id!, { seq: 9, ...over })),
        '23514',
        constraint,
      );
    }
  });

  it('deletes an ask’s tool calls with it — what the purge leans on', async () => {
    const mine = ask(a);
    await db.insert(s.ask).values(mine);
    await db.insert(s.toolCall).values([call(a.operatorId, mine.id!), call(a.operatorId, mine.id!, { seq: 2 })]);
    await db.delete(s.ask).where(eq(s.ask.id, mine.id!));
    expect(await db.select().from(s.toolCall).where(eq(s.toolCall.askId, mine.id!))).toEqual([]);
  });

  it('keeps an ask when its session is gone: the session is a soft link', async () => {
    const mine = ask(a, { sessionId: newId() });
    await db.insert(s.ask).values(mine);
    const [stored] = await db.select().from(s.ask).where(eq(s.ask.id, mine.id!));
    expect(stored!.sessionId).toBe(mine.sessionId);
  });
});
