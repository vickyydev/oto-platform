import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { auditLog, branch, printTemplate } from '@oto/db';
import { ROLE_FOR_KIND, profileFor, testPrintJob } from '@oto/box-agent';
import { PRINT_SAMPLE_NAMES, printSampleJob, renderJob, type PrintJob, type PrintTemplate } from '@oto/print';
import {
  APPLICABLE_FIELDS,
  PRINT_KINDS,
  PRINT_TEMPLATE_TYPES,
  PRINT_TEMPLATE_TYPE_ORDER,
  PrintTemplateSchema,
  defaultPrintTemplate,
  isUntouchedDefaultTemplate,
  newId,
  type PrintKind,
} from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-707 — a new branch has editable print templates.
 *
 * Driven through the routes the Console presses. What it has to prove, in the
 * order a person would notice: the panel has six rows to open on a new branch;
 * the paper does not change, to the byte; a branch opened earlier can be filled
 * in, as often as anybody likes, without touching what it has edited; and a
 * clone still carries the source's templates across, which it would not do if
 * the new default rows read as "already there".
 */

let ctx: TestContext;
let adminCookie: string;
let receptionCookie: string;
let operatorId: string;
let centralId: string;
let codeCounter = 0;

const inject = (
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  cookie = adminCookie,
) => ctx.app.inject({ method, url, headers: { cookie, ...headers }, payload: payload as never });

const fillIn = (branchId: string, headers: Record<string, string> = {}, cookie = adminCookie) =>
  inject('POST', `/branches/${branchId}/print-templates/create-missing`, undefined, headers, cookie);

/** A branch opened the way one was before this ticket: straight in, with no rows. */
async function bareBranch(name: string): Promise<string> {
  const id = newId();
  codeCounter += 1;
  await ctx.db.insert(branch).values({
    id,
    operatorId,
    name,
    code: `bare-${codeCounter}`,
    timezone: 'Asia/Bangkok',
    country: 'TH',
  });
  return id;
}

async function openBranch(name: string): Promise<string> {
  codeCounter += 1;
  const res = await inject('POST', '/branches', { name, code: `opened-${codeCounter}` });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().id as string;
}

const rowsOf = (branchId: string) =>
  ctx.db
    .select()
    .from(printTemplate)
    .where(and(eq(printTemplate.branchId, branchId), isNull(printTemplate.archivedAt)));

const trail = (branchId: string, action: string) =>
  ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.branchId, branchId), eq(auditLog.action, action)));

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function asRendered(row: typeof printTemplate.$inferSelect): PrintTemplate {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    showLogo: row.showLogo,
    headerText: row.headerText ?? undefined,
    footerText: row.footerText ?? undefined,
    fields: row.fields as PrintTemplate['fields'],
  };
}

function deviceFor(kind: PrintKind) {
  const role = ROLE_FOR_KIND[kind];
  return profileFor({
    id: 'sample-printer',
    role,
    kind: role.endsWith('band') ? 'band_printer' : 'receipt_printer',
    label: 'Sample',
    transport: 'simulated',
    address: null,
    model: null,
    protocol: null,
    serialNumber: null,
    terminalId: null,
    merchantId: null,
    settings: null,
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  centralId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const [row] = await ctx.db.select().from(branch).where(eq(branch.id, centralId)).limit(1);
  operatorId = row!.operatorId;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('opening a branch', () => {
  it('gives it all six editable templates, each audited, in the transaction that opened it', async () => {
    const id = await openBranch('Fresh Park');
    const listed = (await inject('GET', `/branches/${id}/print-templates`)).json().templates as {
      id: string;
      type: string;
      version: number;
      showLogo: boolean;
      headerText: string | null;
      footerText: string | null;
      fields: Record<string, boolean>;
    }[];
    expect(listed.map((t) => t.type)).toEqual([...PRINT_TEMPLATE_TYPE_ORDER]);
    for (const t of listed) {
      expect(t.version).toBe(1);
      expect(t.showLogo).toBe(false);
      expect(t.headerText).toBeNull();
      expect(t.footerText).toBeNull();
      expect(Object.keys(t.fields).sort()).toEqual(
        [...APPLICABLE_FIELDS[t.type as keyof typeof APPLICABLE_FIELDS]].sort(),
      );
    }

    const rows = await trail(id, 'print_template.create');
    expect(rows.map((r) => r.entityId).sort()).toEqual(listed.map((t) => t.id).sort());
    const [opened] = await trail(id, 'branch.create');
    expect(rows.every((r) => r.requestId === opened!.requestId)).toBe(true);
  });

  it('a replayed open writes no second set', async () => {
    const clientId = newId();
    codeCounter += 1;
    const body = { id: clientId, name: 'Replay Templates', code: `opened-${codeCounter}` };
    expect((await inject('POST', '/branches', body)).statusCode).toBe(200);
    expect((await inject('POST', '/branches', body)).statusCode).toBe(200);
    expect(await rowsOf(clientId)).toHaveLength(6);
    expect(await trail(clientId, 'print_template.create')).toHaveLength(6);
  });

  it('the rows the box is sent pass the box’s own schema', async () => {
    const id = await openBranch('Box Reads These');
    for (const row of await rowsOf(id)) {
      const parsed = PrintTemplateSchema.safeParse(row);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });
});

describe('the paper does not change', () => {
  const jobsFor = async (kind: PrintKind): Promise<PrintJob[]> => {
    const named = PRINT_SAMPLE_NAMES.map((name) => printSampleJob(kind, name)).filter(
      (job): job is PrintJob => job !== undefined,
    );
    return [await testPrintJob(kind), ...named];
  };

  it.each([...PRINT_KINDS])('%s prints byte for byte what a branch with no rows prints', async (kind) => {
    const id = await openBranch(`Same Paper ${kind}`);
    const templates = (await rowsOf(id)).map(asRendered);
    const device = deviceFor(kind);
    for (const job of await jobsFor(kind)) {
      const withNone = renderJob(job, { device, templates: [] });
      const withDefaults = renderJob(job, { device, templates });
      expect(hex(withDefaults.bytes)).toBe(hex(withNone.bytes));
    }
  });

  it('a branch with no saved row still prints, from the built-in defaults', async () => {
    const id = await bareBranch('Prints With None');
    expect(await rowsOf(id)).toHaveLength(0);
    const rendered = renderJob(await testPrintJob('receipt'), { device: deviceFor('receipt'), templates: [] });
    expect(rendered.template).toBeUndefined();
    expect(rendered.bytes.length).toBeGreaterThan(0);
  });
});

describe('filling in a branch that has none', () => {
  it('creates the six, and a second run writes nothing', async () => {
    const id = await bareBranch('Filled Later');
    const first = await fillIn(id);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().created).toEqual([...PRINT_TEMPLATE_TYPE_ORDER]);
    expect(first.json().templates).toHaveLength(6);

    const before = await rowsOf(id);
    const second = await fillIn(id);
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toEqual([]);
    expect(second.json().templates).toHaveLength(6);
    expect(await rowsOf(id)).toEqual(before);
    expect(await trail(id, 'print_template.create')).toHaveLength(6);
  });

  it('fills only what is missing and leaves an edited template exactly as it stands', async () => {
    const id = await bareBranch('Half Filled');
    await fillIn(id);
    const receipt = (await rowsOf(id)).find((t) => t.type === 'receipt')!;
    const edited = await inject('PATCH', `/print-templates/${receipt.id}`, {
      footerText: 'Thank you · Tax ID 0999999999999',
      showLogo: true,
      fields: { itemizedLines: true, taxServiceBreakdown: false, voucherInfo: false },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const kept = (await rowsOf(id)).find((t) => t.type === 'receipt')!;
    await ctx.db
      .update(printTemplate)
      .set({ archivedAt: new Date() })
      .where(and(eq(printTemplate.branchId, id), eq(printTemplate.type, 'bar_ticket')));

    const res = await fillIn(id);
    expect(res.json().created).toEqual(['bar_ticket']);
    const after = (await rowsOf(id)).find((t) => t.type === 'receipt')!;
    expect(after).toEqual(kept);

    const device = deviceFor('receipt');
    const job = await testPrintJob('receipt');
    expect(hex(renderJob(job, { device, templates: [asRendered(after)] }).bytes)).toBe(
      hex(renderJob(job, { device, templates: [asRendered(kept)] }).bytes),
    );
  });

  it('never touches a seeded park', async () => {
    const before = await rowsOf(centralId);
    const res = await fillIn(centralId);
    expect(res.json().created).toEqual([]);
    expect(await rowsOf(centralId)).toEqual(before);
  });

  it('replays one key to one answer, and refuses the same key on another branch', async () => {
    const id = await bareBranch('Keyed Fill');
    const key = newId();
    const first = await fillIn(id, { 'idempotency-key': key });
    const second = await fillIn(id, { 'idempotency-key': key });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(second.json().created).toHaveLength(6);
    expect(await trail(id, 'print_template.create')).toHaveLength(6);

    const other = await bareBranch('Keyed Fill Two');
    expect((await fillIn(other, { 'idempotency-key': key })).statusCode).toBe(409);
    expect(await rowsOf(other)).toHaveLength(0);
  });

  it('asks for the right to edit that branch, and does not confirm another operator’s', async () => {
    const id = await bareBranch('Not Reception’s');
    const refused = await fillIn(id, {}, receptionCookie);
    expect(refused.statusCode).toBe(403);
    expect(await rowsOf(id)).toHaveLength(0);

    const foreign = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);
    const answer = await fillIn(foreign);
    expect(answer.statusCode).toBe(404);
    expect(await rowsOf(foreign)).toHaveLength(0);
  });

  it('does not fill in a branch that has been archived', async () => {
    const id = await bareBranch('Retired Park');
    await ctx.db.update(branch).set({ archivedAt: new Date() }).where(eq(branch.id, id));
    expect((await fillIn(id)).statusCode).toBe(404);
    expect(await rowsOf(id)).toHaveLength(0);
  });
});

describe('cloning into a branch that now has default templates', () => {
  const clone = (targetId: string, sourceId: string) =>
    inject('POST', `/branches/${targetId}/clone`, { sourceBranchId: sourceId });

  /**
   * The seeded park's own words. Three of its six (the kids' band and the two
   * prep tickets) are the same as a default, so a clone has nothing to give for
   * those and says so; the others are what has to arrive.
   */
  const sourceRows = async () => {
    const rows = await rowsOf(centralId);
    const own = rows.filter((t) => !isUntouchedDefaultTemplate(t)).map((t) => t.type).sort();
    const same = rows.filter((t) => isUntouchedDefaultTemplate(t)).map((t) => t.type).sort();
    return { rows, own, same };
  };
  const planned = (res: { json: () => { plan: { printTemplates: { create: string[]; exists: string[] } } } }) => {
    const { create, exists } = res.json().plan.printTemplates;
    return { create: [...create].sort(), exists: [...exists].sort() };
  };

  it('carries the source’s templates onto the untouched defaults, without a second row of a type', async () => {
    const { rows: source, own, same } = await sourceRows();
    expect(own.length).toBeGreaterThan(0);
    const id = await openBranch('Clone Into Defaults');
    const defaults = await rowsOf(id);

    const preview = await inject('GET', `/branches/${id}/clone-preview?from=${centralId}`);
    expect(planned(preview)).toEqual({ create: own, exists: same });

    const res = await clone(id, centralId);
    expect(res.statusCode, res.body).toBe(200);
    expect(planned(res)).toEqual({ create: own, exists: same });

    const after = await rowsOf(id);
    expect(after).toHaveLength(6);
    for (const row of after) {
      const from = source.find((t) => t.type === row.type)!;
      expect(row.id).toBe(defaults.find((t) => t.type === row.type)!.id);
      expect(row.version).toBe(own.includes(row.type) ? 2 : 1);
      expect([row.name, row.showLogo, row.headerText, row.footerText, row.fields]).toEqual([
        from.name,
        from.showLogo,
        from.headerText,
        from.footerText,
        from.fields,
      ]);
    }
    const audited = await trail(id, 'print_template.update');
    expect(audited.map((r) => r.entityId).sort()).toEqual(
      after.filter((t) => own.includes(t.type)).map((t) => t.id).sort(),
    );
    const moved = audited.find((r) => r.entityId === after.find((t) => t.type === own[0])!.id)!;
    expect((moved.before as { version: number }).version).toBe(1);
    expect((moved.after as { version: number }).version).toBe(2);
  });

  it('a second clone changes nothing', async () => {
    const id = await openBranch('Clone Twice');
    await clone(id, centralId);
    const before = await rowsOf(id);
    const audited = await trail(id, 'print_template.update');
    const res = await clone(id, centralId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().counts.printTemplates).toEqual({ created: 0, existing: 6, blocked: 0 });
    expect(await rowsOf(id)).toEqual(before);
    expect(await trail(id, 'print_template.update')).toHaveLength(audited.length);
  });

  it('leaves a template the target has edited alone, and fills the rest', async () => {
    const { own, same } = await sourceRows();
    expect(own).toContain('receipt');
    const id = await openBranch('Clone Around An Edit');
    const receipt = (await rowsOf(id)).find((t) => t.type === 'receipt')!;
    const edited = await inject('PATCH', `/print-templates/${receipt.id}`, { footerText: 'Our own words' });
    expect(edited.statusCode).toBe(200);

    const res = await clone(id, centralId);
    expect(res.statusCode, res.body).toBe(200);
    expect(planned(res)).toEqual({
      create: own.filter((type) => type !== 'receipt'),
      exists: [...same, 'receipt'].sort(),
    });
    const after = (await rowsOf(id)).find((t) => t.type === 'receipt')!;
    expect(after.footerText).toBe('Our own words');
    expect(after.version).toBe(2);
  });

  it('a default edited back to its starting words is still the park’s own', async () => {
    const id = await openBranch('Edited Back');
    const receipt = (await rowsOf(id)).find((t) => t.type === 'receipt')!;
    await inject('PATCH', `/print-templates/${receipt.id}`, { footerText: 'Briefly' });
    await inject('PATCH', `/print-templates/${receipt.id}`, { footerText: null });
    const after = (await rowsOf(id)).find((t) => t.type === 'receipt')!;
    expect(isUntouchedDefaultTemplate(after)).toBe(false);
    const res = await clone(id, centralId);
    expect(res.json().plan.printTemplates.exists).toContain('receipt');
    expect((await rowsOf(id)).find((t) => t.type === 'receipt')!.footerText).toBeNull();
  });

  it('a source that is itself all defaults has nothing to give a target of defaults', async () => {
    const source = await openBranch('Default Source');
    const target = await openBranch('Default Target');
    const before = await rowsOf(target);
    const res = await clone(target, source);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().counts.printTemplates).toEqual({ created: 0, existing: 6, blocked: 0 });
    expect(await rowsOf(target)).toEqual(before);
  });

  it('a target with no rows at all still takes fresh copies at version 1', async () => {
    const id = await bareBranch('Clone Into Nothing');
    const res = await clone(id, centralId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().counts.printTemplates).toEqual({ created: 6, existing: 0, blocked: 0 });
    const after = await rowsOf(id);
    expect(after).toHaveLength(6);
    expect(after.every((t) => t.version === 1)).toBe(true);
  });
});

describe('the default itself', () => {
  it('has a name that fits the editor for every type', () => {
    for (const type of PRINT_TEMPLATE_TYPES) {
      const start = defaultPrintTemplate(type);
      expect(start.name.length).toBeGreaterThan(0);
      expect(start.name.length).toBeLessThanOrEqual(80);
      expect(isUntouchedDefaultTemplate({ ...start, type, version: 1 })).toBe(true);
      expect(isUntouchedDefaultTemplate({ ...start, type, version: 2 })).toBe(false);
    }
  });
});
