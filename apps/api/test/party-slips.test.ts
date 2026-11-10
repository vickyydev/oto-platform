import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  boxCommand,
  branch,
  device,
  partySlipPrint,
  printJob,
  product,
  productCategory,
  station,
  stationDevice,
} from '@oto/db';
import {
  PARTY_ADULTS_NO_NOTE,
  PARTY_ADULTS_ONLY,
  PARTY_CHOICE_NOT_MADE,
  PARTY_KIDS_ONLY,
  PARTY_NO_KIDS_FOOD_TIME,
  PartyDetailWithSlipsAnswerSchema,
  PartySlipsPrintAnswerSchema,
  addDaysToIsoDate,
  businessDate,
  composePartySlips,
  newId,
  parseDayStart,
  partyAdultsNoteMark,
  partyCountsMark,
  partyReadyBy,
  partySlipsTime,
  type PartyDetailWithSlipsAnswer,
  type PartyPlan,
  type PartySlipDocument,
  type PartySlipsPrintAnswer,
} from '@oto/shared';
import { loadEnv } from '../src/env';
import { buildDefaultJobs } from '../src/services/jobs';
import { PARTY_SLIPS_JOB, runPartySlipsJob } from '../src/services/party-slips';
import { buildPrintDocument } from '../src/services/sale-printing';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  ADMIN,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-805 — A PARTY'S KITCHEN AND BAR SLIPS AT A SET TIME (birthday plan §5;
 * the owner's decision 3 of 2026-11-09: the slip time per party from the BEO,
 * 11:00 by default; food to the kitchen printer and drinks to the bar printer
 * of the station the park names; until it names one, "no printer").
 *
 * The OTO App is as real as it can be without its server: its tables are built
 * by its own migrations, the plan view is its migration 0042 exactly, and the
 * party is written into the app's own BEO tables — the package snapshot with
 * its slip time, the kitchen plan with its food time and ready offset, the
 * Floresta set menu with its pizza choice, the parent's submitted choice and
 * the bar plan — so every slip here is read through the same view staging
 * reads.
 */

let ctx: TestContext;
let central: string;
let chalong: string;
let operatorId: string;
let reception: string;
let admin: string;
let chalongManager: string;
let t1: typeof station.$inferSelect;
let T: string;

const appTenant = newId();
const appCentral = newId();
const appChalong = newId();
const floresta = newId();

/** The Floresta birthday set menu, as the OTO App's template holds it (SCRUM-803's seed). */
const FLORESTA_ITEMS = [
  {
    id: 'g-pizza',
    type: 'choice_group',
    label: 'Pizza',
    qty: 3,
    options: ['Margherita', 'Hawaiian', 'Pepperoni'],
    optionProductCodes: { Margherita: 'CF-24', Hawaiian: 'CF-27', Pepperoni: 'CF-31' },
  },
  { id: 'i-fries', type: 'always_included', label: 'French fries', productCode: 'CF-11', qty: 2 },
  // Not on the printed menu, so no till product: the kitchen's by name.
  { id: 'i-fruit', type: 'always_included', label: 'Fruit skewers', qty: 2 },
];

/** Bangkok wall clock on day `date` as an instant (the park is UTC+7). */
const atBangkok = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`);

interface AppParty {
  id: string;
  title: string;
  date: string;
  appBranch?: string;
  slipsTime?: string | null;
  kidsFoodTime?: string | null;
  setMenu?: boolean;
  chosen?: string[] | null;
  bar?: Array<{ itemName: string; quantity: number }>;
  withPackage?: boolean;
  status?: string;
}

/** A party written into the OTO App's own tables, as the BEO writes it. */
async function appParty(p: AppParty): Promise<string> {
  await ctx.db.execute(sql`
    insert into otoapp.core_events (
      id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time,
      total_value, prepayment_amount, child_name, parent_name, whatsapp_phone_e164,
      kid_turning_age, num_children, num_adults, location_text, status, created_at, updated_at)
    values (
      ${p.id}, ${appTenant}, ${p.appBranch ?? appCentral}, 'birthday', ${p.title}, ${p.date}, '13:00', '16:00',
      16900, 3000, 'Mali', 'Nok', '+66812345678',
      6, 10, 4, 'Party room 1', ${p.status ?? 'upcoming'},
      (now() at time zone 'UTC') - interval '1 hour', (now() at time zone 'UTC') - interval '1 hour')`);
  if (p.withPackage === false) return p.id;
  await ctx.db.execute(sql`
    insert into otoapp.beo_package_snapshots (id, event_id, package_name, base_price, slips_time)
    values (${newId()}, ${p.id}, 'Floresta Birthday', 1690000, ${p.slipsTime === undefined ? '11:00' : p.slipsTime}::time)`);
  if (p.setMenu !== false) {
    await ctx.db.execute(sql`
      insert into otoapp.beo_kitchen_plans (id, event_id, set_menu_enabled, set_menu_template_id, menus, kitchen_ready_offset_minutes)
      values (${newId()}, ${p.id}, true, ${floresta},
              ${JSON.stringify(p.kidsFoodTime === null ? {} : { kidsFoodTime: p.kidsFoodTime ?? '14:00' })}::jsonb, 20)`);
    if (p.chosen !== null) {
      await ctx.db.execute(sql`
        insert into otoapp.beo_set_menu_selections (id, event_id, template_id, token, is_submitted, selections)
        values (${newId()}, ${p.id}, ${floresta}, ${newId()}, true,
                ${JSON.stringify([{ groupId: 'g-pizza', chosenOptions: p.chosen ?? ['Margherita'] }])}::jsonb)`);
    }
  }
  await ctx.db.execute(sql`
    insert into otoapp.beo_bar_plans (id, event_id, items)
    values (${newId()}, ${p.id}, ${JSON.stringify(p.bar ?? [{ itemName: 'Juice pitcher', quantity: 2 }])}::jsonb)`);
  return p.id;
}

async function call<T>(
  method: 'GET' | 'POST' | 'PATCH',
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

const detail = (id: string, cookie = reception, branchId = central) =>
  call<PartyDetailWithSlipsAnswer>('GET', cookie, `/parties/${id}?branchId=${branchId}`);
const printNow = (id: string, body: Record<string, unknown> = {}, cookie = reception, headers: Record<string, string> = {}) =>
  call<PartySlipsPrintAnswer>('POST', cookie, `/parties/${id}/slips/print`, { branchId: central, ...body }, headers);

/** A party's slip rows, by run, the kitchen's before the bar's (one run's rows share a clock). */
const slipsOf = async (eventId: string) =>
  (
    await ctx.db
      .select()
      .from(partySlipPrint)
      .where(eq(partySlipPrint.eventId, eventId))
      .orderBy(asc(partySlipPrint.run))
  ).sort((a, b) => a.run - b.run || (a.station === b.station ? 0 : a.station === 'kitchen' ? -1 : 1));

const nameStation = (stationId: string | null) =>
  ctx.db.update(branch).set({ partySlipsStationId: stationId }).where(eq(branch.id, central));

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  central = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  chalong = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.id, central));
  operatorId = hkt!.operatorId;
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, central), eq(station.codePrefix, 'T1')));
  t1 = till!;

  // The till catalogue's codes the set menu names: the pizzas and the fries
  // print in the kitchen; a kids' juice at the bar.
  const kitchenCat = newId();
  const barCat = newId();
  await ctx.db.insert(productCategory).values([
    { id: kitchenCat, operatorId, code: 'ZZ-805-FOOD', name: 'Party food', taxableCategory: 'fnb', defaultPrepStation: 'kitchen' },
    { id: barCat, operatorId, code: 'ZZ-805-DRINK', name: 'Party drinks', taxableCategory: 'bar', defaultPrepStation: 'bar' },
  ]);
  const item = (code: string, name: string, categoryId: string) => ({
    id: newId(),
    operatorId,
    branchId: central,
    categoryId,
    kind: 'menu' as const,
    code,
    name,
    priceSatang: 10_000,
  });
  await ctx.db.insert(product).values([
    item('CF-24', 'Margherita', kitchenCat),
    item('CF-27', 'Hawaiian', kitchenCat),
    item('CF-31', 'Pepperoni', kitchenCat),
    item('CF-11', 'French fries', kitchenCat),
    item('CF-66-1', 'Kids juice', barCat),
  ]);

  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${appTenant}, 'OTO', 'oto-805')`);
  await ctx.db.execute(sql`
    insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appCentral}, ${appTenant}, 'Central Floresta', 'Phuket', ${central}),
           (${appChalong}, ${appTenant}, 'Robinson Chalong', 'Phuket', ${chalong})`);
  await ctx.db.execute(sql`
    insert into otoapp.beo_set_menu_templates (id, tenant_id, name, items)
    values (${floresta}, ${appTenant}, 'Birthday set menu Central Floresta', ${JSON.stringify(FLORESTA_ITEMS)}::jsonb)`);
}, 300_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

// =============================================================================
// The slip — what goes on which slip, in which words
// =============================================================================

const plan = (over: Partial<PartyPlan> = {}): Pick<PartyPlan, 'setMenu' | 'barItems' | 'kitchen' | 'counts' | 'startTime'> => ({
  startTime: '13:00',
  counts: { kidsExpected: 10, adultsExpected: 4 },
  kitchen: { kidsFoodTime: '14:00', adultsFoodTime: null, readyOffsetMinutes: 20, slipsTime: '11:00' },
  setMenu: [
    { productCode: 'CF-24', name: 'Pizza', qty: 3, choiceGroup: 'Pizza', chosenOption: 'Margherita', note: null },
    { productCode: 'CF-11', name: 'French fries', qty: 2, choiceGroup: null, chosenOption: null, note: null },
    { productCode: null, name: 'Fruit skewers', qty: 2, choiceGroup: null, chosenOption: null, note: null },
  ],
  barItems: [{ productCode: null, name: 'Juice pitcher', qty: 2 }],
  ...over,
});
const CATALOGUE: Record<string, 'kitchen' | 'bar' | 'none'> = {
  'CF-24': 'kitchen',
  'CF-27': 'kitchen',
  'CF-31': 'kitchen',
  'CF-11': 'kitchen',
  'CF-66-1': 'bar',
  'AO-BOTTLE': 'none',
};
const compose = (p: ReturnType<typeof plan>, location: string | null = 'Party room 1') =>
  composePartySlips({
    plan: p,
    partyName: "Mali's 6th",
    location,
    prepStationOf: (code) => CATALOGUE[code] ?? null,
    printedAt: '11:00',
  });

describe('the slip, composed from the plan', () => {
  it('the Floresta set menu: the chosen pizza, the fries and the uncoded fruit skewers to the kitchen; the juice to the bar', () => {
    const slips = compose(plan());
    expect(slips.kitchen).toEqual({
      title: 'Kitchen',
      heading: 'Birthday party',
      orderRef: "Mali's 6th",
      time: '11:00',
      details: ['Room: Party room 1', 'Children: 10'],
      readyBy: '13:40',
      lines: [
        { qty: 3, name: 'Margherita' },
        { qty: 2, name: 'French fries' },
        { qty: 2, name: 'Fruit skewers' },
      ],
    } satisfies PartySlipDocument);
    expect(slips.bar).toMatchObject({ title: 'Bar', heading: 'Birthday party', readyBy: '13:40', lines: [{ qty: 2, name: 'Juice pitcher' }] });
  });

  it('a set-menu line whose product prints at the bar goes on the bar slip; one printing nowhere is left off; an unknown code is the kitchen’s', () => {
    const slips = compose(
      plan({
        setMenu: [
          { productCode: 'CF-66-1', name: 'Kids juice', qty: 10, choiceGroup: null, chosenOption: null, note: null },
          { productCode: 'AO-BOTTLE', name: 'Water bottle', qty: 10, choiceGroup: null, chosenOption: null, note: null },
          { productCode: 'CF-999', name: 'Belgian waffles', qty: 2, choiceGroup: null, chosenOption: null, note: null },
        ],
        barItems: [],
      }),
    );
    expect(slips.kitchen?.lines).toEqual([{ qty: 2, name: 'Belgian waffles' }]);
    expect(slips.bar?.lines).toEqual([{ qty: 10, name: 'Kids juice' }]);
  });

  it('an open choice prints the group’s name, marked; a split choice prints its dishes with no count; a note rides along', () => {
    const slips = compose(
      plan({
        setMenu: [
          { productCode: null, name: 'Hot dish', qty: 2, choiceGroup: 'Hot dish', chosenOption: null, note: 'Fish & Chips may be 2 Chicken Schnitzel' },
          { productCode: 'CF-24', name: 'Pizza', qty: null, choiceGroup: 'Pizza', chosenOption: 'Margherita', note: null },
          { productCode: 'CF-27', name: 'Pizza', qty: null, choiceGroup: 'Pizza', chosenOption: 'Hawaiian', note: null },
        ],
        barItems: [],
      }),
    );
    expect(slips.kitchen?.lines).toEqual([
      { qty: 2, name: 'Hot dish', note: `${PARTY_CHOICE_NOT_MADE} · Fish & Chips may be 2 Chicken Schnitzel` },
      { name: 'Margherita' },
      { name: 'Hawaiian' },
    ]);
    expect(slips.bar).toBeNull();
  });

  it('READY BY is the kids’ food time less the ready offset; with no kids’ food time the slip prints no time, only that the OTO App has none', () => {
    expect(partyReadyBy(plan())).toBe('13:40');
    expect(partyReadyBy(plan({ kitchen: { kidsFoodTime: '00:10', adultsFoodTime: null, readyOffsetMinutes: 20, slipsTime: null } }))).toBe(
      '23:50',
    );
    const noFood = plan({ kitchen: { kidsFoodTime: null, adultsFoodTime: '15:00', readyOffsetMinutes: 20, slipsTime: null } });
    expect(partyReadyBy(noFood)).toBeNull();
    const kitchen = compose(noFood).kitchen;
    expect(kitchen).toMatchObject({ readyByNote: PARTY_NO_KIDS_FOOD_TIME });
    expect(kitchen).not.toHaveProperty('readyBy');
    expect(partyReadyBy(plan({ kitchen: null }))).toBeNull();
    expect(compose(plan({ kitchen: null })).bar).toMatchObject({ readyByNote: PARTY_NO_KIDS_FOOD_TIME });
    // A slip with a READY BY time carries no note.
    expect(compose(plan()).kitchen).not.toHaveProperty('readyByNote');
  });

  it('the slip time is the party’s own, else 11:00', () => {
    expect(partySlipsTime(plan())).toBe('11:00');
    expect(partySlipsTime({ kitchen: { kidsFoodTime: null, adultsFoodTime: null, readyOffsetMinutes: 20, slipsTime: '09:30' } })).toBe('09:30');
    expect(partySlipsTime({ kitchen: null })).toBe('11:00');
  });

  it('nothing on the plan for a station prints nothing there, and a room the event has none of is left off', () => {
    const slips = compose(plan({ barItems: [], setMenu: [] }), null);
    expect(slips).toEqual({ kitchen: null, bar: null });
    expect(compose(plan({ barItems: [] }), null).kitchen?.details).toEqual(['Children: 10']);
  });

  // SCRUM-829: the BEO's adults' menu mirrors the kids' unless "Different for
  // adults" is on; then the view marks the lines, and the slip stays ONE list.
  it('one food list with the adults’ changes marked: kids only, the two counts beside a shared dish, an adults’ note, adults only', () => {
    const slips = compose(
      plan({
        setMenu: [
          // The set menu's pizza: the adults' list dropped it.
          { productCode: 'CF-24', name: 'Pizza', qty: 3, choiceGroup: 'Pizza', chosenOption: 'Margherita', note: null, audience: 'kids' },
          // The fries: an unchanged copy for the adults, so the view sends no adults' line and nothing is marked.
          { productCode: 'CF-11', name: 'French fries', qty: 2, choiceGroup: null, chosenOption: null, note: null },
          { productCode: null, name: 'Fruit skewers', qty: 2, choiceGroup: null, chosenOption: null, note: null },
          { productCode: 'CF-66-1', name: 'Kids juice', qty: 10, choiceGroup: null, chosenOption: null, note: null },
          // The adults' own: the skewers in another count, a note on the juice, pasta of their own (no code).
          { productCode: null, name: 'fruit skewers', qty: 4, choiceGroup: null, chosenOption: null, note: null, audience: 'adults' },
          { productCode: 'CF-66-1', name: 'Kids juice', qty: 10, choiceGroup: null, chosenOption: null, note: 'no ice', audience: 'adults' },
          { productCode: null, name: 'Pasta', qty: 4, choiceGroup: null, chosenOption: null, note: 'al dente', audience: 'adults' },
        ],
        barItems: [],
      }),
    );
    expect(slips.kitchen?.lines).toEqual([
      { qty: 3, name: 'Margherita', note: PARTY_KIDS_ONLY },
      { qty: 2, name: 'French fries' },
      { name: 'Fruit skewers', note: partyCountsMark(2, 4) },
      { qty: 4, name: 'Pasta', note: `${PARTY_ADULTS_ONLY} · al dente` },
    ]);
    expect(partyCountsMark(2, 4)).toBe('kids 2 · adults 4');
    expect(slips.bar?.lines).toEqual([{ qty: 10, name: 'Kids juice', note: 'adults: no ice' }]);
    expect(PARTY_KIDS_ONLY).toBe('kids only');
    expect(PARTY_ADULTS_ONLY).toBe('adults only');
  });

  it('the same dish for the adults with another note is one line with their note beside it; a cleared note is said; an uncoded kids’ line takes the two counts', () => {
    const slips = compose(
      plan({
        setMenu: [
          // The view carries the adults' note on the kids' line (one dish, charged once).
          { productCode: 'CF-66-1', name: 'Kids juice', qty: 10, choiceGroup: null, chosenOption: null, note: null, adultsNote: 'no ice' },
          { productCode: 'CF-24', name: 'Pizza', qty: 3, choiceGroup: 'Pizza', chosenOption: 'Margherita', note: 'no cheese', adultsNote: '' },
          // An uncoded kids' line the adults get in another count: the view emits both, uncharged.
          { productCode: null, name: 'Fruit skewers', qty: 2, choiceGroup: null, chosenOption: null, note: null },
          { productCode: null, name: 'Fruit skewers', qty: 4, choiceGroup: null, chosenOption: null, note: null, audience: 'adults' },
        ],
        barItems: [],
      }),
    );
    expect(slips.kitchen?.lines).toEqual([
      { qty: 3, name: 'Margherita', note: `no cheese · ${PARTY_ADULTS_NO_NOTE}` },
      { name: 'Fruit skewers', note: partyCountsMark(2, 4) },
    ]);
    expect(slips.bar?.lines).toEqual([{ qty: 10, name: 'Kids juice', note: 'adults: no ice' }]);
    expect(partyAdultsNoteMark(' no ice ')).toBe('adults: no ice');
    expect(partyAdultsNoteMark('')).toBe(PARTY_ADULTS_NO_NOTE);
    expect(PARTY_ADULTS_NO_NOTE).toBe('adults: no note');
  });

  it('an adults’ line folds only into a line on its own station; a split choice with no count takes the adults’ count alone', () => {
    const slips = compose(
      plan({
        setMenu: [
          { productCode: 'CF-24', name: 'Pizza', qty: null, choiceGroup: 'Pizza', chosenOption: 'Margherita', note: null },
          { productCode: 'CF-27', name: 'Pizza', qty: null, choiceGroup: 'Pizza', chosenOption: 'Hawaiian', note: null },
          { productCode: null, name: 'Margherita', qty: 2, choiceGroup: null, chosenOption: null, note: null, audience: 'adults' },
          // A bar drink of the adults' own: on the bar slip, marked.
          { productCode: 'CF-66-1', name: 'Kids juice', qty: 2, choiceGroup: null, chosenOption: null, note: null, audience: 'adults' },
        ],
        barItems: [],
      }),
    );
    expect(slips.kitchen?.lines).toEqual([{ name: 'Margherita', note: partyCountsMark(null, 2) }, { name: 'Hawaiian' }]);
    expect(slips.bar?.lines).toEqual([{ qty: 2, name: 'Kids juice', note: PARTY_ADULTS_ONLY }]);
    // A plan from before the switch carries no audience and prints as it always did.
    expect(compose(plan()).kitchen?.lines).toEqual([
      { qty: 3, name: 'Margherita' },
      { qty: 2, name: 'French fries' },
      { qty: 2, name: 'Fruit skewers' },
    ]);
  });
});

// =============================================================================
// The job at the slip time, through the OTO App's own view
// =============================================================================

describe('job:parties.slips — at the slip time, once', () => {
  it('is registered with the job runner', () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused' });
    const jobs = buildDefaultJobs({ db: ctx.db, env, log: ctx.app.log, channels: [] });
    const job = jobs.find((j) => j.name === PARTY_SLIPS_JOB);
    expect(job?.intervalSeconds).toBe(60);
  });

  it('no station named for the park: both slips recorded "no printer", nothing queued, and the party page says so', async () => {
    await nameStation(null);
    const id = await appParty({ id: newId(), title: "Mali's 6th", date: T });
    await runPartySlipsJob(ctx.db, atBangkok(T, '11:01'));
    const rows = await slipsOf(id);
    expect(rows.map((r) => [r.station, r.run, r.trigger, r.status, r.printJobId])).toEqual([
      ['kitchen', 1, 'schedule', 'no_printer', null],
      ['bar', 1, 'schedule', 'no_printer', null],
    ]);
    // What it would have printed is kept, as composed through the view.
    expect((rows[0]!.document as PartySlipDocument).lines).toEqual([
      { qty: 3, name: 'Margherita' },
      { qty: 2, name: 'French fries' },
      { qty: 2, name: 'Fruit skewers' },
    ]);
    expect((rows[1]!.document as PartySlipDocument).lines).toEqual([{ qty: 2, name: 'Juice pitcher' }]);
    const jobs = await ctx.db.select().from(printJob).where(eq(printJob.subjectType, 'party_slip'));
    expect(jobs.filter((j) => rows.some((r) => r.id === j.subjectId))).toEqual([]);

    const page = await detail(id);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(PartyDetailWithSlipsAnswerSchema.safeParse(page.body).success).toBe(true);
    expect(page.body.slips).toMatchObject({
      partyDate: T,
      slipsTime: '11:00',
      station: null,
      latest: { kitchen: { status: 'no_printer', run: 1, trigger: 'schedule' }, bar: { status: 'no_printer' } },
    });
  });

  it('the named station prints the kitchen slip on its kitchen printer and the bar slip on its bar printer, with the party heading and READY BY', async () => {
    // Reception Till 1 carries the Kitchen Printer; the park gives it a bar role too.
    const [receipt] = await ctx.db
      .select({ deviceId: stationDevice.deviceId })
      .from(stationDevice)
      .where(and(eq(stationDevice.stationId, t1.id), eq(stationDevice.role, 'receipt')));
    await ctx.db.insert(stationDevice).values({ id: newId(), stationId: t1.id, role: 'bar', deviceId: receipt!.deviceId });
    await nameStation(t1.id);

    const id = await appParty({ id: newId(), title: "Ton's 5th", date: T });
    const summary = await runPartySlipsJob(ctx.db, atBangkok(T, '11:00'));
    expect(summary.failed).toBe(0);
    const rows = await slipsOf(id);
    expect(rows.map((r) => [r.station, r.status])).toEqual([
      ['kitchen', 'printed'],
      ['bar', 'printed'],
    ]);
    const jobs = await ctx.db
      .select({ job: printJob, deviceKind: device.kind })
      .from(printJob)
      .innerJoin(device, eq(device.id, printJob.deviceId))
      .where(inArray(printJob.id, rows.map((r) => r.printJobId!)));
    const kitchen = jobs.find((j) => j.job.id === rows[0]!.printJobId)!;
    const bar = jobs.find((j) => j.job.id === rows[1]!.printJobId)!;
    expect(kitchen.job).toMatchObject({ kind: 'kitchen_ticket', role: 'kitchen', status: 'queued', stationId: t1.id, subjectType: 'party_slip', subjectId: rows[0]!.id });
    expect(kitchen.deviceKind).toBe('kitchen_printer');
    expect(bar.job).toMatchObject({ kind: 'bar_ticket', role: 'bar', status: 'queued', subjectType: 'party_slip', subjectId: rows[1]!.id });
    // The box is told to print each, as a sale's prep ticket is.
    const commands = await ctx.db.select().from(boxCommand).where(eq(boxCommand.boxId, t1.boxId!));
    for (const r of rows) {
      expect(commands.some((c) => (c.payload as { printJobId?: string }).printJobId === r.printJobId)).toBe(true);
    }
    // What the box is handed for the kitchen job: the slip the record keeps.
    const doc = await buildPrintDocument(ctx.db, { boxId: t1.boxId!, operatorId }, rows[0]!.printJobId!);
    expect(doc.job).toEqual({
      kind: 'kitchen_ticket',
      data: {
        title: 'Kitchen',
        heading: 'Birthday party',
        orderRef: "Ton's 5th",
        time: '11:00',
        details: ['Room: Party room 1', 'Children: 10'],
        readyBy: '13:40',
        lines: [
          { qty: 3, name: 'Margherita' },
          { qty: 2, name: 'French fries' },
          { qty: 2, name: 'Fruit skewers' },
        ],
      },
    });
    const barDoc = await buildPrintDocument(ctx.db, { boxId: t1.boxId!, operatorId }, rows[1]!.printJobId!);
    expect(barDoc.job).toMatchObject({ kind: 'bar_ticket', data: { title: 'Bar', lines: [{ qty: 2, name: 'Juice pitcher' }] } });

    const page = await detail(id);
    expect(page.body.slips).toMatchObject({
      station: { id: t1.id, name: t1.name },
      latest: { kitchen: { status: 'printed', at: '11:00', jobStatus: 'queued' }, bar: { status: 'printed', at: '11:00' } },
    });
    const [audited] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'party.slips_print'), eq(auditLog.entityId, id)));
    expect(audited?.after).toMatchObject({ run: 1, trigger: 'schedule', partyDate: T, stationId: t1.id });
  });

  it('SCRUM-829: a party whose adults’ menu differs prints one kitchen slip with the adults’ changes marked, read through the app’s view (0048)', async () => {
    const id = await appParty({ id: newId(), title: "Fah's 7th", date: T });
    // The BEO as the editor saves it with "Different for adults" on: the kids' list holds the
    // set menu's resolved lines, the team's own skewers and a coded juice; the adults' list is
    // its copy with the pizza dropped, the skewers in another count and pasta of their own.
    const kids = [
      { id: 'set_pizza', itemName: 'Margherita', quantity: 3, notes: '(Pizza)', included: true, price: 0, source: 'set_menu', groupId: 'g-pizza' },
      { id: 'set_fries', itemName: 'French fries', quantity: 2, notes: '', included: true, price: 0, source: 'set_menu', groupId: 'i-fries' },
      { id: 'k1', itemName: 'Fruit skewers', quantity: 2, notes: '', included: true, price: 0, source: 'additional' },
      { id: 'k2', itemName: 'Kids juice', quantity: 10, notes: '', included: true, price: 0, source: 'additional', productCode: 'CF-66-1' },
    ];
    const adults = [
      { id: 'a1', itemName: 'French fries', quantity: 2, notes: '', included: true, price: 0, source: 'set_menu', groupId: 'i-fries' },
      { id: 'a2', itemName: 'Fruit skewers', quantity: 4, notes: '', included: true, price: 0, source: 'additional' },
      { id: 'a3', itemName: 'Kids juice', quantity: 10, notes: '', included: true, price: 0, source: 'additional', productCode: 'CF-66-1' },
      { id: 'a4', itemName: 'Pasta', quantity: 4, notes: '', included: false, price: 0, source: 'additional' },
    ];
    await ctx.db.execute(sql`
      update otoapp.beo_kitchen_plans
      set menus = ${JSON.stringify({ kidsFoodTime: '14:00', kids, adults, adultsDiffer: true })}::jsonb
      where event_id = ${id}`);
    await runPartySlipsJob(ctx.db, atBangkok(T, '11:01'));
    const rows = await slipsOf(id);
    expect((rows[0]!.document as PartySlipDocument).lines).toEqual([
      // The set menu's own lines: the pizza the adults do not get, marked; the fries an unchanged copy.
      { qty: 3, name: 'Margherita', note: PARTY_KIDS_ONLY },
      { qty: 2, name: 'French fries' },
      // The adults' skewers in another count fold into the set menu's line of that name.
      { name: 'Fruit skewers', note: partyCountsMark(2, 4) },
      { qty: 4, name: 'Pasta', note: PARTY_ADULTS_ONLY },
    ]);
    // The coded juice copied unchanged for the adults reaches the bar once (and the till charges it once).
    expect((rows[1]!.document as PartySlipDocument).lines).toEqual([
      { qty: 10, name: 'Kids juice' },
      { qty: 2, name: 'Juice pitcher' },
    ]);
  });

  it('SCRUM-829: a coded dish copied for the adults with another note is one slip line and one charge; an uncoded dish in another count folds, through the view (0048)', async () => {
    const id = await appParty({ id: newId(), title: "Ploy's 5th", date: T, setMenu: false, bar: [] });
    // No set menu: the kids' list holds a coded juice and the team's own skewers; the adults'
    // own list copies the juice with a note and takes the skewers in another count.
    const kids = [
      { id: 'k1', itemName: 'Kids juice', quantity: 10, notes: '', included: true, price: 0, productCode: 'CF-66-1' },
      { id: 'k2', itemName: 'Fruit skewers', quantity: 2, notes: 'no melon', included: true, price: 0 },
    ];
    const adults = [
      { id: 'a1', itemName: 'Kids juice', quantity: 10, notes: 'no ice', included: true, price: 0, productCode: 'CF-66-1' },
      { id: 'a2', itemName: 'Fruit skewers', quantity: 4, notes: 'no melon', included: true, price: 0 },
    ];
    await ctx.db.execute(sql`
      insert into otoapp.beo_kitchen_plans (id, event_id, set_menu_enabled, menus, kitchen_ready_offset_minutes)
      values (${newId()}, ${id}, false, ${JSON.stringify({ kidsFoodTime: '14:00', kids, adults, adultsDiffer: true })}::jsonb, 20)`);
    // What the till charges is the plan's coded lines: the juice once, 10, not 20.
    const shown = await detail(id);
    expect(shown.status).toBe(200);
    const codes = new Map<string, number>();
    for (const m of shown.body.plan?.setMenu ?? []) if (m.productCode) codes.set(m.productCode, (codes.get(m.productCode) ?? 0) + (m.qty ?? 1));
    expect([...codes]).toEqual([['CF-66-1', 10]]);
    expect(shown.body.plan?.setMenu.map((m) => [m.name, m.qty, m.audience ?? null, m.adultsNote ?? null])).toEqual([
      ['Kids juice', 10, null, 'no ice'],
      ['Fruit skewers', 2, null, null],
      ['Fruit skewers', 4, 'adults', null],
    ]);
    await runPartySlipsJob(ctx.db, atBangkok(T, '11:01'));
    const rows = await slipsOf(id);
    expect((rows[0]!.document as PartySlipDocument).lines).toEqual([{ name: 'Fruit skewers', note: `no melon · ${partyCountsMark(2, 4)}` }]);
    expect((rows[1]!.document as PartySlipDocument).lines).toEqual([{ qty: 10, name: 'Kids juice', note: 'adults: no ice' }]);
  });

  it('prints once and not twice: a second tick, and two ticks at once, make no second run', async () => {
    const id = await appParty({ id: newId(), title: "Pim's 4th", date: T });
    await Promise.all([
      runPartySlipsJob(ctx.db, atBangkok(T, '11:02')),
      runPartySlipsJob(ctx.db, atBangkok(T, '11:02')),
    ]);
    const again = await runPartySlipsJob(ctx.db, atBangkok(T, '11:03'));
    expect(again.runs).toBe(0);
    expect(again.alreadyPrinted).toBeGreaterThanOrEqual(1);
    const rows = await slipsOf(id);
    expect(rows.map((r) => [r.station, r.run])).toEqual([
      ['kitchen', 1],
      ['bar', 1],
    ]);
  });

  it('waits for the party’s own slip time, and leaves a party of another day alone', async () => {
    const late = await appParty({ id: newId(), title: 'Late slips', date: T, slipsTime: '12:30' });
    const tomorrow = await appParty({ id: newId(), title: 'Tomorrow', date: addDaysToIsoDate(T, 1) });
    await runPartySlipsJob(ctx.db, atBangkok(T, '12:29'));
    expect(await slipsOf(late)).toEqual([]);
    expect(await slipsOf(tomorrow)).toEqual([]);
    await runPartySlipsJob(ctx.db, atBangkok(T, '12:30'));
    expect((await slipsOf(late)).map((r) => r.status)).toEqual(['printed', 'printed']);
    expect(await slipsOf(tomorrow)).toEqual([]);
  });

  it('a party at another park prints with that park’s station — none named there, so no printer — never this one’s', async () => {
    const away = await appParty({ id: newId(), title: 'Chalong party', date: T, appBranch: appChalong });
    await runPartySlipsJob(ctx.db, atBangkok(T, '11:05'));
    const rows = await slipsOf(away);
    expect(rows.map((r) => [r.branchId, r.status])).toEqual([
      [chalong, 'no_printer'],
      [chalong, 'no_printer'],
    ]);
    // And it is not one of this park's parties.
    expect((await detail(away)).status).toBe(404);
    expect((await printNow(away)).status).toBe(404);
  });

  it('a cancelled party prints nothing at its slip time', async () => {
    const id = await appParty({ id: newId(), title: 'Called off', date: T, status: 'cancelled' });
    await runPartySlipsJob(ctx.db, atBangkok(T, '11:06'));
    expect(await slipsOf(id)).toEqual([]);
  });

  it('a plan with nothing for the bar records "nothing to print" there', async () => {
    const id = await appParty({ id: newId(), title: 'No drinks', date: T, bar: [] });
    await runPartySlipsJob(ctx.db, atBangkok(T, '11:07'));
    expect((await slipsOf(id)).map((r) => [r.station, r.status, r.document === null])).toEqual([
      ['kitchen', 'printed', false],
      ['bar', 'nothing_to_print', true],
    ]);
  });
});

// =============================================================================
// "Print party slips now"
// =============================================================================

describe('POST /parties/:id/slips/print — Print party slips now', () => {
  it('a reprint is a new run beside the first, each slip a copy of the one it reprints', async () => {
    const id = await appParty({ id: newId(), title: 'Reprinted', date: T });
    await runPartySlipsJob(ctx.db, atBangkok(T, '11:08'));
    const first = await slipsOf(id);

    const actionId = newId();
    const res = await printNow(id, { actionId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(PartySlipsPrintAnswerSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.replayed).toBe(false);
    expect(res.body.printed.map((r) => [r.station, r.run, r.trigger, r.status])).toEqual([
      ['kitchen', 2, 'reprint', 'printed'],
      ['bar', 2, 'reprint', 'printed'],
    ]);
    expect(res.body.slips.latest.kitchen?.run).toBe(2);
    expect(res.body.slips.records.map((r) => r.run)).toEqual([2, 2, 1, 1]);
    expect(res.body.printed[0]!.requestedByName).not.toBeNull();

    const rows = await slipsOf(id);
    expect(rows).toHaveLength(4);
    expect(rows.slice(0, 2)).toEqual(first);
    const copies = await ctx.db
      .select()
      .from(printJob)
      .where(inArray(printJob.id, rows.slice(2).map((r) => r.printJobId!)));
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      const station = copy.kind === 'kitchen_ticket' ? 'kitchen' : 'bar';
      expect(copy.reprintOf).toBe(first.find((r) => r.station === station)!.printJobId);
      expect(copy.reprintReason).toBe('Print party slips now');
    }

    // The same press again answers the run it made, and prints nothing.
    const again = await printNow(id, { actionId });
    expect(again.status).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    expect(again.body.printed.map((r) => r.id)).toEqual(res.body.printed.map((r) => r.id));
    expect(await slipsOf(id)).toHaveLength(4);
  });

  it('honours an Idempotency-Key: the same key answers the same run', async () => {
    const id = await appParty({ id: newId(), title: 'Keyed', date: T });
    const key = `party-slips:${newId()}`;
    const one = await printNow(id, {}, reception, { 'idempotency-key': key });
    const two = await printNow(id, {}, reception, { 'idempotency-key': key });
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(two.status).toBe(200);
    expect(two.body).toEqual(one.body);
    expect((await slipsOf(id)).map((r) => r.run)).toEqual([1, 1]);
  });

  it('prints before the slip time when pressed, and the job still prints at the slip time', async () => {
    // Pressed before the park names a station: recorded "no printer". The
    // station is named afterwards, and at the slip time the job's own run
    // reaches the kitchen and the bar — a press never stands in for it.
    await nameStation(null);
    const id = await appParty({ id: newId(), title: 'Early', date: T, slipsTime: '15:00' });
    try {
      const early = await printNow(id);
      expect(early.status).toBe(200);
      expect(early.body.printed.map((r) => r.status)).toEqual(['no_printer', 'no_printer']);
    } finally {
      await nameStation(t1.id);
    }
    await runPartySlipsJob(ctx.db, atBangkok(T, '15:01'));
    expect((await slipsOf(id)).map((r) => [r.run, r.trigger, r.status])).toEqual([
      [1, 'reprint', 'no_printer'],
      [1, 'reprint', 'no_printer'],
      [2, 'schedule', 'printed'],
      [2, 'schedule', 'printed'],
    ]);
    // And once is once: the next tick leaves the day alone.
    const again = await runPartySlipsJob(ctx.db, atBangkok(T, '15:02'));
    expect(again.runs).toBe(0);
    expect(await slipsOf(id)).toHaveLength(4);
  });

  it('with no station named, records no printer and queues nothing', async () => {
    await nameStation(null);
    try {
      const id = await appParty({ id: newId(), title: 'Unnamed', date: T });
      const res = await printNow(id);
      expect(res.body.printed.map((r) => [r.status, r.printJobId])).toEqual([
        ['no_printer', null],
        ['no_printer', null],
      ]);
      expect(res.body.slips.station).toBeNull();
    } finally {
      await nameStation(t1.id);
    }
  });

  it('a party the OTO App has no package for has no slips: 409, and the page shows none', async () => {
    const id = await appParty({ id: newId(), title: 'No package', date: T, withPackage: false });
    const res = await printNow(id);
    expect(res.status).toBe(409);
    expect((res.body as unknown as { error: { code: string } }).error.code).toBe('PARTY_NO_PLAN');
    expect((await detail(id)).body.slips).toBeNull();
  });

  it('is the party’s own act: refused at a park the account does not hold', async () => {
    const id = await appParty({ id: newId(), title: 'Guarded', date: T });
    expect((await printNow(id, {}, chalongManager)).status).toBe(403);
    expect(await slipsOf(id)).toEqual([]);
  });
});

// =============================================================================
// The branch setting
// =============================================================================

describe('the branch names the station whose printers take its party slips', () => {
  it('GET /branches says which; PATCH names one of the park’s stations, refuses another park’s, and clears', async () => {
    const list = await call<{ branches: Array<{ id: string; partySlipsStationId: string | null }> }>('GET', admin, '/branches');
    expect(list.body.branches.find((b) => b.id === central)?.partySlipsStationId).toBe(t1.id);

    const [away] = await ctx.db.select().from(station).where(eq(station.branchId, chalong)).limit(1);
    const refused = await call<{ error: { code: string } }>('PATCH', admin, `/branches/${central}`, { partySlipsStationId: away!.id });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('STATION_NOT_AT_BRANCH');

    const cleared = await call('PATCH', admin, `/branches/${central}`, { partySlipsStationId: null });
    expect(cleared.status).toBe(200);
    const [after] = await ctx.db.select().from(branch).where(eq(branch.id, central));
    expect(after?.partySlipsStationId).toBeNull();

    const named = await call('PATCH', admin, `/branches/${central}`, { partySlipsStationId: t1.id });
    expect(named.status).toBe(200);
    const [again] = await ctx.db.select().from(branch).where(eq(branch.id, central));
    expect(again?.partySlipsStationId).toBe(t1.id);
  });
});
