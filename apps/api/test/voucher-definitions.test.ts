import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, branch, product, ticketPackage, voucher, voucherDefinition } from '@oto/db';
import { newId } from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_NAME,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-400 — voucher types, created and edited by the park in the Console.
 *
 * Driven through the routes with real sessions, because every rule here is a
 * rule about what somebody pressing Save is allowed to leave behind: a free
 * product with no product, an amount of nothing, a type another operator can
 * reach. Each refusal is asserted with the row it must NOT have written, and
 * each write with the audit row it must have.
 */

let ctx: TestContext;
let admin: string;
let manager: string;
let reception: string;
let foreignAdmin: string;
let adminAccountId: string;
/** The seeded Margherita Pizza at Central Floresta — a product a free item can hand over. */
let pizzaId: string;
/** A seeded ticket package of the park, for the 1+1. */
let packageId: string;
/** A product of the SECOND operator — never linkable from OTO. */
let foreignProductId: string;
/** The park's operator and its Central Floresta branch, for vouchers written as the booth sync writes them. */
let operatorId: string;
let florestaId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  foreignAdmin = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);

  const [me] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.phone, ADMIN.phone))
    .limit(1);
  adminAccountId = me!.id;

  const [floresta] = await ctx.db
    .select({ id: branch.id })
    .from(branch)
    .where(eq(branch.name, 'Oto Play Park, Central Floresta'))
    .limit(1);
  florestaId = floresta!.id;
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  const [pizza] = await ctx.db
    .select({ id: product.id })
    .from(product)
    .where(and(eq(product.code, 'FB-PIZZA'), eq(product.branchId, floresta!.id)))
    .limit(1);
  pizzaId = pizza!.id;
  const [pkg] = await ctx.db
    .select({ id: ticketPackage.id })
    .from(ticketPackage)
    .where(eq(ticketPackage.branchId, floresta!.id))
    .limit(1);
  packageId = pkg!.id;

  const secondOperatorId = await operatorIdByName(ctx.db, SECOND_OPERATOR_NAME);
  foreignProductId = newId();
  await ctx.db
    .insert(product)
    .values({ id: foreignProductId, operatorId: secondOperatorId, name: 'Another park’s pizza' });
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const post = (cookie: string, payload: Record<string, unknown>, key: string = newId()) =>
  ctx.app.inject({
    method: 'POST',
    url: '/voucher-definitions',
    headers: { cookie, 'idempotency-key': key },
    payload,
  });

const patch = (cookie: string, id: string, payload: Record<string, unknown>, key: string = newId()) =>
  ctx.app.inject({
    method: 'PATCH',
    url: `/voucher-definitions/${id}`,
    headers: { cookie, 'idempotency-key': key },
    payload,
  });

const archive = (cookie: string, id: string, key: string = newId()) =>
  ctx.app.inject({
    method: 'DELETE',
    url: `/voucher-definitions/${id}`,
    headers: { cookie, 'idempotency-key': key },
  });

async function rowsWithCode(code: string) {
  return ctx.db.select().from(voucherDefinition).where(eq(voucherDefinition.code, code));
}

async function auditFor(action: string, entityId: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));
}

async function seededDefinition(code: string) {
  const [row] = await rowsWithCode(code);
  if (!row) throw new Error(`the seed has no ${code}`);
  return row;
}

describe('creating a voucher type (SCRUM-400)', () => {
  it('creates a 50 THB off type, audits it, and answers a replay of the same key with the same type', async () => {
    const payload = {
      code: 'test-50-thb-off',
      nameEn: '50 THB off',
      nameTh: 'ส่วนลด 50 บาท',
      kind: 'discount',
      valueType: 'amount',
      valueSatang: 5_000,
      expiryDays: 30,
      titleEn: '50 THB OFF YOUR TICKETS',
      titleTh: 'ส่วนลดค่าบัตร 50 บาท',
      instructionEn: 'Show this QR at OTO Reception.',
      instructionTh: 'แสดง QR นี้ที่แผนกต้อนรับ OTO',
      termsEn: 'One use only. No cash value.',
    };
    const key = newId();
    const first = await post(admin, payload, key);
    expect(first.statusCode, first.body).toBe(201);
    const created = first.json().definition;
    expect(created).toMatchObject({
      code: 'test-50-thb-off',
      kind: 'discount',
      valueType: 'amount',
      valueSatang: 5_000,
      valueBp: null,
      productId: null,
      ticketPackageId: null,
      expiryDays: 30,
      titleEn: '50 THB OFF YOUR TICKETS',
      titleTh: 'ส่วนลดค่าบัตร 50 บาท',
      instructionEn: 'Show this QR at OTO Reception.',
      instructionTh: 'แสดง QR นี้ที่แผนกต้อนรับ OTO',
      active: true,
      archivedAt: null,
      usedBy: [],
    });

    const [entry] = await auditFor('voucher_definition.create', created.id);
    expect(entry, 'a type was created with no audit row').toBeTruthy();
    expect(entry!.actorAccountId).toBe(adminAccountId);
    expect(entry!.after).toMatchObject({ code: 'test-50-thb-off', valueSatang: 5_000 });

    // The same key and the same body: the stored answer, and still one row.
    const replay = await post(admin, payload, key);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(await rowsWithCode('test-50-thb-off')).toHaveLength(1);

    // The same key with a different body is somebody else's request.
    const mismatch = await post(admin, { ...payload, valueSatang: 6_000 }, key);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe('IDEMPOTENCY_MISMATCH');
    expect((await rowsWithCode('test-50-thb-off'))[0]!.valueSatang).toBe(5_000);
  });

  it('refuses a type that is not whole, names what is missing, and writes nothing', async () => {
    const cases: Array<{ body: Record<string, unknown>; code: string }> = [
      { body: { kind: 'discount', valueType: 'amount' }, code: 'VOUCHER_VALUE_MISSING' },
      { body: { kind: 'discount', valueType: 'amount', valueSatang: 0 }, code: 'VOUCHER_VALUE_MISSING' },
      { body: { kind: 'discount', valueType: 'percent', valueBp: 0 }, code: 'VOUCHER_VALUE_MISSING' },
      { body: { kind: 'discount', valueType: 'item', valueSatang: 100 }, code: 'VOUCHER_VALUE_TYPE_INVALID' },
      { body: { kind: 'free_item' }, code: 'VOUCHER_PRODUCT_MISSING' },
      { body: { kind: 'free_item', productId: foreignProductId }, code: 'VOUCHER_PRODUCT_NOT_FOUND' },
      { body: { kind: 'free_item', productId: pizzaId, valueType: 'amount' }, code: 'VOUCHER_VALUE_TYPE_INVALID' },
      { body: { kind: 'free_ticket' }, code: 'VOUCHER_PACKAGE_MISSING' },
      { body: { kind: 'free_ticket', ticketPackageId: newId() }, code: 'VOUCHER_PACKAGE_NOT_FOUND' },
    ];
    for (const [i, c] of cases.entries()) {
      const code = `test-incomplete-${i}`;
      const res = await post(admin, { code, nameEn: `Incomplete ${i}`, ...c.body });
      expect(res.statusCode, `${JSON.stringify(c.body)}: ${res.body}`).toBe(400);
      expect(res.json().error.code).toBe(c.code);
      expect(await rowsWithCode(code), `${c.code} still wrote a row`).toHaveLength(0);
    }
  });

  it('saves a free product and a 1+1 with their links named, and a type that never expires', async () => {
    const item = await post(admin, {
      code: 'test-free-pizza',
      nameEn: 'Free pizza',
      kind: 'free_item',
      productId: pizzaId,
      expiryDays: null,
    });
    expect(item.statusCode, item.body).toBe(201);
    expect(item.json().definition).toMatchObject({
      kind: 'free_item',
      valueType: 'item',
      productId: pizzaId,
      expiryDays: null,
      product: { id: pizzaId, name: 'Margherita Pizza', code: 'FB-PIZZA', live: true },
    });

    const ticket = await post(admin, {
      code: 'test-one-plus-one',
      nameEn: '1+1 test',
      kind: 'free_ticket',
      ticketPackageId: packageId,
    });
    expect(ticket.statusCode, ticket.body).toBe(201);
    expect(ticket.json().definition).toMatchObject({
      kind: 'free_ticket',
      valueType: 'item',
      ticketPackageId: packageId,
      ticketPackage: { id: packageId, live: true },
    });
  });
});

describe('editing a voucher type (SCRUM-400)', () => {
  it('will not save the seeded Kids Pizza until it names its product, then saves the wording and "never"', async () => {
    const before = await seededDefinition('spin-kids-pizza');
    expect(before.productId, 'the seed was expected to leave Kids Pizza unlinked').toBeNull();

    // Wording alone leaves a free product the till cannot honour: refused.
    const refused = await patch(admin, before.id, { titleEn: 'FREE KIDS PIZZA' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('VOUCHER_PRODUCT_MISSING');
    expect((await seededDefinition('spin-kids-pizza')).titleEn).toBeNull();

    const saved = await patch(admin, before.id, {
      productId: pizzaId,
      titleEn: 'FREE KIDS PIZZA',
      titleTh: 'พิซซ่าเด็กฟรี',
      instructionEn: 'Show this slip at the OTO restaurant for one free kids pizza.',
      instructionTh: 'แสดงสลิปนี้ที่ร้านอาหาร OTO รับพิซซ่าเด็กฟรี 1 ถาด',
      termsEn: 'Valid at any Oto Play Park. One use only.',
      expiryDays: null,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const view = saved.json().definition;
    expect(view).toMatchObject({
      productId: pizzaId,
      titleEn: 'FREE KIDS PIZZA',
      titleTh: 'พิซซ่าเด็กฟรี',
      expiryDays: null,
      product: { name: 'Margherita Pizza' },
    });
    // The booth prize that points at it, so the screen can say what an edit reaches.
    // The Thai name too: a slip prints the prize's own names where a title is left empty.
    expect(view.usedBy).toEqual([
      expect.objectContaining({
        boothName: 'Booth 1',
        prizeName: 'Kids Pizza',
        prizeNameTh: 'พิซซ่าสำหรับเด็ก',
        active: true,
      }),
    ]);

    const [entry] = await auditFor('voucher_definition.update', before.id);
    expect(entry, 'an edit with no audit row').toBeTruthy();
    expect(entry!.before).toMatchObject({ productId: null, expiryDays: 14, titleEn: null });
    expect(entry!.after).toMatchObject({ productId: pizzaId, expiryDays: null, titleEn: 'FREE KIDS PIZZA' });
  });

  it('refuses a PATCH that names no field as “Nothing to change”, and writes nothing', async () => {
    const before = await seededDefinition('spin-voucher-150');
    const audited = (await auditFor('voucher_definition.update', before.id)).length;
    // An empty body, and one whose only key is not a field (dropped by the schema).
    for (const body of [{}, { notAField: 'x' }]) {
      const res = await patch(admin, before.id, body);
      expect(res.statusCode, `${JSON.stringify(body)}: ${res.body}`).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION');
      expect(JSON.stringify(res.json().error.details)).toContain('Nothing to change');
    }
    const after = await seededDefinition('spin-voucher-150');
    expect(after.updatedAt.getTime(), 'an empty edit moved updatedAt').toBe(before.updatedAt.getTime());
    expect(await auditFor('voucher_definition.update', before.id), 'an empty edit was audited').toHaveLength(
      audited,
    );
  });

  it('clears what the old kind read when the kind changes, and stores blank words as not written', async () => {
    const created = await post(admin, {
      code: 'test-kind-switch',
      nameEn: 'Kind switch',
      kind: 'free_item',
      productId: pizzaId,
      titleEn: 'A title',
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().definition.id;

    const switched = await patch(admin, id, {
      kind: 'discount',
      valueType: 'amount',
      valueSatang: 2_000,
      titleEn: '   ',
    });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json().definition).toMatchObject({
      kind: 'discount',
      valueType: 'amount',
      valueSatang: 2_000,
      productId: null,
      product: null,
      titleEn: null,
    });
  });
});

describe('how many vouchers a type still has out (SCRUM-409)', () => {
  it('counts the issued vouchers that are neither used, void nor past their date, on the list and on a single answer', async () => {
    const created = await post(admin, { code: 'test-still-out', nameEn: 'Still out', kind: 'manual' });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().definition.id;
    // A type nobody has won yet has nothing out.
    expect(created.json().definition.unredeemedVouchers).toBe(0);

    const now = Date.now();
    const day = 86_400_000;
    /** A voucher of the type, issued yesterday for 14 days, as the booth sync files one. */
    const issue = (code: string, values: Partial<typeof voucher.$inferInsert>) =>
      ctx.db.insert(voucher).values({
        id: newId(),
        operatorId,
        branchId: florestaId,
        voucherDefinitionId: id,
        code,
        source: 'booth',
        status: 'issued',
        issuedAt: new Date(now - day),
        expiresAt: new Date(now + 13 * day),
        ...values,
      });
    await issue('TEST-OUT-DATED', {});
    await issue('TEST-OUT-NEVER', { expiresAt: null });
    // Past its date a minute ago, still marked issued: no job marks a lapsed voucher expired yet.
    await issue('TEST-LAPSED', { expiresAt: new Date(now - 60_000) });
    // Marked expired outright: a status the schema allows and the till refuses.
    await issue('TEST-MARKED', { status: 'expired', expiresAt: new Date(now - 60_000) });
    await issue('TEST-USED', { status: 'redeemed', redeemedAt: new Date(now - 3_600_000) });
    await issue('TEST-VOID', { status: 'void' });

    const list = await ctx.app.inject({ method: 'GET', url: '/voucher-definitions', headers: { cookie: admin } });
    expect(list.statusCode, list.body).toBe(200);
    const definitions: Array<{ id: string; code: string; unredeemedVouchers: number }> = list.json().definitions;
    expect(definitions.find((d) => d.id === id)?.unredeemedVouchers).toBe(2);
    // The vouchers above are this type's alone: the seeded 100 THB Voucher still has none out.
    expect(definitions.find((d) => d.code === 'spin-voucher-100')?.unredeemedVouchers).toBe(0);

    const edited = await patch(admin, id, { nameEn: 'Still out, renamed' });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json().definition.unredeemedVouchers).toBe(2);
  });
});

describe('archiving a voucher type (SCRUM-400)', () => {
  it('archives it once, hides it from the list, refuses an edit, and restores it', async () => {
    const created = await post(admin, {
      code: 'test-archive-me',
      nameEn: 'Archive me',
      kind: 'manual',
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().definition.id;

    const key = newId();
    const first = await archive(admin, id, key);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().definition.archivedAt).toBeTruthy();
    expect(first.json().definition.active).toBe(false);
    // A replay of the same press is the same answer.
    const replay = await archive(admin, id, key);
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    // A second press with a new key finds it archived: same row, no new record.
    const second = await archive(admin, id);
    expect(second.statusCode).toBe(200);
    expect(second.json().definition.archivedAt).toBe(first.json().definition.archivedAt);
    expect(await auditFor('voucher_definition.archive', id)).toHaveLength(1);

    const live = await ctx.app.inject({ method: 'GET', url: '/voucher-definitions', headers: { cookie: admin } });
    expect(live.json().definitions.map((d: { id: string }) => d.id)).not.toContain(id);
    const all = await ctx.app.inject({
      method: 'GET',
      url: '/voucher-definitions?includeArchived=true',
      headers: { cookie: admin },
    });
    expect(all.json().definitions.map((d: { id: string }) => d.id)).toContain(id);

    const edit = await patch(admin, id, { nameEn: 'Edited while archived' });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error.code).toBe('VOUCHER_DEFINITION_ARCHIVED');

    const restored = await ctx.app.inject({
      method: 'POST',
      url: `/voucher-definitions/${id}/restore`,
      headers: { cookie: admin, 'idempotency-key': newId() },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().definition).toMatchObject({ archivedAt: null, active: true });
    expect(await auditFor('voucher_definition.restore', id)).toHaveLength(1);
  });
});

describe('who may set up voucher types (SCRUM-400)', () => {
  it('reception may neither read nor change them; a branch manager may read and not change', async () => {
    const [target] = await rowsWithCode('spin-voucher-100');
    expect((await ctx.app.inject({ method: 'GET', url: '/voucher-definitions', headers: { cookie: reception } })).statusCode).toBe(403);
    expect((await post(reception, { code: 'test-reception', nameEn: 'No', kind: 'manual' })).statusCode).toBe(403);
    expect((await patch(reception, target!.id, { nameEn: 'No' })).statusCode).toBe(403);
    expect((await archive(reception, target!.id)).statusCode).toBe(403);

    const read = await ctx.app.inject({ method: 'GET', url: '/voucher-definitions', headers: { cookie: manager } });
    expect(read.statusCode, read.body).toBe(200);
    expect((await post(manager, { code: 'test-manager', nameEn: 'No', kind: 'manual' })).statusCode).toBe(403);
    expect((await patch(manager, target!.id, { nameEn: 'No' })).statusCode).toBe(403);
    expect(await rowsWithCode('test-reception')).toHaveLength(0);
    expect(await rowsWithCode('test-manager')).toHaveLength(0);
    expect((await rowsWithCode('spin-voucher-100'))[0]!.nameEn).toBe(target!.nameEn);
  });

  it('another operator’s administrator neither sees nor reaches the park’s types', async () => {
    const [target] = await rowsWithCode('spin-voucher-100');
    const list = await ctx.app.inject({ method: 'GET', url: '/voucher-definitions', headers: { cookie: foreignAdmin } });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().definitions.map((d: { id: string }) => d.id)).not.toContain(target!.id);

    const edit = await patch(foreignAdmin, target!.id, { nameEn: 'Taken over' });
    expect(edit.statusCode).toBe(404);
    const gone = await archive(foreignAdmin, target!.id);
    expect(gone.statusCode).toBe(404);
    expect((await rowsWithCode('spin-voucher-100'))[0]).toMatchObject({ nameEn: target!.nameEn, archivedAt: null });

    const options = await ctx.app.inject({
      method: 'GET',
      url: '/voucher-definitions/link-options',
      headers: { cookie: foreignAdmin },
    });
    expect(options.statusCode, options.body).toBe(200);
    expect(options.json().products.map((p: { id: string }) => p.id)).not.toContain(pizzaId);
  });
});

describe('what a type can point at (SCRUM-400)', () => {
  it('lists the park’s products on sale and its live ticket packages, each with its branch', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/voucher-definitions/link-options',
      headers: { cookie: admin },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { products, packages } = res.json();
    expect(products).toContainEqual(
      expect.objectContaining({
        id: pizzaId,
        name: 'Margherita Pizza',
        code: 'FB-PIZZA',
        branchName: 'Oto Play Park, Central Floresta',
      }),
    );
    expect(products.map((p: { id: string }) => p.id)).not.toContain(foreignProductId);
    expect(packages).toContainEqual(expect.objectContaining({ id: packageId }));
  });
});
