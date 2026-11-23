import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branch, product, productCategory } from '@oto/db';
import {
  PARTY_NOT_ON_TILL_MENU,
  composePartySlips,
  newId,
  type PartyDetailWithSlipsAnswer,
  type PartyKitchenPlan,
  type PartyPlanBarItem,
  type PartyPlanMenuItem,
  type PartySlipDocument,
} from '@oto/shared';
import { readPartyPlan } from '../src/services/party-plan';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-1051 — A DISH'S OR GROUP'S SERVING TIME ON THE TILL'S KITCHEN AND BAR
 * SLIPS (the owner's answer of 19 November: on the BEO, its print and the
 * till's slips).
 *
 * The BEO stores the time on each food line (`serviceTime` "HH:MM",
 * `serviceGroup`) in the kitchen plan's lists and the bar plan's items. The
 * app's migration 0057 publishes them through the till's plan view as
 * `service_time` and `service_group` on each kitchen line and bar line, only
 * when the line stores a valid clock time, so every row of before reads
 * unchanged. The platform reads the two keys read-only, the party page's route
 * carries them, and the slips print the timed lines after the rest, in time
 * order, the lines of one group at one time together.
 *
 * The OTO App's tables are built by its own migrations, the view is its
 * migration 0057 exactly, and the party is written into the app's own BEO
 * tables, so every read here is the read staging makes.
 */

let ctx: TestContext;
let central: string;
let operatorId: string;
let reception: string;

const appTenant = newId();
const appCentral = newId();

interface Line {
  id: string;
  itemName: string;
  quantity: number;
  notes?: string;
  productCode?: string;
  serviceTime?: unknown;
  serviceGroup?: unknown;
}

async function appParty(p: { id: string; kids: Line[]; adults?: Line[]; bar?: Line[]; differ?: boolean }): Promise<string> {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time,
      total_value, prepayment_amount, child_name, parent_name, whatsapp_phone_e164,
      kid_turning_age, num_children, num_adults, location_text, status, created_at, updated_at)
    values (
      ${p.id}, ${appTenant}, ${appCentral}, 'birthday', 'ZZ TEST 1051 Mali''s 6th', '2026-12-10', '13:00', '16:00',
      16900, 3000, 'Mali', 'Nok', '+66812345678',
      6, 10, 4, 'Party room 1', 'upcoming',
      (now() at time zone 'UTC') - interval '1 hour', (now() at time zone 'UTC') - interval '1 hour')`);
  await ctx.db.execute(sql`
    insert into otoapp.beo_package_snapshots (id, event_id, package_name, base_price, slips_time)
    values (${newId()}, ${p.id}, 'Floresta Birthday', 1690000, '11:00'::time)`);
  await ctx.db.execute(sql`
    insert into otoapp.beo_kitchen_plans (id, event_id, set_menu_enabled, menus, kitchen_ready_offset_minutes)
    values (${newId()}, ${p.id}, false,
            ${JSON.stringify({ kidsFoodTime: '14:00', adultsDiffer: p.differ ?? false, kids: p.kids, adults: p.adults ?? [] })}::jsonb, 20)`);
  await ctx.db.execute(sql`
    insert into otoapp.beo_bar_plans (id, event_id, service_time, items)
    values (${newId()}, ${p.id}, '13:30', ${JSON.stringify(p.bar ?? [])}::jsonb)`);
  return p.id;
}

interface ViewLine {
  name: string;
  service_time?: unknown;
  service_group?: unknown;
  [key: string]: unknown;
}

/** The view's whole kitchen plan for a party, as the till's seam reads it. */
async function viewPlan(eventId: string): Promise<{ lines: ViewLine[]; bar_lines: ViewLine[] }> {
  const rows = await ctx.db.execute(sql`select kitchen_plan from otoapp_v.event_packages where event_id = ${eventId}`);
  const row = (rows as unknown as { rows: Array<{ kitchen_plan: { lines: ViewLine[]; bar_lines: ViewLine[] } }> }).rows[0];
  if (!row) throw new Error('no view row');
  return row.kitchen_plan;
}

const byName = (lines: ViewLine[], name: string) => {
  const found = lines.find((l) => l.name === name);
  if (!found) throw new Error(`no line ${name}`);
  return found;
};
const serving = (l: ViewLine) => ({
  ...('service_time' in l ? { service_time: l.service_time } : {}),
  ...('service_group' in l ? { service_group: l.service_group } : {}),
});

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  const kitchenCat = newId();
  const barCat = newId();
  await ctx.db.insert(productCategory).values([
    { id: kitchenCat, operatorId, code: 'ZZ-1051-FOOD', name: 'Party food', taxableCategory: 'fnb', defaultPrepStation: 'kitchen' },
    { id: barCat, operatorId, code: 'ZZ-1051-DRINK', name: 'Party drinks', taxableCategory: 'bar', defaultPrepStation: 'bar' },
  ]);
  const item = (code: string, name: string, categoryId: string) => ({
    id: newId(), operatorId, branchId: central, categoryId, kind: 'menu' as const, code, name, priceSatang: 10_000,
  });
  await ctx.db.insert(product).values([item('ZZ-1051-NUG', 'Chicken nuggets', kitchenCat), item('ZZ-1051-JUICE', 'Kids juice', barCat)]);
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-1051')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central})`);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

// =============================================================================
// The view (app migration 0057): the two keys, only with a valid clock time
// =============================================================================

describe('the till plan view carries each BEO line’s serving time and group', () => {
  const timed = newId();
  const untimed = newId();

  beforeAll(async () => {
    await appParty({
      id: timed,
      kids: [
        { id: 'k1', itemName: 'Chicken nuggets', quantity: 10, productCode: 'ZZ-1051-NUG' },
        { id: 'k2', itemName: 'Fruit skewers', quantity: 2, serviceTime: '13:00', serviceGroup: 'ZZ Dessert' },
        { id: 'k3', itemName: 'Mini waffles', quantity: 10, serviceTime: '13:00', serviceGroup: '  ZZ   Dessert ' },
        { id: 'k4', itemName: 'Pad Thai', quantity: 4, serviceTime: ' 9:05 ' },
        { id: 'k5', itemName: 'Soup', quantity: 4, serviceTime: '25:00', serviceGroup: 'Starter' },
        { id: 'k6', itemName: 'Salad', quantity: 4, serviceTime: 'noon' },
        { id: 'k7', itemName: 'Bread', quantity: 4, serviceGroup: 'Starter' },
        { id: 'k8', itemName: 'Rice', quantity: 4, serviceTime: '12:15:00', serviceGroup: 'x'.repeat(80) },
        { id: 'k9', itemName: 'Noodles', quantity: 4, serviceTime: 1230, serviceGroup: 7 },
      ],
      bar: [
        { id: 'b1', itemName: 'Juice pitcher', quantity: 2 },
        { id: 'b2', itemName: 'Mocktails', quantity: 10, serviceTime: '14:00', serviceGroup: 'Toast' },
        { id: 'b3', itemName: 'Kids juice', quantity: 10, productCode: 'ZZ-1051-JUICE', serviceTime: '12:30' },
      ],
    });
    await appParty({
      id: untimed,
      kids: [
        { id: 'u1', itemName: 'Chicken nuggets', quantity: 10, productCode: 'ZZ-1051-NUG' },
        { id: 'u2', itemName: 'Fruit skewers', quantity: 2, notes: 'no melon' },
      ],
      bar: [{ id: 'ub1', itemName: 'Juice pitcher', quantity: 2 }],
    });
  });

  it('a valid clock time gives service_time as HH:MM and, when named, service_group trimmed and folded, at most 60 characters', async () => {
    const kp = await viewPlan(timed);
    expect(serving(byName(kp.lines, 'Fruit skewers'))).toEqual({ service_time: '13:00', service_group: 'ZZ Dessert' });
    expect(serving(byName(kp.lines, 'Mini waffles'))).toEqual({ service_time: '13:00', service_group: 'ZZ Dessert' });
    expect(serving(byName(kp.lines, 'Pad Thai'))).toEqual({ service_time: '09:05' });
    expect(serving(byName(kp.lines, 'Rice'))).toEqual({ service_time: '12:15', service_group: 'x'.repeat(60) });
    expect(serving(byName(kp.bar_lines, 'Mocktails'))).toEqual({ service_time: '14:00', service_group: 'Toast' });
    expect(serving(byName(kp.bar_lines, 'Kids juice'))).toEqual({ service_time: '12:30' });
  });

  it('a line with no valid time carries neither key: none stored, an impossible hour, a word, a group alone, a number', async () => {
    const kp = await viewPlan(timed);
    for (const name of ['Chicken nuggets', 'Soup', 'Salad', 'Bread', 'Noodles']) {
      expect(serving(byName(kp.lines, name)), name).toEqual({});
    }
    expect(serving(byName(kp.bar_lines, 'Juice pitcher'))).toEqual({});
  });

  it('a party with no times reads exactly as 0052 gave it: the same keys on every line, none of them new', async () => {
    const kp = await viewPlan(untimed);
    const keysOf = (l: ViewLine) => Object.keys(l).sort();
    for (const l of kp.lines) {
      expect(keysOf(l)).toEqual(['choice_group', 'chosen_option', 'line_id', 'name', 'note', 'product_code', 'qty', 'source', 'unit_price_satang']);
    }
    for (const l of kp.bar_lines) {
      expect(keysOf(l)).toEqual(['charge_approved', 'line_id', 'name', 'note', 'product_code', 'qty', 'source', 'unit_price_satang']);
    }
    expect(byName(kp.lines, 'Fruit skewers').note).toBe('no melon');
  });

  it('the platform reads the two keys read-only, and the party page’s route carries them to the till', async () => {
    const read = await readPartyPlan(ctx.db, { branchId: central, eventId: timed });
    expect(read.status).toBe('ready');
    const line = (name: string) => read.kitchen!.setMenu.find((m) => m.name === name) as PartyPlanMenuItem;
    const bar = (name: string) => read.kitchen!.barItems.find((m) => m.name === name) as PartyPlanBarItem;
    expect([line('Fruit skewers').serviceTime, line('Fruit skewers').serviceGroup]).toEqual(['13:00', 'ZZ Dessert']);
    expect([line('Mini waffles').serviceTime, line('Mini waffles').serviceGroup]).toEqual(['13:00', 'ZZ Dessert']);
    expect([line('Pad Thai').serviceTime, line('Pad Thai').serviceGroup]).toEqual(['09:05', undefined]);
    expect([line('Chicken nuggets').serviceTime, line('Chicken nuggets').serviceGroup]).toEqual([undefined, undefined]);
    expect([bar('Mocktails').serviceTime, bar('Mocktails').serviceGroup]).toEqual(['14:00', 'Toast']);
    expect([bar('Kids juice').serviceTime, bar('Juice pitcher').serviceTime]).toEqual(['12:30', undefined]);

    const res = await ctx.app.inject({ method: 'GET', url: `/parties/${timed}?branchId=${central}`, headers: { cookie: reception } });
    expect(res.statusCode).toBe(200);
    const answer = res.json() as PartyDetailWithSlipsAnswer;
    const shown = answer.kitchenPlan!.setMenu.filter((m) => m.name === 'Fruit skewers' || m.name === 'Mini waffles');
    expect(shown.map((m) => [m.name, m.serviceTime, m.serviceGroup])).toEqual([
      ['Fruit skewers', '13:00', 'ZZ Dessert'],
      ['Mini waffles', '13:00', 'ZZ Dessert'],
    ]);
    expect(answer.kitchenPlan!.barItems.find((b) => b.name === 'Mocktails')).toMatchObject({ serviceTime: '14:00', serviceGroup: 'Toast' });
  });
});

// =============================================================================
// The slip: the timed lines after the rest, in time order, a group together
// =============================================================================

const planOf = (
  setMenu: PartyKitchenPlan['setMenu'],
  barItems: PartyKitchenPlan['barItems'] = [],
): Pick<PartyKitchenPlan, 'setMenu' | 'barItems' | 'kitchen' | 'counts' | 'cake'> => ({
  counts: { kidsExpected: 10, adultsExpected: 4 },
  kitchen: { kidsFoodTime: '14:00', adultsFoodTime: null, readyOffsetMinutes: 20, slipsTime: '11:00', barServiceTime: '13:30' },
  setMenu,
  barItems,
  cake: null,
});
const food = (name: string, qty: number, over: Partial<PartyPlanMenuItem> = {}): PartyPlanMenuItem => ({
  productCode: null, name, qty, choiceGroup: null, chosenOption: null, note: null, origin: 'extra', ...over,
});
const drink = (name: string, qty: number, over: Partial<PartyPlanBarItem> = {}): PartyPlanBarItem => ({
  productCode: null, name, qty, note: null, origin: 'extra', ...over,
});
const compose = (plan: ReturnType<typeof planOf>) =>
  composePartySlips({
    plan,
    partyName: "Mali's 6th",
    location: 'Party room 1',
    prepStationOf: (code) => (code === 'ZZ-1051-NUG' ? 'kitchen' : code === 'ZZ-1051-JUICE' ? 'bar' : null),
    printedAt: '11:00',
  });

describe('the slips, composed with serving times', () => {
  it('keeps separate serving times for one billed dish shared by children and adults', async () => {
    const id = await appParty({ id: newId(), differ: true,
      kids: [{ id: 'k', itemName: 'Pizza', quantity: 2, serviceTime: '12:30' }],
      adults: [{ id: 'a', itemName: 'Pizza', quantity: 2, serviceTime: '13:30' }] });
    const plan = await readPartyPlan(ctx.db, { branchId: central, eventId: id });
    expect(plan.plan!.setMenu).toHaveLength(1);
    const slips = compose(planOf(plan.plan!.setMenu));
    expect(slips.kitchen!.lines.map(l => l.time)).toEqual(['12:30', '13:30']);
  });

  it('a plan with no times composes exactly as before: no time or group on any line', () => {
    const slips = compose(planOf(
      [food('Chicken nuggets', 10, { productCode: 'ZZ-1051-NUG' }), food('Fruit skewers', 2)],
      [drink('Juice pitcher', 2)],
    ));
    expect(slips.kitchen!.lines).toEqual([
      { qty: 10, name: 'Chicken nuggets' },
      { qty: 2, name: 'Fruit skewers', note: PARTY_NOT_ON_TILL_MENU },
    ]);
    expect(slips.bar!.lines).toEqual([{ qty: 2, name: 'Juice pitcher', note: PARTY_NOT_ON_TILL_MENU }]);
  });

  it('the kitchen slip: untimed lines first as before, then the timed ones in time order, a group’s lines together under its name and time', () => {
    const slips = compose(planOf([
      food('Fruit skewers', 2, { serviceTime: '13:00', serviceGroup: 'ZZ Dessert' }),
      food('Chicken nuggets', 10, { productCode: 'ZZ-1051-NUG' }),
      food('Pad Thai', 4, { serviceTime: '12:30' }),
      food('Mini waffles', 10, { serviceTime: '13:00', serviceGroup: 'ZZ Dessert' }),
      food('Soup', 4, { serviceTime: '12:30', serviceGroup: 'Starter' }),
      food('Bread', 4),
    ]));
    expect(slips.kitchen!.lines).toEqual([
      { qty: 10, name: 'Chicken nuggets' },
      { qty: 4, name: 'Bread', note: PARTY_NOT_ON_TILL_MENU },
      { qty: 4, name: 'Pad Thai', note: PARTY_NOT_ON_TILL_MENU, time: '12:30' },
      { qty: 4, name: 'Soup', note: PARTY_NOT_ON_TILL_MENU, time: '12:30', group: 'Starter' },
      { qty: 2, name: 'Fruit skewers', note: PARTY_NOT_ON_TILL_MENU, time: '13:00', group: 'ZZ Dessert' },
      { qty: 10, name: 'Mini waffles', note: PARTY_NOT_ON_TILL_MENU, time: '13:00', group: 'ZZ Dessert' },
    ] satisfies PartySlipDocument['lines']);
  });

  it('the bar slip orders its timed drinks the same way; a bar line sent to the kitchen keeps its time there', () => {
    const slips = compose(planOf([], [
      drink('Juice pitcher', 2),
      drink('Mocktails', 10, { serviceTime: '14:00', serviceGroup: 'Toast' }),
      drink('Kids juice', 10, { productCode: 'ZZ-1051-JUICE', serviceTime: '12:30' }),
      drink('Hot chips', 4, { productCode: 'ZZ-1051-NUG', serviceTime: '12:00' }),
    ]));
    expect(slips.bar!.lines).toEqual([
      { qty: 2, name: 'Juice pitcher', note: PARTY_NOT_ON_TILL_MENU },
      { qty: 10, name: 'Kids juice', time: '12:30' },
      { qty: 10, name: 'Mocktails', note: PARTY_NOT_ON_TILL_MENU, time: '14:00', group: 'Toast' },
    ]);
    expect(slips.kitchen!.lines).toEqual([{ qty: 4, name: 'Hot chips', time: '12:00' }]);
  });

  it('nothing else on a slip changes with a time: the heading, the party, READY BY, the room and the children read as before', () => {
    const slips = compose(planOf([food('Fruit skewers', 2, { serviceTime: '13:00', serviceGroup: 'ZZ Dessert' })]));
    expect(slips.kitchen).toMatchObject({
      title: 'Kitchen', heading: 'Birthday party', orderRef: "Mali's 6th", time: '11:00',
      details: ['Room: Party room 1', 'Children: 10'], readyBy: '13:40',
    });
    expect(slips.bar).toBeNull();
  });
});
