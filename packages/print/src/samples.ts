/**
 * Named sample sets for the Print Templates editor's preview (SCRUM-472).
 *
 * The editor shows a template filled in with made-up content, and one sample is
 * not enough to judge a template by: a quiet weekday sale hides a wrapped
 * total, and a two-line receipt says nothing about a party's worth of lines, a
 * service charge or credit handed out. So the preview offers a few scenarios
 * and the person switches between them above the picture.
 *
 * **`standard` is not defined here.** It is the renderer's committed fixture
 * (`test/fixtures.ts`), which is also what the Test print button puts on paper,
 * so the default preview and the paper stay one drawing of one sample — the
 * guarantee `apps/api/test/print-api.test.ts` holds to the byte. A caller asked
 * for `standard` gets `undefined` from `printSampleJob` and uses the fixture
 * (`testPrintJob` in `@oto/box-agent`).
 *
 * **This is sample content, and it lives only in this package.** The rule that
 * there is one set of printout sample content in the repository, and that it
 * is the renderer's (`test/single-renderer.test.ts`), is about a second drawing
 * path; these sets feed the one drawing path from inside the package that owns
 * it. The browser never holds a line of them — it names a scenario and the
 * platform renders it.
 *
 * Money strings are exactly what `formatTHB` in `@oto/shared` emits (`฿1,090`
 * whole, `฿1,090.50` otherwise) and each receipt adds up the way the tax
 * engine would add it, VAT included at 7%; `test/samples.test.ts` checks both,
 * so a sample never shows a sum the till could not produce.
 */

import type { PrintJob } from './index';
import type { PrintKind } from './templates/model';

/** Every scenario the preview offers, in the order the editor lists them. */
export const PRINT_SAMPLE_NAMES = ['standard', 'simple', 'full', 'long_names'] as const;
export type PrintSampleName = (typeof PRINT_SAMPLE_NAMES)[number];

/** The fixture a test print uses — what the preview shows until someone picks. */
export const DEFAULT_PRINT_SAMPLE: PrintSampleName = 'standard';

/** The printouts an editable template governs (`TEMPLATE_FOR_KIND`). */
export type TemplatedPrintKind = Extract<
  PrintKind,
  | 'receipt'
  | 'kitchen_ticket'
  | 'bar_ticket'
  | 'kids_wristband'
  | 'adult_wristband'
  | 'credit_voucher'
  | 'item_voucher'
>;

type JobOf<K extends PrintKind> = Extract<PrintJob, { kind: K }>;
export type PrintSampleSet = { [K in TemplatedPrintKind]: JobOf<K> };

// --- A simple sale: one child, one line, cash --------------------------------

const SIMPLE: PrintSampleSet = {
  receipt: {
    kind: 'receipt',
    data: {
      title: 'Receipt',
      receiptNumber: 'HKT1-000431',
      dateTime: '20 Sep 2026 10:05',
      staffName: 'Nok',
      lines: [{ qty: 1, name: '2hr Play — Child', price: '฿350' }],
      subtotal: '฿350',
      vat: '฿22.90',
      total: '฿350',
      tenders: [{ label: 'Cash', amount: '฿350' }],
      bandCodes: ['T1-A7K3M1'],
    },
  },
  kitchen_ticket: {
    kind: 'kitchen_ticket',
    data: {
      title: 'Kitchen',
      orderRef: 'F-2210',
      time: '12:02',
      lines: [{ qty: 1, name: 'Chicken Nuggets' }],
    },
  },
  bar_ticket: {
    kind: 'bar_ticket',
    data: {
      title: 'Bar',
      orderRef: 'F-2210',
      time: '12:02',
      lines: [{ qty: 1, name: 'Thai Iced Tea' }],
    },
  },
  kids_wristband: {
    kind: 'kids_wristband',
    data: {
      holderName: 'Mali',
      startEndTime: '10:00 – 12:00',
      duration: '2 hours',
      bandCode: 'T1229E98P2DRXHTB6MKV5J2A7K3M1.Q4W8E2R6T0YP',
      shortCode: 'T1-A7K3M1',
    },
  },
  adult_wristband: {
    kind: 'adult_wristband',
    data: {
      holderName: 'Guardian',
      startEndTime: '10:00 – 12:00',
      duration: '2 hours',
      bandCode: 'T1229E98P2DRXHTB6MKV5J2B8N4P2.H3J5K7M9N1PQ',
      shortCode: 'T1-B8N4P2',
    },
  },
  credit_voucher: {
    kind: 'credit_voucher',
    data: { balance: '฿100', qrCode: 'wb-walkin-S10431-0' },
  },
  item_voucher: {
    kind: 'item_voucher',
    data: { label: 'Free: Ice Cream Cone', quantity: 1, qrCode: 'grant-S10431-item-1' },
  },
};

// --- A fuller sale: a birthday party's worth of lines, service, credit -------

const FULL: PrintSampleSet = {
  receipt: {
    kind: 'receipt',
    data: {
      title: 'Receipt',
      taxInvoiceLines: ['ใบกำกับภาษีอย่างย่อ', 'Tax ID 0105500000000'],
      receiptNumber: 'HKT1-000512',
      dateTime: '27 Sep 2026 15:48',
      staffName: 'Nok',
      memberNickname: 'Khun Ploy',
      lines: [
        { qty: 3, name: '2hr Play — Child', price: '฿1,050' },
        { qty: 2, name: 'Adult Pass', price: '฿300' },
        { qty: 1, name: 'Birthday Package — Jungle', price: '฿4,500', note: 'Party room B, 16:00' },
        { qty: 3, name: 'Grip Socks', price: '฿180', note: 'Sizes 22, 24, 24' },
        { qty: 2, name: 'Margherita Pizza', price: '฿440' },
        { qty: 4, name: 'Thai Iced Tea', price: '฿260', note: 'Less sweet' },
      ],
      subtotal: '฿6,730',
      service: '฿673',
      vat: '฿484.31',
      total: '฿7,403',
      tenders: [
        { label: 'Card', amount: '฿5,000' },
        { label: 'Cash', amount: '฿2,500' },
        { label: 'Change', amount: '฿97' },
      ],
      bandCodes: ['T1-C9P5Q3', 'T1-C9P5Q4', 'T1-C9P5Q5', 'T1-D0Q6R4', 'T1-D0Q6R5'],
      creditGrants: ['฿500 credit', '3× Grip socks to collect', '1× Birthday cake to collect'],
      orderNote: 'Cake at 16:30, candles on the side.',
    },
  },
  kitchen_ticket: {
    kind: 'kitchen_ticket',
    data: {
      title: 'Kitchen',
      orderRef: 'F-2231',
      time: '15:52',
      holderName: 'Ploy (Band 12)',
      allergiesMedical: 'Peanuts, tree nuts',
      lines: [
        { qty: 2, name: 'Margherita Pizza', note: 'Cut in 8' },
        { qty: 1, name: 'Chicken Nuggets', note: 'No dip' },
        { qty: 3, name: 'French Fries' },
        { qty: 1, name: 'Fried Rice with Egg', note: 'No chilli' },
      ],
      orderNote: 'Party room B — serve at 16:00.',
    },
  },
  bar_ticket: {
    kind: 'bar_ticket',
    data: {
      title: 'Bar',
      orderRef: 'F-2231',
      time: '15:52',
      holderName: 'Ploy (Band 12)',
      allergiesMedical: 'Dairy',
      lines: [
        { qty: 4, name: 'Thai Iced Tea', note: 'Less sweet' },
        { qty: 2, name: 'Fresh Coconut' },
        { qty: 3, name: 'Orange Juice', note: 'No ice' },
      ],
      orderNote: 'Party room B — serve at 16:00.',
    },
  },
  kids_wristband: {
    kind: 'kids_wristband',
    data: {
      holderName: 'Ploy',
      supervisionMode: 'DROP-OFF',
      startEndTime: '14:00 – 18:00',
      duration: '4 hours · valid until 18:00',
      partyName: 'Ploy’s Jungle Birthday',
      dietaryRequirement: 'Vegetarian',
      assignedNannyName: 'Fon',
      allergy: 'Peanuts, tree nuts',
      bandCode: 'T1229E9A1C3E5G7J9K1M3N5C9P5Q3.R2S4T6V8W0XY',
      shortCode: 'T1-C9P5Q3',
    },
  },
  adult_wristband: {
    kind: 'adult_wristband',
    data: {
      holderName: 'Khun Somchai',
      startEndTime: '14:00 – 18:00',
      duration: '4 hours · valid until 18:00',
      partyName: 'Ploy’s Jungle Birthday',
      dietaryRequirement: 'Halal',
      bandCode: 'T1229E9A1C3E5G7J9K1M3N5D0Q6R4.Z1A3B5C7D9EF',
      shortCode: 'T1-D0Q6R4',
    },
  },
  credit_voucher: {
    kind: 'credit_voucher',
    data: { balance: '฿500', qrCode: 'wb-T1-C9P5Q3-0', holderName: 'Ploy' },
  },
  item_voucher: {
    kind: 'item_voucher',
    data: { label: 'Birthday cake to collect', quantity: 1, qrCode: 'grant-S10512-item-3' },
  },
};

// --- Long names: what wraps, in both scripts ---------------------------------

const LONG_CHILD = 'Maximilian Alexander Worthington-Smythe';
const LONG_GUARDIAN = 'Alexandra-Charlotte Montgomery-Whitfield';
const LONG_PARTY = 'Maximilian and Charlotte’s Enchanted Jungle Birthday Party';

const LONG_NAMES: PrintSampleSet = {
  receipt: {
    kind: 'receipt',
    data: {
      title: 'Receipt',
      receiptNumber: 'HKT1-000587',
      dateTime: '28 Sep 2026 11:17',
      staffName: 'Nokkaew Srisawatdiphong',
      memberNickname: `${LONG_GUARDIAN} · น้องอเล็กซานดรา`,
      lines: [
        {
          qty: 1,
          name: 'Ultimate All-Day Adventure Pass with Unlimited Trampoline Access — Child (3–12 years)',
          price: '฿890',
        },
        { qty: 2, name: 'ชุดอาหารกลางวันสำหรับเด็กพร้อมน้ำผลไม้และของหวาน', price: '฿520' },
        {
          qty: 1,
          name: 'Limited Edition OTO Park Explorer Backpack — Jungle Green, Extra Large',
          price: '฿1,290',
          note: 'Gift wrap requested; please attach the birthday card from reception',
        },
      ],
      subtotal: '฿2,700',
      vat: '฿176.64',
      total: '฿2,700',
      tenders: [{ label: 'QR PromptPay (Kasikorn Bank)', amount: '฿2,700' }],
      bandCodes: ['T1-E1R7S5', 'T1-F2S8T6'],
      creditGrants: ['2× Unlimited Trampoline Session vouchers to collect at the trampoline zone'],
    },
  },
  kitchen_ticket: {
    kind: 'kitchen_ticket',
    data: {
      title: 'Kitchen',
      orderRef: 'F-2298',
      time: '11:24',
      holderName: `${LONG_CHILD} (Band 27)`,
      allergiesMedical:
        'Severe peanut and tree nut allergy — EpiPen in guardian’s bag; also lactose intolerant',
      lines: [
        {
          qty: 1,
          name: 'Grilled Chicken Breast with Steamed Jasmine Rice and Seasonal Vegetables',
          note: 'No sauce, no butter, cook separately from the nut station',
        },
        { qty: 1, name: 'ข้าวผัดกุ้งไม่ใส่พริกไม่ใส่ผงชูรส' },
      ],
      orderNote: 'Deliver to the family table beside the soft-play entrance, not the party room.',
    },
  },
  bar_ticket: {
    kind: 'bar_ticket',
    data: {
      title: 'Bar',
      orderRef: 'F-2298',
      time: '11:24',
      holderName: `${LONG_CHILD} (Band 27)`,
      allergiesMedical: 'Lactose intolerant',
      lines: [
        {
          qty: 1,
          name: 'Freshly Squeezed Orange and Passion Fruit Smoothie (No Dairy)',
          note: 'Use oat milk if any; no honey',
        },
        { qty: 2, name: 'ชาเย็นไม่หวานใส่นมโอ๊ต' },
      ],
      orderNote: 'Deliver to the family table beside the soft-play entrance, not the party room.',
    },
  },
  kids_wristband: {
    kind: 'kids_wristband',
    data: {
      holderName: LONG_CHILD,
      supervisionMode: 'NANNY',
      startEndTime: '09:30 – 13:30',
      duration: '4 hours · valid until 13:30',
      partyName: LONG_PARTY,
      dietaryRequirement: 'Strict vegetarian, no egg',
      assignedNannyName: 'Kanokwan Phromsuwan',
      allergy: 'Peanuts, tree nuts, sesame — EpiPen with guardian',
      bandCode: 'T1229E9F2H4J6K8M0N2P4Q6E1R7S5.G2H4J6K8M0NP',
      shortCode: 'T1-E1R7S5',
    },
  },
  adult_wristband: {
    kind: 'adult_wristband',
    data: {
      holderName: LONG_GUARDIAN,
      startEndTime: '09:30 – 13:30',
      duration: '4 hours · valid until 13:30',
      partyName: LONG_PARTY,
      dietaryRequirement: 'Gluten free',
      bandCode: 'T1229E9F2H4J6K8M0N2P4Q6F2S8T6.V3W5X7Y9Z1AB',
      shortCode: 'T1-F2S8T6',
    },
  },
  credit_voucher: {
    kind: 'credit_voucher',
    data: {
      balance: '฿1,500',
      qrCode: 'wb-T1-E1R7S5-0',
      holderName: `${LONG_GUARDIAN} · น้องอเล็กซานดรา`,
    },
  },
  item_voucher: {
    kind: 'item_voucher',
    data: {
      label: 'Free: Double Scoop Coconut Ice Cream with Mango Sticky Rice Topping',
      quantity: 2,
      qrCode: 'grant-S10587-item-1',
    },
  },
};

/** The sets this module owns — every name but `standard`, which is the fixture. */
export const PRINT_SAMPLES: Readonly<Record<Exclude<PrintSampleName, 'standard'>, PrintSampleSet>> = {
  simple: SIMPLE,
  full: FULL,
  long_names: LONG_NAMES,
};

const TEMPLATED: ReadonlySet<PrintKind> = new Set<TemplatedPrintKind>([
  'receipt',
  'kitchen_ticket',
  'bar_ticket',
  'kids_wristband',
  'adult_wristband',
  'credit_voucher',
  'item_voucher',
]);

/**
 * The job for one printout under one named sample.
 *
 * `undefined` for `standard` and for a printout no template governs (the booth
 * voucher, the test page): the caller then renders the committed fixture,
 * which is the Test print's own sample. A copy is returned, so a caller that
 * adjusts the job cannot change the next preview.
 */
export function printSampleJob(kind: PrintKind, name: PrintSampleName): PrintJob | undefined {
  if (name === 'standard' || !TEMPLATED.has(kind)) return undefined;
  const job = PRINT_SAMPLES[name][kind as TemplatedPrintKind];
  return JSON.parse(JSON.stringify(job)) as PrintJob;
}
