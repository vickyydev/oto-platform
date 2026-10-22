import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import { account, auditLog, modifierOption, product, productCategory, role, roleAssignment, rolePermission } from '@oto/db';
import { CATEGORY_SHEET, CATEGORY_SHEET_COLUMNS, MENU_SHEET, MENU_SHEET_COLUMNS, newId } from '@oto/shared';
import { ADMIN, BRANCH_MANAGER, RECEPTION, SECOND_OPERATOR_ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string, manager: string, reception: string, outside: string;
let operatorId: string, outsideOperatorId: string, park: string, managerId: string;
type Cell = string | number | boolean | null;
type Row = Record<string, Cell>;
function request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, cookie = admin, key = newId()) {
  return ctx.app.inject({ method, url, headers: { cookie, 'idempotency-key': key }, ...(payload ? { payload } : {}) });
}
const path = () => '/branches/' + park + '/menu';
const code = () => 'ZZ-' + newId().replaceAll('-', '').slice(0, 16).toUpperCase();
async function workbook(items: Row[], categories: Row[] = []) {
  const sheet = (columns: readonly string[], rows: Row[]) => [
    columns.map(value => ({ value, type: String })),
    ...rows.map(row => columns.map(column => {
      const value = row[column];
      return value === undefined || value === null || value === '' ? { value: undefined, type: String }
        : typeof value === 'number' ? { value, type: Number } : { value: String(value), type: String };
    })),
  ];
  return writeXlsxFile([
    { data: sheet(MENU_SHEET_COLUMNS, items) as never, sheet: MENU_SHEET },
    { data: sheet(CATEGORY_SHEET_COLUMNS, categories) as never, sheet: CATEGORY_SHEET },
  ]).toBuffer();
}
async function prepare(items: Row[], categories: Row[] = [], who = manager) {
  const file = await workbook(items, categories), upload = { filename: 'ZZ TEST menu.xlsx', contentBase64: file.toString('base64') };
  const preview = await request('POST', path() + '/import/preview', upload, who);
  expect(preview.statusCode).toBe(200);
  expect(preview.json().errors).toEqual([]);
  return { ...upload, previewToken: preview.json().previewToken as string };
}
async function category() {
  const body = { code: code(), name: 'ZZ TEST Review category', taxableCategory: 'fnb', defaultPrepStation: 'kitchen', sortOrder: 0 };
  const response = await request('POST', '/menu/categories', body);
  expect(response.statusCode).toBe(200);
  return { ...body, id: response.json().id as string };
}
const categoryRow = (value: Awaited<ReturnType<typeof category>>): Row => ({ id: value.id, code: value.code, name_en: value.name, sort_order: 0, default_prep_station: 'kitchen', default_tax_category: 'fnb' });
// Refused requests still make the required security audit; they must not make a catalogue write.
const auditRows = async () => (await ctx.db.select().from(auditLog)).filter(row => row.action !== 'auth.permission_denied');

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  outside = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  operatorId = (await request('GET', '/me')).json().account.operatorId as string;
  outsideOperatorId = (await request('GET', '/me', undefined, outside)).json().account.operatorId as string;
  park = (await request('GET', '/me', undefined, manager)).json().branch.id as string;
  const [caller] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
  managerId = caller!.id;
  const scopedRole = newId();
  await ctx.db.insert(role).values({ id: scopedRole, operatorId, name: 'ZZ TEST Menu branch reviewer' });
  await ctx.db.insert(rolePermission).values(['catalog:menu:read', 'catalog:menu:manage', 'catalog:menu:import'].map(permission => ({ id: newId(), roleId: scopedRole, permission })));
  await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: managerId, roleId: scopedRole, scopeType: 'branch', scopeId: park });
}, 180_000);
afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-622 independent menu review', () => {
  it('R1 [critical] branch imports cannot mutate operator categories; fix: require operator import reach for actual create, update and archive effects', async () => {
    const existing = await category(), withdrawn = await category(), freshCode = code();
    const changes: Row[] = [
      { ...categoryRow(existing), name_en: 'ZZ TEST Refused category rename' },
      { ...categoryRow(withdrawn), action: 'archive' },
      { code: freshCode, name_en: 'ZZ TEST Refused category create', sort_order: 0, default_prep_station: 'kitchen', default_tax_category: 'fnb' },
    ];
    for (const row of changes) {
      const body = await prepare([], [row]);
      const before = await ctx.db.select().from(productCategory), audits = await auditRows();
      expect.soft((await request('POST', path() + '/import/commit', body, manager)).statusCode).toBe(403);
      expect.soft(await ctx.db.select().from(productCategory)).toEqual(before);
      expect.soft(await auditRows()).toEqual(audits);
    }
  });

  it('R2 [critical] a branch import cannot update or archive a shared product; fix: require operator import reach before shared-row mutation', async () => {
    const cat = await category();
    for (const action of ['update', 'archive']) {
      const id = newId(), itemCode = code(), name = 'ZZ TEST Shared ' + action;
      await ctx.db.insert(product).values({ id, operatorId, branchId: null, categoryId: cat.id, code: itemCode, name, priceSatang: 12345 });
      const body = await prepare([{ id, code: itemCode, name_en: action === 'update' ? 'ZZ TEST Refused shared rename' : name, category: cat.code, price_weekday: 123.45, available: 'yes', action: action === 'archive' ? 'archive' : null }]);
      const before = await ctx.db.select().from(product).where(eq(product.id, id));
      expect.soft((await request('POST', path() + '/import/commit', body, manager)).statusCode).toBe(403);
      expect.soft(await ctx.db.select().from(product).where(eq(product.id, id))).toEqual(before);
    }
  });

  it('R3 [high] an own-park item import needs no operator category grant; fix: fence changed global rows without denying unchanged categories or replay', async () => {
    const cat = await category(), itemCode = code();
    const body = await prepare([{ code: itemCode, name_en: 'ZZ TEST Exact price import', category: cat.code, price_weekday: 123.45, price_weekend: 167.89, available: 'yes' }]);
    const before = await ctx.db.select().from(productCategory), key = newId();
    const first = await request('POST', path() + '/import/commit', body, manager, key);
    expect(first.statusCode).toBe(200);
    const replay = await request('POST', path() + '/import/commit', body, manager, key);
    expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(first.json());
    const stored = await ctx.db.select().from(product).where(and(eq(product.operatorId, operatorId), eq(product.code, itemCode)));
    expect(stored).toHaveLength(1); expect(stored[0]).toMatchObject({ branchId: park, priceSatang: 12345, priceWeekendSatang: 16789 });
    expect(await ctx.db.select().from(productCategory)).toEqual(before);
    expect(await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, stored[0]!.id), eq(auditLog.action, 'menu_item.create')))).toHaveLength(1);
    expect((await request('POST', path() + '/import/commit', { ...body, filename: 'ZZ TEST Changed.xlsx' }, manager, key)).statusCode).toBe(409);
  });

  it('R4 [critical] corrupt foreign options are neither returned nor modified; fix: constrain option reads, replacement and archive by operator as well as group', async () => {
    const created = await request('POST', '/menu/modifier-groups', { name: 'ZZ TEST Owned review modifiers', options: [{ name: 'ZZ TEST Owned first', priceSatang: 1234, sortOrder: 0 }] });
    expect(created.statusCode).toBe(200); const id = created.json().id as string, foreignId = newId();
    await ctx.db.insert(modifierOption).values({ id: foreignId, operatorId: outsideOperatorId, modifierGroupId: id, name: 'ZZ TEST Foreign option', priceSatang: 9876 });
    const before = await ctx.db.select().from(modifierOption).where(eq(modifierOption.id, foreignId));
    const menu = await request('GET', path());
    expect.soft(menu.json().modifierGroups.find((group: { id: string }) => group.id === id).options.some((option: { id: string }) => option.id === foreignId)).toBe(false);
    const updated = await request('PATCH', '/menu/modifier-groups/' + id, { name: 'ZZ TEST Owned review modifiers', options: [{ name: 'ZZ TEST Owned replacement', priceSatang: 2345, sortOrder: 0 }] });
    expect(updated.statusCode).toBe(200);
    expect.soft(await ctx.db.select().from(modifierOption).where(eq(modifierOption.id, foreignId))).toEqual(before);
    const own = (await request('GET', path())).json().modifierGroups.find((group: { id: string }) => group.id === id);
    expect(own.options.map((option: { name: string }) => option.name)).toContain('ZZ TEST Owned replacement');
    expect((await request('DELETE', '/menu/modifier-groups/' + id)).statusCode).toBe(200);
    expect.soft(await ctx.db.select().from(modifierOption).where(eq(modifierOption.id, foreignId))).toEqual(before);
  });

  it('R5 [high] operator import reach uses the import permission itself; fix: do not substitute a new operator menu-manage requirement', async () => {
    const roleId = newId(), assignmentId = newId();
    await ctx.db.insert(role).values({ id: roleId, operatorId, name: 'ZZ TEST Operator importer only' });
    await ctx.db.insert(rolePermission).values({ id: newId(), roleId, permission: 'catalog:menu:import' });
    await ctx.db.insert(roleAssignment).values({ id: assignmentId, accountId: managerId, roleId, scopeType: 'operator', scopeId: operatorId });
    try {
      const freshCode = code(), body = await prepare([], [{ code: freshCode, name_en: 'ZZ TEST Operator import category', sort_order: 0, default_prep_station: 'kitchen', default_tax_category: 'fnb' }]);
      expect((await request('POST', path() + '/import/commit', body, manager)).statusCode).toBe(200);
      expect(await ctx.db.select().from(productCategory).where(and(eq(productCategory.operatorId, operatorId), eq(productCategory.code, freshCode)))).toHaveLength(1);
      expect((await request('POST', '/menu/categories', { code: code(), name: 'ZZ TEST Manual operator refusal', taxableCategory: 'fnb' }, manager)).statusCode).toBe(403);
    } finally { await ctx.db.delete(roleAssignment).where(eq(roleAssignment.id, assignmentId)); }
  });

  it('R6 [high] exporting cost-bearing workbooks stays scoped and read-only; fix: retain manage permission and tenant fences without export audits or mutations', async () => {
    const productsBefore = await ctx.db.select().from(product), categoriesBefore = await ctx.db.select().from(productCategory), auditsBefore = await auditRows(), messages = ctx.smsLog.length;
    expect((await request('GET', path() + '/export.xlsx', undefined, manager)).statusCode).toBe(200);
    expect((await request('GET', path() + '/export.xlsx', undefined, reception)).statusCode).toBe(403);
    expect([403, 404]).toContain((await request('GET', path() + '/export.xlsx', undefined, outside)).statusCode);
    expect(await ctx.db.select().from(product)).toEqual(productsBefore);
    expect(await ctx.db.select().from(productCategory)).toEqual(categoriesBefore);
    expect(await auditRows()).toEqual(auditsBefore); expect(ctx.smsLog).toHaveLength(messages);
  });
});
