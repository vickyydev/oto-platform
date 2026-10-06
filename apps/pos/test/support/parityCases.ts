import type {
  AddOn,
  CartLine,
  Discount,
  FnbOrder,
  FnbOrderLine,
  InventoryItem,
  ManualDiscount,
  MenuCategoryDef,
  MenuItem,
  MerchItem,
  MerchOrder,
  MerchOrderLine,
  ModifierGroup,
  OtoEvent,
  PricingOverride,
  Sale,
  SelectedModifier,
  TaxConfig,
  TicketType,
  Wristband,
} from '@/types';
import type { RateMode } from '@/lib/pricingMode';

/**
 * THE CARTS THE ONE-CALCULATOR PARITY IS PROVEN ON — SCRUM-271, plan
 * `docs/progress/plans/offline/PLAN.md` Round 2 ("prototype-figure parity per
 * surface").
 *
 * Every cart here was priced twice: once by the prototype's arithmetic
 * (`lib/tax.ts`, and `computeTotals`, `computeFnbTotals`, `computeMerchTotals`,
 * `computeLineTotal`, `computeMerchLineTotal` in `lib/sale.ts`, `lib/fnb.ts`,
 * `lib/merch.ts`) before that arithmetic was deleted, and those figures are in
 * `test/fixtures/one-calculator-parity.json`; and once by the satang engine
 * through `lib/cartWire.ts`, in `one-calculator-parity.test.ts`, every time the
 * suite runs.
 *
 * NOTHING HERE PRICES ANYTHING. The builders take the functions that do as
 * arguments, so the same carts could be — and were — handed to both
 * arithmetics. A line's total is left to the caller's `price` hooks; the only
 * figures written here are the ones a record stores as data (a manual
 * discount's recorded `amountTHB`, a wallet entry, an inventory cost).
 *
 * THE CATALOGUE is the till's seed at the time the figures were taken, stored in
 * the fixture and handed back to the store by the test, so a later edit to the
 * seed cannot move a figure out from under the comparison.
 */

/** The catalogue the figures were taken against — the till's seed, captured once. */
export interface ParityCatalogue {
  ticketTypes: TicketType[];
  addOns: AddOn[];
  menuItems: MenuItem[];
  menuCategories: MenuCategoryDef[];
  modifierGroups: ModifierGroup[];
  merchItems: MerchItem[];
  taxConfig: TaxConfig;
  discounts: Discount[];
  pricingOverrides: PricingOverride[];
}

/** The pricing a cart needs before it can be totalled — the function under test supplies it. */
export interface PricingHooks {
  /** A ticket line's total: `lib/pricing.ts` `computeLineTotal`, unchanged by this round. */
  ticketLine: (
    base: Omit<CartLine, 'id' | 'lineTotal'>,
    mode: RateMode,
  ) => number;
  /** An F&B line's total: the prototype's `computeLineTotal`, or the engine's through `cartWire`. */
  fnbLine: (item: MenuItem, selected: SelectedModifier[], qty: number, mode: RateMode) => number;
  /** A shop line's total: the prototype's `computeMerchLineTotal`, or the engine's. */
  merchLine: (item: MerchItem, qty: number, mode: RateMode) => number;
}

/** A tax configuration other than the seed's, so rounding under service and added tax is exercised. */
export type ConfigName = 'seeded' | 'service_exclusive' | 'after_tax' | 'secondary';

export function taxConfigNamed(name: ConfigName, seeded: TaxConfig): TaxConfig {
  if (name === 'seeded') return seeded;
  const rules = seeded.categoryRules;
  if (name === 'service_exclusive') {
    // VAT added on top, a 10 % service charge, and VAT charged on the service.
    return {
      ...seeded,
      categoryRules: rules.map((rule) =>
        rule.taxMode === 'none'
          ? rule
          : { ...rule, taxMode: 'exclusive', serviceChargePercent: 10, taxOnServiceCharge: true },
      ),
    };
  }
  if (name === 'after_tax') {
    return { ...seeded, discountPlacement: 'after_tax' };
  }
  // A second rate on F&B, added on top of the included VAT.
  return {
    ...seeded,
    rates: [...seeded.rates, { id: 'city', name: 'City tax', percent: 5 }],
    categoryRules: rules.map((rule) =>
      rule.category === 'fnb'
        ? { ...rule, secondaryTaxRateId: 'city', secondaryTaxMode: 'exclusive' }
        : rule,
    ),
  };
}

// --- Records a discount is stored as -----------------------------------------

const APPLIED_AT = '2026-09-30T04:00:00.000Z';

function manual(
  id: string,
  fields: Pick<ManualDiscount, 'scope' | 'type' | 'value'> &
    Partial<Pick<ManualDiscount, 'targetLineId' | 'targetComponent' | 'targetLabel' | 'amountTHB' | 'appliedBy'>>,
): ManualDiscount {
  return {
    id,
    reason: 'Service recovery',
    amountTHB: fields.amountTHB ?? 0,
    appliedBy: fields.appliedBy ?? 'Som (Reception)',
    appliedById: 'op-1',
    appliedAt: APPLIED_AT,
    ...fields,
  };
}

function code(fields: Discount): Discount {
  return fields;
}

// --- Ticket carts ------------------------------------------------------------

export interface TicketCase {
  id: string;
  /** Which screens total a cart like this one. */
  surface: 'ticket' | 'event' | 'dropoff' | 'history';
  mode: RateMode;
  /**
   * The rate mode the lines were PRICED under, when it is not the one the cart
   * is totalled under — the history screens re-deriving yesterday's sale.
   */
  pricedMode?: RateMode;
  config: ConfigName;
  lines: CartLine[];
  discounts: Discount[];
  manual: ManualDiscount[];
  /**
   * Why the engine's figure may differ from the prototype's here, when it may:
   *   rounding  — within a satang per tax row, or a percent the prototype
   *               rounded to the baht;
   *   ruling-1, ruling-2 — the two recorded rulings in
   *               `packages/shared/src/cart-totals.ts` (OPEN_QUESTIONS.md §3c).
   * Absent means the two must agree to the satang.
   */
  differs?: 'rounding' | 'ruling-1' | 'ruling-2';
}

const TIERS = ['tourist', 'expat', 'thai'] as const;
const PACKAGES = ['t-1h', 't-2h', 't-fd', 't-pe'] as const;

function ticketOf(catalogue: ParityCatalogue, id: string): TicketType {
  const found = catalogue.ticketTypes.find((ticket) => ticket.id === id);
  if (!found) throw new Error(`parity catalogue has no ticket ${id}`);
  return found;
}

function addOnOf(catalogue: ParityCatalogue, id: string, quantity: number, mode: RateMode) {
  const found = catalogue.addOns.find((addOn) => addOn.id === id);
  if (!found) throw new Error(`parity catalogue has no add-on ${id}`);
  return { ...found, price: mode === 'weekend' ? found.price.weekend : found.price.weekday, quantity };
}

function ticketLine(
  catalogue: ParityCatalogue,
  hooks: PricingHooks,
  id: string,
  mode: RateMode,
  spec: { ticket: string; tier: string; kids: number; adults: number; socks?: number; addOns?: [string, number][] },
): CartLine {
  const base = {
    ticketType: ticketOf(catalogue, spec.ticket),
    tier: spec.tier,
    kids: spec.kids,
    adults: spec.adults,
    socks: spec.socks ?? 0,
    addOns: (spec.addOns ?? []).map(([addOnId, quantity]) => addOnOf(catalogue, addOnId, quantity, mode)),
  };
  return { id, ...base, lineTotal: hooks.ticketLine(base, mode) };
}

export function ticketCases(catalogue: ParityCatalogue, hooks: PricingHooks): TicketCase[] {
  const cases: TicketCase[] = [];
  const line = (id: string, mode: RateMode, spec: Parameters<typeof ticketLine>[4]) =>
    ticketLine(catalogue, hooks, id, mode, spec);

  // Every package, every tier, five shapes, both rate modes: what the till
  // prices all day, and what `checkCartPricing.ts` walks.
  const shapes: [string, Omit<Parameters<typeof ticketLine>[4], 'ticket' | 'tier'>][] = [
    ['2k3a', { kids: 2, adults: 3 }],
    ['2k3a4s', { kids: 2, adults: 3, socks: 4 }],
    ['1k1a2s-addons', { kids: 1, adults: 1, socks: 2, addOns: [['a-grip-socks', 2], ['a-locker', 2]] }],
    ['0k2a', { kids: 0, adults: 2 }],
    ['5k0a1s', { kids: 5, adults: 0, socks: 1 }],
  ];
  for (const mode of ['weekday', 'weekend'] as const) {
    for (const ticket of PACKAGES) {
      for (const tier of TIERS) {
        for (const [shape, spec] of shapes) {
          cases.push({
            id: `T-${mode}-${ticket}-${tier}-${shape}`,
            surface: 'ticket',
            mode,
            config: 'seeded',
            lines: [line('l1', mode, { ticket, tier, ...spec })],
            discounts: [],
            manual: [],
          });
        }
      }
    }
  }

  const standard = (mode: RateMode = 'weekday') =>
    line('l1', mode, { ticket: 't-2h', tier: 'tourist', kids: 2, adults: 1, socks: 2 });
  const plain = (id: string, extra: Partial<TicketCase>) => ({
    id,
    surface: 'ticket' as const,
    mode: 'weekday' as const,
    config: 'seeded' as const,
    lines: [standard()],
    discounts: [],
    manual: [],
    ...extra,
  });

  cases.push(
    plain('T-two-lines', {
      lines: [
        line('l1', 'weekday', { ticket: 't-2h', tier: 'tourist', kids: 2, adults: 2, socks: 2 }),
        line('l2', 'weekday', {
          ticket: 't-fd',
          tier: 'thai',
          kids: 1,
          adults: 2,
          addOns: [['a-cup', 1], ['a-glow', 3]],
        }),
      ],
    }),
    plain('T-manual-order-fixed', { manual: [manual('md1', { scope: 'order', type: 'fixed', value: 150 })] }),
    plain('T-manual-line-fixed', {
      manual: [manual('md1', { scope: 'line', targetLineId: 'l1', type: 'fixed', value: 90 })],
    }),
    plain('T-manual-line-comp', {
      manual: [manual('md1', { scope: 'line', targetLineId: 'l1', type: 'comp', value: 0 })],
    }),
    plain('T-manual-kids-comp', {
      manual: [
        manual('md1', { scope: 'line', targetLineId: 'l1', targetComponent: { kind: 'kids' }, type: 'comp', value: 0 }),
      ],
    }),
    plain('T-manual-socks-fixed-and-order-fixed', {
      manual: [
        manual('md1', { scope: 'line', targetLineId: 'l1', targetComponent: { kind: 'socks' }, type: 'fixed', value: 30 }),
        manual('md2', { scope: 'order', type: 'fixed', value: 45 }),
      ],
    }),
    // A percent the prototype rounds to the whole baht and the engine to the satang.
    plain('T-manual-order-percent', {
      manual: [manual('md1', { scope: 'order', type: 'percent', value: 13 })],
      differs: 'rounding',
    }),
    plain('T-manual-adults-percent', {
      manual: [
        manual('md1', {
          scope: 'line',
          targetLineId: 'l1',
          targetComponent: { kind: 'adults' },
          type: 'percent',
          value: 15,
        }),
      ],
      differs: 'rounding',
    }),
    plain('T-promo-fixed', { discounts: [code({ code: 'SAVE100', label: 'Save 100', type: 'fixed', value: 100 })] }),
    plain('T-promo-percent', {
      discounts: [code({ code: 'STAFF10', label: 'Staff Discount', type: 'percent', value: 10, stackable: true })],
    }),
    plain('T-promo-stacked-percents', {
      discounts: [
        code({ code: 'STAFF10', label: 'Staff Discount', type: 'percent', value: 10, stackable: true }),
        code({ code: 'MEMBER20', label: 'Member Discount', type: 'percent', value: 20, stackable: true }),
      ],
    }),
    // WE-6's shape on the till's seed: manual first, the code against the balance.
    plain('T-manual-then-promo', {
      lines: [line('l1', 'weekday', { ticket: 't-2h', tier: 'tourist', kids: 2, adults: 1 })],
      manual: [manual('md1', { scope: 'order', type: 'fixed', value: 200 })],
      discounts: [code({ code: 'STAFF10', label: 'Staff Discount', type: 'percent', value: 10, stackable: true })],
    }),
    plain('T-promo-addons-scoped', {
      lines: [line('l1', 'weekday', { ticket: 't-2h', tier: 'tourist', kids: 2, adults: 1, socks: 2, addOns: [['a-locker', 1]] })],
      discounts: [
        code({ code: 'ADDON50', label: 'Add-ons half off', type: 'percent', value: 50, target: { kind: 'addOns' } }),
      ],
    }),
  );

  // RULING 1 — the free item goes on at ฿0 and the rest of the bill is untouched
  // (cart-totals.ts `promoItemTaxCategory`; fixture WE-8 in @oto/shared). The
  // cart is built the way `pages/Till.tsx` builds it: the promo line at the
  // item's shelf price, the code's value resolved to that price.
  {
    const cone = catalogue.menuItems.find((item) => item.id === 'm-icecream')!;
    const tickets = line('l1', 'weekday', { ticket: 't-2h', tier: 'tourist', kids: 2, adults: 1 });
    const promoLine: CartLine = {
      id: 'promo-ICECREAM',
      ticketType: tickets.ticketType,
      tier: 'tourist',
      kids: 0,
      adults: 0,
      socks: 0,
      addOns: [],
      lineTotal: cone.price.weekday,
      promoItem: { itemId: cone.id, itemKind: 'menu', name: cone.name, priceTHB: cone.price.weekday },
    };
    cases.push({
      id: 'T-ruling-1-free-item',
      surface: 'ticket',
      mode: 'weekday',
      config: 'seeded',
      lines: [tickets, promoLine],
      discounts: [
        code({
          code: 'ICECREAM',
          label: 'Free Ice Cream',
          type: 'free_item',
          value: cone.price.weekday,
          freeItemId: cone.id,
          freeItemKind: 'menu',
          target: { kind: 'menuItems', menuItemIds: [cone.id] },
        }),
      ],
      manual: [],
      differs: 'ruling-1',
    });
  }

  // RULING 2 — a scoped discount spends only what its own scope has left
  // (fixtures EC-15 and EC-17 in @oto/shared, on the till's seed).
  cases.push(
    {
      id: 'T-ruling-2-comped-kids-then-tickets-code',
      surface: 'ticket',
      mode: 'weekday',
      config: 'seeded',
      lines: [line('l1', 'weekday', { ticket: 't-2h', tier: 'tourist', kids: 2, adults: 0, addOns: [['a-locker', 10]] })],
      discounts: [code({ code: 'TICKETS100', label: 'Tickets on us', type: 'percent', value: 100, target: { kind: 'tickets' } })],
      manual: [
        manual('md1', { scope: 'line', targetLineId: 'l1', targetComponent: { kind: 'kids' }, type: 'comp', value: 0 }),
      ],
      differs: 'ruling-2',
    },
    {
      id: 'T-ruling-2-two-tickets-codes',
      surface: 'ticket',
      mode: 'weekday',
      config: 'seeded',
      lines: [
        line('l1', 'weekday', { ticket: 't-2h', tier: 'tourist', kids: 3, adults: 0, socks: 2, addOns: [['a-locker', 2]] }),
      ],
      discounts: [
        code({ code: 'KIDS23', label: 'Kids 23% off', type: 'percent', value: 23, stackable: true, target: { kind: 'tickets' } }),
        code({ code: 'TICKETSFREE', label: 'Tickets on us', type: 'percent', value: 100, stackable: true, target: { kind: 'tickets' } }),
      ],
      manual: [],
      differs: 'ruling-2',
    },
  );

  // Service, added tax and after-tax placement: where the prototype's floats
  // and the engine's satang can part by a satang per row.
  for (const config of ['service_exclusive', 'after_tax', 'secondary'] as const) {
    cases.push(
      plain(`T-config-${config}`, { config, differs: 'rounding' }),
      plain(`T-config-${config}-discounted`, {
        config,
        manual: [manual('md1', { scope: 'line', targetLineId: 'l1', type: 'fixed', value: 75 })],
        discounts: [code({ code: 'STAFF10', label: 'Staff Discount', type: 'percent', value: 10, stackable: true })],
        differs: 'rounding',
      }),
    );
  }

  // Events: a camp day pass, rung up the way `lib/eventPass.ts` rings it up.
  for (const [id, fee] of [['E-camp-pass', 450], ['E-event-pass', 1_250]] as const) {
    cases.push({
      id,
      surface: 'event',
      mode: 'weekday',
      config: 'seeded',
      lines: [
        {
          id: `pass-${id}`,
          ticketType: {
            id: id === 'E-camp-pass' ? 'svc-camp-pass' : 'svc-event-pass',
            name: id === 'E-camp-pass' ? 'Camp day pass' : 'Event entry pass',
            durationLabel: 'One-time',
            hours: 0,
            prices: { tourist: { weekday: fee, weekend: fee } },
          },
          tier: 'tourist',
          kids: 1,
          adults: 0,
          socks: 0,
          addOns: [],
          lineTotal: fee,
        },
      ],
      discounts: [],
      manual: [],
    });
  }

  // Drop-off: a priced child with its fee and prepaid food, and one whose play
  // length nobody has chosen yet — the cart the engine refuses and the till
  // still has to show a figure for (lib/cartQuote.ts).
  {
    const ticket = ticketOf(catalogue, 't-1h');
    const child = (lengthChosen: boolean, food?: 'prepaid_items' | 'prepaid_credit'): CartLine => {
      const fee = lengthChosen ? 150 : 0;
      const paid = lengthChosen && food ? 200 : 0;
      return {
        id: `line-ci-${lengthChosen ? food ?? 'plain' : 'unpriced'}`,
        ticketType: ticket,
        tier: 'tourist',
        kids: 1,
        adults: 0,
        socks: 0,
        addOns: [],
        lineTotal: lengthChosen ? ticket.prices.tourist!.weekday + fee + paid : 0,
        dropOff: {
          registrationId: 'reg-1',
          checkInId: 'ci-1',
          childName: 'Nong Ploy',
          childAge: 5,
          service: 'drop_off',
          hours: ticket.hours,
          lengthChosen,
          serviceFeeTHB: fee,
          ...(food ? { foodProvision: { mode: food, paidTHB: paid } } : {}),
        },
      };
    };
    cases.push(
      { id: 'D-priced', surface: 'dropoff', mode: 'weekday', config: 'seeded', lines: [child(true)], discounts: [], manual: [] },
      {
        id: 'D-prepaid-items',
        surface: 'dropoff',
        mode: 'weekday',
        config: 'seeded',
        lines: [child(true, 'prepaid_items')],
        discounts: [],
        manual: [],
      },
      {
        id: 'D-prepaid-credit',
        surface: 'dropoff',
        mode: 'weekday',
        config: 'seeded',
        lines: [child(true, 'prepaid_credit'), standard()],
        discounts: [],
        manual: [],
      },
      {
        id: 'D-unpriced',
        surface: 'dropoff',
        mode: 'weekday',
        config: 'seeded',
        lines: [standard(), child(false)],
        discounts: [],
        manual: [],
      },
    );
  }

  // History: a sale re-derived after the fact. The same rate mode it was sold
  // under; the other one (a Friday sale re-read on the Saturday); and the seed's
  // drop-off service sale, whose lines no rate mode reproduces
  // (`mockApi.ts` seedHistory, sale D9N4T7).
  cases.push(
    plain('H-same-mode', {
      surface: 'history',
      manual: [manual('md1', { scope: 'order', type: 'fixed', value: 60, amountTHB: 60 })],
      discounts: [code({ code: 'SAVE100', label: 'Save 100', type: 'fixed', value: 100 })],
    }),
    {
      id: 'H-sold-weekday-read-weekend',
      surface: 'history',
      mode: 'weekend',
      pricedMode: 'weekday',
      config: 'seeded',
      lines: [line('l1', 'weekday', { ticket: 't-2h', tier: 'thai', kids: 2, adults: 2, socks: 1 })],
      discounts: [],
      manual: [],
    },
    {
      id: 'H-seeded-dropoff-service-sale',
      surface: 'history',
      mode: 'weekday',
      config: 'seeded',
      lines: [
        { ...line('seedline-t', 'weekday', { ticket: 't-2h', tier: 'thai', kids: 1, adults: 0 }), lineTotal: 300 },
        {
          id: 'seedline-svc',
          ticketType: {
            id: 'svc-dropoff',
            name: 'Drop-off service',
            durationLabel: 'One-time',
            hours: 2,
            prices: {
              tourist: { weekday: 150, weekend: 150 },
              expat: { weekday: 150, weekend: 150 },
              thai: { weekday: 150, weekend: 150 },
            },
          },
          tier: 'thai',
          kids: 0,
          adults: 0,
          socks: 0,
          addOns: [],
          lineTotal: 150,
        },
      ],
      discounts: [],
      manual: [],
    },
  );

  return cases;
}

// --- F&B and shop orders -----------------------------------------------------

export interface FnbLineSpec {
  id: string;
  item: string;
  qty: number;
  selected?: SelectedModifier[];
  prepaid?: boolean;
}

export interface FnbCase {
  id: string;
  mode: RateMode;
  config: ConfigName;
  lines: FnbLineSpec[];
  manual: ManualDiscount[];
  promos: Discount[];
  differs?: 'rounding';
}

export function fnbCases(): FnbCase[] {
  const order = (id: string, lines: FnbLineSpec[], extra: Partial<FnbCase> = {}): FnbCase => ({
    id,
    mode: 'weekday',
    config: 'seeded',
    lines,
    manual: [],
    promos: [],
    ...extra,
  });
  return [
    order('F-seed-order', [
      { id: 'f1', item: 'm-nuggets', qty: 1 },
      { id: 'f2', item: 'm-fries', qty: 2 },
    ]),
    order('F-modifiers', [
      { id: 'f1', item: 'm-fries', qty: 3, selected: [{ groupId: 'fries-sauce', optionIds: ['fries-sauce-cheese', 'fries-sauce-mayo'] }] },
      {
        id: 'f2',
        item: 'm-latte',
        qty: 2,
        selected: [
          { groupId: 'latte-ice', optionIds: ['latte-ice-less'] },
          { groupId: 'latte-milk', optionIds: ['latte-milk-oat'] },
        ],
      },
      { id: 'f3', item: 'm-shake', qty: 1, selected: [{ groupId: 'shake-size', optionIds: ['shake-large'] }] },
    ]),
    order(
      'F-bar-and-kitchen-order-percent',
      [
        { id: 'f1', item: 'm-pizza', qty: 1, selected: [{ groupId: 'pizza-toppings', optionIds: ['pizza-cheese', 'pizza-ham'] }] },
        { id: 'f2', item: 'm-burger', qty: 2, selected: [{ groupId: 'burger-cook', optionIds: ['burger-medium'] }] },
        { id: 'f3', item: 'm-beer', qty: 1 },
      ],
      { manual: [manual('md1', { scope: 'order', type: 'percent', value: 10 })] },
    ),
    order(
      'F-line-fixed',
      [
        { id: 'f1', item: 'm-latte', qty: 1, selected: [{ groupId: 'latte-ice', optionIds: ['latte-ice-normal'] }] },
        { id: 'f2', item: 'm-water', qty: 2 },
      ],
      { manual: [manual('md1', { scope: 'line', targetLineId: 'f1', type: 'fixed', value: 20 })] },
    ),
    order(
      'F-line-comp-and-order-fixed',
      [
        { id: 'f1', item: 'm-padthai', qty: 2 },
        { id: 'f2', item: 'm-juice', qty: 2 },
      ],
      {
        manual: [
          manual('md1', { scope: 'line', targetLineId: 'f2', type: 'comp', value: 0 }),
          manual('md2', { scope: 'order', type: 'fixed', value: 30 }),
        ],
      },
    ),
    order(
      'F-promo-and-manual',
      [
        { id: 'f1', item: 'm-hotdog', qty: 2 },
        { id: 'f2', item: 'm-soda', qty: 2, selected: [{ groupId: 'soda-ice', optionIds: ['soda-ice-none'] }] },
      ],
      {
        manual: [manual('md1', { scope: 'order', type: 'fixed', value: 30 })],
        promos: [code({ code: 'STAFF10', label: 'Staff Discount', type: 'percent', value: 10, stackable: true })],
      },
    ),
    order(
      'F-promo-drinks-scoped',
      [
        { id: 'f1', item: 'm-latte', qty: 1, selected: [{ groupId: 'latte-ice', optionIds: ['latte-ice-normal'] }] },
        { id: 'f2', item: 'm-popcorn', qty: 2 },
      ],
      { promos: [code({ code: 'DRINKS20', label: 'Drinks 20%', type: 'percent', value: 20, target: { kind: 'fnbCategory', category: 'drinks' } })] },
    ),
    order('F-prepaid-line', [
      { id: 'f1', item: 'm-icecream', qty: 1, prepaid: true },
      { id: 'f2', item: 'm-cottoncandy', qty: 1 },
    ]),
    order('F-weekend', [{ id: 'f1', item: 'm-mojito', qty: 2 }, { id: 'f2', item: 'm-fruitcup', qty: 1 }], { mode: 'weekend' }),
    order('F-manual-percent-rounds', [{ id: 'f1', item: 'm-latte', qty: 1, selected: [{ groupId: 'latte-ice', optionIds: ['latte-ice-normal'] }] }], {
      manual: [manual('md1', { scope: 'order', type: 'percent', value: 15 })],
      differs: 'rounding',
    }),
    order('F-service-exclusive', [{ id: 'f1', item: 'm-pizza', qty: 1 }, { id: 'f2', item: 'm-slushie', qty: 3 }], {
      config: 'service_exclusive',
      manual: [manual('md1', { scope: 'order', type: 'fixed', value: 25 })],
      differs: 'rounding',
    }),
    order('F-secondary-tax', [{ id: 'f1', item: 'm-gintonic', qty: 1 }, { id: 'f2', item: 'm-nuggets', qty: 2 }], {
      config: 'secondary',
      differs: 'rounding',
    }),
  ];
}

export interface MerchLineSpec {
  id: string;
  item: string;
  qty: number;
}

export interface MerchCase {
  id: string;
  mode: RateMode;
  config: ConfigName;
  lines: MerchLineSpec[];
  manual: ManualDiscount[];
  promos: Discount[];
  differs?: 'rounding';
}

export function merchCases(): MerchCase[] {
  const order = (id: string, lines: MerchLineSpec[], extra: Partial<MerchCase> = {}): MerchCase => ({
    id,
    mode: 'weekday',
    config: 'seeded',
    lines,
    manual: [],
    promos: [],
    ...extra,
  });
  return [
    order('S-tee-and-caps', [{ id: 's1', item: 'mr-tshirt', qty: 1 }, { id: 's2', item: 'mr-cap', qty: 2 }]),
    order('S-order-fixed', [{ id: 's1', item: 'mr-plush', qty: 1 }, { id: 's2', item: 'mr-keyring', qty: 3 }], {
      manual: [manual('md1', { scope: 'order', type: 'fixed', value: 50 })],
    }),
    order('S-promo-member', [{ id: 's1', item: 'mr-socks', qty: 2 }], {
      promos: [code({ code: 'MEMBER20', label: 'Member Discount', type: 'percent', value: 20, stackable: true })],
    }),
    order('S-line-comp', [{ id: 's1', item: 'mr-bottle', qty: 1 }, { id: 's2', item: 'mr-stickerpack', qty: 4 }], {
      manual: [manual('md1', { scope: 'line', targetLineId: 's2', type: 'comp', value: 0 })],
    }),
    order('S-manual-percent-rounds', [{ id: 's1', item: 'mr-keyring', qty: 1 }], {
      manual: [manual('md1', { scope: 'order', type: 'percent', value: 7 })],
      differs: 'rounding',
    }),
    order('S-weekend', [{ id: 's1', item: 'mr-cap', qty: 1 }], { mode: 'weekend' }),
    order('S-service-exclusive', [{ id: 's1', item: 'mr-tshirt', qty: 2 }], {
      config: 'service_exclusive',
      differs: 'rounding',
    }),
  ];
}

export function fnbLines(
  catalogue: ParityCatalogue,
  hooks: PricingHooks,
  spec: FnbCase,
): FnbOrderLine[] {
  return spec.lines.map((line) => {
    const menuItem = catalogue.menuItems.find((item) => item.id === line.item);
    if (!menuItem) throw new Error(`parity catalogue has no menu item ${line.item}`);
    const selected = line.selected ?? [];
    return {
      id: line.id,
      menuItem,
      qty: line.qty,
      selectedModifiers: selected,
      lineTotal: line.prepaid ? 0 : hooks.fnbLine(menuItem, selected, line.qty, spec.mode),
      ...(line.prepaid ? { isPrepaid: true } : {}),
    };
  });
}

export function merchLines(
  catalogue: ParityCatalogue,
  hooks: PricingHooks,
  spec: MerchCase,
): MerchOrderLine[] {
  return spec.lines.map((line) => {
    const merchItem = catalogue.merchItems.find((item) => item.id === line.item);
    if (!merchItem) throw new Error(`parity catalogue has no shop item ${line.item}`);
    return { id: line.id, merchItem, qty: line.qty, lineTotal: hooks.merchLine(merchItem, line.qty, spec.mode) };
  });
}

// --- The tax panel's live example -------------------------------------------

/** What Admin → Tax previews: a ฿100 base under a draft configuration. */
export interface TaxPreviewCase {
  id: string;
  category: 'tickets' | 'fnb' | 'merch' | 'addons';
  config: ConfigName;
  /** Rate percents the admin might type, beside the seed's 7. */
  percent?: number;
}

export function taxPreviewCases(): TaxPreviewCase[] {
  return [
    { id: 'X-inclusive', category: 'tickets', config: 'seeded' },
    { id: 'X-service-exclusive', category: 'fnb', config: 'service_exclusive' },
    { id: 'X-secondary', category: 'fnb', config: 'secondary' },
    { id: 'X-inclusive-7.5', category: 'merch', config: 'seeded', percent: 7.5 },
    { id: 'X-exclusive-8.25', category: 'addons', config: 'service_exclusive', percent: 8.25 },
  ];
}

export function previewConfig(spec: TaxPreviewCase, seeded: TaxConfig): TaxConfig {
  const config = taxConfigNamed(spec.config, seeded);
  if (spec.percent === undefined) return config;
  return { ...config, rates: config.rates.map((rate) => (rate.id === 'city' ? rate : { ...rate, percent: spec.percent! })) };
}

// --- The reports -------------------------------------------------------------

/** The records the manager's reports read, in place of `@/mockApi`'s seed. */
export interface ReportingDataset {
  sales: Sale[];
  fnbOrders: FnbOrder[];
  merchOrders: MerchOrder[];
  events: OtoEvent[];
  wristbands: Wristband[];
  inventory: InventoryItem[];
}

/**
 * A month of trading across two days and two months, two branches and every
 * tender, built from the cases above. `total` on each record is data here —
 * the prototype stored the figure its arithmetic produced at the time, and the
 * reports read it as stored — so it is written once, the same for both runs.
 */
export function reportingDataset(
  catalogue: ParityCatalogue,
  hooks: PricingHooks,
): ReportingDataset {
  const tickets = ticketCases(catalogue, hooks);
  const pick = (id: string) => {
    const found = tickets.find((c) => c.id === id);
    if (!found) throw new Error(`no ticket case ${id}`);
    return found;
  };
  const sale = (
    id: string,
    source: string,
    createdAt: string,
    extra: Partial<Sale> & { total: number },
  ): Sale => {
    const c = pick(source);
    return {
      id,
      operatorId: 'op-1',
      operatorName: 'Som (Reception)',
      tier: c.lines[0]!.tier,
      lines: c.lines,
      discounts: c.discounts,
      manualDiscounts: c.manual.map((md) => ({ ...md, amountTHB: md.amountTHB || 12.5 })),
      branchId: 'br-central',
      paymentMethod: 'cash',
      creditGrants: [],
      bracelets: { adults: 0, children: 0 },
      createdAt,
      status: 'paid',
      refunds: [],
      ...extra,
    };
  };

  /**
   * THE RECORDS THE REPORTS ARE PROVEN ON CARRY NO DISCOUNT THE TWO ARITHMETICS
   * PLACE DIFFERENTLY. A code or a staff discount aimed at one component, and
   * the carts rulings 1 and 2 move, are proven cart by cart (`ticketCases`,
   * where each is pinned with its class); here they would only blur a report
   * figure that is otherwise exact, and the point of this dataset is that the
   * reports' own plumbing — satang accumulators, the CSV edge — moves nothing.
   */
  const sales: Sale[] = [
    sale('S1', 'T-weekday-t-2h-tourist-2k3a4s', '2026-06-15T09:12:00.000Z', { total: 3030, paymentMethod: 'cash' }),
    sale('S2', 'T-weekday-t-fd-thai-1k1a2s-addons', '2026-06-15T10:40:00.000Z', { total: 1080, paymentMethod: 'card', tier: 'thai' }),
    sale('S3', 'T-manual-order-fixed', '2026-06-16T11:05:00.000Z', {
      total: 1830,
      paymentMethod: 'promptpay',
      branchId: 'br-chalong',
    }),
    sale('S4', 'T-promo-stacked-percents', '2026-07-01T12:00:00.000Z', { total: 1580.4, paymentMethod: 'card' }),
    sale('S6', 'T-manual-line-comp', '2026-07-02T09:00:00.000Z', { total: 0, paymentMethod: 'cash' }),
    sale('S7', 'T-two-lines', '2026-07-02T10:00:00.000Z', { total: 4140, paymentMethod: 'card', tier: 'tourist' }),
    sale('S5', 'T-manual-line-fixed', '2026-07-01T13:30:00.000Z', {
      total: 2140,
      paymentMethod: 'cash',
      refunds: [
        {
          id: 'r1',
          transactionId: 'S5',
          kind: 'ticket',
          scope: 'partial',
          amountTHB: 50.25,
          creditRestoredTHB: 0,
          reason: 'Socks returned',
          refundedBy: 'Khun Lek (Manager)',
          refundedById: 'op-3',
          refundedAt: '2026-07-01T14:00:00.000Z',
        },
      ],
    }),
    sale('S8', 'E-camp-pass', '2026-07-02T11:00:00.000Z', { total: 450, paymentMethod: 'promptpay' }),
    sale('S9', 'H-seeded-dropoff-service-sale', '2026-06-15T13:30:00.000Z', { total: 520, paymentMethod: 'promptpay' }),
    sale('S10', 'D-prepaid-credit', '2026-07-03T09:30:00.000Z', {
      total: 3170,
      paymentMethod: 'card',
      operatorName: 'Nok (Reception)',
    }),
  ];

  const fnbAt = (spec: FnbCase) => fnbLines(catalogue, hooks, spec);
  const fnbById = new Map(fnbCases().map((c) => [c.id, c]));
  const fnbOrder = (
    id: string,
    source: string,
    createdAt: string,
    payment: FnbOrder['payment'],
    extra: Partial<FnbOrder> = {},
  ): FnbOrder => {
    const spec = fnbById.get(source)!;
    return {
      id,
      operatorId: 'op-2',
      operatorName: 'Nok (Reception)',
      branchId: 'br-central',
      lines: fnbAt(spec),
      manualDiscounts: spec.manual.map((md) => ({ ...md, amountTHB: md.amountTHB || 7.35 })),
      total: payment.cash + payment.card + payment.promptpay + payment.creditUsed,
      pickupCode: '042',
      payment,
      createdAt,
      status: 'paid',
      refunds: [],
      ...extra,
    };
  };
  const fnbOrders: FnbOrder[] = [
    fnbOrder('F1', 'F-seed-order', '2026-06-15T14:10:00.000Z', { creditUsed: 250, cash: 50, card: 0, promptpay: 0 }),
    fnbOrder('F2', 'F-modifiers', '2026-06-16T12:00:00.000Z', { creditUsed: 0, cash: 0, card: 675, promptpay: 0 }),
    fnbOrder('F3', 'F-bar-and-kitchen-order-percent', '2026-07-01T18:00:00.000Z', {
      creditUsed: 0,
      cash: 0,
      card: 0,
      promptpay: 625.5,
    }),
    fnbOrder('F4', 'F-line-comp-and-order-fixed', '2026-07-02T12:30:00.000Z', { creditUsed: 0, cash: 270, card: 0, promptpay: 0 }, {
      branchId: 'br-chalong',
    }),
    fnbOrder('F5', 'F-prepaid-line', '2026-07-03T15:00:00.000Z', { creditUsed: 70, cash: 0, card: 0, promptpay: 0 }),
  ];

  const merchById = new Map(merchCases().map((c) => [c.id, c]));
  const merchOrder = (
    id: string,
    source: string,
    createdAt: string,
    payment: MerchOrder['payment'],
  ): MerchOrder => {
    const spec = merchById.get(source)!;
    return {
      id,
      operatorId: 'op-1',
      operatorName: 'Som (Reception)',
      branchId: 'br-central',
      lines: merchLines(catalogue, hooks, spec),
      manualDiscounts: spec.manual.map((md) => ({ ...md, amountTHB: md.amountTHB || 50 })),
      total: payment.cash + payment.card + payment.promptpay + payment.creditUsed,
      payment,
      createdAt,
      status: 'paid',
      refunds: [],
    };
  };
  const merchOrders: MerchOrder[] = [
    merchOrder('M1', 'S-tee-and-caps', '2026-06-15T16:00:00.000Z', { creditUsed: 0, cash: 850, card: 0, promptpay: 0 }),
    merchOrder('M2', 'S-order-fixed', '2026-07-01T16:30:00.000Z', { creditUsed: 100, cash: 0, card: 570, promptpay: 0 }),
    merchOrder('M3', 'S-line-comp', '2026-07-02T17:00:00.000Z', { creditUsed: 0, cash: 0, card: 0, promptpay: 180 }),
  ];

  const events = [
    {
      id: 'ev-camp',
      branchId: 'br-central',
      type: 'camp',
      status: 'confirmed',
      title: 'Summer camp',
      date: '2026-07-02',
      startTime: '09:00',
      endTime: '15:00',
      location: 'Main hall',
      expectedKids: 10,
      expectedAdults: 0,
      entryPriceTHB: { weekday: 450, weekend: 550 },
      attendees: [
        { id: 'a1', name: 'Mali', parentName: 'Som', checkinByDate: { '2026-07-02': { checkedInAt: '2026-07-02T09:05:00.000Z' } } },
        { id: 'a2', name: 'Tom', parentName: 'Nok' },
      ],
    },
    {
      id: 'ev-event',
      branchId: 'br-central',
      type: 'event',
      status: 'confirmed',
      title: 'Halloween',
      date: '2026-07-04',
      startTime: '17:00',
      endTime: '20:00',
      location: 'Arena',
      expectedKids: 30,
      expectedAdults: 10,
      entryPriceTHB: { weekday: 1_250.5, weekend: 1_300.75 },
      attendees: [{ id: 'b1', name: 'James', parentName: 'Ann' }],
    },
  ] as unknown as OtoEvent[];

  const wristbands = [
    {
      id: 'wb-1',
      code: '1001',
      customerNickname: 'Mali',
      creditBalanceTHB: 120.5,
      ledger: [
        { kind: 'grant', amountTHB: 350, source: 'ticket_sale', at: '2026-06-15T09:12:00.000Z' },
        { kind: 'spend', amountTHB: -229.5, source: 'fnb_order', at: '2026-06-15T14:10:00.000Z', by: 'Nok' },
      ],
    },
    {
      id: 'wb-2',
      code: '1002',
      customerNickname: 'Tom',
      creditBalanceTHB: 0,
      ledger: [
        { kind: 'grant', amountTHB: 200.1, source: 'prepaid_food', at: '2026-07-01T10:00:00.000Z' },
        { kind: 'refund', amountTHB: 20.2, source: 'refund', at: '2026-07-01T11:00:00.000Z' },
        { kind: 'expire', amountTHB: -220.3, source: 'expiry', at: '2026-07-02T23:59:00.000Z' },
      ],
    },
  ] as unknown as Wristband[];

  const inventory = [
    { id: 'inv-nuggets', name: 'Nuggets', linkedKind: 'menu', linkedId: 'm-nuggets', variants: [], unitCostTHB: 35.5 },
    { id: 'inv-fries', name: 'Fries', linkedKind: 'menu', linkedId: 'm-fries', variants: [], unitCostTHB: 12.25 },
  ] as unknown as InventoryItem[];

  return { sales, fnbOrders, merchOrders, events, wristbands, inventory };
}

/** The shop items with a cost-to-park, for the profitability report. */
export function withMerchCosts(catalogue: ParityCatalogue): MerchItem[] {
  const costs: Record<string, number> = { 'mr-tshirt': 120.5, 'mr-cap': 80, 'mr-plush': 199.99 };
  return catalogue.merchItems.map((item) => (costs[item.id] !== undefined ? { ...item, cost: costs[item.id] } : item));
}

/** The seeded codes with usage counted, for the promo-usage report. */
export function withUsage(catalogue: ParityCatalogue): Discount[] {
  const used: Record<string, number> = { STAFF10: 3, MEMBER20: 1, SAVE100: 2 };
  return catalogue.discounts.map((d) => (used[d.code] !== undefined ? { ...d, usedCount: used[d.code] } : d));
}

/** Every date the reports are asked about — the whole dataset, all branches. */
export const REPORT_FILTERS = { startDate: '2026-01-01', endDate: '2026-12-31', branchId: 'all' } as const;

/** (line total, quantity) pairs the F&B customer display divides for its "each" figure. */
export const PER_UNIT_CASES: [number, number][] = [
  [100, 3],
  [95, 2],
  [270, 4],
  [115, 3],
  [1_000, 7],
  [10.5, 2],
];
