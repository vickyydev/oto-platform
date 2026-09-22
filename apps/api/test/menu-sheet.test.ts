import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { branch } from '@oto/db';
import {
  CATEGORY_SHEET,
  HELP_SHEET,
  MENU_SHEET,
  MENU_SHEET_COLUMNS,
  CATEGORY_SHEET_COLUMNS,
  branchToday,
} from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-232 — the spreadsheet, driven end to end through the real routes.
 *
 * Export the menu, change the bytes the way a person changes them in Excel,
 * ask what that would do, confirm it, and read the menu back. Nothing here
 * calls the parser or the writer directly except to play the part of Excel.
 */

let ctx: TestContext;
let cookie: string;
let branchId: string;
/** The second operator's branch: a genuinely empty menu, for the template. */
let emptyCookie: string;
let emptyBranchId: string;

type Value = string | number | boolean | null;

const call = async (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  opts: { cookie?: string; payload?: unknown } = {},
) => {
  const res = await ctx.app.inject({
    method,
    url,
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    ...(opts.payload === undefined ? {} : { payload: opts.payload as object }),
  });
  return { statusCode: res.statusCode, body: res.json() as Record<string, never> };
};

/** Download the workbook exactly as a browser would. */
async function exportWorkbook(who = cookie, branch = branchId): Promise<Buffer> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/branches/${branch}/menu/export.xlsx`,
    headers: { cookie: who },
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('spreadsheetml');
  expect(String(res.headers['content-disposition'])).toContain('.xlsx');
  return res.rawPayload;
}

/** The sheets of a workbook, as arrays of rows. */
async function sheetsOf(file: Buffer): Promise<Map<string, Value[][]>> {
  const sheets = (await readXlsxFile(file)) as Array<{ sheet: string; data: Value[][] }>;
  return new Map(sheets.map((s) => [s.sheet, s.data]));
}

/** Rows as objects keyed by the header, which is how a person reads the file. */
function asObjects(rows: Value[][]): Array<Record<string, Value>> {
  const [head, ...body] = rows;
  const headers = (head ?? []).map((h) => String(h ?? ''));
  return body.map((line) => {
    const out: Record<string, Value> = {};
    headers.forEach((name, at) => {
      out[name] = line[at] ?? null;
    });
    return out;
  });
}

/** Write a workbook back the way Excel does when somebody presses Save. */
async function rewrite(
  menu: Array<Record<string, Value>>,
  categories: Array<Record<string, Value>>,
): Promise<Buffer> {
  const sheet = (columns: readonly string[], rows: Array<Record<string, Value>>) => [
    columns.map((c) => ({ value: c, type: String })),
    ...rows.map((row) =>
      columns.map((c) => {
        const value = row[c];
        if (value === null || value === undefined || value === '') {
          return { value: undefined, type: String };
        }
        return typeof value === 'number'
          ? { value, type: Number }
          : { value: String(value), type: String };
      }),
    ),
  ];
  return writeXlsxFile([
    { data: sheet(MENU_SHEET_COLUMNS, menu) as never, sheet: MENU_SHEET },
    { data: sheet(CATEGORY_SHEET_COLUMNS, categories) as never, sheet: CATEGORY_SHEET },
  ]).toBuffer();
}

const upload = (file: Buffer, filename = 'menu.xlsx') => ({
  filename,
  contentBase64: file.toString('base64'),
});

const preview = (file: Buffer, branch = branchId) =>
  call('POST', `/branches/${branch}/menu/import/preview`, {
    cookie,
    payload: upload(file),
  });

const apply = (file: Buffer, previewToken: string, branch = branchId) =>
  call('POST', `/branches/${branch}/menu/import/commit`, {
    cookie,
    payload: { ...upload(file), previewToken },
  });

const readMenuItems = async (branch = branchId) => {
  const res = await call('GET', `/branches/${branch}/menu`, { cookie });
  return res.body.products as unknown as Array<{
    id: string;
    code: string | null;
    name: string;
    priceSatang: number;
    priceWeekendSatang: number | null;
    costSatang: number | null;
    active: boolean;
    translations: { th?: { name?: string } } | null;
    effectivePrepStation: string;
    linkedModifierGroupIds: string[];
  }>;
};

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  emptyCookie = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  emptyBranchId = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);

  // A small menu of our own, through the real write routes.
  const food = await call('POST', '/menu/categories', {
    cookie,
    payload: { code: 'T-FOOD', name: 'Food', taxableCategory: 'fnb', defaultPrepStation: 'kitchen', sortOrder: 0 },
  });
  const mains = await call('POST', '/menu/categories', {
    cookie,
    payload: { code: 'T-FOOD-MAINS', name: 'Mains', parentId: food.body.id as unknown as string, sortOrder: 0 },
  });
  await call('POST', '/menu/categories', {
    cookie,
    payload: { code: 'T-DRINKS', name: 'Drinks', taxableCategory: 'fnb', defaultPrepStation: 'bar', sortOrder: 1 },
  });
  const ice = await call('POST', '/menu/modifier-groups', {
    cookie,
    payload: {
      name: 'Test ice level',
      required: true,
      sortOrder: 0,
      options: [
        { name: 'Normal ice', priceSatang: 0, sortOrder: 0 },
        { name: 'No ice', priceSatang: 0, sortOrder: 1 },
      ],
    },
  });

  const mainsId = mains.body.id as unknown as string;
  const drinks = await call('GET', `/branches/${branchId}/menu`, { cookie });
  const drinksId = (drinks.body.categories as unknown as Array<{ id: string; code: string }>).find(
    (c) => c.code === 'T-DRINKS',
  )!.id;

  await call('POST', `/branches/${branchId}/menu/products`, {
    cookie,
    payload: {
      code: 'T-PIZZA',
      name: 'Margherita Pizza',
      description: 'Tomato, mozzarella, basil',
      categoryId: mainsId,
      priceSatang: 22000,
      costSatang: 7800,
      translations: { th: { name: 'พิซซ่ามาร์เกอริต้า' }, fr: { name: 'Pizza Margherita' } },
    },
  });
  await call('POST', `/branches/${branchId}/menu/products`, {
    cookie,
    payload: {
      code: 'T-SODA',
      name: 'Soft Drink',
      categoryId: drinksId,
      priceSatang: 4500,
      modifierGroupIds: [ice.body.id as unknown as string],
    },
  });
  await call('POST', `/branches/${branchId}/menu/products`, {
    cookie,
    payload: { code: 'T-WATER', name: 'Bottled Water', categoryId: drinksId, priceSatang: 2500 },
  });
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the export', () => {
  it('has the three sheets, the full header, and the menu in baht', async () => {
    const sheets = await sheetsOf(await exportWorkbook());
    expect([...sheets.keys()]).toEqual([MENU_SHEET, CATEGORY_SHEET, HELP_SHEET]);
    expect(sheets.get(MENU_SHEET)![0]).toEqual([...MENU_SHEET_COLUMNS]);
    expect(sheets.get(CATEGORY_SHEET)![0]).toEqual([...CATEGORY_SHEET_COLUMNS]);

    const rows = asObjects(sheets.get(MENU_SHEET)!);
    const pizza = rows.find((r) => r.code === 'T-PIZZA')!;
    // Baht as a person types it, not satang.
    expect(pizza.price_weekday).toBe(220);
    expect(pizza.cost).toBe(78);
    // Blank weekend means the same as weekday, so the cell is left empty.
    expect(pizza.price_weekend).toBeNull();
    expect(pizza.name_en).toBe('Margherita Pizza');
    expect(pizza.name_th).toBe('พิซซ่ามาร์เกอริต้า');
    expect(pizza.category).toBe('T-FOOD');
    expect(pizza.subcategory).toBe('T-FOOD-MAINS');
    expect(pizza.available).toBe('yes');
    expect(String(pizza.id)).toMatch(/^[0-9a-f-]{36}$/);

    const soda = rows.find((r) => r.code === 'T-SODA')!;
    expect(soda.modifier_groups).toBe('Test ice level');
  });

  it('names the file for the branch’s own calendar day, not UTC’s', async () => {
    // Phuket is UTC+7, so for the first seven hours of every trading day the
    // UTC date is yesterday's: two mornings' exports would land in the same
    // folder under one name, and the file would be dated the day before the
    // menu inside it.
    const [row] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/branches/${branchId}/menu/export.xlsx`,
      headers: { cookie },
    });
    expect(String(res.headers['content-disposition'])).toContain(
      `oto-menu-${row!.code}-${branchToday(row!.timezone)}.xlsx`,
    );
  });

  it('writes the category tree with parents before their children', async () => {
    const rows = asObjects((await sheetsOf(await exportWorkbook())).get(CATEGORY_SHEET)!);
    const codes = rows.map((r) => r.code);
    expect(codes.indexOf('T-FOOD')).toBeLessThan(codes.indexOf('T-FOOD-MAINS'));
    const mains = rows.find((r) => r.code === 'T-FOOD-MAINS')!;
    expect(mains.parent_code).toBe('T-FOOD');
    // A sub-category leaves them blank to inherit, which is the prototype's rule.
    expect(mains.default_prep_station).toBeNull();
    expect(mains.default_tax_category).toBeNull();
  });
});

describe('the template, which is what an empty menu exports', () => {
  it('still carries every header, the help sheet and worked examples', async () => {
    const sheets = await sheetsOf(await exportWorkbook(emptyCookie, emptyBranchId));
    const menu = asObjects(sheets.get(MENU_SHEET)!);
    expect(menu.length).toBeGreaterThan(0);
    expect(menu.every((r) => r.action === 'example')).toBe(true);
    expect(menu[0]!.code).toBe('FB-PIZZA');
    expect(sheets.get(HELP_SHEET)!.length).toBeGreaterThan(20);
    // The help sheet says the thing that surprises people most.
    const help = sheets
      .get(HELP_SHEET)!
      .map((r) => r.join(' '))
      .join('\n');
    expect(help).toContain('never removes anything you left out');
    expect(help).toContain('BLANK MEANS THE SAME AS WEEKDAY');
  });

  it('imports back as nothing at all, because the examples are marked', async () => {
    const file = await exportWorkbook(emptyCookie, emptyBranchId);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/branches/${emptyBranchId}/menu/import/preview`,
      headers: { cookie: emptyCookie },
      payload: upload(file),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { counts: Record<string, number>; errors: unknown[] };
    expect(body.errors).toEqual([]);
    expect(body.counts.create).toBe(0);
    expect(body.counts.ignored).toBeGreaterThan(0);
  });
});

describe('export → edit → preview → apply', () => {
  let edited: Buffer;
  let token: string;

  it('previews a price change, a new item and a withdrawal without writing anything', async () => {
    const sheets = await sheetsOf(await exportWorkbook());
    const menu = asObjects(sheets.get(MENU_SHEET)!);
    const categories = asObjects(sheets.get(CATEGORY_SHEET)!);

    // Exactly what a person does in Excel.
    menu.find((r) => r.code === 'T-PIZZA')!.price_weekday = 240;
    menu.find((r) => r.code === 'T-PIZZA')!.price_weekend = 260;
    menu.find((r) => r.code === 'T-WATER')!.action = 'archive';
    menu.push({
      id: null,
      code: 'FB-CAKE',
      name_en: 'Chocolate Cake',
      name_th: 'เค้กช็อกโกแลต',
      description_en: 'A slice, with cream',
      description_th: null,
      category: 'T-FOOD',
      subcategory: null,
      price_weekday: 130.5,
      price_weekend: null,
      cost: 40,
      prep_station: null,
      tax_category: null,
      available: 'yes',
      modifier_groups: null,
      action: null,
    });
    edited = await rewrite(menu, categories);

    const res = await preview(edited);
    expect(res.statusCode).toBe(200);
    const body = res.body as unknown as {
      previewToken: string;
      filename: string;
      counts: Record<string, number>;
      rows: Array<{
        code: string;
        action: string;
        changes: Array<{ field: string; from: string | null; to: string | null }>;
      }>;
      errors: unknown[];
      notice: string;
    };
    token = body.previewToken;

    expect(body.errors).toEqual([]);
    expect(body.filename).toBe('menu.xlsx');
    expect(body.counts).toMatchObject({ create: 1, update: 1, archive: 1 });
    expect(body.notice).toContain('never removes anything you left out');
    const pizza = body.rows.find((c) => c.code === 'T-PIZZA')!;
    expect(pizza.action).toBe('update');
    // Named and valued as the SHEET spells it, because that is what was edited.
    expect(pizza.changes).toContainEqual({ field: 'price_weekday', from: '220', to: '240' });
    expect(pizza.changes).toContainEqual({ field: 'price_weekend', from: null, to: '260' });
    expect(body.rows.find((c) => c.code === 'T-SODA')!.action).toBe('unchanged');

    // Nothing has been written.
    const items = await readMenuItems();
    expect(items.find((i) => i.code === 'T-PIZZA')!.priceSatang).toBe(22000);
    expect(items.some((i) => i.code === 'FB-CAKE')).toBe(false);
  });

  it('refuses a token that does not describe this file', async () => {
    const res = await apply(edited, 'v1.deadbeefdeadbeef.deadbeefdeadbeef');
    expect(res.statusCode).toBe(409);
    expect((res.body.error as unknown as { code: string }).code).toBe('IMPORT_FILE_CHANGED');
  });

  it('applies it, and the menu says so', async () => {
    const res = await apply(edited, token);
    expect(res.statusCode).toBe(200);
    expect(res.body as unknown as Record<string, number>).toMatchObject({
      created: 1,
      updated: 1,
      archived: 1,
    });

    const items = await readMenuItems();
    const pizza = items.find((i) => i.code === 'T-PIZZA')!;
    expect(pizza.priceSatang).toBe(24000);
    expect(pizza.priceWeekendSatang).toBe(26000);

    const cake = items.find((i) => i.code === 'FB-CAKE')!;
    // 130.5 baht is 13050 satang, and the decimal survived the round trip.
    expect(cake.priceSatang).toBe(13050);
    expect(cake.costSatang).toBe(4000);
    expect(cake.translations?.th?.name).toBe('เค้กช็อกโกแลต');
    expect(cake.effectivePrepStation).toBe('kitchen');

    // The withdrawal was explicit, and nothing else went with it.
    expect(items.some((i) => i.code === 'T-WATER')).toBe(false);
    expect(items.some((i) => i.code === 'T-SODA')).toBe(true);
  });

  it('keeps the languages the sheet has no column for', async () => {
    const items = await readMenuItems();
    const pizza = items.find((i) => i.code === 'T-PIZZA')!;
    expect((pizza.translations as { fr?: { name?: string } }).fr?.name).toBe('Pizza Margherita');
  });

  it('keeps the modifier groups a round-tripped row already had', async () => {
    const menu = await call('GET', `/branches/${branchId}/menu`, { cookie });
    const groups = menu.body.modifierGroups as unknown as Array<{ id: string; name: string }>;
    const soda = (menu.body.products as unknown as Array<{ code: string; linkedModifierGroupIds: string[] }>)
      .find((i) => i.code === 'T-SODA')!;
    expect(
      soda.linkedModifierGroupIds.map((id) => groups.find((g) => g.id === id)?.name),
    ).toEqual(['Test ice level']);
  });

  it('refuses a confirmation once somebody else has moved the menu under it', async () => {
    // A file that is still valid against the current menu — the point here is
    // the token, not the rows.
    const sheets = await sheetsOf(await exportWorkbook());
    const menu = asObjects(sheets.get(MENU_SHEET)!);
    menu.find((r) => r.code === 'T-PIZZA')!.price_weekday = 245;
    const file = await rewrite(menu, asObjects(sheets.get(CATEGORY_SHEET)!));

    const previewed = await preview(file);
    const stale = (previewed.body as unknown as { previewToken: string }).previewToken;

    // Meanwhile, in the admin screen.
    const soda = (await readMenuItems()).find((i) => i.code === 'T-SODA')!;
    const moved = await call('PATCH', `/branches/${branchId}/menu/products/${soda.id}`, {
      cookie,
      payload: { priceSatang: 4900 },
    });
    expect(moved.statusCode).toBe(200);

    const res = await apply(file, stale);
    expect(res.statusCode).toBe(409);
    expect((res.body.error as unknown as { code: string }).code).toBe('MENU_CHANGED');
    // And the confirmed change did not land.
    expect((await readMenuItems()).find((i) => i.code === 'T-PIZZA')!.priceSatang).toBe(24000);
  });

  it('refuses the same confirmation twice by the token, not by inventing a bad row', async () => {
    // `edited` still says to withdraw FB-WATER, which the apply above already
    // withdrew. That is NOT an error: a row asking for what has already
    // happened is an unchanged row — otherwise the file somebody keeps on
    // their desktop becomes unimportable the moment it has been imported, and
    // the help sheet's "importing the same file twice changes nothing" is a
    // lie. What stops the second press is the honest thing: the preview's
    // token no longer describes this menu.
    const res = await apply(edited, token);
    expect(res.statusCode).toBe(409);
    expect((res.body.error as unknown as { code: string }).code).toBe('MENU_CHANGED');

    // Previewed again, the file has no bad row in it at all: the withdrawal
    // has happened, so it reads as unchanged and withdraws nothing a second
    // time. (The one update left is FB-SODA, whose price the test above moved
    // in the admin screen after this file was exported.)
    const again = (await preview(edited)).body as unknown as {
      errors: unknown[];
      counts: Record<string, number>;
      rows: Array<{ code: string | null; action: string }>;
    };
    expect(again.errors).toEqual([]);
    expect(again.counts).toMatchObject({ create: 0, archive: 0 });
    expect(again.rows.find((r) => r.code === 'T-WATER')!.action).toBe('unchanged');
  });

  it('re-importing the current export changes nothing', async () => {
    const again = await exportWorkbook();
    const res = await preview(again);
    const body = res.body as unknown as { counts: Record<string, number>; previewToken: string };
    expect(body.counts).toMatchObject({ create: 0, update: 0, archive: 0 });
    expect(body.counts.unchanged).toBeGreaterThan(0);

    const applied = await apply(again, body.previewToken);
    expect(applied.statusCode).toBe(200);
  });
});

describe('an item left out of the sheet is left alone', () => {
  it('does not withdraw what the file never mentions', async () => {
    const sheets = await sheetsOf(await exportWorkbook());
    const menu = asObjects(sheets.get(MENU_SHEET)!);
    const categories = asObjects(sheets.get(CATEGORY_SHEET)!);
    const before = await readMenuItems();

    // One category's worth of rows, the way somebody fixing three prices does it.
    const trimmed = menu.filter((r) => r.code === 'T-PIZZA');
    trimmed[0]!.price_weekday = 250;
    const file = await rewrite(trimmed, categories);

    const previewed = await preview(file);
    const body = previewed.body as unknown as {
      previewToken: string;
      counts: Record<string, number>;
    };
    expect(body.counts).toMatchObject({ create: 0, update: 1, archive: 0 });
    expect((await apply(file, body.previewToken)).statusCode).toBe(200);

    const after = await readMenuItems();
    expect(after.map((i) => i.code).sort()).toEqual(before.map((i) => i.code).sort());
    expect(after.find((i) => i.code === 'T-PIZZA')!.priceSatang).toBe(25000);
  });
});

describe('a bad row refuses the whole file, and every bad row is named', () => {
  it('lists all of them with the row number Excel shows', async () => {
    const sheets = await sheetsOf(await exportWorkbook());
    const menu = asObjects(sheets.get(MENU_SHEET)!);
    const categories = asObjects(sheets.get(CATEGORY_SHEET)!);
    const before = await readMenuItems();

    menu.find((r) => r.code === 'T-PIZZA')!.price_weekday = '฿220';
    menu.find((r) => r.code === 'T-SODA')!.category = 'NOSUCHCATEGORY';
    // A new row with none of what a new row needs.
    menu.push({
      id: null,
      code: null,
      name_en: 'No code and no category',
      category: null,
      price_weekday: 10,
      action: null,
    });
    menu.push({
      id: null,
      code: 'lower case',
      name_en: 'Bad code',
      category: 'T-FOOD',
      price_weekday: 10,
      prep_station: 'microwave',
      available: 'perhaps',
      action: null,
    });
    const file = await rewrite(menu, categories);

    const res = await preview(file);
    expect(res.statusCode).toBe(200);
    const body = res.body as unknown as {
      previewToken: string;
      errors: Array<{ sheet: string; row: number; column: string | null; message: string }>;
    };

    const columns = body.errors.map((e) => e.column);
    expect(columns).toContain('price_weekday');
    expect(columns).toContain('category');
    expect(columns).toContain('code');
    expect(columns).toContain('prep_station');
    expect(columns).toContain('available');
    // Validation runs to the end rather than stopping at the first failure.
    expect(body.errors.length).toBeGreaterThanOrEqual(5);
    expect(body.errors.every((e) => e.row >= 2)).toBe(true);
    expect(body.errors.find((e) => e.column === 'price_weekday')!.message).toContain('฿220');

    // And the file is refused whole.
    const applied = await apply(file, body.previewToken);
    expect(applied.statusCode).toBe(400);
    const after = await readMenuItems();
    expect(after.map((i) => i.code).sort()).toEqual(before.map((i) => i.code).sort());
    expect(after.find((i) => i.code === 'T-PIZZA')!.priceSatang).toBe(25000);
  });

  it('refuses a duplicate code inside one sheet, naming the other row', async () => {
    const sheets = await sheetsOf(await exportWorkbook());
    const menu = asObjects(sheets.get(MENU_SHEET)!);
    menu.push({ ...menu.find((r) => r.code === 'T-PIZZA')!, id: null, name_en: 'Twin' });
    const res = await preview(await rewrite(menu, asObjects(sheets.get(CATEGORY_SHEET)!)));
    const errors = (res.body as unknown as { errors: Array<{ message: string }> }).errors;
    expect(errors.some((e) => /is also on row \d+ of this sheet/.test(e.message))).toBe(true);
  });

  it('refuses a file that is not a workbook at all', async () => {
    const res = await preview(Buffer.from('code,name_en\nFB-X,Not a workbook\n'));
    expect(res.statusCode).toBe(400);
    expect(String((res.body.error as unknown as { message: string }).message)).toContain('.xlsx');
  });
});

describe('the Categories sheet builds the tree the items need', () => {
  it('adds a tab and its first item in one file', async () => {
    const sheets = await sheetsOf(await exportWorkbook());
    const menu = asObjects(sheets.get(MENU_SHEET)!);
    const categories = asObjects(sheets.get(CATEGORY_SHEET)!);

    categories.push({
      code: 'DESSERTS',
      name_en: 'Desserts',
      name_th: 'ของหวาน',
      parent_code: null,
      sort_order: 5,
      default_prep_station: 'kitchen',
      default_tax_category: 'fnb',
      action: null,
    });
    menu.push({
      id: null,
      code: 'FB-SUNDAE',
      name_en: 'Sundae',
      category: 'DESSERTS',
      price_weekday: 90,
      available: 'yes',
      action: null,
    });

    const file = await rewrite(menu, categories);
    const res = await preview(file);
    const body = res.body as unknown as { previewToken: string; errors: unknown[] };
    expect(body.errors).toEqual([]);
    expect((await apply(file, body.previewToken)).statusCode).toBe(200);

    const menuNow = await call('GET', `/branches/${branchId}/menu`, { cookie });
    const desserts = (
      menuNow.body.categories as unknown as Array<{ id: string; code: string; name: string }>
    ).find((c) => c.code === 'DESSERTS')!;
    expect(desserts.name).toBe('Desserts');
    const sundae = (await readMenuItems()).find((i) => i.code === 'FB-SUNDAE')!;
    expect(sundae.priceSatang).toBe(9000);
    expect(sundae.effectivePrepStation).toBe('kitchen');
  });

  it('refuses a third level and a top-level with no taxable area', async () => {
    const sheets = await sheetsOf(await exportWorkbook());
    const categories = asObjects(sheets.get(CATEGORY_SHEET)!);
    categories.push({
      code: 'TOO-DEEP',
      name_en: 'Too deep',
      parent_code: 'T-FOOD-MAINS',
      sort_order: 9,
      default_prep_station: null,
      default_tax_category: null,
      action: null,
    });
    categories.push({
      code: 'NO-AREA',
      name_en: 'No taxable area',
      parent_code: null,
      sort_order: 10,
      default_prep_station: null,
      default_tax_category: null,
      action: null,
    });
    const res = await preview(await rewrite(asObjects(sheets.get(MENU_SHEET)!), categories));
    const errors = (res.body as unknown as { errors: Array<{ message: string; column: string | null }> })
      .errors;
    expect(errors.some((e) => e.message.includes('two levels deep'))).toBe(true);
    expect(errors.some((e) => e.column === 'default_tax_category')).toBe(true);
  });
});

describe('confirming twice applies once', () => {
  it('refuses the second press, and replays the first when it carries the same key', async () => {
    const sheets = await sheetsOf(await exportWorkbook());
    const menu = asObjects(sheets.get(MENU_SHEET)!);
    menu.find((r) => r.code === 'T-PIZZA')!.price_weekday = 265;
    const file = await rewrite(menu, asObjects(sheets.get(CATEGORY_SHEET)!));
    const { previewToken } = (await preview(file)).body as unknown as { previewToken: string };

    const body = { ...upload(file), previewToken };
    const send = (key?: string) =>
      ctx.app.inject({
        method: 'POST',
        url: `/branches/${branchId}/menu/import/commit`,
        headers: { cookie, ...(key ? { 'idempotency-key': key } : {}) },
        payload: body,
      });

    const first = await send('menu-import-once');
    expect(first.statusCode).toBe(200);

    // The same key: the stored answer comes back, and nothing runs again.
    const replay = await send('menu-import-once');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());

    // No key at all — the menu has moved, so the token no longer describes it.
    const again = await send();
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('MENU_CHANGED');

    expect((await readMenuItems()).find((i) => i.code === 'T-PIZZA')!.priceSatang).toBe(26500);
  });
});

describe('re-importing the same file changes nothing the second time', () => {
  it('a row withdrawing something already withdrawn reads as unchanged, not as an error', async () => {
    // This is the workbook's own printed promise — "Importing the same file
    // twice changes nothing the second time" — and `action: archive` used to
    // break it: the second pass could not find the row among the live ones,
    // said "There is no item FB-SUNDAE to withdraw", and one bad row refuses
    // the whole file. The file somebody keeps on their desktop became
    // unimportable the moment it had been imported.
    const sheets = await sheetsOf(await exportWorkbook());
    const menu = asObjects(sheets.get(MENU_SHEET)!);
    const categories = asObjects(sheets.get(CATEGORY_SHEET)!);

    // The Desserts tab and its only item, withdrawn in one file.
    menu.find((r) => r.code === 'FB-SUNDAE')!.action = 'archive';
    categories.find((r) => r.code === 'DESSERTS')!.action = 'archive';
    const file = await rewrite(menu, categories);

    const first = (await preview(file)).body as unknown as {
      previewToken: string;
      errors: unknown[];
      counts: Record<string, number>;
      categories: Record<string, number>;
    };
    expect(first.errors).toEqual([]);
    expect(first.counts.archive).toBe(1);
    expect(first.categories.archive).toBe(1);
    expect((await apply(file, first.previewToken)).statusCode).toBe(200);
    expect((await readMenuItems()).some((i) => i.code === 'FB-SUNDAE')).toBe(false);

    // The same bytes again.
    const second = (await preview(file)).body as unknown as {
      previewToken: string;
      errors: Array<{ message: string }>;
      counts: Record<string, number>;
      categories: Record<string, number>;
      rows: Array<{ sheet: string; code: string | null; action: string }>;
    };
    expect(second.errors).toEqual([]);
    expect(second.counts).toMatchObject({ create: 0, update: 0, archive: 0 });
    expect(second.categories).toMatchObject({ create: 0, update: 0, archive: 0 });
    expect(second.counts.unchanged).toBeGreaterThan(0);
    expect(second.rows.find((r) => r.code === 'FB-SUNDAE')!.action).toBe('unchanged');
    expect(second.rows.find((r) => r.code === 'DESSERTS')!.action).toBe('unchanged');
    expect(second.rows.every((r) => r.action === 'unchanged')).toBe(true);

    // And confirming it is accepted, and does nothing.
    const applied = await apply(file, second.previewToken);
    expect(applied.statusCode).toBe(200);
    expect(applied.body as unknown as Record<string, number>).toMatchObject({
      created: 0,
      updated: 0,
      archived: 0,
      categoriesArchived: 0,
    });
    expect((await readMenuItems()).some((i) => i.code === 'FB-SUNDAE')).toBe(false);
  });

  it('still refuses a withdrawal of something that was never on the menu', async () => {
    // The fix is "already withdrawn", not "withdrawal always succeeds".
    const sheets = await sheetsOf(await exportWorkbook());
    const menu = asObjects(sheets.get(MENU_SHEET)!);
    menu.push({
      id: null,
      code: 'FB-NEVER',
      name_en: 'Never existed',
      category: 'T-FOOD',
      price_weekday: 10,
      action: 'archive',
    });
    const res = await preview(await rewrite(menu, asObjects(sheets.get(CATEGORY_SHEET)!)));
    const errors = (res.body as unknown as { errors: Array<{ message: string }> }).errors;
    expect(errors.some((e) => e.message.includes('FB-NEVER'))).toBe(true);
  });
});

describe('the preview counts what would happen, not what was typed', () => {
  it('leaves a row that carries an error out of the counts', async () => {
    const sheets = await sheetsOf(await exportWorkbook());
    const menu = asObjects(sheets.get(MENU_SHEET)!);
    const categories = asObjects(sheets.get(CATEGORY_SHEET)!);

    // One good edit, and one new row nothing can be done with.
    menu.find((r) => r.code === 'T-PIZZA')!.price_weekday = 270;
    menu.push({
      id: null,
      code: 'FB-BROKEN',
      name_en: 'Broken',
      category: 'NOSUCHCATEGORY',
      price_weekday: 10,
      action: null,
    });
    const res = await preview(await rewrite(menu, categories));
    const body = res.body as unknown as {
      counts: Record<string, number>;
      rows: Array<{ code: string | null; action: string }>;
      errors: Array<{ column: string | null }>;
    };

    expect(body.errors.some((e) => e.column === 'category')).toBe(true);
    // The bad row is not a creation: it creates nothing. Saying "1 to create"
    // beside the error that stops it is the preview contradicting itself.
    expect(body.counts.create).toBe(0);
    expect(body.counts.update).toBe(1);
    // It is still LISTED, because seeing what it tried to say is how it gets
    // fixed — it is only the count that leaves it out.
    expect(body.rows.some((r) => r.code === 'FB-BROKEN')).toBe(true);
  });
});

describe('the import is on the record', () => {
  it('writes a row for the file and a row for each item it touched', async () => {
    const res = await call('GET', '/audit?action=menu.import', { cookie });
    expect(res.statusCode).toBe(200);
    const entries = res.body.entries as unknown as Array<{
      action: string;
      after: { filename?: string; result?: Record<string, number> } | null;
    }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.after?.filename).toBe('menu.xlsx');

    const created = await call('GET', '/audit?action=menu_item.create', { cookie });
    expect((created.body.entries as unknown as unknown[]).length).toBeGreaterThan(0);
  });
});
