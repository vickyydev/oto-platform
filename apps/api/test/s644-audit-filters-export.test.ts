import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import { account, auditLog, role, roleAssignment, rolePermission } from '@oto/db';
import { newId, normalizePhone, type Permission } from '@oto/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  OTO_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-644, planner ruling Q25 — the server-side Activity filters and the
 * audited, bounded export.
 *
 *  - `app`, `targetApp` and `category` (`data_access`, `denial`) narrow on the
 *    server, inside the same operator/branch reach as every other filter;
 *  - `GET /audit/export` answers CSV or NDJSON for ONE bounded page, masks
 *    exactly as the JSON read does, and writes one `audit.export` row
 *    (category `data_access`) naming its filters and row count.
 */

type Entry = Record<string, unknown> & { id: string; action: string; before: unknown; after: unknown };
type Page = { entries: Entry[]; masked: boolean; nextCursor: string | null };

const TAG = 'ZZ TEST 644 filters';
const SECRET_PHONE = '+66812340644';
const SECRET_NOTE = 'ZZ TEST 644 peanut allergy note';
let ctx: TestContext;
let operatorId: string, central: string, chalong: string;
let admin: string, maskedExporter: string, readerOnly: string, centralExporter: string, exportOnly: string;
const ids: Record<string, string> = {};

async function accountWith(name: string, grants: Array<{ permission: Permission; branchId?: string }>): Promise<string> {
  const id = newId(), phone = normalizePhone(`+669006440${Object.keys(ids).length + 10}`)!;
  const password = randomBytes(18).toString('hex');
  ids[`account:${name}`] = id;
  await ctx.db.insert(account).values({ id, operatorId, phone, passwordHash: await hash(password),
    phoneVerifiedAt: new Date(), status: 'active', mustChangePassword: false });
  // One role per scope, so a branch grant never travels to the operator-wide assignment.
  const byScope = new Map<string, Permission[]>();
  for (const g of grants) byScope.set(g.branchId ?? '', [...(byScope.get(g.branchId ?? '') ?? []), g.permission]);
  for (const [scope, permissions] of byScope) {
    const roleId = newId();
    await ctx.db.insert(role).values({ id: roleId, operatorId, name: `${TAG} ${name} ${scope || 'operator'}` });
    for (const permission of permissions) await ctx.db.insert(rolePermission).values({ id: newId(), roleId, permission });
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: id, roleId,
      scopeType: scope ? 'branch' : 'operator', scopeId: scope || operatorId });
  }
  return signInAs(ctx.app, phone, password);
}

function row(key: string, action: string, extra: Partial<typeof auditLog.$inferInsert> = {}, minute = 0) {
  ids[key] = newId();
  return { id: ids[key]!, operatorId, action, entityType: TAG, entityId: key,
    before: { phone: SECRET_PHONE, kept: 'ZZ TEST kept' }, after: { notes: SECRET_NOTE, count: 1 },
    createdAt: new Date(Date.UTC(2026, 9, 27, 3, minute)), ...extra };
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api' } });
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  maskedExporter = await accountWith('masked exporter', [
    { permission: 'admin:audit:read' }, { permission: 'console:activity:export' }]);
  readerOnly = await accountWith('reader only', [{ permission: 'admin:audit:read' }]);
  centralExporter = await accountWith('central exporter', [
    { permission: 'admin:audit:read', branchId: central }, { permission: 'console:activity:export' }]);
  exportOnly = await accountWith('export only', [{ permission: 'console:activity:export' }]);
  await ctx.db.insert(auditLog).values([
    row('inbox', 'zz.test644.inbox_write', { sourceApp: 'inbox', branchId: central }, 1),
    row('console', 'zz.test644.console_write', { sourceApp: 'console', targetApp: 'oto_app', branchId: central }, 2),
    row('unlabelled', 'zz.test644.unlabelled', { branchId: chalong }, 3),
    row('sensitive', 'audit.read_sensitive', { branchId: central }, 4),
    // SCRUM-663: a Money oversight read classifies as data access by its action.
    row('moneyRead', 'console.money.read', { branchId: central }, 4.5),
    row('labelledAccess', 'zz.test644.child_note_read', { category: 'data_access', branchId: central }, 5),
    row('denied', 'access.denied', { branchId: central }, 6),
    row('permissionDenied', 'auth.permission_denied', { branchId: chalong }, 7),
    row('signInFailed', 'auth.sign_in_failed', {}, 8),
    row('lockedOut', 'auth.locked_out', { branchId: central }, 9),
    row('handoffRejected', 'auth.handoff_rejected', { branchId: central }, 10),
    row('opFailed', 'zz.test644.write_failed', { branchId: central }, 11),
    row('formula', 'zz.test644.formula', { branchId: central, entityId: '=HYPERLINK("http://zz.test")' }, 12),
  ]);
}, 240_000);

afterAll(async () => {
  try { await ctx?.close(); } finally { await teardownAll(); }
});

const get = (cookie: string, url: string) => ctx.app.inject({ method: 'GET', url, headers: { cookie } });

async function page(cookie: string, query: string): Promise<Page> {
  const res = await get(cookie, `/audit?entityType=${encodeURIComponent(TAG)}&limit=200&${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Page;
}

const keysOf = (p: Page) => p.entries.map((e) => e.entityId as string).sort();

async function exportRows(): Promise<Array<typeof auditLog.$inferSelect>> {
  return ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'audit.export'), eq(auditLog.operatorId, operatorId)));
}

describe('server-side Activity filters (SCRUM-644)', () => {
  it('F1 app narrows to the producer label on the server', async () => {
    expect(keysOf(await page(admin, 'app=inbox'))).toEqual(['inbox']);
    expect(keysOf(await page(admin, 'app=console'))).toEqual(['console']);
  });

  it('F2 targetApp narrows to the app a Console action reached into', async () => {
    expect(keysOf(await page(admin, 'targetApp=oto_app'))).toEqual(['console']);
  });

  it('F3 data access is the labelled rows plus the sensitive and money reads, never anything else', async () => {
    const p = await page(admin, 'category=data_access');
    expect(keysOf(p)).toEqual(['labelledAccess', 'moneyRead', 'sensitive']);
    expect(p.entries.every((e) => e.category === 'data_access')).toBe(true);
  });

  it('F4 denials are the named refusals, not every failure', async () => {
    const p = await page(admin, 'category=denial');
    expect(keysOf(p)).toEqual(['denied', 'handoffRejected', 'lockedOut', 'permissionDenied', 'signInFailed']);
    expect(keysOf(p)).not.toContain('opFailed');
    expect(p.entries.every((e) => e.category === 'denial')).toBe(true);
  });

  it('F5 every entry carries app, targetApp and category, null where nothing labelled it', async () => {
    const p = await page(admin, 'action=zz.test644.unlabelled');
    expect(p.entries[0]).toMatchObject({ app: null, targetApp: null, category: null });
    const c = await page(admin, 'action=zz.test644.console_write');
    expect(c.entries[0]).toMatchObject({ app: 'console', targetApp: 'oto_app', category: null });
  });

  it('F6 the filters stay inside the branch reach: a central reader never sees chalong or branchless denials', async () => {
    const p = await page(centralExporter, 'category=denial');
    expect(keysOf(p)).toEqual(['denied', 'handoffRejected', 'lockedOut']);
  });

  it('F7 an unknown category is refused rather than silently ignored', async () => {
    const res = await get(admin, `/audit?category=everything`);
    expect(res.statusCode).toBe(400);
  });
});

describe('audited, bounded export (SCRUM-644)', () => {
  it('E1 NDJSON carries exactly the entries the JSON read returns, one per line', async () => {
    const json = await page(admin, '');
    const res = await get(admin, `/audit/export?format=ndjson&entityType=${encodeURIComponent(TAG)}&limit=200`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/x-ndjson/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="activity-.+\.ndjson"$/);
    const lines = res.body.trim().split('\n').map((l) => JSON.parse(l) as Entry);
    expect(lines).toEqual(json.entries);
    expect(res.headers['x-oto-export-rows']).toBe(String(json.entries.length));
  });

  it('E2 a masked exporter gets exactly the JSON read masking, in both formats, with no raw personal value', async () => {
    const json = await page(maskedExporter, '');
    expect(json.masked).toBe(true);
    const nd = await get(maskedExporter, `/audit/export?format=ndjson&entityType=${encodeURIComponent(TAG)}&limit=200`);
    expect(nd.statusCode, nd.body).toBe(200);
    expect(nd.body.trim().split('\n').map((l) => JSON.parse(l))).toEqual(json.entries);
    const csv = await get(maskedExporter, `/audit/export?format=csv&entityType=${encodeURIComponent(TAG)}&limit=200`);
    expect(csv.statusCode, csv.body).toBe(200);
    for (const body of [nd.body, csv.body]) {
      expect(body).not.toContain(SECRET_PHONE);
      expect(body).not.toContain(SECRET_NOTE);
      expect(body).toContain('[redacted]');
      expect(body).toContain('ZZ TEST kept');
    }
    expect(nd.headers['x-oto-export-masked']).toBe('true');
  });

  it('E3 each export writes one data_access audit row naming its format, filters, row count and masking', async () => {
    const before = (await exportRows()).length;
    const res = await get(maskedExporter, `/audit/export?format=csv&category=denial&entityType=${encodeURIComponent(TAG)}&limit=200`);
    expect(res.statusCode, res.body).toBe(200);
    const rows = await exportRows();
    expect(rows.length).toBe(before + 1);
    const latest = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
    expect(latest).toMatchObject({ category: 'data_access', sourceApp: 'console', entityType: 'audit_log',
      actorAccountId: ids['account:masked exporter'] });
    expect(latest.after).toEqual({ format: 'csv', rows: 5, masked: true, more: false,
      filters: { category: 'denial', entityType: TAG, limit: 200 } });
  });

  it('E4 the export is page-bounded: past 5000 rows is refused with a clear message, and a full page says more remain', async () => {
    const tooMany = await get(admin, `/audit/export?format=csv&limit=5001`);
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.body).toMatch(/5000/);
    const firstPage = await get(admin, `/audit/export?format=ndjson&entityType=${encodeURIComponent(TAG)}&limit=2`);
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.body.trim().split('\n')).toHaveLength(2);
    expect(firstPage.headers['x-oto-next-cursor']).toEqual(expect.any(String));
    const next = await get(admin, `/audit/export?format=ndjson&entityType=${encodeURIComponent(TAG)}&limit=2&cursor=${
      encodeURIComponent(String(firstPage.headers['x-oto-next-cursor']))}`);
    expect(next.statusCode).toBe(200);
    const seen = new Set(firstPage.body.trim().split('\n').map((l) => (JSON.parse(l) as Entry).id));
    expect(next.body.trim().split('\n').some((l) => seen.has((JSON.parse(l) as Entry).id))).toBe(false);
  });

  it('E5 CSV cells are formula-safe', async () => {
    const res = await get(admin, `/audit/export?format=csv&action=zz.test644.formula`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    const [header, line] = res.body.trim().split('\n');
    expect(header).toContain('"entityId"');
    expect(line).toContain(`"'=HYPERLINK(""http://zz.test"")"`);
  });

  it('E6 the export stays inside the branch reach exactly as the read does', async () => {
    const json = await page(centralExporter, '');
    const res = await get(centralExporter, `/audit/export?format=ndjson&entityType=${encodeURIComponent(TAG)}&limit=200`);
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry);
    expect(lines).toEqual(json.entries);
    expect(lines.some((e) => e.branchId === chalong || e.branchId === null)).toBe(false);
  });

  it('E7 refuses a reader without the export permission, and a holder of export alone, writing no export row', async () => {
    const before = (await exportRows()).length;
    expect((await get(readerOnly, `/audit/export?format=csv`)).statusCode).toBe(403);
    expect((await get(exportOnly, `/audit/export?format=csv`)).statusCode).toBe(403);
    expect((await exportRows()).length).toBe(before);
  });

  it('E8 an unmasked JSON read is still recorded as audit.read_sensitive, now labelled data_access', async () => {
    await page(admin, 'action=zz.test644.unlabelled');
    const [latest] = await ctx.db.select().from(auditLog)
      .where(and(eq(auditLog.action, 'audit.read_sensitive'), eq(auditLog.actorAccountId, (await adminId())!)));
    expect(latest?.category).toBe('data_access');
  });
});

async function adminId(): Promise<string | undefined> {
  const [r] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, normalizePhone(ADMIN.phone)!));
  return r?.id;
}
