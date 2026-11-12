import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, branch, product, productCategory } from '@oto/db';
import {
  PARTY_KITCHEN_EDIT_PERMISSION,
  PartyKitchenChoicesAnswerSchema,
  PartyKitchenEditAnswerSchema,
  ROLE_BUNDLES,
  newId,
  type PartyKitchenEditAnswer,
} from '@oto/shared';
import type {
  DirectoryKitchenPlanChoicesAnswer,
  DirectoryKitchenPlanEditAnswer,
  DirectoryKitchenPlanEditBody,
  DirectoryOutcome,
  OtoAppDirectory,
} from '../src/services/otoapp-directory';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-907 — A MANAGER CHANGES A PARTY'S KITCHEN PLAN ON THE TILL, AND THE
 * BEO IS CHANGED (the owner's decision 7 of 12 November), the platform's half.
 *
 * The OTO App is as real as it can be without its server: its tables are built
 * by its own migrations and the plan is read through its plan view (0050). Its
 * directory is a stub that answers as the app's door does and, when it says
 * yes, writes the change into the app's own BEO rows, so the answer the till
 * gets is read back from the view as on staging. The app's own half (the door,
 * the BEO's Save, the activity row) is the app's check, till-kitchen-edit.
 */

let ctx: TestContext;
let central: string;
let operatorId: string;
let reception: string;
let manager: string;
let chalongManager: string;
let admin: string;

const appTenant = newId();
const appCentral = newId();
const template = newId();
const PARTY_DATE = '2099-05-16';

type Mode = 'apply' | 'refuse' | 'silent';
let mode: Mode = 'apply';
const editCalls: Array<{ eventId: string; body: DirectoryKitchenPlanEditBody }> = [];
/** The edit ids the stub's app has written, as the app's door keeps them on its activity row. */
const applied = new Set<string>();
let choicesMode: 'ok' | 'silent' = 'ok';

/** What the app's door does with a `set` of a kids' line: the count and note on the BEO's own row. */
async function applyInApp(eventId: string, body: DirectoryKitchenPlanEditBody) {
  for (const raw of body.changes) {
    const c = raw as { op: string; lineId?: string; qty?: number; note?: string | null };
    if (c.op !== 'set' || !c.lineId) continue;
    await ctx.db.execute(sql`
      update otoapp.beo_kitchen_plans
         set menus = jsonb_set(menus, '{kids}', (
           select jsonb_agg(case when l ->> 'id' = ${c.lineId}
                    then l || ${JSON.stringify({ ...(c.qty === undefined ? {} : { quantity: c.qty }), ...(c.note === undefined ? {} : { notes: c.note ?? '' }) })}::jsonb
                    else l end)
             from jsonb_array_elements(menus -> 'kids') l))
       where event_id = ${eventId}`);
  }
}

const directory: OtoAppDirectory = {
  configured: true,
  async checkinAttendee() {
    return { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'not used here', retryable: true as const };
  },
  async addAttendee() {
    return { ok: false as const, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'not used here', retryable: true as const };
  },
  async editKitchenPlan(eventId, body): Promise<DirectoryOutcome<DirectoryKitchenPlanEditAnswer>> {
    editCalls.push({ eventId, body });
    if (mode === 'silent') {
      return { ok: false, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'The OTO App did not answer', retryable: true };
    }
    if (mode === 'refuse') {
      return {
        ok: false,
        status: 409,
        code: 'OTOAPP_SET_MENU_LINE',
        message: 'French fries is a dish of the party\'s set menu, so it is not removed from the till.',
        retryable: false,
      };
    }
    const replayed = applied.has(body.id);
    if (!replayed) {
      applied.add(body.id);
      await applyInApp(eventId, body);
    }
    return { ok: true, status: 200, body: { edit: { id: body.id, eventId, changes: body.changes.length }, replayed } };
  },
  async kitchenPlanChoices(): Promise<DirectoryOutcome<DirectoryKitchenPlanChoicesAnswer>> {
    if (choicesMode === 'silent') {
      return { ok: false, status: null, code: 'OTOAPP_DIRECTORY_UNREACHABLE', message: 'The OTO App did not answer', retryable: true };
    }
    return {
      ok: true,
      status: 200,
      body: { setMenu: { templateName: 'ZZ TEST 907 set menu', groups: [{ label: 'Pizza', options: ['Margherita', 'Hawaiian'], allowMultiple: false }] } },
    };
  },
};

async function call<T>(
  method: 'GET' | 'PUT',
  cookie: string,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: { cookie, ...headers },
  });
  return { status: res.statusCode, body: res.json() as T, headers: res.headers };
}

/** A party in the OTO App with a set menu and an extra, as the BEO writes them. */
async function appParty(id: string, title: string) {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time,
      total_value, prepayment_amount, child_name, parent_name, num_children, num_adults, location_text, status, created_at, updated_at)
    values (
      ${id}, ${appTenant}, ${appCentral}, 'birthday', ${title}, ${PARTY_DATE}, '13:00', '16:00',
      16900, 3000, 'Mali', 'Nok', 10, 4, 'Party room 1', 'upcoming',
      (now() at time zone 'UTC') - interval '1 hour', (now() at time zone 'UTC') - interval '1 hour')`);
  await ctx.db.execute(sql`
    insert into otoapp.beo_package_snapshots (id, event_id, package_name, base_price, slips_time)
    values (${newId()}, ${id}, 'Floresta Birthday', 1690000, '11:00'::time)`);
  await ctx.db.execute(sql`
    insert into otoapp.beo_kitchen_plans (id, event_id, set_menu_enabled, set_menu_template_id, menus, cake_mode, cake_time, cake_notes)
    values (${newId()}, ${id}, true, ${template}, ${JSON.stringify({
      kidsFoodTime: '14:00',
      kids: [
        { id: 'set_g-pizza_Margherita', itemName: 'Margherita', quantity: 3, notes: '(Pizza)', included: true, price: 0, source: 'set_menu', groupId: 'g-pizza' },
        { id: 'm1', itemName: 'Calamari', quantity: 2, notes: '', included: false, price: 120, productCode: 'ZZ-907-CAL', source: 'additional' },
      ],
      adults: [],
      adultsDiffer: false,
    })}::jsonb, 'INTERNAL', '15:00', 'ZZ unicorn')`);
  return id;
}

const body = (changes: unknown[], o: Record<string, unknown> = {}) => ({ branchId: central, editId: newId(), changes, ...o });
const put = (cookie: string, id: string, payload: unknown, key = newId()) =>
  call<PartyKitchenEditAnswer>('PUT', cookie, `/parties/${id}/kitchen-plan`, payload, { 'idempotency-key': key });
const auditsOf = (id: string) =>
  ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'party.kitchen_update'), eq(auditLog.entityId, id)));

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const cat = newId();
  await ctx.db.insert(productCategory).values({ id: cat, operatorId, code: 'ZZ-907-FOOD', name: 'ZZ party food', taxableCategory: 'fnb', defaultPrepStation: 'kitchen' });
  await ctx.db.insert(product).values({ id: newId(), operatorId, branchId: central, categoryId: cat, kind: 'menu', code: 'ZZ-907-CAL', name: 'Calamari', priceSatang: 29_500 });
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-907')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
  await ctx.db.execute(sql`
    insert into otoapp.beo_set_menu_templates (id, tenant_id, name, items)
    values (${template}, ${appTenant}, 'ZZ TEST 907 set menu', ${JSON.stringify([
      { id: 'g-pizza', type: 'choice_group', label: 'Pizza', qty: 3, options: ['Margherita', 'Hawaiian'], optionProductCodes: { Margherita: 'CF-24' } },
    ])}::jsonb)`);
  (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

beforeEach(() => {
  mode = 'apply';
  choicesMode = 'ok';
  editCalls.length = 0;
});

describe('who may change it', () => {
  it('a branch manager and the administrators hold the permission; reception does not', () => {
    expect(ROLE_BUNDLES.branch_manager).toContain(PARTY_KITCHEN_EDIT_PERMISSION);
    expect(ROLE_BUNDLES.operator_admin).toContain(PARTY_KITCHEN_EDIT_PERMISSION);
    expect(ROLE_BUNDLES.platform_admin).toContain(PARTY_KITCHEN_EDIT_PERMISSION);
    expect(ROLE_BUNDLES.reception).not.toContain(PARTY_KITCHEN_EDIT_PERMISSION);
    expect(ROLE_BUNDLES.reception).toContain('pos:party:update');
    expect(ROLE_BUNDLES.staff).not.toContain(PARTY_KITCHEN_EDIT_PERMISSION);
  });

  it('reception, who edit the party, are refused the kitchen plan and its choices; nothing reaches the OTO App', async () => {
    const id = await appParty(newId(), 'ZZ TEST 907 reception');
    const res = await put(reception, id, body([{ op: 'set', lineId: 'm1', qty: 3 }]));
    expect(res.status).toBe(403);
    const choices = await call('GET', reception, `/parties/${id}/kitchen-plan/choices?branchId=${central}`);
    expect(choices.status).toBe(403);
    expect(editCalls).toEqual([]);
  });

  it("another park's manager is refused at this party's park", async () => {
    const id = await appParty(newId(), 'ZZ TEST 907 chalong');
    const res = await put(chalongManager, id, body([{ op: 'set', lineId: 'm1', qty: 3 }]));
    expect(res.status).toBe(403);
    expect(editCalls).toEqual([]);
  });
});

describe('a manager changes the plan and the BEO is changed', () => {
  it('the change goes to the OTO App under the edit id with who did it; the answer is the BEO as the view now reads it; one audit row', async () => {
    const id = await appParty(newId(), 'ZZ TEST 907 count');
    const payload = body([{ op: 'set', lineId: 'm1', qty: 3, note: 'no sauce' }]);
    const res = await put(manager, id, payload);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(PartyKitchenEditAnswerSchema.safeParse(res.body).success).toBe(true);
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]!.eventId).toBe(id);
    expect(editCalls[0]!.body).toMatchObject({ id: payload.editId, by: { role: 'Manager' }, changes: payload.changes });
    expect(editCalls[0]!.body.by.name.trim()).not.toBe('');
    expect(res.body.kitchenEdit).toEqual({ id: payload.editId, replayed: false });
    const calamari = res.body.kitchenPlan?.setMenu.find((m) => m.lineId === 'm1');
    expect(calamari).toMatchObject({ name: 'Calamari', qty: 3, note: 'no sauce', origin: 'extra', onTillMenu: true });
    expect(res.body.event.id).toBe(id);
    const [row, ...more] = await auditsOf(id);
    expect(more).toEqual([]);
    expect(row!.before).toMatchObject({ food: [{ lineId: 'm1', name: 'Calamari', qty: 2, note: null }], bar: [] });
    expect(row!.after).toMatchObject({
      food: [{ lineId: 'm1', name: 'Calamari', qty: 3, note: 'no sauce' }],
      editId: payload.editId,
      replayed: false,
      by: { role: 'Manager' },
    });
  });

  it('an administrator may too, named as one', async () => {
    const id = await appParty(newId(), 'ZZ TEST 907 admin');
    const res = await put(admin, id, body([{ op: 'cake', time: '16:00' }]));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(editCalls[0]!.body.by.role).toMatch(/admin/i);
  });

  it('the same press twice (one Idempotency-Key) is one write in the OTO App and the same answer', async () => {
    const id = await appParty(newId(), 'ZZ TEST 907 twice');
    const payload = body([{ op: 'set', lineId: 'm1', qty: 4 }]);
    const key = newId();
    const a = await put(manager, id, payload, key);
    const b = await put(manager, id, payload, key);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body).toEqual(a.body);
    expect(editCalls).toHaveLength(1);
    expect(await auditsOf(id)).toHaveLength(1);
    // The same edit id under a new key (a till that lost its answer and its key) is the app's replay: no second write.
    const c = await put(manager, id, payload);
    expect(c.status).toBe(200);
    expect(c.body.kitchenEdit.replayed).toBe(true);
    expect(c.headers['x-oto-replay']).toBe('true');
    expect(c.body.kitchenPlan?.setMenu.find((m) => m.lineId === 'm1')?.qty).toBe(4);
  });

  it("a refusal from the OTO App is said in its words, and nothing is recorded as written", async () => {
    const id = await appParty(newId(), 'ZZ TEST 907 refused');
    mode = 'refuse';
    const res = await put(manager, id, body([{ op: 'remove', lineId: 'set_g-pizza_Margherita' }]));
    expect(res.status).toBe(409);
    const error = (res.body as unknown as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('OTOAPP_SET_MENU_LINE');
    expect(error.message).toMatch(/^The OTO App did not change the kitchen plan: French fries is a dish/);
    expect(await auditsOf(id)).toEqual([]);
  });

  it('no answer is a 502 that says Save again; nothing is recorded, and the same key runs again once the app answers', async () => {
    const id = await appParty(newId(), 'ZZ TEST 907 silent');
    mode = 'silent';
    const payload = body([{ op: 'set', lineId: 'm1', qty: 6 }]);
    const key = newId();
    const res = await put(manager, id, payload, key);
    expect(res.status).toBe(502);
    expect((res.body as unknown as { error: { code: string; message: string } }).error).toMatchObject({
      code: 'OTOAPP_NOT_ANSWERED',
      message: expect.stringMatching(/may not have changed yet\. Press Save again: it is never written twice\./),
    });
    expect(await auditsOf(id)).toEqual([]);
    mode = 'apply';
    const again = await put(manager, id, payload, key);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.kitchenPlan?.setMenu.find((m) => m.lineId === 'm1')?.qty).toBe(6);
    expect(editCalls.map((c) => c.body.id)).toEqual([payload.editId, payload.editId]);
  });

  it('a deployment with no directory says the plan was not changed', async () => {
    const id = await appParty(newId(), 'ZZ TEST 907 unconfigured');
    const { editKitchenPlan: _held, ...without } = directory;
    (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = without;
    try {
      const res = await put(manager, id, body([{ op: 'set', lineId: 'm1', qty: 3 }]));
      expect(res.status).toBe(503);
      expect((res.body as unknown as { error: { code: string } }).error.code).toBe('OTOAPP_DIRECTORY_NOT_CONFIGURED');
    } finally {
      (ctx.app as unknown as { otoAppDirectory: OtoAppDirectory }).otoAppDirectory = directory;
    }
  });

  it("a party that is not one of the branch's is 404, and the OTO App is never asked", async () => {
    const res = await put(manager, newId(), body([{ op: 'set', lineId: 'm1', qty: 3 }]));
    expect(res.status).toBe(404);
    expect(editCalls).toEqual([]);
  });

  it('a body the till may not send is refused before anything: a price, a count of 0, no change', async () => {
    const id = await appParty(newId(), 'ZZ TEST 907 body');
    const add = { op: 'add', id: newId(), list: 'food', name: 'Hummus', productCode: 'CF-13', qty: 1 };
    expect((await put(manager, id, body([{ ...add, price: 275 }]))).status).toBe(400);
    expect((await put(manager, id, body([{ op: 'set', lineId: 'm1', qty: 0 }]))).status).toBe(400);
    expect((await put(manager, id, body([]))).status).toBe(400);
    expect(editCalls).toEqual([]);
  });
});

describe("the set menu's choices", () => {
  it('a manager reads the groups from the OTO App; when it does not answer the form is told why and offered none', async () => {
    const id = await appParty(newId(), 'ZZ TEST 907 choices');
    const ok = await call('GET', manager, `/parties/${id}/kitchen-plan/choices?branchId=${central}`);
    expect(ok.status).toBe(200);
    expect(PartyKitchenChoicesAnswerSchema.parse(ok.body)).toEqual({
      status: 'ok',
      message: null,
      groups: [{ label: 'Pizza', options: ['Margherita', 'Hawaiian'], allowMultiple: false }],
    });
    choicesMode = 'silent';
    const silent = await call('GET', manager, `/parties/${id}/kitchen-plan/choices?branchId=${central}`);
    expect(silent.status).toBe(200);
    expect(silent.body).toEqual({
      status: 'unavailable',
      message: 'The OTO App did not answer, so the set menu choices cannot be changed here now.',
      groups: [],
    });
  });
});
