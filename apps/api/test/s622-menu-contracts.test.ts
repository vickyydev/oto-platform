import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, modifierOption } from '@oto/db';
import { newId } from '@oto/shared';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext, cookie: string, branchId: string;
beforeAll(async () => {
  ctx = await createTestContext();
  await ctx.app.ready();
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie } });
  expect(me.statusCode).toBe(200);
  branchId = me.json().branch.id;
});
afterAll(async () => { await ctx?.close(); await teardownAll(); });
const headers = (key = newId()) => ({ cookie, 'idempotency-key': key });
const actionsFor = async (id: string) => (await ctx.db.select().from(auditLog).where(eq(auditLog.entityId, id))).map(row => row.action).sort();

describe('SCRUM-622 menu response contracts', () => {
  for (const [label, routes] of [
    ['categories', [['/menu/categories', 'post'], ['/menu/categories/{id}', 'patch'], ['/menu/categories/{id}', 'delete']]],
    ['modifier groups and options', [['/menu/modifier-groups', 'post'], ['/menu/modifier-groups/{id}', 'patch'], ['/menu/modifier-groups/{id}', 'delete']]],
    ['workbook preview and confirmation', [['/branches/{branchId}/menu/import/preview', 'post'], ['/branches/{branchId}/menu/import/commit', 'post']]],
  ] as const) {
    it(`describes every lifted JSON answer for ${label}`, () => {
      const document = ctx.app.swagger();
      for (const [path, verb] of routes) {
        const response = document.paths?.[path]?.[verb]?.responses?.['200'];
        expect(response && 'content' in response ? response.content?.['application/json']?.schema : undefined, `${verb.toUpperCase()} ${path}`).toBeDefined();
      }
    });
  }

  it('keeps category create, edit and withdrawal answers, canonical fields and audit-once replay', async () => {
    const translations = { th: { name: 'ZZ TEST Thai category' }, 'zz-local': { name: 'ZZ TEST another category' } };
    const body = { code: 'ZZ_622_CONTRACT', name: 'ZZ TEST Contract category', taxableCategory: 'fnb', defaultPrepStation: 'kitchen', sortOrder: 21, translations };
    const createKey = headers();
    const created = await ctx.app.inject({ method: 'POST', url: '/menu/categories', headers: createKey, payload: body });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    expect(created.json()).toEqual({ id });
    expect(id).toMatch(/^[a-f0-9-]{36}$/i);
    const replay = await ctx.app.inject({ method: 'POST', url: '/menu/categories', headers: createKey, payload: body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ id });
    const patchKey = headers();
    for (let n = 0; n < 2; n++) {
      const changed = await ctx.app.inject({ method: 'PATCH', url: `/menu/categories/${id}`, headers: patchKey, payload: { name: 'ZZ TEST Edited category', sortOrder: 22 } });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toEqual({ ok: true });
    }
    const menu = await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/menu`, headers: { cookie } });
    expect(menu.statusCode).toBe(200);
    expect(menu.json().categories.find((row: { id: string }) => row.id === id)).toEqual({ id, code: body.code, name: 'ZZ TEST Edited category', parentId: null, taxableCategory: 'fnb', defaultPrepStation: 'kitchen', effectiveTaxCategory: 'fnb', effectivePrepStation: 'kitchen', sortOrder: 22, translations, archivedAt: null });
    const deleteKey = headers();
    for (let n = 0; n < 2; n++) {
      const removed = await ctx.app.inject({ method: 'DELETE', url: `/menu/categories/${id}`, headers: deleteKey });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual({ ok: true });
    }
    expect(await actionsFor(id)).toEqual(['menu_category.archive', 'menu_category.create', 'menu_category.update']);
  });

  it('keeps modifier choices and language fields while replacing options as a set and auditing each action once', async () => {
    const body = { name: 'ZZ TEST Contract question', required: true, selectionType: 'multi', minSelect: 1, maxSelect: 2, sortOrder: 23,
      translations: { th: { name: 'ZZ TEST Thai question' } },
      options: [{ name: 'ZZ TEST Warm', priceSatang: 125, priceWeekendSatang: 250, costSatang: 50, sortOrder: 1, translations: { th: { name: 'ZZ TEST Thai answer' } } }] };
    const createKey = headers();
    const created = await ctx.app.inject({ method: 'POST', url: '/menu/modifier-groups', headers: createKey, payload: body });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    expect(created.json()).toEqual({ id });
    const replay = await ctx.app.inject({ method: 'POST', url: '/menu/modifier-groups', headers: createKey, payload: body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ id });
    const originalOptions = await ctx.db.select().from(modifierOption).where(eq(modifierOption.modifierGroupId, id));
    const edited = { ...body, name: 'ZZ TEST Edited question', options: [{ ...body.options[0]!, name: 'ZZ TEST Mild' }] };
    const patchKey = headers();
    for (let n = 0; n < 2; n++) {
      const changed = await ctx.app.inject({ method: 'PATCH', url: `/menu/modifier-groups/${id}`, headers: patchKey, payload: edited });
      expect(changed.statusCode).toBe(200);
      expect(changed.json()).toEqual({ ok: true });
    }
    const menu = await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/menu`, headers: { cookie } });
    expect(menu.statusCode).toBe(200);
    const group = menu.json().modifierGroups.find((row: { id: string }) => row.id === id);
    expect(group).toMatchObject({ id, productId: null, name: edited.name, required: true, selectionType: 'multi', minSelect: 1, maxSelect: 2, sortOrder: 23, translations: body.translations });
    expect(group.options).toHaveLength(1);
    expect(group.options[0]).toEqual({ id: expect.any(String), ...edited.options[0], priceWeekendSatang: 250, costSatang: 50 });
    expect(originalOptions.map(row => row.id)).not.toContain(group.options[0].id);
    const afterOptions = await ctx.db.select().from(modifierOption).where(eq(modifierOption.modifierGroupId, id));
    expect(afterOptions.filter(row => originalOptions.some(original => original.id === row.id)).every(row => row.archivedAt instanceof Date)).toBe(true);
    const deleteKey = headers();
    for (let n = 0; n < 2; n++) {
      const removed = await ctx.app.inject({ method: 'DELETE', url: `/menu/modifier-groups/${id}`, headers: deleteKey });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toEqual({ ok: true });
    }
    expect(await actionsFor(id)).toEqual(['modifier_group.archive', 'modifier_group.create', 'modifier_group.update']);
  });

  it('keeps real workbook MIME, filename, preview detail and no-change confirmation with exact-key replay', async () => {
    const workbook = await ctx.app.inject({ method: 'GET', url: `/branches/${branchId}/menu/export.xlsx`, headers: { cookie } });
    expect(workbook.statusCode).toBe(200);
    expect(workbook.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(workbook.headers['content-disposition']).toMatch(/attachment; filename="oto-menu-.+\.xlsx"/);
    expect(workbook.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const body = { filename: 'ZZ TEST 622 current-menu.xlsx', contentBase64: workbook.rawPayload.toString('base64') };
    const preview = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/menu/import/preview`, headers: { cookie }, payload: body });
    expect(preview.statusCode).toBe(200);
    const result = preview.json();
    expect(Object.keys(result).sort()).toEqual(['categories', 'counts', 'errors', 'filename', 'notice', 'previewToken', 'rows']);
    expect(result.errors).toEqual([]);
    expect(result.filename).toBe(body.filename);
    expect(result.previewToken).toMatch(/^v1\./);
    expect(result.notice).toEqual(expect.any(String));
    expect(result.counts).toMatchObject({ create: 0, update: 0, archive: 0, ignored: expect.any(Number), unchanged: expect.any(Number) });
    expect(result.categories).toMatchObject({ create: 0, update: 0, archive: 0, unchanged: expect.any(Number) });
    expect(result.rows.every((row: { action: string; changes: unknown[] }) => row.action === 'unchanged' && row.changes.length === 0)).toBe(true);
    const commitHeaders = headers();
    for (let n = 0; n < 2; n++) {
      const confirmed = await ctx.app.inject({ method: 'POST', url: `/branches/${branchId}/menu/import/commit`, headers: commitHeaders, payload: { ...body, previewToken: result.previewToken } });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json()).toEqual({ created: 0, updated: 0, archived: 0, categoriesCreated: 0, categoriesUpdated: 0, categoriesArchived: 0 });
    }
    const imports = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'menu.import'));
    expect(imports).toHaveLength(1);
  });
});
