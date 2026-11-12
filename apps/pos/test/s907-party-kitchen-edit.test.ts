import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PARTY_KITCHEN_READ_ONLY,
  PARTY_NOT_ON_TILL_MENU,
  type EventView,
  type PartyKitchenEditAnswer,
  type PartyKitchenPlan,
  type PartySettleQuote,
} from '@oto/shared';
import { api, ApiError } from '@/api/client';
import { toOtoEvent } from '@/api/events';
import { editPartyKitchenOnPlatform, readPartyKitchenChoicesOnPlatform } from '@/api/parties';
import { PartyDetail } from '@/components/parties/PartyDetail';
import { PartyEditForm } from '@/components/parties/PartyEditForm';
import { PartyBarPlanSection, PartyKitchenPlanSection } from '@/components/parties/PartyKitchenPlanEditor';
import { PartySettleModal } from '@/components/parties/PartySettleModal';
import { toast } from '@/hooks/use-toast';
import {
  addedKitchenLine,
  kitchenChangesOf,
  kitchenDraftOf,
  kitchenLineRemovable,
  kitchenMenuMatches,
  type KitchenDraft,
} from '@/lib/partyKitchenEdit';
import type { PartyBooking } from '@/types';
import { renderHook } from './support/hooks';

/**
 * SCRUM-907 — A MANAGER CHANGES A PARTY'S KITCHEN PLAN ON THE TILL'S EDIT
 * FORM, AND THE BEO IS CHANGED (the owner's decision 7 of 12 November); and
 * SCRUM-950 — Settle party names each extra it charges before Confirm.
 *
 * The form's kitchen and bar sections are filled from the plan the till reads
 * (SCRUM-906); a manager changes a count and a note, adds a line from the
 * till's menu or typed, removes an EXTRA, changes a set-menu choice and the
 * cake's time and note, and Save sends only that, under one edit id; reception
 * see the same sections read-only with one line saying a manager changes them.
 */

Object.assign(globalThis, { React });

const HKT_CENTRAL = '0190a0a0-0000-7000-8000-00000000b001';
const PARTY = '0190a0a0-0000-7000-8000-0000000e0907';
const TILL = '0190a0a0-0000-7000-8000-00000000c001';
const T = '2026-11-18';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const harness = await import('./support/hooks');
  const hooks = {
    useState: harness.useState,
    useRef: harness.useRef,
    useMemo: harness.useMemo,
    useCallback: harness.useCallback,
    useEffect: harness.useEffect,
  };
  return { ...real, ...hooks, default: { ...real, ...hooks } };
});
vi.mock('@/api/catalogBridge', () => ({
  apiBranchIdForSlug: (slug: string) => (slug === 'hkt-central' ? HKT_CENTRAL : null),
}));
vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/client')>();
  return { ...original, api: { ...original.api, get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() } };
});
vi.mock('@/mockApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/mockApi')>();
  return {
    ...original,
    getMenuItems: () => [
      { id: 'm-cal', name: 'Calamari', code: 'CF-14', category: 'starters', price: { weekday: 295, weekend: 295 } },
      { id: 'm-hum', name: 'Hummus', code: 'CF-13', category: 'starters', price: { weekday: 275, weekend: 275 } },
      { id: 'm-x', name: 'No code dish', category: 'starters', price: { weekday: 10, weekend: 10 } },
    ],
  };
});
vi.mock('@/lib/lane', () => ({ currentLane: () => 'platform', viaLane: (onPlatform: () => unknown) => onPlatform() }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toasts: [], toast: vi.fn(), dismiss: vi.fn() }) }));
const access = vi.hoisted(() => ({ kitchen: true }));
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({
    operator: { id: 'acc-noi', name: 'Noi (Manager)' },
    locked: false,
    can: (permission: string) => permission !== 'pos:party:kitchen_update' || access.kitchen,
  }),
}));
vi.mock('@/station/StationContext', () => ({ useStation: () => ({ station: { stationId: TILL, name: 'Till 1' } }) }));
vi.mock('@/branch/BranchContext', () => ({ useBranch: () => ({ branch: { id: 'hkt-central', name: 'HKT Central' } }) }));
vi.mock('@/i18n/LanguageContext', () => ({ useLanguage: () => ({ lang: 'en', setLang: () => undefined, t: (key: string) => key }) }));
vi.mock('@/lib/customerDisplayPref', () => ({ useCustomerDisplayPref: () => [true, () => undefined] }));
vi.mock('@/lib/themePref', () => ({ useCustomerTheme: () => ['dark', () => undefined] }));

const getMock = vi.mocked(api.get);
const putMock = vi.mocked(api.put);
const toastMock = vi.mocked(toast);

// --- The plan the till reads -----------------------------------------------------------

const KITCHEN: PartyKitchenPlan = {
  eventId: PARTY,
  partyDate: T,
  startTime: '13:00',
  endTime: '16:00',
  counts: { kidsExpected: 10, adultsExpected: 4 },
  setMenu: [
    { lineId: 'set_rice', productCode: null, name: 'Fried rice', qty: 3, choiceGroup: 'Fried rice', chosenOption: 'Veggie', note: null, origin: 'set_menu', onTillMenu: false },
    { lineId: 'set_fries', productCode: 'CF-11', name: 'French fries', qty: 2, choiceGroup: null, chosenOption: null, note: null, origin: 'set_menu', onTillMenu: true },
    // An open group no BEO line holds yet.
    { productCode: null, name: 'Pizza', qty: 2, choiceGroup: 'Pizza', chosenOption: null, note: null, origin: 'set_menu', onTillMenu: false },
    { lineId: 'm1', productCode: 'CF-14', name: 'Calamari', qty: 2, choiceGroup: null, chosenOption: null, note: null, origin: 'extra', onTillMenu: true, unitPriceSatang: 12_000 },
    { lineId: 'm2', productCode: null, name: 'ZZ fruit plate', qty: 1, choiceGroup: null, chosenOption: null, note: 'cut small', origin: 'extra', onTillMenu: false },
  ],
  barItems: [
    { lineId: 'b1', productCode: 'CF-65-6', name: 'Mineral water', qty: 2, note: null, origin: 'extra', onTillMenu: true },
    { lineId: 'b2', productCode: 'CF-63-1', name: 'Orange juice', qty: 4, note: null, origin: 'set_menu', onTillMenu: true },
  ],
  kitchen: { kidsFoodTime: '14:00', adultsFoodTime: null, readyOffsetMinutes: 20, slipsTime: '11:00', barServiceTime: '19:15' },
  cake: { type: 'our', qty: 1, time: '20:30', note: 'ZZ unicorn' },
};

function viewOf(): EventView {
  return {
    id: PARTY,
    branchId: HKT_CENTRAL,
    type: 'party',
    appEventType: 'birthday',
    status: 'upcoming',
    appStatus: 'upcoming',
    archived: false,
    title: "Mali's 6th",
    startDate: T,
    endDate: T,
    cancelledDays: [],
    startTime: '13:00',
    endTime: '16:00',
    location: 'Party room 1',
    expectedKids: 10,
    expectedAdults: 4,
    entryPrice: null,
    party: {
      childName: 'Mali',
      kidTurningAge: 6,
      bookingName: null,
      parentName: 'Nok',
      parentPhone: '+66812345678',
      activities: null,
      decoration: null,
      totalValueSatang: 0,
      depositSatang: 0,
      depositDate: null,
      walkUpCharges: [],
      charges: [],
      payments: [],
      lastEdited: null,
      editSync: null,
      settlement: null,
    },
    attendeeCount: 0,
    attendees: [],
    roster: { arrived: 0, expected: 0, currentlyIn: 0, outstanding: 0, all: 0 },
  };
}
const partyOf = () => toOtoEvent(viewOf(), 'hkt-central') as unknown as PartyBooking;
const detailAnswer = (kitchen: PartyKitchenPlan) => ({
  branchId: HKT_CENTRAL,
  date: T,
  event: viewOf(),
  plan: null,
  planStatus: 'no_package',
  kitchenPlan: kitchen,
  slips: null,
});

beforeEach(() => {
  access.kitchen = true;
  toastMock.mockReset();
  putMock.mockReset();
  getMock.mockReset();
  getMock.mockImplementation((async (path: string) => {
    if (path.startsWith(`/parties/${PARTY}/kitchen-plan/choices`)) {
      return { status: 'ok', message: null, groups: [{ label: 'Fried rice', options: ['Veggie', 'Chicken', 'Shrimp'], allowMultiple: false }, { label: 'Pizza', options: ['Margherita', 'Hawaiian'], allowMultiple: false }] };
    }
    if (path.startsWith(`/parties/${PARTY}`)) return detailAnswer(KITCHEN);
    return { member: null };
  }) as unknown as typeof api.get);
});

// --- Reading the screen --------------------------------------------------------------

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}
const isEl = (n: unknown): n is El => !!n && typeof n === 'object' && 'type' in n && 'props' in n;
function* walk(node: unknown): Generator<El> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!isEl(node)) return;
  yield node;
  for (const value of Object.values(node.props)) {
    if (Array.isArray(value) || isEl(value)) yield* walk(value);
  }
}
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isEl(node)) return ` ${textOf(node.props.children)} `;
  return '';
};
const flat = (tree: unknown) => textOf(tree).replace(/\s+/g, ' ');
const elementOf = (tree: unknown, type: unknown): El | null => {
  for (const el of walk(tree)) if (el.type === type) return el;
  return null;
};
function buttonIn(tree: unknown, words: string): El | null {
  for (const el of walk(tree)) {
    if (typeof el.props.onClick !== 'function') continue;
    if (textOf(el.props.children).replace(/\s+/g, ' ').trim() === words) return el;
  }
  return null;
}
/** A child component the harness handed over as an element, drawn as a plain function (it uses no hook). */
const draw = (el: El | null): unknown => (el && typeof el.type === 'function' ? (el.type as (p: unknown) => unknown)(el.props) : null);
/** Every function component under a tree drawn too, as far as `depth` levels. */
function drawAll(node: unknown, depth = 3): unknown {
  if (depth < 0) return node;
  if (Array.isArray(node)) return node.map((n) => drawAll(n, depth));
  if (!isEl(node)) return node;
  if (typeof node.type === 'function' && !/MenuPickInput/.test((node.type as { name?: string }).name ?? '')) {
    return drawAll((node.type as (p: unknown) => unknown)(node.props), depth - 1);
  }
  const children = node.props.children;
  return { ...node, props: { ...node.props, children: drawAll(children, depth) } };
}
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

// =============================================================================

describe('the draft and what Save sends', () => {
  it('the plan as the form opens it: every food and bar line, the cake; nothing changed sends nothing', () => {
    const draft = kitchenDraftOf(KITCHEN);
    expect(draft.lines.map((l) => [l.list, l.lineId, l.name, l.qty])).toEqual([
      ['food', 'set_rice', 'Fried rice', 3],
      ['food', 'set_fries', 'French fries', 2],
      ['food', null, 'Pizza', 2],
      ['food', 'm1', 'Calamari', 2],
      ['food', 'm2', 'ZZ fruit plate', 1],
      ['bar', 'b1', 'Mineral water', 2],
      ['bar', 'b2', 'Orange juice', 4],
    ]);
    expect(draft.cake).toEqual({ time: '20:30', note: 'ZZ unicorn' });
    expect(kitchenChangesOf(KITCHEN, draft)).toEqual([]);
  });

  it('a count and a note, an EXTRA removed, a choice, an open group chosen, a till item and a typed line added, the cake: only those, in order', () => {
    const draft = kitchenDraftOf(KITCHEN);
    const by = (key: string) => draft.lines.find((l) => l.key === key)!;
    by('food:m1').qty = 3;
    by('food:m1').note = 'no sauce';
    by('food:m2').removed = true;
    by('food:set_rice').chosenOption = 'Chicken';
    by('food:place-2').chosenOption = 'Hawaiian';
    by('bar:b1').qty = 4;
    const picked = addedKitchenLine('food', { name: 'Hummus', code: 'CF-13' });
    const typed = { ...addedKitchenLine('food'), name: 'ZZ mango sticky rice', qty: 2, note: 'no nuts' };
    const blank = addedKitchenLine('bar');
    const next: KitchenDraft = { lines: [...draft.lines, picked, typed, blank], cake: { time: '21:00', note: 'ZZ rainbow' } };
    expect(kitchenChangesOf(KITCHEN, next)).toEqual([
      { op: 'choose', choiceGroup: 'Fried rice', lineId: 'set_rice', option: 'Chicken' },
      { op: 'choose', choiceGroup: 'Pizza', lineId: null, option: 'Hawaiian' },
      { op: 'set', lineId: 'm1', qty: 3, note: 'no sauce' },
      { op: 'remove', lineId: 'm2' },
      { op: 'set', lineId: 'b1', qty: 4 },
      { op: 'add', id: picked.added, list: 'food', name: 'Hummus', productCode: 'CF-13', qty: 1 },
      { op: 'add', id: typed.added, list: 'food', name: 'ZZ mango sticky rice', productCode: null, qty: 2, note: 'no nuts' },
      { op: 'cake', time: '21:00', note: 'ZZ rainbow' },
    ]);
  });

  it('a set-menu dish is never removed from the till, and a line the BEO does not hold by id changes nothing but its choice', () => {
    const draft = kitchenDraftOf(KITCHEN);
    expect(draft.lines.map((l) => [l.key, kitchenLineRemovable(l)])).toEqual([
      ['food:set_rice', false],
      ['food:set_fries', false],
      ['food:place-2', false],
      ['food:m1', true],
      ['food:m2', true],
      ['bar:b1', true],
      ['bar:b2', false],
    ]);
    const tried = { ...draft, lines: draft.lines.map((l) => (l.key === 'food:set_fries' || l.key === 'food:place-2' ? { ...l, removed: l.key === 'food:set_fries', qty: 5 } : l)) };
    expect(kitchenChangesOf(KITCHEN, tried)).toEqual([]);
  });

  it("the picker finds the till's items by name or code, the closest first", () => {
    const menu = [
      { name: 'Grilled chicken', code: 'CF-10-11' },
      { name: 'Chicken schnitzel', code: 'CF-30' },
      { name: 'Calamari', code: 'CF-14' },
    ];
    expect(kitchenMenuMatches(menu, 'chicken').map((m) => m.code)).toEqual(['CF-30', 'CF-10-11']);
    expect(kitchenMenuMatches(menu, 'cf-14').map((m) => m.name)).toEqual(['Calamari']);
    expect(kitchenMenuMatches(menu, '  ')).toEqual([]);
  });
});

describe('the platform calls', () => {
  it('Save sends PUT /parties/:id/kitchen-plan under the edit id, as one Idempotency-Key', async () => {
    putMock.mockResolvedValueOnce({ ...detailAnswer(KITCHEN), kitchenEdit: { id: 'e1', replayed: false } } as unknown as PartyKitchenEditAnswer);
    const outcome = await editPartyKitchenOnPlatform({
      party: { id: PARTY, branchId: 'hkt-central' },
      changes: [{ op: 'set', lineId: 'm1', qty: 3 }],
      stationId: TILL,
      ids: { id: '0190a0a0-0000-7000-8000-0000000ed001', actionId: 'act-1' },
    });
    expect(outcome.ok).toBe(true);
    expect(putMock).toHaveBeenCalledWith(
      `/parties/${PARTY}/kitchen-plan`,
      { branchId: HKT_CENTRAL, editId: '0190a0a0-0000-7000-8000-0000000ed001', actionId: 'act-1', stationId: TILL, changes: [{ op: 'set', lineId: 'm1', qty: 3 }] },
      { idempotencyKey: 'party-kitchen:0190a0a0-0000-7000-8000-0000000ed001' },
    );
  });

  it("a refusal is the OTO App's words and asks afresh; no answer may go again", async () => {
    putMock.mockRejectedValueOnce(new ApiError(409, 'OTOAPP_SET_MENU_LINE', 'The OTO App did not change the kitchen plan: French fries is a dish of the set menu.'));
    const refused = await editPartyKitchenOnPlatform({ party: { id: PARTY, branchId: 'hkt-central' }, changes: [{ op: 'remove', lineId: 'set_fries' }], ids: { id: 'x', actionId: 'y' } });
    expect(refused).toEqual({ ok: false, message: 'The OTO App did not change the kitchen plan: French fries is a dish of the set menu.', retryable: false });
    putMock.mockRejectedValueOnce(new ApiError(502, 'OTOAPP_NOT_ANSWERED', 'The OTO App did not answer'));
    const silent = await editPartyKitchenOnPlatform({ party: { id: PARTY, branchId: 'hkt-central' }, changes: [{ op: 'remove', lineId: 'm2' }], ids: { id: 'x', actionId: 'y' } });
    expect(silent).toMatchObject({ ok: false, retryable: true });
  });

  it('the choices are read for the form; a till not linked reads none', async () => {
    expect(await readPartyKitchenChoicesOnPlatform({ id: PARTY, branchId: 'hkt-central' })).toMatchObject({ status: 'ok' });
    expect(getMock).toHaveBeenCalledWith(`/parties/${PARTY}/kitchen-plan/choices?branchId=${HKT_CENTRAL}`);
    expect(await readPartyKitchenChoicesOnPlatform({ id: PARTY, branchId: 'not-linked' })).toBeNull();
  });
});

describe('the Edit form', () => {
  function form(mayEditKitchen: boolean) {
    const onSave = vi.fn();
    const props = { party: partyOf(), onSave, onCancel: vi.fn(), kitchenPlan: KITCHEN, mayEditKitchen, kitchenChoices: null };
    return { onSave, host: renderHook((p: typeof props) => PartyEditForm(p), props) };
  }

  it("a manager's form fills the kitchen and bar sections from the plan and Save hands over what changed", () => {
    const { onSave, host } = form(true);
    const tree = host.result.current;
    const kitchen = elementOf(tree, PartyKitchenPlanSection)!;
    expect(kitchen.props).toMatchObject({ plan: KITCHEN, readOnly: false });
    expect(elementOf(tree, PartyBarPlanSection)!.props).toMatchObject({ readOnly: false });
    // The till's menu for the picker: its coded items only.
    expect(kitchen.props.menu).toEqual([
      { name: 'Calamari', code: 'CF-14' },
      { name: 'Hummus', code: 'CF-13' },
    ]);
    const draft = kitchen.props.draft as KitchenDraft;
    (kitchen.props.onChange as (d: KitchenDraft) => void)({
      ...draft,
      lines: draft.lines.map((l) => (l.key === 'food:m1' ? { ...l, qty: 5 } : l)),
    });
    const save = buttonIn(host.result.current, 'Save changes');
    (save!.props.onClick as () => void)();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![1]).toEqual([{ op: 'set', lineId: 'm1', qty: 5 }]);
  });

  it('reception see the same sections read-only, told a manager changes them, and Save sends no kitchen change', () => {
    const { onSave, host } = form(false);
    const kitchen = elementOf(host.result.current, PartyKitchenPlanSection)!;
    expect(kitchen.props.readOnly).toBe(true);
    const drawn = drawAll(draw(kitchen));
    const words = flat(drawn);
    expect(words).toContain(PARTY_KITCHEN_READ_ONLY);
    expect(buttonIn(drawn, 'Add item')).toBeNull();
    expect(buttonIn(drawAll(draw(elementOf(host.result.current, PartyBarPlanSection))), 'Add item')).toBeNull();
    (buttonIn(host.result.current, 'Save changes')!.props.onClick as () => void)();
    expect(onSave.mock.calls[0]![1]).toEqual([]);
  });

  it("a manager's kitchen section offers Add item and a remove on an EXTRA, never on a set-menu dish, and names a line the till does not sell", () => {
    const { host } = form(true);
    const drawn = drawAll(draw(elementOf(host.result.current, PartyKitchenPlanSection)));
    expect(buttonIn(drawn, 'Add item')).not.toBeNull();
    const removes = [...walk(drawn)].map((el) => el.props['aria-label']).filter((l): l is string => typeof l === 'string' && l.startsWith('Remove') && l.endsWith(' item'));
    expect(removes).toEqual(['Remove Calamari item', 'Remove ZZ fruit plate item']);
    const values = [...walk(drawn)].map((el) => el.props.value).filter((v): v is string => typeof v === 'string');
    expect(values).toContain(`Fried rice · Veggie · ${PARTY_NOT_ON_TILL_MENU}`);
    expect(values).toContain('20:30');
    expect(values).toContain('ZZ unicorn');
  });

  it('without a plan read, the sections are the prototype\'s own, as before', () => {
    const props = { party: partyOf(), onSave: vi.fn(), onCancel: vi.fn() };
    const host = renderHook((p: typeof props) => PartyEditForm(p), props);
    expect(elementOf(host.result.current, PartyKitchenPlanSection)).toBeNull();
    expect(flat(host.result.current)).toContain('Kitchen service needed');
  });
});

describe('the party page saves the kitchen plan to the BEO', () => {
  function page() {
    const onChanged = vi.fn();
    const props: Record<string, unknown> = { party: partyOf(), surface: 'fnb', onBack: () => undefined, onChanged };
    return { onChanged, host: renderHook((p: Record<string, unknown>) => PartyDetail(p as never), props) };
  }
  async function openEdit(host: ReturnType<typeof page>['host']) {
    await settle();
    (buttonIn(host.result.current, 'Edit party')!.props.onClick as () => void)();
    await settle();
    return elementOf(host.result.current, PartyEditForm)!;
  }

  it('a manager: the form has the plan and the choices; Save writes the kitchen plan, closes and reads the plan again', async () => {
    const { host } = page();
    const editForm = await openEdit(host);
    expect(editForm.props).toMatchObject({ kitchenPlan: KITCHEN, mayEditKitchen: true });
    expect((editForm.props.kitchenChoices as { status: string } | null)?.status).toBe('ok');
    putMock.mockResolvedValueOnce({ ...detailAnswer({ ...KITCHEN }), kitchenEdit: { id: 'e1', replayed: false } } as unknown as PartyKitchenEditAnswer);
    const readsBefore = getMock.mock.calls.filter((c) => c[0] === `/parties/${PARTY}?branchId=${HKT_CENTRAL}`).length;
    // The party's own fields as they were: only the kitchen plan changed.
    await (editForm.props.onSave as (p: unknown, c: unknown) => Promise<void>)({ ...partyOf() }, [{ op: 'set', lineId: 'm1', qty: 3 }]);
    await settle();
    expect(putMock).toHaveBeenCalledTimes(1);
    expect(putMock.mock.calls[0]![0]).toBe(`/parties/${PARTY}/kitchen-plan`);
    expect(putMock.mock.calls[0]![1]).toMatchObject({ branchId: HKT_CENTRAL, changes: [{ op: 'set', lineId: 'm1', qty: 3 }] });
    expect(elementOf(host.result.current, PartyEditForm)).toBeNull();
    expect(toastMock).toHaveBeenCalledWith({ title: 'Kitchen plan saved', description: 'The BEO in the OTO App now has the change.' });
    const readsAfter = getMock.mock.calls.filter((c) => c[0] === `/parties/${PARTY}?branchId=${HKT_CENTRAL}`).length;
    expect(readsAfter).toBeGreaterThan(readsBefore);
  });

  it("a refusal keeps the form open and says the OTO App's words", async () => {
    const { host } = page();
    const editForm = await openEdit(host);
    putMock.mockRejectedValueOnce(new ApiError(409, 'OTOAPP_SET_MENU_LINE', 'The OTO App did not change the kitchen plan: French fries is a dish of the set menu.'));
    await (editForm.props.onSave as (p: unknown, c: unknown) => Promise<void>)(
      { ...partyOf() },
      [{ op: 'remove', lineId: 'set_fries' }],
    );
    await settle();
    expect(elementOf(host.result.current, PartyEditForm)).not.toBeNull();
    expect(toastMock).toHaveBeenCalledWith({
      title: 'Kitchen plan not saved',
      description: 'The OTO App did not change the kitchen plan: French fries is a dish of the set menu.',
      variant: 'destructive',
    });
  });

  it('reception open the form read-only and the choices are not asked for', async () => {
    access.kitchen = false;
    const { host } = page();
    const editForm = await openEdit(host);
    expect(editForm.props).toMatchObject({ mayEditKitchen: false, kitchenChoices: null });
    expect(getMock.mock.calls.some((c) => String(c[0]).includes('/kitchen-plan/choices'))).toBe(false);
  });
});

describe('SCRUM-950 — Settle party names each extra it charges', () => {
  const QUOTE: PartySettleQuote = {
    partyDate: T,
    rateMode: 'weekday',
    packageName: 'Floresta Birthday',
    lines: [],
    packageSatang: 1_690_000,
    extraChildren: 0,
    extraChildrenSatang: 0,
    extraAdults: 0,
    extraAdultsSatang: 0,
    freeSocks: 10,
    paidSocks: 0,
    socksSatang: 0,
    addOnsSatang: 400_000 + 81_500,
    entertainmentSatang: 0,
    totalSatang: 1_690_000 + 481_500,
    creditSatang: 0,
    depositSatang: 300_000,
    balanceSatang: 1_690_000 + 481_500 - 300_000,
    walkUps: 0,
    walkUpsSatang: 0,
    extras: [
      { name: 'Calamari', productCode: 'CF-14', qty: 2, unitSatang: 12_000, totalSatang: 24_000, charged: true },
      { name: 'Hummus', productCode: 'CF-13', qty: 1, unitSatang: 27_500, totalSatang: 27_500, charged: true },
      { name: 'ZZ mango sticky rice', productCode: null, qty: 2, unitSatang: 9_000, totalSatang: 18_000, charged: true },
      { name: 'Mineral water', productCode: 'CF-65-6', qty: 2, unitSatang: 6_000, totalSatang: 12_000, charged: true },
      { name: 'ZZ fruit plate', productCode: null, qty: 1, unitSatang: null, totalSatang: 0, charged: false },
    ],
  };
  /** The form's figures, drawn: the summary element the modal hands over is drawn with its quote. */
  async function summaryOf(quote: PartySettleQuote) {
    const postMock = vi.mocked(api.post);
    postMock.mockReset();
    postMock.mockResolvedValue({ quote });
    const plan = {
      eventId: PARTY,
      partyDate: T,
      startTime: '13:00',
      endTime: '16:00',
      package: {
        templateId: 'f',
        name: 'Floresta Birthday',
        hours: 3,
        kidsIncluded: 10,
        adultsIncluded: 4,
        socksIncluded: -1,
        priceWeekdaySatang: 1_690_000,
        priceWeekendSatang: 2_090_000,
        extraChildWeekdaySatang: 130_000,
        extraChildWeekendSatang: 150_000,
        extraAdultWeekdaySatang: 35_000,
        extraAdultWeekendSatang: 50_000,
        includedLines: [],
      },
      counts: { kidsExpected: 10, adultsExpected: 4 },
      addOns: [],
      entertainment: [],
      setMenu: [],
      barItems: [],
      kitchen: null,
      settlement: { depositSatang: 300_000, posSaleId: null },
    };
    const props = { open: true, onOpenChange: vi.fn(), party: partyOf(), plan, stationId: TILL, resumeSaleId: null, onSettled: vi.fn() };
    const host = renderHook((p: typeof props) => PartySettleModal(p as never), props);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    for (const el of walk(host.result.current)) if (el.props.quote === quote) return flat(draw(el));
    return '';
  }

  it('each charged extra with its count, the price of one and its amount; one not charged says so; the add-ons row keeps the plan\'s own', async () => {
    const text = await summaryOf(QUOTE);
    for (const words of [
      'Calamari · 2 × ฿120 ฿240',
      'Hummus · 1 × ฿275 ฿275',
      'ZZ mango sticky rice · 2 × ฿90 ฿180',
      'Mineral water · 2 × ฿60 ฿120',
      'ZZ fruit plate Not charged',
      'Add-ons ฿4,000',
      'Total ฿21,715',
    ]) {
      expect(text).toContain(words);
    }
    expect(text).not.toContain('Add-ons ฿4,815');
  });

  it('an extra of a thousand baht or more is grouped like the form\'s other figures', async () => {
    const big = [
      { name: 'ZZ seafood platter', productCode: null, qty: 2, unitSatang: 65_000, totalSatang: 130_000, charged: true },
      { name: 'ZZ cake tower', productCode: null, qty: 1, unitSatang: 125_000, totalSatang: 125_000, charged: true },
    ];
    const addOnsSatang = QUOTE.addOnsSatang + 130_000 + 125_000;
    const text = await summaryOf({
      ...QUOTE,
      addOnsSatang,
      totalSatang: QUOTE.packageSatang + addOnsSatang,
      balanceSatang: QUOTE.packageSatang + addOnsSatang - QUOTE.depositSatang,
      extras: [...(QUOTE.extras ?? []), ...big],
    });
    for (const words of [
      'ZZ seafood platter · 2 × ฿650 ฿1,300',
      'ZZ cake tower · 1 × ฿1,250 ฿1,250',
      'Calamari · 2 × ฿120 ฿240',
      'Add-ons ฿4,000',
      'Total ฿24,265',
    ]) {
      expect(text).toContain(words);
    }
    expect(text).not.toContain('฿1300');
    expect(text).not.toContain('฿1250');
  });

  it('a quote from a platform before it keeps the one add-ons row', async () => {
    const { extras: _extras, ...before } = QUOTE;
    const text = await summaryOf(before);
    expect(text).toContain('Add-ons ฿4,815');
    expect(text).not.toContain('Calamari');
  });
});
