import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { INBOX_ROLE_BUNDLES, INBOX_ROLES, newId } from '@oto/shared';
import { schema, type Db } from '../src/index';
import * as s from '../src/schema/index';
import { OWNED_SCHEMAS } from '../src/schema/helpers';
import { INBOX_TEMPLATE_KEYS } from '../src/schema/inbox';
import { platformSync, seed, SECOND_OPERATOR_NAME } from '../src/seed/index';
import {
  CONSOLE_NOTICE_CHANNELS,
  INBOX_DEPARTMENTS,
  INBOX_TEMPLATE_BODIES,
  INBOX_TEMPLATE_TRANSLATIONS,
  syncInboxSetup,
} from '../src/seed/inbox';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * S2-19 I1 (SCRUM-578) — the Inbox's schema and its configuration through
 * platform-sync. The demo conversations (I1b) are `inbox-i1b-demo.test.ts`.
 *
 * Plan: docs/progress/plans/inbox-build/PLAN.md §1 and §6 "I1". Against a real
 * database, because every rule worth asserting here is the database's own:
 * the composite tenant fences, the partial unique indexes on the assignment
 * slots, the webhook receipt's dedupe key, and the timeline's append-only
 * trigger — none of which can be proved against the TypeScript.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 0078's fifteen, and the assistant's three from 0080_inbox_ai (SCRUM-590). */
const INBOX_TABLES = [
  'ai_example',
  'ai_turn',
  'assignment',
  'channel_account',
  'contact',
  'conversation',
  'conversation_tag',
  'event',
  'kb_entry',
  'message',
  'note',
  'participant',
  'routing_rule',
  'sla_policy',
  'tag',
  'team',
  'template',
  'webhook_receipt',
];

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

/** The Postgres error code behind a failed statement, through drizzle's wrapper. */
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

async function count(table: string): Promise<number> {
  const r = await pool.query<{ n: string }>(`select count(*)::text as n from inbox.${table}`);
  return Number(r.rows[0]!.n);
}

async function inboxCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of INBOX_TABLES) out[t] = await count(t);
  return out;
}

const operatorByName = async (name: string) =>
  (await db.select({ id: s.operator.id }).from(s.operator).where(eq(s.operator.name, name)).limit(1))[0]!.id;

describe('0078_inbox_schema — structure (I1)', () => {
  it('creates the inbox schema with its eighteen tables and writes no row', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'inbox' and table_type = 'BASE TABLE' order by 1`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(INBOX_TABLES);
    // Migrations own structure, platform-sync owns data: a freshly migrated
    // database has the tables and nothing in them, and no inbox role.
    expect(Object.values(await inboxCounts()).every((n) => n === 0)).toBe(true);
    const roles = await db.select().from(s.role).where(inArray(s.role.name, [...INBOX_ROLES]));
    expect(roles).toEqual([]);
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
    expect(OWNED_SCHEMAS).toContain('inbox');
    const config = readFileSync(join(PKG, 'drizzle.config.ts'), 'utf8');
    const filter = /schemaFilter:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '';
    const listed = [...filter.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...OWNED_SCHEMAS].sort());
  });

  it('indexes every foreign key in the inbox schema', async () => {
    // A foreign key is covered when some index on the table starts with its
    // columns (in any order among themselves).
    const fks = await pool.query<{ table: string; name: string; cols: string[] }>(`
      select c.conrelid::regclass::text as table, c.conname as name,
             array_agg(a.attname::text order by k.ord) as cols
      from pg_constraint c
      join pg_namespace n on n.oid = c.connamespace
      cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype = 'f' and n.nspname = 'inbox'
      group by c.conrelid, c.conname`);
    const idx = await pool.query<{ table: string; cols: string[] }>(`
      select i.indrelid::regclass::text as table,
             array(select a.attname::text from unnest(i.indkey) with ordinality as k(attnum, ord)
                   join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                   order by k.ord) as cols
      from pg_index i join pg_class t on t.oid = i.indrelid join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'inbox'`);
    const unindexed = fks.rows.filter((fk) => {
      const want = new Set(fk.cols);
      return !idx.rows.some(
        (i) => i.table === fk.table && i.cols.length >= want.size && i.cols.slice(0, want.size).every((c) => want.has(c)),
      );
    });
    expect(unindexed.map((f) => `${f.table}.${f.name}`)).toEqual([]);
    expect(fks.rows.length).toBeGreaterThan(40);
  });
});

describe('platform-sync lays the inbox configuration (I1)', () => {
  let oto: string;
  let second: string;

  beforeAll(async () => {
    // The full demo seed: two operators, OTO's two parks with their reception
    // departments, the second operator's one branch without any department.
    await seed(db);
    oto = await operatorByName('OTO');
    second = await operatorByName(SECOND_OPERATOR_NAME);
  }, 300_000);

  it('gives every operator the three inbox roles as its own, with their bundles', async () => {
    for (const operatorId of [oto, second]) {
      const roles = await db
        .select({ id: s.role.id, name: s.role.name, isSystem: s.role.isSystem })
        .from(s.role)
        .where(and(eq(s.role.operatorId, operatorId), inArray(s.role.name, [...INBOX_ROLES])));
      expect(roles.map((r) => r.name).sort()).toEqual([...INBOX_ROLES].sort());
      for (const r of roles) {
        expect(r.isSystem).toBe(false);
        const perms = await db
          .select({ p: s.rolePermission.permission })
          .from(s.rolePermission)
          .where(eq(s.rolePermission.roleId, r.id));
        expect(perms.map((x) => x.p).sort()).toEqual([...INBOX_ROLE_BUNDLES[r.name as (typeof INBOX_ROLES)[number]]].sort());
      }
    }
  });

  it('declares the inbox permissions to the system bundles that take everything', async () => {
    const [opAdmin] = await db
      .select({ id: s.role.id })
      .from(s.role)
      .where(and(eq(s.role.name, 'operator_admin'), isNull(s.role.operatorId)));
    const perms = (
      await db.select({ p: s.rolePermission.permission }).from(s.rolePermission).where(eq(s.rolePermission.roleId, opAdmin!.id))
    ).map((x) => x.p);
    expect(perms.filter((p) => p.startsWith('inbox:')).sort()).toEqual([
      'inbox:ai:manage',
      'inbox:channel:manage',
      'inbox:contact:erase',
      'inbox:conversation:assign',
      'inbox:conversation:handle',
      'inbox:conversation:move',
      'inbox:conversation:read',
      'inbox:conversation:reopen',
      'inbox:conversation:reply',
      'inbox:dashboard:read',
      'inbox:kb:manage',
      'inbox:routing:manage',
      'inbox:template:manage',
    ]);
  });

  it('maps reception teams onto each branch’s own reception department, and adds the two operator-wide ones', async () => {
    const teams = await db.select().from(s.team).where(eq(s.team.operatorId, oto));
    expect(teams.map((t) => t.key).sort()).toEqual(['birthdays', 'marketing', 'reception', 'reception']);
    for (const t of teams.filter((x) => x.key === 'reception')) {
      const [dept] = await db.select().from(s.department).where(eq(s.department.id, t.departmentId!));
      expect(dept!.name).toBe('reception');
      expect(dept!.branchId).toBe(t.branchId);
    }
    expect(teams.find((t) => t.key === 'reception' && t.name === 'Reception · Central Floresta')).toBeDefined();
    expect(teams.find((t) => t.key === 'reception' && t.name === 'Reception · Robinson Chalong')).toBeDefined();
    for (const key of ['birthdays', 'marketing'] as const) {
      const t = teams.find((x) => x.key === key)!;
      const [dept] = await db.select().from(s.department).where(eq(s.department.id, t.departmentId!));
      expect(dept!.name).toBe(INBOX_DEPARTMENTS[key]);
      expect(dept!.branchId).toBeNull();
    }
    // The second operator's branch had no reception department: it got one.
    const secondTeams = await db.select().from(s.team).where(eq(s.team.operatorId, second));
    expect(secondTeams.map((t) => t.key).sort()).toEqual(['birthdays', 'marketing', 'reception']);
  });

  it('lays the routing rules with every person blank and one catch-all per team', async () => {
    const rules = await db.select().from(s.routingRule).where(eq(s.routingRule.operatorId, oto));
    expect(rules).toHaveLength(4 + 2 + 2); // birthdays EN/RU/TH + catch-all; marketing + catch-all; one per reception
    expect(rules.every((r) => r.primaryKind === 'team' && r.primaryAccountId === null && r.backupAccountId === null)).toBe(true);
    const teams = await db.select().from(s.team).where(eq(s.team.operatorId, oto));
    for (const t of teams) {
      const catchAll = rules.filter(
        (r) => r.teamId === t.id && r.language === null && r.branchId === t.branchId && r.priority === 0,
      );
      expect(catchAll, `${t.name} has exactly one catch-all`).toHaveLength(1);
    }
    expect(rules.filter((r) => r.category === 'birthdays' && r.language !== null).map((r) => r.language).sort()).toEqual([
      'en',
      'ru',
      'th',
    ]);
  });

  it('lays the ten templates in EN, TH and RU, each language in its own words, nothing waiting for a translator', async () => {
    const templates = await db.select().from(s.template).where(eq(s.template.operatorId, oto));
    expect(templates).toHaveLength(INBOX_TEMPLATE_KEYS.length * 3);
    expect(new Set(templates.map((t) => t.key))).toEqual(new Set(INBOX_TEMPLATE_KEYS));
    expect(templates.every((t) => !t.needsTranslation)).toBe(true);
    expect(templates.every((t) => t.approvalStatus === 'not_required' && t.active)).toBe(true);
    for (const key of INBOX_TEMPLATE_KEYS) {
      const en = templates.find((t) => t.key === key && t.language === 'en')!;
      const th = templates.find((t) => t.key === key && t.language === 'th')!;
      const ru = templates.find((t) => t.key === key && t.language === 'ru')!;
      expect(en.body).toBe(INBOX_TEMPLATE_BODIES[key]);
      expect(th.body).toBe(INBOX_TEMPLATE_TRANSLATIONS.th[key]);
      expect(ru.body).toBe(INBOX_TEMPLATE_TRANSLATIONS.ru[key]);
      expect(th.body).not.toBe(en.body);
      expect(ru.body).not.toBe(en.body);
      // Thai script in the Thai line, Cyrillic in the Russian one; the same
      // placeholders as the English source, and no number it does not carry.
      expect(th.body).toMatch(/[฀-๿]/);
      expect(ru.body).toMatch(/[Ѐ-ӿ]/);
      const placeholders = (body: string) => [...body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]).sort();
      expect(placeholders(th.body)).toEqual(placeholders(en.body));
      expect(placeholders(ru.body)).toEqual(placeholders(en.body));
      const numbers = (body: string) => new Set(body.match(/\d+/g) ?? []);
      for (const n of numbers(th.body)) expect(numbers(en.body)).toContain(n);
      for (const n of numbers(ru.body)) expect(numbers(en.body)).toContain(n);
    }
    // The follow-up is the one line that is not a holding line, and the only one with a placeholder.
    expect(INBOX_TEMPLATE_BODIES.follow_up).toContain('{{name}}');
    expect(INBOX_TEMPLATE_KEYS.filter((k) => INBOX_TEMPLATE_BODIES[k].includes('{{'))).toEqual(['follow_up']);
  });

  it('an operator synced before the translations existed: the English-bodied TH and RU rows take theirs, once; an admin’s words are never overwritten', async () => {
    // As staging stands before this deploy: every TH and RU row carries the
    // English source and is flagged for translation — here, the second
    // operator's handover_events and out_of_hours rows.
    const staging = async (key: 'handover_events' | 'out_of_hours') =>
      db
        .update(s.template)
        .set({ body: INBOX_TEMPLATE_BODIES[key], needsTranslation: true })
        .where(
          and(
            eq(s.template.operatorId, second),
            eq(s.template.key, key),
            inArray(s.template.language, ['th', 'ru']),
            isNull(s.template.channel),
            isNull(s.template.branchId),
          ),
        );
    await staging('handover_events');
    await staging('out_of_hours');
    // An admin's own words: a flagged row they rewrote, and an unflagged one.
    const adminWords = 'สวัสดีค่ะ ยินดีต้อนรับสู่ OTO Play Park สาขาที่สอง ค่ะ';
    const edited = (key: 'welcome' | 'handover_general') =>
      and(eq(s.template.operatorId, second), eq(s.template.key, key), eq(s.template.language, 'th'), isNull(s.template.channel), isNull(s.template.branchId));
    await db.update(s.template).set({ body: adminWords, needsTranslation: true }).where(edited('welcome'));
    await db.update(s.template).set({ body: `${adminWords} (ตรวจแล้ว)`, needsTranslation: false }).where(edited('handover_general'));

    const first = await syncInboxSetup(db);
    expect(first.translations).toBe(4);
    expect(first.templates).toBe(0);
    expect(first.operators).toBe(1);
    const again = await syncInboxSetup(db);
    expect(again.translations).toBe(0);
    expect(again.operators).toBe(0);

    const rows = await db
      .select()
      .from(s.template)
      .where(and(eq(s.template.operatorId, second), isNull(s.template.channel), isNull(s.template.branchId)));
    for (const key of ['handover_events', 'out_of_hours'] as const) {
      const en = rows.find((t) => t.key === key && t.language === 'en')!;
      for (const language of ['th', 'ru'] as const) {
        const row = rows.find((t) => t.key === key && t.language === language)!;
        expect(row.body).toBe(INBOX_TEMPLATE_TRANSLATIONS[language][key]);
        expect(row.body).not.toBe(en.body);
        expect(row.needsTranslation).toBe(false);
      }
    }
    const welcomeTh = rows.find((t) => t.key === 'welcome' && t.language === 'th')!;
    expect(welcomeTh.body).toBe(adminWords);
    expect(welcomeTh.needsTranslation).toBe(true);
    const generalTh = rows.find((t) => t.key === 'handover_general' && t.language === 'th')!;
    expect(generalTh.body).toBe(`${adminWords} (ตรวจแล้ว)`);
    expect(generalTh.needsTranslation).toBe(false);

    // Put the fixture back for the cases below.
    await db.update(s.template).set({ body: INBOX_TEMPLATE_TRANSLATIONS.th.welcome, needsTranslation: false }).where(edited('welcome'));
    await db
      .update(s.template)
      .set({ body: INBOX_TEMPLATE_TRANSLATIONS.th.handover_general, needsTranslation: false })
      .where(edited('handover_general'));
  });

  it('lays one console channel account per notice channel, none of which can reply', async () => {
    const accounts = await db.select().from(s.channelAccount).where(eq(s.channelAccount.operatorId, oto));
    expect(accounts.map((a) => a.channel).sort()).toEqual([...CONSOLE_NOTICE_CHANNELS].sort());
    expect(accounts.every((a) => a.provider === 'console' && !a.canReply && a.branchId === null)).toBe(true);
  });

  it('a second and a third run lay nothing, and never undo an edit', async () => {
    const before = await inboxCounts();
    const rolesBefore = (await db.select().from(s.role)).length;
    const deptsBefore = (await db.select().from(s.department)).length;

    // The operator's own decisions, made after the first sync.
    const [admin] = await db.select().from(s.account).where(eq(s.account.operatorId, oto)).limit(1);
    const [rule] = await db
      .select()
      .from(s.routingRule)
      .where(and(eq(s.routingRule.operatorId, oto), eq(s.routingRule.category, 'marketing'), eq(s.routingRule.priority, 10)));
    await db
      .update(s.routingRule)
      .set({ primaryKind: 'account', primaryAccountId: admin!.id })
      .where(eq(s.routingRule.id, rule!.id));
    const [welcomeTh] = await db
      .select()
      .from(s.template)
      .where(and(eq(s.template.operatorId, oto), eq(s.template.key, 'welcome'), eq(s.template.language, 'th')));
    await db.update(s.template).set({ archivedAt: new Date() }).where(eq(s.template.id, welcomeTh!.id));
    const [agent] = await db
      .select()
      .from(s.role)
      .where(and(eq(s.role.operatorId, oto), eq(s.role.name, 'inbox_agent')));
    await db
      .delete(s.rolePermission)
      .where(and(eq(s.rolePermission.roleId, agent!.id), eq(s.rolePermission.permission, 'inbox:dashboard:read')));

    const first = await syncInboxSetup(db);
    await platformSync(db);
    expect(first).toEqual({
      operators: 0,
      roles: 0,
      grants: 0,
      departments: 0,
      teams: 0,
      rules: 0,
      templates: 0,
      translations: 0,
      channelAccounts: 0,
    });
    expect(await inboxCounts()).toEqual(before);
    expect((await db.select().from(s.role)).length).toBe(rolesBefore);
    expect((await db.select().from(s.department)).length).toBe(deptsBefore);

    const [ruleAfter] = await db.select().from(s.routingRule).where(eq(s.routingRule.id, rule!.id));
    expect(ruleAfter!.primaryAccountId).toBe(admin!.id);
    const [welcomeAfter] = await db.select().from(s.template).where(eq(s.template.id, welcomeTh!.id));
    expect(welcomeAfter!.archivedAt).not.toBeNull();
    const agentPerms = (
      await db.select({ p: s.rolePermission.permission }).from(s.rolePermission).where(eq(s.rolePermission.roleId, agent!.id))
    ).map((x) => x.p);
    expect(agentPerms).not.toContain('inbox:dashboard:read');

    // Put the fixture back for the cases below.
    await db.update(s.routingRule).set({ primaryKind: 'team', primaryAccountId: null }).where(eq(s.routingRule.id, rule!.id));
    await db.update(s.template).set({ archivedAt: null }).where(eq(s.template.id, welcomeTh!.id));
    await db.insert(s.rolePermission).values({ id: newId(), roleId: agent!.id, permission: 'inbox:dashboard:read' });
  });
});

describe('the database refuses what the services must never write (I1)', () => {
  /** A minimal thread in one operator: contact, channel account, team, conversation. */
  async function thread(operatorId: string, tag: string) {
    const channelAccountId = newId();
    await db.insert(s.channelAccount).values({
      id: channelAccountId,
      operatorId,
      channel: 'whatsapp',
      // Not `simulator`: the demo case below counts the simulator's threads.
      provider: 'meta_cloud',
      externalId: `fence-${tag}-${channelAccountId}`,
      displayName: `Fence ${tag}`,
    });
    const contactId = newId();
    await db.insert(s.contact).values({ id: contactId, operatorId, channel: 'whatsapp', externalHandle: `h-${contactId}` });
    const [team] = await db.select().from(s.team).where(and(eq(s.team.operatorId, operatorId), eq(s.team.key, 'marketing')));
    const conversationId = newId();
    await db.insert(s.conversation).values({ id: conversationId, operatorId, contactId, channelAccountId, teamId: team!.id });
    const accounts = await db.select({ id: s.account.id }).from(s.account).where(eq(s.account.operatorId, operatorId)).limit(3);
    return { operatorId, channelAccountId, contactId, conversationId, teamId: team!.id, accounts: accounts.map((a) => a.id) };
  }

  let a: Awaited<ReturnType<typeof thread>>;
  let b: Awaited<ReturnType<typeof thread>>;

  beforeAll(async () => {
    a = await thread(await operatorByName('OTO'), 'a');
    b = await thread(await operatorByName(SECOND_OPERATOR_NAME), 'b');
  });

  describe('the tenant fence', () => {
    it('refuses a message in one operator that points at another operator’s thread', async () => {
      await expectPgError(
        () =>
          db.insert(s.message).values({
            id: newId(),
            operatorId: b.operatorId,
            conversationId: a.conversationId,
            channelAccountId: b.channelAccountId,
            direction: 'inbound',
            authorKind: 'customer',
            body: 'x',
          }),
        '23503',
        'message_conversation_fk',
      );
    });

    it('refuses a conversation that borrows another operator’s contact, channel account or team', async () => {
      // A contact of B's with no thread yet, so the only thing wrong with each
      // row below is the one borrowed reference.
      const freshContact = newId();
      await db
        .insert(s.contact)
        .values({ id: freshContact, operatorId: b.operatorId, channel: 'whatsapp', externalHandle: `h-${freshContact}` });
      const base = { operatorId: b.operatorId, contactId: freshContact, channelAccountId: b.channelAccountId };
      await expectPgError(
        () => db.insert(s.conversation).values({ ...base, id: newId(), contactId: a.contactId }),
        '23503',
        'conversation_contact_fk',
      );
      await expectPgError(
        () => db.insert(s.conversation).values({ ...base, id: newId(), channelAccountId: a.channelAccountId }),
        '23503',
        'conversation_channel_account_fk',
      );
      await expectPgError(
        () => db.insert(s.conversation).values({ ...base, id: newId(), teamId: a.teamId }),
        '23503',
        'conversation_team_fk',
      );
    });

    it('refuses an assignment, an event or a receipt that crosses operators', async () => {
      await expectPgError(
        () =>
          db.insert(s.assignment).values({
            id: newId(),
            operatorId: b.operatorId,
            conversationId: b.conversationId,
            slot: 'primary',
            slotIndex: 0,
            assigneeKind: 'team',
            teamId: a.teamId,
            assignedByKind: 'system',
            reason: 'auto',
          }),
        '23503',
        'assignment_team_fk',
      );
      await expectPgError(
        () =>
          db.insert(s.inboxEvent).values({
            id: newId(),
            operatorId: b.operatorId,
            conversationId: a.conversationId,
            kind: 'routed',
            actorKind: 'system',
          }),
        '23503',
        'event_conversation_fk',
      );
      await expectPgError(
        () =>
          db.insert(s.webhookReceipt).values({
            id: newId(),
            operatorId: b.operatorId,
            channelAccountId: a.channelAccountId,
            providerEventId: 'evt-cross',
            signatureOk: true,
          }),
        '23503',
        'webhook_receipt_channel_account_fk',
      );
    });

    it('accepts the same rows inside their own operator', async () => {
      await db.insert(s.message).values({
        id: newId(),
        operatorId: a.operatorId,
        conversationId: a.conversationId,
        channelAccountId: a.channelAccountId,
        direction: 'inbound',
        authorKind: 'customer',
        body: 'hello',
        externalMessageId: 'wamid.fence-1',
      });
      expect(
        (await db.select().from(s.message).where(eq(s.message.conversationId, a.conversationId))).length,
      ).toBe(1);
    });
  });

  describe('the assignment slots', () => {
    const row = (over: Partial<typeof s.assignment.$inferInsert>): typeof s.assignment.$inferInsert => ({
      id: newId(),
      operatorId: a.operatorId,
      conversationId: a.conversationId,
      slot: 'support',
      slotIndex: 1,
      assigneeKind: 'account',
      assignedByKind: 'system',
      reason: 'auto',
      ...over,
    });

    it('holds one primary, two support places, and one slot per person', async () => {
      const [p1, p2, p3] = a.accounts;
      expect(p3).toBeDefined();
      await db.insert(s.assignment).values(row({ slot: 'primary', slotIndex: 0, assigneeKind: 'team', teamId: a.teamId }));
      // A second active primary.
      await expectPgError(
        () => db.insert(s.assignment).values(row({ slot: 'primary', slotIndex: 0, accountId: p1 })),
        '23505',
        'assignment_active_slot_unique',
      );
      await db.insert(s.assignment).values(row({ slotIndex: 1, accountId: p1 }));
      await db.insert(s.assignment).values(row({ slotIndex: 2, accountId: p2 }));
      // A third support: there is no third place.
      await expectPgError(
        () => db.insert(s.assignment).values(row({ slotIndex: 3, accountId: p3 })),
        '23514',
        'assignment_slot_index_check',
      );
      // Or a taken place.
      await expectPgError(
        () => db.insert(s.assignment).values(row({ slotIndex: 2, accountId: p3 })),
        '23505',
        'assignment_active_slot_unique',
      );
      // A person in two slots.
      await expectPgError(
        () => db.insert(s.assignment).values(row({ slot: 'primary', slotIndex: 0, accountId: p1, id: newId() })),
        '23505',
      );
      const [released] = await db
        .update(s.assignment)
        .set({ releasedAt: new Date() })
        .where(and(eq(s.assignment.conversationId, a.conversationId), eq(s.assignment.accountId, p2!)))
        .returning();
      expect(released).toBeDefined();
      // Released, the place and the person are free again; the history row stays.
      await db.insert(s.assignment).values(row({ slotIndex: 2, accountId: p3 }));
      await db.insert(s.assignment).values(row({ id: newId(), slotIndex: 2, accountId: p2, releasedAt: new Date() }));
      const active = await db
        .select()
        .from(s.assignment)
        .where(and(eq(s.assignment.conversationId, a.conversationId), isNull(s.assignment.releasedAt)));
      expect(active.map((x) => x.slotIndex).sort()).toEqual([0, 1, 2]);
    });

    it('refuses an assignee that is not what its kind says', async () => {
      await expectPgError(
        () => db.insert(s.assignment).values(row({ conversationId: b.conversationId, operatorId: b.operatorId, assigneeKind: 'account' })),
        '23514',
        'assignment_assignee_check',
      );
    });
  });

  describe('replays', () => {
    it('keeps one webhook receipt per provider event and channel account', async () => {
      const receipt = (channelAccountId: string, operatorId: string) => ({
        id: newId(),
        operatorId,
        channelAccountId,
        providerEventId: 'evt-001',
        signatureOk: true,
        payload: { entry: [] },
      });
      await db.insert(s.webhookReceipt).values(receipt(a.channelAccountId, a.operatorId));
      await expectPgError(
        () => db.insert(s.webhookReceipt).values(receipt(a.channelAccountId, a.operatorId)),
        '23505',
        'webhook_receipt_event_unique',
      );
      // What the ingest does: insert-or-nothing, and stop when nothing.
      const replay = await db
        .insert(s.webhookReceipt)
        .values(receipt(a.channelAccountId, a.operatorId))
        .onConflictDoNothing({ target: [s.webhookReceipt.channelAccountId, s.webhookReceipt.providerEventId] })
        .returning();
      expect(replay).toEqual([]);
      // The same id from another provider account is another event.
      await db.insert(s.webhookReceipt).values(receipt(b.channelAccountId, b.operatorId));
      expect(await count('webhook_receipt')).toBe(2);
    });

    it('keeps one message per provider message id and channel account', async () => {
      await expectPgError(
        () =>
          db.insert(s.message).values({
            id: newId(),
            operatorId: a.operatorId,
            conversationId: a.conversationId,
            channelAccountId: a.channelAccountId,
            direction: 'inbound',
            authorKind: 'customer',
            body: 'hello again',
            externalMessageId: 'wamid.fence-1',
          }),
        '23505',
        'message_external_unique',
      );
    });
  });

  describe('shape', () => {
    it('holds a contact phone to E.164 and a preview to 140 characters', async () => {
      await expectPgError(
        () =>
          db.insert(s.contact).values({
            id: newId(),
            operatorId: a.operatorId,
            channel: 'whatsapp',
            externalHandle: `h-${newId()}`,
            phone: '0812345678',
          }),
        '23514',
        'contact_phone_check',
      );
      await expectPgError(
        () => db.update(s.conversation).set({ lastMessagePreview: 'x'.repeat(141) }).where(eq(s.conversation.id, a.conversationId)),
        '23514',
        'conversation_preview_length_check',
      );
    });

    it('refuses a team primary that names a person, and a console account that could reply', async () => {
      await expectPgError(
        () =>
          db.insert(s.routingRule).values({
            id: newId(),
            operatorId: a.operatorId,
            teamId: a.teamId,
            category: 'marketing',
            primaryKind: 'team',
            primaryAccountId: a.accounts[0],
          }),
        '23514',
        'routing_rule_primary_account_check',
      );
      await expectPgError(
        () =>
          db.insert(s.channelAccount).values({
            id: newId(),
            operatorId: a.operatorId,
            channel: 'line',
            provider: 'console',
            externalId: 'console:line-2',
            displayName: 'x',
            canReply: true,
          }),
        '23514',
        'channel_account_console_reply_check',
      );
    });
  });

  describe('the timeline is append-only', () => {
    let eventId: string;
    beforeAll(async () => {
      eventId = newId();
      await db.insert(s.inboxEvent).values({
        id: eventId,
        operatorId: a.operatorId,
        conversationId: a.conversationId,
        kind: 'routed',
        actorKind: 'system',
        payload: { teamId: a.teamId, preview: 'body-bearing key' },
      });
    });

    it('refuses an update and a delete from any ordinary caller', async () => {
      await expectPgError(() => db.update(s.inboxEvent).set({ kind: 'handled' }).where(eq(s.inboxEvent.id, eventId)), '23514');
      await expectPgError(() => db.delete(s.inboxEvent).where(eq(s.inboxEvent.id, eventId)), '23514');
    });

    it('lets the erasure rewrite the payload, and nothing else', async () => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('oto.inbox_erasure', 'on', true)`);
        await tx.update(s.inboxEvent).set({ payload: { teamId: a.teamId, preview: null } }).where(eq(s.inboxEvent.id, eventId));
      });
      const [row] = await db.select().from(s.inboxEvent).where(eq(s.inboxEvent.id, eventId));
      expect(row!.payload).toEqual({ teamId: a.teamId, preview: null });
      await expectPgError(
        () =>
          db.transaction(async (tx) => {
            await tx.execute(sql`select set_config('oto.inbox_erasure', 'on', true)`);
            await tx.update(s.inboxEvent).set({ kind: 'handled' }).where(eq(s.inboxEvent.id, eventId));
          }),
        '23514',
      );
    });

    it('lets the retention purge delete, and only inside it', async () => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('oto.inbox_purge', 'on', true)`);
        await tx.delete(s.inboxEvent).where(eq(s.inboxEvent.id, eventId));
      });
      expect(await db.select().from(s.inboxEvent).where(eq(s.inboxEvent.id, eventId))).toEqual([]);
    });
  });
});
